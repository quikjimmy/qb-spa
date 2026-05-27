import Anthropic from '@anthropic-ai/sdk'
import db from '../db'
import {
  FEEDBACK_TRIAGE_SYSTEM,
  FEEDBACK_TRIAGE_MODEL_DEFAULT,
  FEEDBACK_TRIAGE_MODEL_FALLBACK,
  FEEDBACK_TRIAGE_MODEL_OLLAMA,
} from './prompt'
import { getDefaultKeyFor, getKeyById, type ProviderId, SUPPORTED_PROVIDERS } from '../lib/userProviderKeys'

export interface FeedbackInput {
  id: number
  path: string
  category: string | null
  body: string
  created_at: string
  user: string | null
}

interface ProposalDraft {
  scope_md: string
  files_touched: string[]
  effort_estimate: 'S' | 'M' | 'L'
  risk_notes: string
}

interface ClusterDraft {
  title: string
  summary: string
  theme: string | null
  feedback_ids: number[]
  proposal: ProposalDraft
}

interface TriageResponse {
  clusters: ClusterDraft[]
}

export interface TriageRunSummary {
  run_id: number
  feedback_considered: number
  clusters_created: number
  proposals_drafted: number
  model: string
  tokens_in: number
  tokens_out: number
  cost_cents: number
}

const PRICING = {
  'claude-sonnet-4-6': { in: 3.0, out: 15.0 },
  'claude-haiku-4-5-20251001': { in: 1.0, out: 5.0 },
} as const

function computeCostCents(model: string, tokensIn: number, tokensOut: number): number {
  const p = PRICING[model as keyof typeof PRICING]
  if (!p) return 0
  const inCost = (tokensIn / 1_000_000) * p.in
  const outCost = (tokensOut / 1_000_000) * p.out
  return Math.ceil((inCost + outCost) * 100)
}

function loadUnclusteredFeedback(): FeedbackInput[] {
  const rows = db.prepare(
    `SELECT f.id, f.path, f.category, f.body, f.created_at,
            COALESCE(u.name, u.email) AS user
     FROM app_feedback f
     LEFT JOIN users u ON u.id = f.user_id
     WHERE f.cluster_id IS NULL
       AND f.status NOT IN ('dismissed', 'shipped')
     ORDER BY f.created_at ASC
     LIMIT 200`
  ).all() as Array<{ id: number; path: string; category: string | null; body: string; created_at: string; user: string | null }>
  return rows
}

function parseTriageResponse(raw: string): TriageResponse {
  const trimmed = raw.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim()
  const parsed = JSON.parse(trimmed) as TriageResponse
  if (!parsed || !Array.isArray(parsed.clusters)) {
    throw new Error('Triage response missing clusters[]')
  }
  for (const c of parsed.clusters) {
    if (!c.title || !c.summary || !Array.isArray(c.feedback_ids) || !c.proposal) {
      throw new Error('Triage cluster missing required fields')
    }
    if (!['S', 'M', 'L'].includes(c.proposal.effort_estimate)) {
      c.proposal.effort_estimate = 'M'
    }
    if (!Array.isArray(c.proposal.files_touched)) {
      c.proposal.files_touched = []
    }
    if (typeof c.proposal.risk_notes !== 'string') {
      c.proposal.risk_notes = ''
    }
  }
  return parsed
}

async function callAnthropic(items: FeedbackInput[], model: string, key: { apiKey: string; baseUrl: string | null }): Promise<{ raw: string; tokensIn: number; tokensOut: number }> {
  const client = new Anthropic({ apiKey: key.apiKey, ...(key.baseUrl ? { baseURL: key.baseUrl } : {}) })
  const userPrompt = `## Unclustered feedback (${items.length} items)\n\n${JSON.stringify(items, null, 2)}\n\nGroup these and draft a proposal for each cluster. Return only the JSON object.`

  const response = await client.messages.create({
    model,
    max_tokens: 4000,
    system: [{ type: 'text', text: FEEDBACK_TRIAGE_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userPrompt }],
  })

  const textBlock = response.content.find(b => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') throw new Error('No text response from model')

  const tokensIn =
    (response.usage.input_tokens || 0) +
    (response.usage.cache_creation_input_tokens || 0) +
    (response.usage.cache_read_input_tokens || 0)
  const tokensOut = response.usage.output_tokens || 0

  return { raw: textBlock.text, tokensIn, tokensOut }
}

// Ollama's native /api/chat with format: "json" enforces grammar-constrained
// JSON output. We use this (not the /v1/chat/completions shim) because the
// OpenAI-compat layer does not reliably translate max_tokens → num_predict,
// which left Kimi truncating mid-string at the ~128-token default cap.
async function callOllama(items: FeedbackInput[], model: string, key: { apiKey: string; baseUrl: string | null }): Promise<{ raw: string; tokensIn: number; tokensOut: number }> {
  const base = (key.baseUrl || 'https://ollama.com').replace(/\/+$/, '')
  const userPrompt = `## Unclustered feedback (${items.length} items)\n\n${JSON.stringify(items, null, 2)}\n\nGroup these and draft a proposal for each cluster. Return only the JSON object.`

  const r = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key.apiKey}`,
    },
    body: JSON.stringify({
      model,
      stream: false,
      format: 'json',
      messages: [
        { role: 'system', content: FEEDBACK_TRIAGE_SYSTEM },
        { role: 'user', content: userPrompt },
      ],
      options: { num_predict: 8000 },
    }),
  })
  if (!r.ok) {
    const text = (await r.text().catch(() => '')).slice(0, 400)
    throw new Error(`Ollama ${r.status}: ${text || r.statusText}`)
  }
  const data = (await r.json()) as {
    message?: { content?: string }
    prompt_eval_count?: number
    eval_count?: number
  }
  const content = data.message?.content
  if (!content) throw new Error('Ollama returned no content')

  return {
    raw: content,
    tokensIn: data.prompt_eval_count ?? 0,
    tokensOut: data.eval_count ?? 0,
  }
}

function callModel(provider: ProviderId, items: FeedbackInput[], model: string, key: { apiKey: string; baseUrl: string | null }): Promise<{ raw: string; tokensIn: number; tokensOut: number }> {
  if (provider === 'anthropic') return callAnthropic(items, model, key)
  if (provider === 'ollama') return callOllama(items, model, key)
  throw new Error(`Triage provider not implemented: ${provider}`)
}

function defaultModelFor(provider: ProviderId): string {
  if (provider === 'ollama') return FEEDBACK_TRIAGE_MODEL_OLLAMA
  return FEEDBACK_TRIAGE_MODEL_DEFAULT
}

// Resolve which API key to use for this triage run, in order:
//   1. opts.keyId — caller picked a specific user_provider_keys row
//   2. opts.userId (+ optional opts.provider) — caller's default key for that
//      provider, or first available default walking anthropic→ollama→openai
//   3. ANTHROPIC_API_KEY env var — system fallback (Anthropic only)
function resolveTriageKey(opts: { userId?: number; keyId?: number; provider?: ProviderId }): { apiKey: string; baseUrl: string | null; provider: ProviderId; source: string } {
  if (opts.keyId && opts.userId) {
    const k = getKeyById(opts.userId, opts.keyId)
    if (!k) throw new Error(`API key id=${opts.keyId} not found for user`)
    return { apiKey: k.apiKey, baseUrl: k.baseUrl, provider: k.provider, source: `user-key:${opts.keyId}${k.label ? ` (${k.label})` : ''}` }
  }
  if (opts.userId) {
    if (opts.provider) {
      const k = getDefaultKeyFor(opts.userId, opts.provider)
      if (k) return { apiKey: k.apiKey, baseUrl: k.baseUrl, provider: opts.provider, source: `user-default:${opts.provider}` }
      throw new Error(`No default ${opts.provider} key for user — add one in Settings`)
    }
    for (const provider of SUPPORTED_PROVIDERS) {
      const k = getDefaultKeyFor(opts.userId, provider)
      if (k) return { apiKey: k.apiKey, baseUrl: k.baseUrl, provider, source: `user-default:${provider}` }
    }
  }
  const envKey = process.env['ANTHROPIC_API_KEY']
  if (envKey) return { apiKey: envKey, baseUrl: null, provider: 'anthropic', source: 'env' }
  throw new Error('No API key available for triage — add one in Settings or set ANTHROPIC_API_KEY')
}

export async function runFeedbackTriage(opts?: { triggeredBy?: number; model?: string; userId?: number; keyId?: number; provider?: ProviderId }): Promise<TriageRunSummary> {
  const triggeredBy = opts?.triggeredBy ?? null
  const key = resolveTriageKey({ userId: opts?.userId, keyId: opts?.keyId, provider: opts?.provider })
  const model = opts?.model || defaultModelFor(key.provider)
  const modelWasExplicit = !!opts?.model

  const insertRun = db.prepare(
    `INSERT INTO feedback_triage_runs (status, triggered_by, model) VALUES ('running', ?, ?)`
  )
  const runResult = insertRun.run(triggeredBy, model)
  const runId = Number(runResult.lastInsertRowid)

  const items = loadUnclusteredFeedback()
  if (items.length === 0) {
    db.prepare(
      `UPDATE feedback_triage_runs
         SET finished_at = datetime('now'), status = 'completed', feedback_considered = 0
       WHERE id = ?`
    ).run(runId)
    return {
      run_id: runId,
      feedback_considered: 0,
      clusters_created: 0,
      proposals_drafted: 0,
      model,
      tokens_in: 0,
      tokens_out: 0,
      cost_cents: 0,
    }
  }

  let raw: string
  let tokensIn: number
  let tokensOut: number
  let usedModel = model
  try {
    const r = await callModel(key.provider, items, model, key)
    raw = r.raw
    tokensIn = r.tokensIn
    tokensOut = r.tokensOut
  } catch (err) {
    // Only fall back on Anthropic, and only when caller didn't pin a specific
    // model. Ollama has no second-tier model in this codebase to retry with.
    if (key.provider === 'anthropic' && !modelWasExplicit) {
      const r = await callModel(key.provider, items, FEEDBACK_TRIAGE_MODEL_FALLBACK, key)
      raw = r.raw
      tokensIn = r.tokensIn
      tokensOut = r.tokensOut
      usedModel = FEEDBACK_TRIAGE_MODEL_FALLBACK
    } else {
      throw err
    }
  }

  let parsed: TriageResponse
  try {
    parsed = parseTriageResponse(raw)
  } catch (err) {
    console.error(`[feedback-triage] parse failed (model=${usedModel}, provider=${key.provider}). Raw response:\n${raw.slice(0, 2000)}`)
    db.prepare(
      `UPDATE feedback_triage_runs
         SET finished_at = datetime('now'), status = 'failed',
             feedback_considered = ?, model = ?, tokens_in = ?, tokens_out = ?, cost_cents = ?,
             error = ?
       WHERE id = ?`
    ).run(items.length, usedModel, tokensIn, tokensOut, computeCostCents(usedModel, tokensIn, tokensOut),
          (err as Error).message, runId)
    throw err
  }

  const validIds = new Set(items.map(i => i.id))
  const seen = new Set<number>()

  const insertCluster = db.prepare(
    `INSERT INTO feedback_clusters (title, summary, theme, status, item_count, first_seen, last_seen)
     VALUES (?, ?, ?, 'open', ?, ?, ?)`
  )
  const updateFeedback = db.prepare(`UPDATE app_feedback SET cluster_id = ? WHERE id = ?`)
  const insertProposal = db.prepare(
    `INSERT INTO improvement_proposals
       (cluster_id, scope_md, files_touched_json, effort_estimate, risk_notes,
        triage_run_id, model, tokens_in, tokens_out, cost_cents)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`
  )

  let clustersCreated = 0
  let proposalsDrafted = 0
  const itemById = new Map(items.map(i => [i.id, i]))

  const tx = db.transaction(() => {
    for (const c of parsed.clusters) {
      const ids = c.feedback_ids.filter(id => validIds.has(id) && !seen.has(id))
      if (ids.length === 0) continue
      ids.forEach(id => seen.add(id))

      const memberDates = ids.map(id => itemById.get(id)?.created_at).filter((d): d is string => !!d).sort()
      const firstSeen = memberDates[0] ?? null
      const lastSeen = memberDates[memberDates.length - 1] ?? null

      const clusterResult = insertCluster.run(
        c.title.slice(0, 200),
        c.summary.slice(0, 1000),
        c.theme ? c.theme.slice(0, 40) : null,
        ids.length,
        firstSeen,
        lastSeen
      )
      const clusterId = Number(clusterResult.lastInsertRowid)
      clustersCreated++

      for (const fid of ids) updateFeedback.run(clusterId, fid)

      insertProposal.run(
        clusterId,
        c.proposal.scope_md.slice(0, 8000),
        JSON.stringify(c.proposal.files_touched.slice(0, 30)),
        c.proposal.effort_estimate,
        c.proposal.risk_notes.slice(0, 2000),
        runId,
        usedModel
      )
      proposalsDrafted++
    }
  })
  tx()

  const costCents = computeCostCents(usedModel, tokensIn, tokensOut)
  db.prepare(
    `UPDATE feedback_triage_runs
       SET finished_at = datetime('now'), status = 'completed',
           feedback_considered = ?, clusters_touched = ?, proposals_drafted = ?,
           model = ?, tokens_in = ?, tokens_out = ?, cost_cents = ?
     WHERE id = ?`
  ).run(items.length, clustersCreated, proposalsDrafted, usedModel, tokensIn, tokensOut, costCents, runId)

  return {
    run_id: runId,
    feedback_considered: items.length,
    clusters_created: clustersCreated,
    proposals_drafted: proposalsDrafted,
    model: usedModel,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_cents: costCents,
  }
}
