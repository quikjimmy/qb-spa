import { useState } from 'react'
import type { Agent, LlmId } from '../types/agent'
import { LLM_OPTIONS, AVAILABLE_MCP_SERVERS } from '../types/agent'
import { saveAgent, getAgent } from '../utils/agentStorage'
import './AgentBuilder.css'

interface Props {
  agentId?: string
  onSave: (id: string) => void
  onCancel: () => void
}

export default function AgentBuilder({ agentId, onSave, onCancel }: Props) {
  const existing = agentId ? getAgent(agentId) : undefined

  const [name, setName] = useState(existing?.name ?? '')
  const [purpose, setPurpose] = useState(existing?.purpose ?? '')
  const [systemPrompt, setSystemPrompt] = useState(existing?.systemPrompt ?? '')
  const [llm, setLlm] = useState<LlmId>(existing?.llm ?? 'llama3')
  const [mcpServers, setMcpServers] = useState<string[]>(existing?.mcpServers ?? [])
  const [department, setDepartment] = useState(existing?.department ?? '')
  const [error, setError] = useState('')

  function toggleMcp(id: string) {
    setMcpServers((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]
    )
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (!name.trim()) { setError('Name is required.'); return }
    if (!purpose.trim()) { setError('Purpose is required (one sentence).'); return }
    if (purpose.trim().length > 200) { setError('Purpose should be one concise sentence (under 200 chars).'); return }
    if (!systemPrompt.trim()) { setError('System prompt is required.'); return }

    const now = new Date().toISOString()
    const agent: Agent = {
      id: existing?.id ?? crypto.randomUUID(),
      name: name.trim(),
      purpose: purpose.trim(),
      systemPrompt: systemPrompt.trim(),
      llm,
      status: existing?.status ?? 'draft',
      mcpServers,
      budget: existing?.budget ?? {
        monthlyTokenLimit: 50000,
        tokensUsed: 0,
        tier: 'free',
      },
      createdBy: existing?.createdBy ?? 'current-user',
      department: department.trim() || undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      needsAttention: false,
    }

    saveAgent(agent)
    onSave(agent.id)
  }

  return (
    <div className="agent-builder">
      <h2>{existing ? 'Edit Agent' : 'Create Agent'}</h2>

      <form onSubmit={handleSubmit}>
        <label>
          Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. PR Review Bot"
          />
        </label>

        <label>
          Purpose
          <span className="label-hint">One sentence — what does this agent do?</span>
          <input
            type="text"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="e.g. Reviews pull requests for code quality and security issues"
            maxLength={200}
          />
          <span className="char-count">{purpose.length}/200</span>
        </label>

        <label>
          System Prompt
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={6}
            placeholder="Instructions that define how this agent behaves..."
          />
        </label>

        <label>
          LLM
          <select value={llm} onChange={(e) => setLlm(e.target.value as LlmId)}>
            {LLM_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.name} ({opt.provider})
              </option>
            ))}
          </select>
        </label>

        <fieldset className="mcp-fieldset">
          <legend>Authorized MCP Servers</legend>
          <p className="fieldset-hint">
            Connect to trained protocols so this agent doesn't start from scratch.
          </p>
          {AVAILABLE_MCP_SERVERS.map((mcp) => (
            <label key={mcp.id} className="mcp-option">
              <input
                type="checkbox"
                checked={mcpServers.includes(mcp.id)}
                onChange={() => toggleMcp(mcp.id)}
              />
              <div>
                <strong>{mcp.name}</strong>
                <span className="mcp-desc">{mcp.description}</span>
              </div>
            </label>
          ))}
        </fieldset>

        <label>
          Department
          <span className="label-hint">Optional — which team will this serve?</span>
          <input
            type="text"
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            placeholder="e.g. Engineering, Marketing"
          />
        </label>

        {error && <p className="builder-error">{error}</p>}

        <div className="builder-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit">{existing ? 'Save Changes' : 'Create Agent'}</button>
        </div>
      </form>
    </div>
  )
}
