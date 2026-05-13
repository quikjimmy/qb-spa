// Thin wrapper over Ollama's /api/chat endpoint.
// Works against cloud (https://ollama.com) and self-hosted (http://host:11434).

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  // Set on assistant turns that asked to use tools, echoed back so the model can
  // see what it just decided. Set on tool turns to identify which call this
  // result is for (Ollama uses positional matching; the name is the contract).
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>
  // Set on `role: 'tool'` turns. Identifies which tool produced this output.
  name?: string
}

// Tool definition in Ollama's expected shape (mirrors OpenAI's function-tool
// schema; Ollama Cloud accepts the same JSON Schema).
export interface OllamaToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface OllamaChatOptions {
  baseUrl: string
  apiKey: string
  model: string
  messages: OllamaMessage[]
  maxOutputTokens?: number     // soft cap per run — prevents runaway output
  temperature?: number
  timeoutMs?: number
  // When set, the model can invoke these tools. Many self-hosted models don't
  // support tools and will silently ignore them; that's fine — they just answer
  // without tool calls.
  tools?: OllamaToolDef[]
}

export interface OllamaChatResult {
  ok: boolean
  output?: string
  tokens_in?: number
  tokens_out?: number
  duration_ms?: number
  error?: string
  // Raw response headers from Ollama — used by callUserLlm to capture rate-limit info.
  // Optional so existing callers don't need to handle it.
  response_headers?: Record<string, string>
  // Populated when the model decided to invoke tools. The caller is responsible
  // for executing them and feeding results back as `role: 'tool'` messages.
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>
}

export async function ollamaChat(opts: OllamaChatOptions): Promise<OllamaChatResult> {
  const started = Date.now()
  const base = opts.baseUrl.replace(/\/+$/, '')
  const url = `${base}/api/chat`

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000)

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: false,
        // Only include `tools` when there are any — passing an empty array
        // makes some Ollama models reject the call. Omitting it keeps the
        // request shape identical to before for existing callers.
        ...(opts.tools && opts.tools.length ? { tools: opts.tools } : {}),
        options: {
          temperature: opts.temperature ?? 0.2,
          num_predict: opts.maxOutputTokens ?? 500,
        },
      }),
    })
    clearTimeout(timer)

    const responseHeaders: Record<string, string> = {}
    r.headers.forEach((v, k) => { responseHeaders[k] = v })

    if (!r.ok) {
      const text = (await r.text().catch(() => '')).slice(0, 800)
      return { ok: false, error: `Ollama HTTP ${r.status}: ${text || r.statusText}`, response_headers: responseHeaders }
    }

    const data = await r.json().catch(() => ({})) as {
      message?: {
        role: string
        content: string
        tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>
      }
      prompt_eval_count?: number
      eval_count?: number
    }
    const content = data.message?.content || ''
    const toolCalls = data.message?.tool_calls
    return {
      ok: true,
      output: content,
      tokens_in: data.prompt_eval_count ?? 0,
      tokens_out: data.eval_count ?? 0,
      duration_ms: Date.now() - started,
      response_headers: responseHeaders,
      ...(toolCalls && toolCalls.length ? { tool_calls: toolCalls } : {}),
    }
  } catch (err) {
    clearTimeout(timer)
    const msg = err instanceof Error ? err.message : String(err)
    const timeout = msg.includes('abort') ? 'Request timed out' : msg
    return { ok: false, error: timeout }
  }
}
