// Fixed list of LLMs user-created agents can target.
// `ollamaModel` is the string we actually send to Ollama's /api/chat
// (Ollama identifies models like "llama3.1:8b", not "ollama-llama3.1-8b").
// Expand as more Ollama cloud models are approved for use.

export interface LlmOption {
  id: string
  label: string
  provider: 'ollama-cloud'
  ollamaModel: string
  availableTiers: Array<'ollama-free' | 'company'>
}

export const LLM_OPTIONS: LlmOption[] = [
  { id: 'ollama-llama3.1-8b',  label: 'Ollama — Llama 3.1 8B',  provider: 'ollama-cloud', ollamaModel: 'llama3.1:8b',  availableTiers: ['ollama-free', 'company'] },
  { id: 'ollama-llama3.1-70b', label: 'Ollama — Llama 3.1 70B', provider: 'ollama-cloud', ollamaModel: 'llama3.1:70b', availableTiers: ['company'] },
  { id: 'ollama-qwen2.5-7b',   label: 'Ollama — Qwen 2.5 7B',   provider: 'ollama-cloud', ollamaModel: 'qwen2.5:7b',   availableTiers: ['ollama-free', 'company'] },
  { id: 'ollama-mistral-7b',   label: 'Ollama — Mistral 7B',    provider: 'ollama-cloud', ollamaModel: 'mistral:7b',   availableTiers: ['ollama-free', 'company'] },
]

// Accept either:
//  - a known seeded id ('ollama-llama3.1-8b' → maps to 'llama3.1:8b'), or
//  - a raw Ollama model name ('llama3.1:8b', 'granite3.3:2b-q4_K_M', …).
// Raw names are what Ollama's /api/tags actually returns. Users pick
// from their real model list now; the seeded ids remain for back-compat
// with agents created before the dynamic picker.
export function isValidLlm(id: string): boolean {
  if (!id || typeof id !== 'string') return false
  if (LLM_OPTIONS.some(o => o.id === id)) return true
  // Raw Ollama model name — lenient shape check, server will surface a
  // specific "model not found" error at run time if it's wrong.
  return /^[a-z0-9][a-z0-9._:/\-]{0,120}$/i.test(id)
}

export function llmAvailableForTier(id: string, tier: 'ollama-free' | 'company'): boolean {
  const opt = LLM_OPTIONS.find(o => o.id === id)
  if (opt) return opt.availableTiers.includes(tier)
  // Unmapped raw model — allow on ollama-free tier (user's own key/quota);
  // company tier should go through admin approval which can re-scope.
  return true
}

export function ollamaModelFor(id: string): string | null {
  const opt = LLM_OPTIONS.find(o => o.id === id)
  if (opt) return opt.ollamaModel
  // Unmapped → assume the id is already a real Ollama model name.
  return id && typeof id === 'string' ? id : null
}
