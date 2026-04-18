import type { Agent, AgentRun, AgentLearning } from '../types/agent'

const AGENTS_KEY = 'qb-agents'
const RUNS_KEY = 'qb-agent-runs'
const LEARNINGS_KEY = 'qb-agent-learnings'

function read<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    return JSON.parse(raw) as T[]
  } catch {
    return []
  }
}

function write<T>(key: string, items: T[]): void {
  localStorage.setItem(key, JSON.stringify(items))
}

// --- Agents ---

export function getAgents(): Agent[] {
  return read<Agent>(AGENTS_KEY)
}

export function getAgent(id: string): Agent | undefined {
  return getAgents().find((a) => a.id === id)
}

export function saveAgent(agent: Agent): void {
  const agents = getAgents()
  const idx = agents.findIndex((a) => a.id === agent.id)
  if (idx >= 0) {
    agents[idx] = agent
  } else {
    agents.push(agent)
  }
  write(AGENTS_KEY, agents)
}

export function deleteAgent(id: string): void {
  write(AGENTS_KEY, getAgents().filter((a) => a.id !== id))
  write(RUNS_KEY, getRuns().filter((r) => r.agentId !== id))
  write(LEARNINGS_KEY, getLearnings().filter((l) => l.agentId !== id))
}

// --- Runs ---

export function getRuns(agentId?: string): AgentRun[] {
  const runs = read<AgentRun>(RUNS_KEY)
  if (agentId) return runs.filter((r) => r.agentId === agentId)
  return runs
}

export function saveRun(run: AgentRun): void {
  const runs = read<AgentRun>(RUNS_KEY)
  const idx = runs.findIndex((r) => r.id === run.id)
  if (idx >= 0) {
    runs[idx] = run
  } else {
    runs.push(run)
  }
  write(RUNS_KEY, runs)
}

// --- Learnings ---

export function getLearnings(agentId?: string): AgentLearning[] {
  const learnings = read<AgentLearning>(LEARNINGS_KEY)
  if (agentId) return learnings.filter((l) => l.agentId === agentId)
  return learnings
}

export function saveLearning(learning: AgentLearning): void {
  const learnings = read<AgentLearning>(LEARNINGS_KEY)
  const idx = learnings.findIndex((l) => l.id === learning.id)
  if (idx >= 0) {
    learnings[idx] = learning
  } else {
    learnings.push(learning)
  }
  write(LEARNINGS_KEY, learnings)
}
