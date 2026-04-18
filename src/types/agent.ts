export type AgentStatus = 'draft' | 'submitted' | 'approved' | 'active' | 'paused' | 'terminated'

export type AgentTier = 'free' | 'company'

export const LLM_OPTIONS = [
  { id: 'llama3', name: 'Llama 3', provider: 'Ollama' },
  { id: 'mistral', name: 'Mistral', provider: 'Ollama' },
  { id: 'codellama', name: 'Code Llama', provider: 'Ollama' },
  { id: 'gemma2', name: 'Gemma 2', provider: 'Ollama' },
] as const

export type LlmId = typeof LLM_OPTIONS[number]['id']

export interface McpServer {
  id: string
  name: string
  description: string
  endpoint: string
}

export const AVAILABLE_MCP_SERVERS: McpServer[] = [
  { id: 'mcp-github', name: 'GitHub', description: 'Repository management, PRs, issues', endpoint: '/mcp/github' },
  { id: 'mcp-slack', name: 'Slack', description: 'Channel messaging, notifications', endpoint: '/mcp/slack' },
  { id: 'mcp-db', name: 'Database', description: 'Query and manage data stores', endpoint: '/mcp/database' },
  { id: 'mcp-docs', name: 'Documentation', description: 'Search and retrieve internal docs', endpoint: '/mcp/docs' },
  { id: 'mcp-calendar', name: 'Calendar', description: 'Schedule management and availability', endpoint: '/mcp/calendar' },
]

export interface AgentBudget {
  monthlyTokenLimit: number
  tokensUsed: number
  tier: AgentTier
}

export interface Agent {
  id: string
  name: string
  purpose: string
  systemPrompt: string
  llm: LlmId
  status: AgentStatus
  mcpServers: string[]
  budget: AgentBudget
  createdBy: string
  department?: string
  submissionNote?: string
  rejectionReason?: string
  createdAt: string
  updatedAt: string
  lastHeartbeat?: string
  needsAttention: boolean
  attentionReason?: string
}

export type StepType = 'thought' | 'action' | 'observation' | 'decision' | 'mcp_call' | 'learning'

export interface AgentStep {
  id: string
  timestamp: string
  type: StepType
  content: string
  mcpServer?: string
  durationMs?: number
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'paused'

export interface AgentRun {
  id: string
  agentId: string
  startedAt: string
  completedAt?: string
  status: RunStatus
  steps: AgentStep[]
  outcome?: string
  tokensUsed: number
}

export type LearningStatus = 'proposed' | 'ratified' | 'rejected'

export interface AgentLearning {
  id: string
  agentId: string
  runId: string
  content: string
  proposedAt: string
  status: LearningStatus
  ratifiedBy?: string
  ratifiedAt?: string
}
