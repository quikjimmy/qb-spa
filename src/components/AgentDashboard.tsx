import { useState, useMemo } from 'react'
import type { Agent, AgentStatus } from '../types/agent'
import { AVAILABLE_MCP_SERVERS, LLM_OPTIONS } from '../types/agent'
import { getAgents } from '../utils/agentStorage'
import './AgentDashboard.css'

interface Props {
  onCreateNew: () => void
  onSelectAgent: (id: string) => void
}

const STATUS_LABELS: Record<AgentStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  approved: 'Approved',
  active: 'Active',
  paused: 'Paused',
  terminated: 'Terminated',
}

export default function AgentDashboard({ onCreateNew, onSelectAgent }: Props) {
  const [agents] = useState<Agent[]>(() => getAgents())

  const needsAttention = agents.filter((a) => a.needsAttention)
  const active = agents.filter((a) => a.status === 'active')
  const pending = agents.filter((a) => a.status === 'submitted')

  return (
    <div className="agent-dashboard">
      <div className="agent-dashboard-header">
        <h2>Agents</h2>
        <button className="create-btn" onClick={onCreateNew}>+ New Agent</button>
      </div>

      <div className="agent-stats">
        <div className="stat">
          <span className="stat-value">{agents.length}</span>
          <span className="stat-label">Total</span>
        </div>
        <div className="stat">
          <span className="stat-value">{active.length}</span>
          <span className="stat-label">Active</span>
        </div>
        <div className="stat">
          <span className="stat-value">{pending.length}</span>
          <span className="stat-label">Pending Review</span>
        </div>
        <div className="stat">
          <span className="stat-value">{needsAttention.length}</span>
          <span className="stat-label">Needs Attention</span>
        </div>
      </div>

      {agents.length === 0 ? (
        <p className="agent-empty">No agents yet. Create one to get started.</p>
      ) : (
        <ul className="agent-list">
          {agents.map((agent) => (
            <li
              key={agent.id}
              className="agent-card"
              onClick={() => onSelectAgent(agent.id)}
            >
              <div className="agent-card-top">
                <div className="agent-card-identity">
                  <h3>{agent.name}</h3>
                  <p className="agent-purpose">{agent.purpose}</p>
                </div>
                <span className={`agent-status status-${agent.status}`}>
                  {STATUS_LABELS[agent.status]}
                </span>
              </div>

              <div className="agent-card-meta">
                <span className="agent-llm">
                  {LLM_OPTIONS.find((l) => l.id === agent.llm)?.name ?? agent.llm}
                </span>
                <span className="agent-tier">{agent.budget.tier}</span>
                {agent.mcpServers.length > 0 && (
                  <span className="agent-mcps">
                    {agent.mcpServers
                      .map((id) => AVAILABLE_MCP_SERVERS.find((m) => m.id === id)?.name)
                      .filter(Boolean)
                      .join(', ')}
                  </span>
                )}
              </div>

              <div className="agent-card-bottom">
                <Heartbeat agent={agent} />
                <BudgetBar budget={agent.budget} />
                {agent.needsAttention && (
                  <span className="attention-flag">{agent.attentionReason ?? 'Needs attention'}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Heartbeat({ agent }: { agent: Agent }) {
  const [now] = useState(() => Date.now())

  const { ago, stale } = useMemo(() => {
    if (!agent.lastHeartbeat) return { ago: '', stale: false }
    const ms = now - new Date(agent.lastHeartbeat).getTime()
    return { ago: timeSince(agent.lastHeartbeat), stale: ms > 5 * 60 * 1000 }
  }, [agent.lastHeartbeat, now])

  if (!agent.lastHeartbeat) {
    return <span className="heartbeat heartbeat-none">No heartbeat</span>
  }

  return (
    <span className={`heartbeat ${stale ? 'heartbeat-stale' : 'heartbeat-ok'}`}>
      Last seen {ago}
    </span>
  )
}

function BudgetBar({ budget }: { budget: Agent['budget'] }) {
  const pct = budget.monthlyTokenLimit > 0
    ? Math.min(100, (budget.tokensUsed / budget.monthlyTokenLimit) * 100)
    : 0

  return (
    <div className="budget-bar-wrap">
      <div className="budget-bar">
        <div
          className={`budget-fill ${pct > 90 ? 'budget-danger' : pct > 70 ? 'budget-warn' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="budget-text">
        {Math.round(pct)}% of {(budget.monthlyTokenLimit / 1000).toFixed(0)}k tokens
      </span>
    </div>
  )
}

function timeSince(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
