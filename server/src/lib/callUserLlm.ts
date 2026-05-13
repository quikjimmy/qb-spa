import Anthropic from '@anthropic-ai/sdk'
import { ollamaChat, type OllamaMessage, type OllamaToolDef } from '../agents/ollamaChat'
import { getDefaultKeyFor, type ProviderId } from './userProviderKeys'
import { checkUserBudget, recordUserLlmUsage } from './userBudget'
import { parseRateLimitHeaders, recordRateSnapshot, EMPTY_SNAPSHOT, type RateSnapshot } from './providerRateLimits'
import type { McpToolDef } from './qbMcp'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

// Caller-supplied executor for a tool the model decided to invoke.
// Must return a string — providers' tool-result slots all take string content.
// Throwing here is fine; we catch and feed the error back to the model so it
// can decide to retry, refine arguments, or give up gracefully.
export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>

// One tool round-trip, persisted on the assistant message for transparency.
export interface ToolCallRecord {
  name: string
  args: Record<string, unknown>
  result: string
  error?: boolean
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
  // When `tools` is non-empty and `executeTool` is provided, the call runs as
  // an agentic loop: model asks for a tool, we run it, feed the result back,
  // repeat until the model emits a final text response (or maxToolRounds).
  // Token usage and cost are summed across all rounds; only one usage row is
  // written at the end.
  tools?: McpToolDef[]
  executeTool?: ToolExecutor
  maxToolRounds?: number                // default 5
}

export type CallUserLlmResult =
  | {
      ok: true
      output: string
      provider: ProviderId
      model: string
      tokens_in: number
      tokens_out: number
      cost_cents: number
      used_own_key: boolean
      tool_calls: ToolCallRecord[]      // empty array when no tools fired
    }
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

// Common output across providers — keeps callUserLlm provider-agnostic.
interface ProviderRunResult {
  output: string
  tokensIn: number
  tokensOut: number
  rate: RateSnapshot
  toolCalls: ToolCallRecord[]
}

// Execute one tool with an executor, packaging errors so the model can read them.
async function runOneTool(
  executor: ToolExecutor,
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: string; error?: boolean }> {
  try {
    const r = await executor(name, args)
    return { result: r }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // Feed the error back as a tool result rather than aborting — the model
    // can often recover (e.g. retry with a different field name).
    return { result: `Tool ${name} failed: ${msg}`, error: true }
  }
}

async function callAnthropic(opts: {
  apiKey: string
  model: string
  messages: ChatMessage[]
  maxOutputTokens: number
  temperature: number
  tools?: McpToolDef[]
  executeTool?: ToolExecutor
  maxToolRounds: number
}): Promise<ProviderRunResult> {
  const client = new Anthropic({ apiKey: opts.apiKey })
  const system = opts.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n') || undefined

  // Build the running conversation in Anthropic's message-param shape. We start
  // from the caller's plain text turns; tool_use / tool_result blocks get
  // appended as the loop runs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const turns: any[] = opts.messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

  // Anthropic's SDK types require input_schema.type === 'object'. MCP tools
  // always satisfy this at runtime (the spec mandates an object schema), but
  // the inputSchema is typed as Record<string, unknown> so we cast through
  // the SDK's expected shape.
  const anthTools: Anthropic.Tool[] | undefined = opts.tools && opts.tools.length
    ? opts.tools.map(t => ({
        name: t.name,
        description: t.description,
        // Anthropic calls it `input_schema` (snake) vs OpenAI's `parameters`.
        // Same JSON Schema shape underneath.
        input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
      }))
    : undefined

  let tokensIn = 0
  let tokensOut = 0
  let rate: RateSnapshot = EMPTY_SNAPSHOT
  let output = ''
  const toolCalls: ToolCallRecord[] = []
  const canTool = !!(anthTools && opts.executeTool)
  const maxRounds = canTool ? opts.maxToolRounds : 0

  for (let round = 0; round <= maxRounds; round++) {
    const { data: r, response } = await client.messages.create({
      model: opts.model,
      max_tokens: opts.maxOutputTokens,
      temperature: opts.temperature,
      ...(system ? { system } : {}),
      messages: turns,
      ...(anthTools ? { tools: anthTools } : {}),
    }).withResponse()

    tokensIn += (r.usage.input_tokens || 0)
      + (r.usage.cache_creation_input_tokens || 0)
      + (r.usage.cache_read_input_tokens || 0)
    tokensOut += r.usage.output_tokens || 0
    rate = parseRateLimitHeaders('anthropic', response.headers)

    // Anthropic returns mixed content blocks. Grab any text we got for this
    // round; we keep the LAST round's text as the final assistant message.
    const turnText = r.content
      .filter(b => b.type === 'text')
      .map(b => (b as { text: string }).text)
      .join('')
    output = turnText

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolUseBlocks = r.content.filter(b => b.type === 'tool_use') as any[]
    if (
      r.stop_reason !== 'tool_use'
      || toolUseBlocks.length === 0
      || !opts.executeTool
      || round === maxRounds
    ) {
      break
    }

    // Echo the assistant's full content (text + tool_use blocks) before
    // appending tool_result blocks. The two together form one logical turn.
    turns.push({ role: 'assistant', content: r.content })

    const results: Array<{
      type: 'tool_result'
      tool_use_id: string
      content: string
      is_error?: boolean
    }> = []
    for (const block of toolUseBlocks) {
      const args = (block.input || {}) as Record<string, unknown>
      const { result, error } = await runOneTool(opts.executeTool, block.name, args)
      toolCalls.push({ name: block.name, args, result, ...(error ? { error: true } : {}) })
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result,
        ...(error ? { is_error: true } : {}),
      })
    }
    turns.push({ role: 'user', content: results })
  }

  return { output, tokensIn, tokensOut, rate, toolCalls }
}

// OpenAI message shape — kept loose because the field set varies across roles
// (assistant turns carry tool_calls; tool turns carry tool_call_id; user/system
// just carry content). Stricter typing here adds friction without catching bugs.
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
  name?: string
}

async function callOpenAI(opts: {
  apiKey: string
  baseUrl: string | null
  model: string
  messages: ChatMessage[]
  maxOutputTokens: number
  temperature: number
  timeoutMs: number
  tools?: McpToolDef[]
  executeTool?: ToolExecutor
  maxToolRounds: number
}): Promise<ProviderRunResult> {
  const base = (opts.baseUrl || 'https://api.openai.com').replace(/\/+$/, '')
  const convo: OpenAIMessage[] = opts.messages.map(m => ({ role: m.role, content: m.content }))

  const oaiTools = opts.tools && opts.tools.length
    ? opts.tools.map(t => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }))
    : undefined

  let tokensIn = 0
  let tokensOut = 0
  let rate: RateSnapshot = EMPTY_SNAPSHOT
  let output = ''
  const toolCalls: ToolCallRecord[] = []
  const canTool = !!(oaiTools && opts.executeTool)
  const maxRounds = canTool ? opts.maxToolRounds : 0

  for (let round = 0; round <= maxRounds; round++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs)
    let data: {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: OpenAIMessage['tool_calls'] }; finish_reason?: string }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    try {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: opts.model,
          messages: convo,
          max_tokens: opts.maxOutputTokens,
          temperature: opts.temperature,
          ...(oaiTools ? { tools: oaiTools, tool_choice: 'auto' } : {}),
        }),
      })
      rate = parseRateLimitHeaders('openai', r.headers)
      if (!r.ok) {
        const text = (await r.text().catch(() => '')).slice(0, 500)
        throw new Error(`OpenAI HTTP ${r.status}: ${text || r.statusText}`)
      }
      data = await r.json() as typeof data
    } finally {
      clearTimeout(timer)
    }

    const choice = data.choices?.[0]
    const msg = choice?.message
    tokensIn += data.usage?.prompt_tokens || 0
    tokensOut += data.usage?.completion_tokens || 0

    if (
      msg?.tool_calls
      && msg.tool_calls.length
      && opts.executeTool
      && round < maxRounds
    ) {
      // Echo the assistant's tool-call decision back into the conversation, then
      // append one `role: 'tool'` message per call with its result.
      convo.push({
        role: 'assistant',
        content: msg.content ?? null,
        tool_calls: msg.tool_calls,
      })
      for (const tc of msg.tool_calls) {
        let parsed: Record<string, unknown> = {}
        try { parsed = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown> } catch { /* surface to model below */ }
        const { result, error } = await runOneTool(opts.executeTool, tc.function.name, parsed)
        toolCalls.push({ name: tc.function.name, args: parsed, result, ...(error ? { error: true } : {}) })
        convo.push({ role: 'tool', tool_call_id: tc.id, content: result })
      }
      continue
    }

    output = msg?.content || ''
    break
  }

  return { output, tokensIn, tokensOut, rate, toolCalls }
}

async function callOllama(opts: {
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  maxOutputTokens: number
  temperature: number
  timeoutMs: number
  tools?: McpToolDef[]
  executeTool?: ToolExecutor
  maxToolRounds: number
}): Promise<ProviderRunResult> {
  const convo: OllamaMessage[] = opts.messages.map(m => ({ role: m.role, content: m.content }))

  const ollamaTools: OllamaToolDef[] | undefined = opts.tools && opts.tools.length
    ? opts.tools.map(t => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }))
    : undefined

  let tokensIn = 0
  let tokensOut = 0
  let rate: RateSnapshot = EMPTY_SNAPSHOT
  let output = ''
  const toolCalls: ToolCallRecord[] = []
  const canTool = !!(ollamaTools && opts.executeTool)
  const maxRounds = canTool ? opts.maxToolRounds : 0

  for (let round = 0; round <= maxRounds; round++) {
    const r = await ollamaChat({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      messages: convo,
      maxOutputTokens: opts.maxOutputTokens,
      temperature: opts.temperature,
      timeoutMs: opts.timeoutMs,
      ...(ollamaTools ? { tools: ollamaTools } : {}),
    })
    if (!r.ok) throw new Error(r.error || 'Ollama call failed')
    if (r.response_headers) rate = parseRateLimitHeaders('ollama', r.response_headers)
    tokensIn += r.tokens_in || 0
    tokensOut += r.tokens_out || 0

    if (r.tool_calls && r.tool_calls.length && opts.executeTool && round < maxRounds) {
      // Ollama echoes assistant message with tool_calls. We append the same
      // shape, then one `role: 'tool'` per call carrying that tool's result.
      convo.push({
        role: 'assistant',
        content: r.output || '',
        tool_calls: r.tool_calls,
      })
      for (const tc of r.tool_calls) {
        const args = (tc.function.arguments || {}) as Record<string, unknown>
        const { result, error } = await runOneTool(opts.executeTool, tc.function.name, args)
        toolCalls.push({ name: tc.function.name, args, result, ...(error ? { error: true } : {}) })
        convo.push({ role: 'tool', name: tc.function.name, content: result })
      }
      continue
    }

    output = r.output || ''
    break
  }

  return { output, tokensIn, tokensOut, rate, toolCalls }
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
  // Cap on tool round-trips per request. 5 is enough for "look up the project,
  // read its notes, summarize" style flows without runaway loops.
  const maxToolRounds = opts.maxToolRounds ?? 5

  // Pre-call budget check (we record post-call regardless, so the user sees attempted spend).
  const budget = checkUserBudget(opts.userId, key.usingOwnKey)
  if (!budget.allowed) {
    return { ok: false, error: budget.reason || 'Budget exceeded', reason: 'budget' }
  }

  try {
    let run: ProviderRunResult
    if (provider === 'anthropic') {
      run = await callAnthropic({
        apiKey: key.apiKey,
        model,
        messages: opts.messages,
        maxOutputTokens,
        temperature,
        tools: opts.tools,
        executeTool: opts.executeTool,
        maxToolRounds,
      })
    } else if (provider === 'openai') {
      run = await callOpenAI({
        apiKey: key.apiKey,
        baseUrl: key.baseUrl,
        model,
        messages: opts.messages,
        maxOutputTokens,
        temperature,
        timeoutMs,
        tools: opts.tools,
        executeTool: opts.executeTool,
        maxToolRounds,
      })
    } else {
      run = await callOllama({
        baseUrl: key.baseUrl || 'https://ollama.com',
        apiKey: key.apiKey,
        model,
        messages: opts.messages,
        maxOutputTokens,
        temperature,
        timeoutMs,
        tools: opts.tools,
        executeTool: opts.executeTool,
        maxToolRounds,
      })
    }

    recordRateSnapshot(opts.userId, provider, run.rate, key.usingOwnKey)

    const cost = priceCents(model, run.tokensIn, run.tokensOut)
    recordUserLlmUsage({
      userId: opts.userId, provider, model, feature: opts.feature,
      tokensIn: run.tokensIn, tokensOut: run.tokensOut, costCents: cost, usedOwnKey: key.usingOwnKey,
    })

    return {
      ok: true,
      output: run.output,
      provider,
      model,
      tokens_in: run.tokensIn,
      tokens_out: run.tokensOut,
      cost_cents: cost,
      used_own_key: key.usingOwnKey,
      tool_calls: run.toolCalls,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    recordUserLlmUsage({
      userId: opts.userId, provider, model, feature: opts.feature,
      tokensIn: 0, tokensOut: 0, costCents: 0, usedOwnKey: key.usingOwnKey, error: msg,
    })
    return { ok: false, error: msg, reason: 'provider_error' }
  }
}
