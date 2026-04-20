// Fixed list of LLMs user-created agents can target.
// Expand as more Ollama cloud models are approved for use.
// `tier` indicates which tier the option is available under.

export interface LlmOption {
  id: string
  label: string
  provider: 'ollama-cloud'
  availableTiers: Array<'ollama-free' | 'company'>
}

export const LLM_OPTIONS: LlmOption[] = [
  { id: 'ollama-llama3.1-8b',  label: 'Ollama — Llama 3.1 8B',  provider: 'ollama-cloud', availableTiers: ['ollama-free', 'company'] },
  { id: 'ollama-llama3.1-70b', label: 'Ollama — Llama 3.1 70B', provider: 'ollama-cloud', availableTiers: ['company'] },
  { id: 'ollama-qwen2.5-7b',   label: 'Ollama — Qwen 2.5 7B',   provider: 'ollama-cloud', availableTiers: ['ollama-free', 'company'] },
  { id: 'ollama-mistral-7b',   label: 'Ollama — Mistral 7B',    provider: 'ollama-cloud', availableTiers: ['ollama-free', 'company'] },
]

export function isValidLlm(id: string): boolean {
  return LLM_OPTIONS.some(o => o.id === id)
}

export function llmAvailableForTier(id: string, tier: 'ollama-free' | 'company'): boolean {
  const opt = LLM_OPTIONS.find(o => o.id === id)
  return !!opt && opt.availableTiers.includes(tier)
}
