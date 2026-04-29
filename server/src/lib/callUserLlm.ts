import Anthropic from '@anthropic-ai/sdk'
import { ollamaChat } from '../agents/ollamaChat'
import { getDefaultKeyFor, type ProviderId } from './userProviderKeys'
import { checkUserBudget, recordUserLlmUsage } from './userBudget'
import { parseRateLimitHeaders, recordRateSnapshot, EMPTY_SNAPSHOT, type RateSnapshot } from './providerRateLimits'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface CallUserLlmOptions {
  userId: number
  feature: string                       // e.g. 'chatbot', 'project-summary'
  messages: ChatMessage[]
  // Optional preferences. If unset, picks the user's default provider:
  // anthropic > openai > ollama (whichever the user has a key for, then platform key for anthropic).
  preferProvider?: ProviderId
  model?: string                        // provider-specific model id; falls back to provider default
  maxOutputTokens?: number              // soft cap on the response
  temperature?: number
  timeoutMs?: number
}

export type CallUserLlmResult =
  | { ok: true; output: string; provider: ProviderId; model: string; tokens_in: number; tokens_out: number; cost_cents: number; used_own_key: boolean }
  | { ok: false; error: string; reason: 'budget' | 'no_provider' | 'provider_error' }

// Default models per provider — cheap-and-fast picks suitable for chatbot work.
// Ollama default is the smallest of the gpt-oss models (~20B params), which is
// part of Ollama Cloud's free tier and a common universal default.
const DEFAULT_MODEL: Record<ProviderId, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  ollama: 'gpt-oss:20b',
}

// Per-million-token pricing (USD). Update as providers change pricing.
const PRICING: Record<string, { in: number; out: number }> = {
  // Anthropic
  'claude-haiku-4-5-20251001': { in: 1.0, out: 5.0 },
  'claude-sonnet-4-6': { in: 3.0, out: 15.0 },
  'claude-opus-4-7': { in: 15.0, out: 75.0 },
  // OpenAI (illustrative — adjust to current published rates)
  'gpt-4o-mini': { in: 0.15, out: 0.60 },
  'gpt-4o': { in: 2.5, out: 10.0 },
}

function priceCents(model: string, tokensIn: number, tokensOut: number): number {
  const p = PRICING[model]
  if (!p) return 0
  return Math.ceil(((tokensIn / 1_000_000) * p.in + (tokensOut / 1_000_000) * p.out) * 100)
}

interface ResolvedKey { apiKey: string; baseUrl: string | null; usingOwnKey: boolean }

// Resolve the API key for a provider: user's BYOK if set, else platform env var.
function resolveKey(userId: number, provider: ProviderId): ResolvedKey | null {
  const own = getDefaultKeyFor(userId, provider)
  if (own) return { apiKey: own.apiKey, baseUrl: own.baseUrl, usingOwnKey: true }

  if (provider === 'anthropic') {
    const k = process.env['ANTHROPIC_API_KEY']
    return k ? { apiKey: k, baseUrl: null, usingOwnKey: false } : null
  }
  if (provider === 'openai') {
    const k = process.env['OPENAI_API_KEY']
    return k ? { apiKey: k, baseUrl: null, usingOwnKey: false } : null
  }
  // Ollama has no platform fallback by design — it's BYOK-only for now.
  return null
}

// Pick the first provider for which we can resolve a key.
function pickProvider(userId: number, prefer?: ProviderId): { provider: ProviderId; key: ResolvedKey } | null {
  const order: ProviderId[] = prefer
    ? [prefer, ...(['anthropic', 'openai', 'ollama'] as ProviderId[]).filter(p => p !== prefer)]
    : ['anthropic', 'openai', 'ollama']
  for (const p of order) {
    const k = resolveKey(userId, p)
    if (k) return { provider: p, key: k }
  }
  return null
}

async function callAnthropic(opts: { apiKey: string; model: string; messages: ChatMessage[]; maxOutputTokens: number; temperature: number }): Promise<{ output: string; tokensIn: number; tokensOut: number; rate: RateSnapshot }> {
  const client = new Anthropic({ apiKey: opts.apiKey })
  const system = opts.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n') || undefined
  const turns = opts.messages.filter(m => m.role !== 'system').map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  // withResponse() returns both the parsed body and the raw Response so we can
  // read rate-limit headers without making a second call.
  const { data: r, response } = await client.messages.create({
    model: opts.model,
    max_tokens: opts.maxOutputTokens,
    temperature: opts.temperature,
    ...(system ? { system } : {}),
    messages: turns,
  }).withResponse()
  const text = r.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('')
  const tokensIn = (r.usage.input_tokens || 0) + (r.usage.cache_creation_input_tokens || 0) + (r.usage.cache_read_input_tokens || 0)
  const rate = parseRateLimitHeaders('anthropic', response.headers)
  return { output: text, tokensIn, tokensOut: r.usage.output_tokens || 0, rate }
}

async function callOpenAI(opts: { apiKey: string; baseUrl: string | null; model: string; messages: ChatMessage[]; maxOutputTokens: number; temperature: number; timeoutMs: number }): Promise<{ output: string; tokensIn: number; tokensOut: number; rate: RateSnapshot }> {
  const base = (opts.baseUrl || 'https://api.openai.com').replace(/\/+$/, '')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs)
  try {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        max_tokens: opts.maxOutputTokens,
        temperature: opts.temperature,
      }),
    })
    const rate = parseRateLimitHeaders('openai', r.headers)
    if (!r.ok) {
      const text = (await r.text().catch(() => '')).slice(0, 500)
      throw new Error(`OpenAI HTTP ${r.status}: ${text || r.statusText}`)
    }
    const data = await r.json() as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const output = data.choices?.[0]?.message?.content || ''
    return { output, tokensIn: data.usage?.prompt_tokens || 0, tokensOut: data.usage?.completion_tokens || 0, rate }
  } finally {
    clearTimeout(timer)
  }
}

export async function callUserLlm(opts: CallUserLlmOptions): Promise<CallUserLlmResult> {
  const picked = pickProvider(opts.userId, opts.preferProvider)
  if (!picked) {
    return { ok: false, error: 'No LLM provider configured. Add a key in Settings or contact your admin.', reason: 'no_provider' }
  }
  const { provider, key } = picked
  const model = opts.model || DEFAULT_MODEL[provider]
  const maxOutputTokens = opts.maxOutputTokens ?? 800
  const temperature = opts.temperature ?? 0.3
  const timeoutMs = opts.timeoutMs ?? 30_000

  // Pre-call budget check (we record post-call regardless, so the user sees attempted spend).
  const budget = checkUserBudget(opts.userId, key.usingOwnKey)
  if (!budget.allowed) {
    return { ok: false, error: budget.reason || 'Budget exceeded', reason: 'budget' }
  }

  try {
    let output = ''
    let tokensIn = 0
    let tokensOut = 0
    let rate: RateSnapshot = EMPTY_SNAPSHOT

    if (provider === 'anthropic') {
      const r = await callAnthropic({ apiKey: key.apiKey, model, messages: opts.messages, maxOutputTokens, temperature })
      output = r.output; tokensIn = r.tokensIn; tokensOut = r.tokensOut; rate = r.rate
    } else if (provider === 'openai') {
      const r = await callOpenAI({ apiKey: key.apiKey, baseUrl: key.baseUrl, model, messages: opts.messages, maxOutputTokens, temperature, timeoutMs })
      output = r.output; tokensIn = r.tokensIn; tokensOut = r.tokensOut; rate = r.rate
    } else {
      // ollama
      const r = await ollamaChat({
        baseUrl: key.baseUrl || 'https://ollama.com',
        apiKey: key.apiKey,
        model,
        messages: opts.messages,
        maxOutputTokens,
        temperature,
        timeoutMs,
      })
      if (!r.ok) throw new Error(r.error || 'Ollama call failed')
      output = r.output || ''
      tokensIn = r.tokens_in || 0
      tokensOut = r.tokens_out || 0
      if (r.response_headers) rate = parseRateLimitHeaders('ollama', r.response_headers)
    }

    recordRateSnapshot(opts.userId, provider, rate, key.usingOwnKey)

    const cost = priceCents(model, tokensIn, tokensOut)
    recordUserLlmUsage({
      userId: opts.userId, provider, model, feature: opts.feature,
      tokensIn, tokensOut, costCents: cost, usedOwnKey: key.usingOwnKey,
    })

    return { ok: true, output, provider, model, tokens_in: tokensIn, tokens_out: tokensOut, cost_cents: cost, used_own_key: key.usingOwnKey }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    recordUserLlmUsage({
      userId: opts.userId, provider, model, feature: opts.feature,
      tokensIn: 0, tokensOut: 0, costCents: 0, usedOwnKey: key.usingOwnKey, error: msg,
    })
    return { ok: false, error: msg, reason: 'provider_error' }
  }
}
