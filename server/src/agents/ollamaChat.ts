// Thin wrapper over Ollama's /api/chat endpoint.
// Works against cloud (https://ollama.com) and self-hosted (http://host:11434).

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface OllamaChatOptions {
  baseUrl: string
  apiKey: string
  model: string
  messages: OllamaMessage[]
  maxOutputTokens?: number     // soft cap per run — prevents runaway output
  temperature?: number
  timeoutMs?: number
}

export interface OllamaChatResult {
  ok: boolean
  output?: string
  tokens_in?: number
  tokens_out?: number
  duration_ms?: number
  error?: string
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
        options: {
          temperature: opts.temperature ?? 0.2,
          num_predict: opts.maxOutputTokens ?? 500,
        },
      }),
    })
    clearTimeout(timer)

    if (!r.ok) {
      const text = (await r.text().catch(() => '')).slice(0, 800)
      return { ok: false, error: `Ollama HTTP ${r.status}: ${text || r.statusText}` }
    }

    const data = await r.json().catch(() => ({})) as {
      message?: { role: string; content: string }
      prompt_eval_count?: number
      eval_count?: number
    }
    const content = data.message?.content || ''
    return {
      ok: true,
      output: content,
      tokens_in: data.prompt_eval_count ?? 0,
      tokens_out: data.eval_count ?? 0,
      duration_ms: Date.now() - started,
    }
  } catch (err) {
    clearTimeout(timer)
    const msg = err instanceof Error ? err.message : String(err)
    const timeout = msg.includes('abort') ? 'Request timed out' : msg
    return { ok: false, error: timeout }
  }
}
