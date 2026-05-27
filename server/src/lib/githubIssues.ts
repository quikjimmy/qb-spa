import crypto from 'crypto'
import db from '../db'

export interface ProposalIssueContext {
  proposalId: number
  clusterId: number
  clusterTitle: string
  clusterSummary: string
  clusterTheme: string | null
  scopeMd: string
  filesTouched: string[]
  effortEstimate: string | null
  riskNotes: string | null
  triageRunId: number | null
  model: string | null
  feedback: Array<{
    user_name: string | null
    user_email: string | null
    path: string
    body: string
    created_at: string
  }>
}

interface GitHubCreateIssueResponse {
  number: number
  html_url: string
}

function envOrNull(name: string): string | null {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : null
}

export function githubConfigured(): boolean {
  return !!(envOrNull('GITHUB_TOKEN') && envOrNull('GITHUB_REPO'))
}

function adminHostForLinks(): string {
  return envOrNull('PUBLIC_APP_URL') || 'http://localhost:5173'
}

function formatRequestedBy(feedback: ProposalIssueContext['feedback']): string {
  const handles = feedback.map(f => f.user_name || f.user_email || 'anonymous')
  const unique = Array.from(new Set(handles))
  if (unique.length === 1) return unique[0]!
  return `${unique.length} users`
}

export function buildIssueBody(ctx: ProposalIssueContext): string {
  const lines: string[] = []
  lines.push(`> Drafted from in-app feedback triage.`)
  lines.push(`> Cluster: "${ctx.clusterTitle}" · Theme: ${ctx.clusterTheme || 'other'} · Effort: ${ctx.effortEstimate || '?'}`)
  lines.push(`> Requested by ${formatRequestedBy(ctx.feedback)}`)
  lines.push('')
  lines.push('## Summary')
  lines.push(ctx.clusterSummary || '_(no summary)_')
  lines.push('')
  lines.push('## Proposed scope')
  lines.push(ctx.scopeMd || '_(no scope drafted)_')
  lines.push('')
  lines.push('## Risk notes')
  lines.push(ctx.riskNotes && ctx.riskNotes.trim() ? ctx.riskNotes : '—')
  lines.push('')
  lines.push('## Files (best-guess from triage agent)')
  if (ctx.filesTouched.length === 0) {
    lines.push('- _none guessed_')
  } else {
    for (const f of ctx.filesTouched) lines.push(`- \`${f}\``)
  }
  lines.push('')
  lines.push(`## Originating feedback (${ctx.feedback.length} item${ctx.feedback.length === 1 ? '' : 's'})`)
  for (const f of ctx.feedback) {
    const who = f.user_name || f.user_email || 'anonymous'
    lines.push(`- **${who}** · route \`${f.path}\` · ${f.created_at}`)
    const body = f.body.split('\n').map(l => `  > ${l}`).join('\n')
    lines.push(body)
  }
  lines.push('')
  lines.push('---')
  lines.push(`Triage: cluster #${ctx.clusterId} · run #${ctx.triageRunId ?? '?'} · model \`${ctx.model || '?'}\``)
  lines.push(`Admin: ${adminHostForLinks()}/admin?proposal=${ctx.proposalId}`)
  return lines.join('\n')
}

export function buildIssueLabels(theme: string | null): string[] {
  const labels = ['from-feedback']
  if (theme && theme.trim()) labels.push(`theme:${theme.trim()}`)
  return labels
}

// Creates a GitHub issue for an approved proposal. Throws on any failure;
// the caller is responsible for stamping the error on the proposal row so
// the admin can retry. Does not mutate the DB itself.
export async function createGithubIssue(ctx: ProposalIssueContext): Promise<{ number: number; url: string }> {
  const token = envOrNull('GITHUB_TOKEN')
  const repo = envOrNull('GITHUB_REPO')
  if (!token || !repo) throw new Error('GITHUB_TOKEN and GITHUB_REPO must be set')

  const r = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'qb-spa-feedback-triage',
    },
    body: JSON.stringify({
      title: ctx.clusterTitle.slice(0, 200),
      body: buildIssueBody(ctx),
      labels: buildIssueLabels(ctx.clusterTheme),
    }),
  })
  if (!r.ok) {
    const text = (await r.text().catch(() => '')).slice(0, 400)
    throw new Error(`GitHub ${r.status}: ${text || r.statusText}`)
  }
  const data = (await r.json()) as GitHubCreateIssueResponse
  return { number: data.number, url: data.html_url }
}

// Parses "Closes #123", "Fixes #45", "Resolves #67" out of PR bodies, case
// insensitive, handles plurals and the GH-supported owner/repo#N form
// (which we only match if it points back at our own repo).
const REPO = process.env['GITHUB_REPO'] || ''
const CLOSING_RE = new RegExp(
  String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s+(?:${REPO.replace(/[^a-z0-9-/]/gi, '')}#)?#?(\d+)`,
  'gi'
)

export function parseClosingRefs(prBody: string | null | undefined): number[] {
  if (!prBody) return []
  const found = new Set<number>()
  for (const m of prBody.matchAll(CLOSING_RE)) {
    const n = parseInt(m[1]!, 10)
    if (Number.isInteger(n) && n > 0) found.add(n)
  }
  return Array.from(found)
}

// Constant-time HMAC compare per GitHub's docs.
export function verifyGithubSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  const secret = envOrNull('GITHUB_WEBHOOK_SECRET')
  if (!secret) return false
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(signatureHeader)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

// Loads everything needed to render an issue body for a proposal. Used by
// both the approve-time fire and the manual retry endpoint.
export function loadProposalIssueContext(proposalId: number): ProposalIssueContext | null {
  const row = db.prepare(
    `SELECT p.id AS proposalId, p.cluster_id AS clusterId, p.scope_md AS scopeMd,
            p.files_touched_json AS filesTouchedJson, p.effort_estimate AS effortEstimate,
            p.risk_notes AS riskNotes, p.triage_run_id AS triageRunId, p.model,
            c.title AS clusterTitle, c.summary AS clusterSummary, c.theme AS clusterTheme
       FROM improvement_proposals p
       JOIN feedback_clusters c ON c.id = p.cluster_id
      WHERE p.id = ?`
  ).get(proposalId) as
    | {
        proposalId: number
        clusterId: number
        scopeMd: string
        filesTouchedJson: string
        effortEstimate: string | null
        riskNotes: string | null
        triageRunId: number | null
        model: string | null
        clusterTitle: string
        clusterSummary: string
        clusterTheme: string | null
      }
    | undefined
  if (!row) return null

  const feedback = db.prepare(
    `SELECT f.path, f.body, f.created_at, u.name AS user_name, u.email AS user_email
       FROM app_feedback f
       LEFT JOIN users u ON u.id = f.user_id
      WHERE f.cluster_id = ?
      ORDER BY f.created_at ASC`
  ).all(row.clusterId) as Array<{ path: string; body: string; created_at: string; user_name: string | null; user_email: string | null }>

  let files: string[] = []
  try { files = JSON.parse(row.filesTouchedJson || '[]') as string[] } catch { files = [] }

  return {
    proposalId: row.proposalId,
    clusterId: row.clusterId,
    clusterTitle: row.clusterTitle,
    clusterSummary: row.clusterSummary,
    clusterTheme: row.clusterTheme,
    scopeMd: row.scopeMd,
    filesTouched: files,
    effortEstimate: row.effortEstimate,
    riskNotes: row.riskNotes,
    triageRunId: row.triageRunId,
    model: row.model,
    feedback,
  }
}
