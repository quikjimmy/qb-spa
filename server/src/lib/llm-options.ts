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

export function isValidLlm(id: string): boolean {
  return LLM_OPTIONS.some(o => o.id === id)
}

export function llmAvailableForTier(id: string, tier: 'ollama-free' | 'company'): boolean {
  const opt = LLM_OPTIONS.find(o => o.id === id)
  return !!opt && opt.availableTiers.includes(tier)
}

export function ollamaModelFor(id: string): string | null {
  const opt = LLM_OPTIONS.find(o => o.id === id)
  return opt ? opt.ollamaModel : null
}
