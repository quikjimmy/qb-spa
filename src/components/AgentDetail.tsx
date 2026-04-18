import { useState } from 'react'
import type { Agent, AgentRun, AgentLearning, AgentStatus, StepType } from '../types/agent'
import { AVAILABLE_MCP_SERVERS, LLM_OPTIONS } from '../types/agent'
import { getAgent, saveAgent, deleteAgent, getRuns, getLearnings, saveLearning } from '../utils/agentStorage'
import './AgentDetail.css'

interface Props {
  agentId: string
  onBack: () => void
  onEdit: (id: string) => void
}

const STEP_ICONS: Record<StepType, string> = {
  thought: 'T',
  action: 'A',
  observation: 'O',
  decision: 'D',
  mcp_call: 'M',
  learning: 'L',
}

export default function AgentDetail({ agentId, onBack, onEdit }: Props) {
  const [agent, setAgent] = useState<Agent | undefined>(() => getAgent(agentId))
  const [runs] = useState<AgentRun[]>(() => getRuns(agentId).reverse())
  const [learnings, setLearnings] = useState<AgentLearning[]>(() => getLearnings(agentId))
  const [expandedRun, setExpandedRun] = useState<string | null>(null)
  const [submissionNote, setSubmissionNote] = useState('')

  if (!agent) {
    return (
      <div className="agent-detail">
        <button className="back-btn" onClick={onBack}>Back</button>
        <p>Agent not found.</p>
      </div>
    )
  }

  function updateStatus(status: AgentStatus, extra?: Partial<Agent>) {
    if (!agent) return
    const updated = { ...agent, status, updatedAt: new Date().toISOString(), ...extra }
    saveAgent(updated)
    setAgent(updated)
  }

  function handleSubmitForReview() {
    if (!submissionNote.trim()) return
    updateStatus('submitted', { submissionNote: submissionNote.trim() })
    setSubmissionNote('')
  }

  function handleApprove() {
    updateStatus('approved', {
      budget: { ...agent!.budget, tier: 'company', monthlyTokenLimit: 500000 },
    })
  }

  function handleReject() {
    const reason = window.prompt('Reason for rejection:')
    if (reason) updateStatus('draft', { rejectionReason: reason })
  }

  function handleActivate() { updateStatus('active') }
  function handlePause() { updateStatus('paused') }
  function handleTerminate() {
    if (window.confirm('Terminate this agent? This cannot be undone easily.')) {
      updateStatus('terminated')
    }
  }

  function handleDelete() {
    if (window.confirm('Delete this agent and all its data?')) {
      deleteAgent(agent!.id)
      onBack()
    }
  }

  function handleRatify(learning: AgentLearning) {
    const updated = { ...learning, status: 'ratified' as const, ratifiedBy: 'current-user', ratifiedAt: new Date().toISOString() }
    saveLearning(updated)
    setLearnings(learnings.map((l) => l.id === updated.id ? updated : l))
  }

  function handleRejectLearning(learning: AgentLearning) {
    const updated = { ...learning, status: 'rejected' as const }
    saveLearning(updated)
    setLearnings(learnings.map((l) => l.id === updated.id ? updated : l))
  }

  const pendingLearnings = learnings.filter((l) => l.status === 'proposed')

  return (
    <div className="agent-detail">
      <button className="back-btn" onClick={onBack}>Back to Agents</button>

      <div className="detail-header">
        <div>
          <h2>{agent.name}</h2>
          <p className="detail-purpose">{agent.purpose}</p>
        </div>
        <span className={`agent-status status-${agent.status}`}>{agent.status}</span>
      </div>

      <div className="detail-meta">
        <span>LLM: {LLM_OPTIONS.find((l) => l.id === agent.llm)?.name}</span>
        <span>Tier: {agent.budget.tier}</span>
        {agent.department && <span>Dept: {agent.department}</span>}
        <span>Created: {new Date(agent.createdAt).toLocaleDateString()}</span>
        {agent.lastHeartbeat && <span>Last heartbeat: {new Date(agent.lastHeartbeat).toLocaleString()}</span>}
      </div>

      {agent.mcpServers.length > 0 && (
        <div className="detail-section">
          <h3>Connected MCPs</h3>
          <div className="mcp-tags">
            {agent.mcpServers.map((id) => {
              const mcp = AVAILABLE_MCP_SERVERS.find((m) => m.id === id)
              return mcp ? <span key={id} className="mcp-tag">{mcp.name}</span> : null
            })}
          </div>
        </div>
      )}

      {agent.needsAttention && (
        <div className="attention-banner">
          {agent.attentionReason ?? 'This agent needs your attention.'}
        </div>
      )}

      {agent.rejectionReason && agent.status === 'draft' && (
        <div className="rejection-banner">
          Rejected: {agent.rejectionReason}
        </div>
      )}

      {/* Lifecycle Actions */}
      <div className="detail-section">
        <h3>Actions</h3>
        <div className="lifecycle-actions">
          {agent.status === 'draft' && (
            <>
              <div className="submit-row">
                <input
                  type="text"
                  placeholder="Why should this agent be approved?"
                  value={submissionNote}
                  onChange={(e) => setSubmissionNote(e.target.value)}
                />
                <button onClick={handleSubmitForReview} disabled={!submissionNote.trim()}>
                  Submit for Review
                </button>
              </div>
              <button onClick={() => onEdit(agent.id)}>Edit</button>
              <button className="danger-btn" onClick={handleDelete}>Delete</button>
            </>
          )}
          {agent.status === 'submitted' && (
            <>
              {agent.submissionNote && <p className="submission-note">"{agent.submissionNote}"</p>}
              <button className="approve-btn" onClick={handleApprove}>Approve</button>
              <button className="danger-btn" onClick={handleReject}>Reject</button>
            </>
          )}
          {agent.status === 'approved' && (
            <button onClick={handleActivate}>Activate</button>
          )}
          {agent.status === 'active' && (
            <>
              <button onClick={handlePause}>Pause</button>
              <button className="danger-btn" onClick={handleTerminate}>Terminate</button>
            </>
          )}
          {agent.status === 'paused' && (
            <>
              <button onClick={handleActivate}>Resume</button>
              <button className="danger-btn" onClick={handleTerminate}>Terminate</button>
            </>
          )}
        </div>
      </div>

      {/* Learnings */}
      {learnings.length > 0 && (
        <div className="detail-section">
          <h3>Learnings {pendingLearnings.length > 0 && <span className="pending-count">{pendingLearnings.length} pending</span>}</h3>
          <ul className="learnings-list">
            {learnings.map((learning) => (
              <li key={learning.id} className={`learning-item learning-${learning.status}`}>
                <p>{learning.content}</p>
                <div className="learning-meta">
                  <span className={`learning-status ls-${learning.status}`}>{learning.status}</span>
                  <time>{new Date(learning.proposedAt).toLocaleString()}</time>
                  {learning.status === 'proposed' && (
                    <div className="learning-actions">
                      <button onClick={() => handleRatify(learning)}>Ratify</button>
                      <button onClick={() => handleRejectLearning(learning)}>Reject</button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Process Review / Runs */}
      <div className="detail-section">
        <h3>Process History ({runs.length} runs)</h3>
        {runs.length === 0 ? (
          <p className="no-runs">No runs yet.</p>
        ) : (
          <ul className="runs-list">
            {runs.map((run) => (
              <li key={run.id} className="run-item">
                <div
                  className="run-header"
                  onClick={() => setExpandedRun(expandedRun === run.id ? null : run.id)}
                >
                  <div className="run-summary">
                    <span className={`run-status rs-${run.status}`}>{run.status}</span>
                    <time>{new Date(run.startedAt).toLocaleString()}</time>
                    <span className="run-tokens">{run.tokensUsed.toLocaleString()} tokens</span>
                    <span className="run-steps-count">{run.steps.length} steps</span>
                  </div>
                  <span className="expand-icon">{expandedRun === run.id ? '−' : '+'}</span>
                </div>

                {run.outcome && (
                  <p className="run-outcome"><strong>Outcome:</strong> {run.outcome}</p>
                )}

                {expandedRun === run.id && (
                  <ol className="steps-timeline">
                    {run.steps.map((step) => (
                      <li key={step.id} className={`step-item step-${step.type}`}>
                        <span className="step-icon">{STEP_ICONS[step.type]}</span>
                        <div className="step-body">
                          <div className="step-head">
                            <span className="step-type">{step.type}</span>
                            {step.mcpServer && <span className="step-mcp">{step.mcpServer}</span>}
                            {step.durationMs != null && <span className="step-duration">{step.durationMs}ms</span>}
                            <time>{new Date(step.timestamp).toLocaleTimeString()}</time>
                          </div>
                          <p className="step-content">{step.content}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="detail-section">
        <h3>System Prompt</h3>
        <pre className="system-prompt">{agent.systemPrompt}</pre>
      </div>
    </div>
  )
}
