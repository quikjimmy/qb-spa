<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

// ─── User-created agents (real data) ─────────────────────
interface UserAgent {
  id: number
  user_id: number
  name: string
  objective: string
  llm: string
  monthly_token_cap: number
  tokens_used_month: number
  tier: 'ollama-free' | 'company'
  status: 'draft' | 'submitted' | 'approved' | 'paused' | 'retired'
  department: string | null
  submission_note: string | null
  created_at: string
  updated_at: string
}
interface LlmOption { id: string; label: string; availableTiers: string[] }
interface UserBudget { monthly_token_cap: number; tokens_used_month: number; tier: string; updated_at: string }

interface Department { id: number; name: string; description: string }

const myAgents = ref<UserAgent[]>([])
const llmOptions = ref<LlmOption[]>([])
const myBudget = ref<UserBudget | null>(null)
const myDepartments = ref<Department[]>([])

async function loadMyAgents() {
  const res = await fetch('/api/user-agents/mine', { headers: hdrs() })
  if (res.ok) myAgents.value = (await res.json()).rows || []
}
async function loadLlms() {
  const res = await fetch('/api/user-agents/llms', { headers: hdrs() })
  if (res.ok) llmOptions.value = (await res.json()).options || []
}
async function loadMyBudget() {
  const res = await fetch('/api/user-agents/my-budget', { headers: hdrs() })
  if (res.ok) myBudget.value = (await res.json()).budget || null
}
async function loadMyDepartments() {
  const res = await fetch('/api/user-settings/my-departments', { headers: hdrs() })
  if (res.ok) myDepartments.value = (await res.json()).departments || []
}

const creatingAgent = ref(false)
const newAgent = ref({ name: '', objective: '', llm: '', department: '' })
function resetNew() { newAgent.value = { name: '', objective: '', llm: '', department: '' } }

async function createAgent() {
  if (!newAgent.value.name.trim() || !newAgent.value.objective.trim() || !newAgent.value.llm) return
  creatingAgent.value = true
  try {
    const res = await fetch('/api/user-agents', {
      method: 'POST', headers: hdrs(), body: JSON.stringify(newAgent.value),
    })
    if (res.ok) { resetNew(); await loadMyAgents() }
  } finally { creatingAgent.value = false }
}

async function submitAgent(a: UserAgent) {
  const note = window.prompt('Optional note for admin reviewer:') || ''
  const res = await fetch(`/api/user-agents/${a.id}/submit`, {
    method: 'POST', headers: hdrs(), body: JSON.stringify({ submission_note: note }),
  })
  if (res.ok) await loadMyAgents()
}

async function pauseAgent(a: UserAgent) {
  await fetch(`/api/user-agents/${a.id}/pause`, { method: 'POST', headers: hdrs() })
  await loadMyAgents()
}
async function resumeAgent(a: UserAgent) {
  await fetch(`/api/user-agents/${a.id}/resume`, { method: 'POST', headers: hdrs() })
  await loadMyAgents()
}
async function retireAgent(a: UserAgent) {
  if (!window.confirm(`Retire "${a.name}"? This is permanent.`)) return
  await fetch(`/api/user-agents/${a.id}/retire`, { method: 'POST', headers: hdrs() })
  await loadMyAgents()
}
async function deleteAgent(a: UserAgent) {
  if (!window.confirm(`Delete draft "${a.name}"?`)) return
  await fetch(`/api/user-agents/${a.id}`, { method: 'DELETE', headers: hdrs() })
  await loadMyAgents()
}

const availableLlmsForFreeTier = computed(() =>
  llmOptions.value.filter(o => o.availableTiers.includes('ollama-free'))
)

const myAgentStatusStyle: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  submitted: 'bg-amber-100 text-amber-700',
  approved: 'bg-emerald-100 text-emerald-700',
  paused: 'bg-violet-100 text-violet-700',
  retired: 'bg-muted text-muted-foreground/60',
}

onMounted(() => { loadMyAgents(); loadLlms(); loadMyBudget(); loadMyDepartments() })

// ─── Mock data shaped around what OpenClaw / an orchestrator would provide ───

interface Agent {
  id: string
  name: string
  description: string
  status: 'running' | 'idle' | 'error' | 'disabled'
  type: 'cron' | 'on-demand' | 'webhook'
  schedule?: string
  lastRunAt: string | null
  nextRunAt: string | null
  successRate: number
  totalRuns: number
  avgDurationSec: number
}

interface TaskRun {
  id: string
  agentId: string
  agentName: string
  status: 'running' | 'completed' | 'failed' | 'queued'
  trigger: 'cron' | 'manual' | 'webhook' | 'event'
  startedAt: string
  completedAt: string | null
  durationSec: number | null
  summary: string
  recordsProcessed: number
  qbTable?: string
  error?: string
}

const agents = ref<Agent[]>([
  {
    id: 'agent-intake-processor',
    name: 'Intake Processor',
    description: 'Reviews new intake submissions, validates data, and flags incomplete records for follow-up',
    status: 'idle',
    type: 'cron',
    schedule: 'Every 15 min',
    lastRunAt: '2026-04-03T14:30:00Z',
    nextRunAt: '2026-04-03T14:45:00Z',
    successRate: 98.5,
    totalRuns: 1247,
    avgDurationSec: 12,
  },
  {
    id: 'agent-milestone-tracker',
    name: 'Milestone Tracker',
    description: 'Monitors project milestone dates and updates status fields when milestones are completed',
    status: 'running',
    type: 'cron',
    schedule: 'Every 30 min',
    lastRunAt: '2026-04-03T14:15:00Z',
    nextRunAt: '2026-04-03T14:45:00Z',
    successRate: 99.2,
    totalRuns: 892,
    avgDurationSec: 45,
  },
  {
    id: 'agent-late-detector',
    name: 'Late Detection',
    description: 'Analyzes Arrivy task logs for PREDICTED_LATE, LATE, and NOSHOW events and escalates to coordinators',
    status: 'idle',
    type: 'webhook',
    schedule: undefined,
    lastRunAt: '2026-04-03T13:58:00Z',
    nextRunAt: null,
    successRate: 100,
    totalRuns: 3405,
    avgDurationSec: 3,
  },
  {
    id: 'agent-permit-checker',
    name: 'Permit Status Checker',
    description: 'Checks external permit portals and updates permit submitted/approved dates on projects',
    status: 'error',
    type: 'cron',
    schedule: 'Every 2 hours',
    lastRunAt: '2026-04-03T12:00:00Z',
    nextRunAt: '2026-04-03T14:00:00Z',
    successRate: 94.1,
    totalRuns: 567,
    avgDurationSec: 120,
  },
  {
    id: 'agent-comms-summarizer',
    name: 'Comms Summarizer',
    description: 'Summarizes SMS and call logs into project notes for coordinator review',
    status: 'idle',
    type: 'cron',
    schedule: 'Daily 6:00 AM',
    lastRunAt: '2026-04-03T06:00:00Z',
    nextRunAt: '2026-04-04T06:00:00Z',
    successRate: 97.8,
    totalRuns: 180,
    avgDurationSec: 90,
  },
  {
    id: 'agent-ticket-triage',
    name: 'Ticket Triage',
    description: 'Auto-categorizes new tickets, assigns priority, and routes to the appropriate team',
    status: 'disabled',
    type: 'on-demand',
    schedule: undefined,
    lastRunAt: '2026-03-28T09:00:00Z',
    nextRunAt: null,
    successRate: 91.3,
    totalRuns: 423,
    avgDurationSec: 8,
  },
])

const taskRuns = ref<TaskRun[]>([
  {
    id: 'run-001', agentId: 'agent-milestone-tracker', agentName: 'Milestone Tracker',
    status: 'running', trigger: 'cron', startedAt: '2026-04-03T14:30:12Z',
    completedAt: null, durationSec: null, summary: 'Processing 47 projects with recent milestone updates',
    recordsProcessed: 23, qbTable: 'br9kwm8na',
  },
  {
    id: 'run-002', agentId: 'agent-intake-processor', agentName: 'Intake Processor',
    status: 'completed', trigger: 'cron', startedAt: '2026-04-03T14:30:00Z',
    completedAt: '2026-04-03T14:30:11Z', durationSec: 11, summary: 'Processed 8 new intakes, flagged 2 incomplete',
    recordsProcessed: 8, qbTable: 'bt4a8ypkq',
  },
  {
    id: 'run-003', agentId: 'agent-late-detector', agentName: 'Late Detection',
    status: 'completed', trigger: 'webhook', startedAt: '2026-04-03T13:58:00Z',
    completedAt: '2026-04-03T13:58:03Z', durationSec: 3, summary: 'PREDICTED_LATE event for install #10532 — escalated to Paige Elkins',
    recordsProcessed: 1, qbTable: 'bvbbznmdb',
  },
  {
    id: 'run-004', agentId: 'agent-permit-checker', agentName: 'Permit Status Checker',
    status: 'failed', trigger: 'cron', startedAt: '2026-04-03T12:00:00Z',
    completedAt: '2026-04-03T12:01:45Z', durationSec: 105, summary: 'Permit portal returned 503',
    recordsProcessed: 0, error: 'HTTP 503: Service Unavailable from permits.state.fl.gov — retry scheduled',
  },
  {
    id: 'run-005', agentId: 'agent-comms-summarizer', agentName: 'Comms Summarizer',
    status: 'completed', trigger: 'cron', startedAt: '2026-04-03T06:00:00Z',
    completedAt: '2026-04-03T06:01:28Z', durationSec: 88, summary: 'Summarized 34 SMS threads and 12 calls into project notes',
    recordsProcessed: 46, qbTable: 'bsb6bqt3b',
  },
  {
    id: 'run-006', agentId: 'agent-intake-processor', agentName: 'Intake Processor',
    status: 'completed', trigger: 'cron', startedAt: '2026-04-03T14:15:00Z',
    completedAt: '2026-04-03T14:15:14Z', durationSec: 14, summary: 'Processed 5 new intakes, all complete',
    recordsProcessed: 5, qbTable: 'bt4a8ypkq',
  },
  {
    id: 'run-007', agentId: 'agent-milestone-tracker', agentName: 'Milestone Tracker',
    status: 'completed', trigger: 'cron', startedAt: '2026-04-03T14:00:00Z',
    completedAt: '2026-04-03T14:00:42Z', durationSec: 42, summary: 'Updated 15 milestone statuses across 11 projects',
    recordsProcessed: 15, qbTable: 'br9kwm8na',
  },
  {
    id: 'run-008', agentId: 'agent-late-detector', agentName: 'Late Detection',
    status: 'completed', trigger: 'webhook', startedAt: '2026-04-03T11:22:00Z',
    completedAt: '2026-04-03T11:22:02Z', durationSec: 2, summary: 'NOSHOW event for survey #10518 — ticket created, coordinator notified',
    recordsProcessed: 1, qbTable: 'bvbbznmdb',
  },
])

// ─── Computed ────────────────────────────────────────────

const activeAgents = computed(() => agents.value.filter(a => a.status === 'running').length)
const errorAgents = computed(() => agents.value.filter(a => a.status === 'error').length)
const totalRunsToday = computed(() => taskRuns.value.length)
const avgSuccessRate = computed(() => {
  const rates = agents.value.filter(a => a.totalRuns > 0).map(a => a.successRate)
  return rates.length ? (rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(1) : '0'
})

// ─── Helpers ─────────────────────────────────────────────

const statusStyle: Record<string, { bg: string; text: string; dot: string }> = {
  running: { bg: 'bg-emerald-50 dark:bg-emerald-950/30', text: 'text-emerald-700 dark:text-emerald-400', dot: 'bg-emerald-500 animate-pulse' },
  idle: { bg: 'bg-muted', text: 'text-muted-foreground', dot: 'bg-muted-foreground/50' },
  error: { bg: 'bg-red-50 dark:bg-red-950/30', text: 'text-red-700 dark:text-red-400', dot: 'bg-red-500' },
  disabled: { bg: 'bg-muted', text: 'text-muted-foreground/50', dot: 'bg-muted-foreground/20' },
  completed: { bg: 'bg-emerald-50 dark:bg-emerald-950/30', text: 'text-emerald-700 dark:text-emerald-400', dot: 'bg-emerald-500' },
  failed: { bg: 'bg-red-50 dark:bg-red-950/30', text: 'text-red-700 dark:text-red-400', dot: 'bg-red-500' },
  queued: { bg: 'bg-amber-50 dark:bg-amber-950/30', text: 'text-amber-700 dark:text-amber-400', dot: 'bg-amber-500' },
}

function getStatus(s: string) {
  return statusStyle[s] || statusStyle.idle!
}

function timeAgo(dateStr: string | null) {
  if (!dateStr) return '—'
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function formatDuration(sec: number | null) {
  if (sec === null) return '...'
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m ${sec % 60}s`
}

const selectedAgent = ref<Agent | null>(null)
const agentRuns = computed(() => {
  if (!selectedAgent.value) return []
  return taskRuns.value.filter(r => r.agentId === selectedAgent.value!.id)
})
</script>

<template>
  <div class="grid gap-6">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">AI Agents</h1>
      <p class="text-muted-foreground mt-1">Monitor agent workflows, task execution, and schedules.</p>
    </div>

    <!-- KPI strip -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <Card>
        <CardContent class="pt-6">
          <p class="text-sm text-muted-foreground">Active Now</p>
          <p class="text-3xl font-semibold mt-1">{{ activeAgents }}</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="pt-6">
          <p class="text-sm text-muted-foreground">Errors</p>
          <p class="text-3xl font-semibold mt-1" :class="errorAgents > 0 ? 'text-red-600' : ''">{{ errorAgents }}</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="pt-6">
          <p class="text-sm text-muted-foreground">Runs Today</p>
          <p class="text-3xl font-semibold mt-1">{{ totalRunsToday }}</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="pt-6">
          <p class="text-sm text-muted-foreground">Avg Success Rate</p>
          <p class="text-3xl font-semibold mt-1">{{ avgSuccessRate }}%</p>
        </CardContent>
      </Card>
    </div>

    <Tabs default-value="my-agents">
      <TabsList>
        <TabsTrigger value="my-agents">My Agents</TabsTrigger>
        <TabsTrigger value="agents">System</TabsTrigger>
        <TabsTrigger value="runs">Task Runs</TabsTrigger>
        <TabsTrigger value="schedules">Schedules</TabsTrigger>
      </TabsList>

      <!-- ═══ My Agents ═══ -->
      <TabsContent value="my-agents" class="mt-6 grid gap-4">
        <!-- Per-user budget -->
        <Card v-if="myBudget">
          <CardContent class="pt-6 flex items-baseline gap-4 flex-wrap">
            <div class="flex-1 min-w-0">
              <p class="text-sm text-muted-foreground">Your monthly token budget</p>
              <p class="text-xs text-muted-foreground mt-0.5">
                Tier: <span class="font-semibold capitalize">{{ myBudget.tier.replace('-', ' ') }}</span>.
                Aggregate across all your agents. Approved agents draw from the company pool instead.
              </p>
            </div>
            <div class="text-right">
              <p class="text-2xl font-semibold tabular-nums">{{ myBudget.tokens_used_month.toLocaleString() }}<span class="text-sm text-muted-foreground"> / {{ myBudget.monthly_token_cap.toLocaleString() }}</span></p>
              <p class="text-[10px] text-muted-foreground">tokens used this month</p>
            </div>
          </CardContent>
        </Card>

        <!-- Create new -->
        <Card>
          <CardHeader>
            <CardTitle class="text-base">Create a new agent</CardTitle>
            <CardDescription class="text-xs">
              Draft runs against your ollama-free tier. Submit for review to deploy company-wide with a higher cap.
            </CardDescription>
          </CardHeader>
          <CardContent class="grid gap-3">
            <div class="grid sm:grid-cols-2 gap-3">
              <div class="space-y-1.5">
                <Label class="text-[10px] uppercase tracking-widest text-muted-foreground">Name</Label>
                <Input v-model="newAgent.name" placeholder="e.g. Permit follow-up reminder" maxlength="120" />
              </div>
              <div class="space-y-1.5">
                <Label class="text-[10px] uppercase tracking-widest text-muted-foreground">LLM</Label>
                <Select v-model="newAgent.llm">
                  <SelectTrigger><SelectValue placeholder="Pick an LLM" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="o in availableLlmsForFreeTier" :key="o.id" :value="o.id">{{ o.label }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div class="space-y-1.5">
              <Label class="text-[10px] uppercase tracking-widest text-muted-foreground">Objective</Label>
              <textarea v-model="newAgent.objective" rows="3" maxlength="2000"
                class="w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="What should this agent do? Tight and purposeful — one job per agent."></textarea>
            </div>
            <div class="grid sm:grid-cols-2 gap-3">
              <div class="space-y-1.5">
                <Label class="text-[10px] uppercase tracking-widest text-muted-foreground">Department (optional)</Label>
                <Select v-if="myDepartments.length > 0" :model-value="newAgent.department || '__none__'"
                  @update:model-value="(v: string) => newAgent.department = v === '__none__' ? '' : v">
                  <SelectTrigger><SelectValue placeholder="Pick a department" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    <SelectItem v-for="d in myDepartments" :key="d.id" :value="d.name">{{ d.name }}</SelectItem>
                  </SelectContent>
                </Select>
                <p v-else class="text-xs text-muted-foreground py-2">
                  You're not in any departments yet. Ask an admin to add you, then this picker will appear.
                </p>
              </div>
            </div>
            <div class="flex justify-end">
              <Button :disabled="creatingAgent || !newAgent.name.trim() || !newAgent.objective.trim() || !newAgent.llm" @click="createAgent">
                {{ creatingAgent ? 'Saving…' : 'Save Draft' }}
              </Button>
            </div>
          </CardContent>
        </Card>

        <!-- My agents list -->
        <div v-if="myAgents.length === 0" class="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
          You haven't created any agents yet.
        </div>
        <div v-else class="grid gap-3">
          <Card v-for="a in myAgents" :key="a.id">
            <CardContent class="pt-6 space-y-2">
              <div class="flex items-baseline gap-2 flex-wrap">
                <p class="font-semibold">{{ a.name }}</p>
                <span v-if="a.department" class="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{{ a.department }}</span>
                <span class="text-[10px] font-mono text-muted-foreground ml-auto">{{ a.llm }}</span>
                <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize"
                  :class="myAgentStatusStyle[a.status]">
                  {{ a.status }}
                </span>
              </div>
              <p class="text-sm text-muted-foreground whitespace-pre-wrap">{{ a.objective }}</p>
              <p v-if="a.submission_note" class="text-[11px] italic text-muted-foreground">Note: {{ a.submission_note }}</p>
              <p class="text-[10px] text-muted-foreground">
                Tier: <span class="font-semibold">{{ a.tier }}</span> ·
                Cap: {{ a.monthly_token_cap.toLocaleString() }} tok/mo ·
                Used: {{ a.tokens_used_month.toLocaleString() }}
              </p>
              <div class="flex gap-1.5 flex-wrap pt-1">
                <Button v-if="a.status === 'draft'" size="sm" @click="submitAgent(a)">Submit for review</Button>
                <Button v-if="a.status === 'draft'" size="sm" variant="outline" @click="deleteAgent(a)">Delete</Button>
                <Button v-if="a.status === 'approved'" size="sm" variant="outline" @click="pauseAgent(a)">Pause</Button>
                <Button v-if="a.status === 'paused'" size="sm" @click="resumeAgent(a)">Resume</Button>
                <Button v-if="['approved','paused'].includes(a.status)" size="sm" variant="ghost" @click="retireAgent(a)">Retire</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </TabsContent>

      <!-- ═══ Agents ═══ -->
      <TabsContent value="agents" class="mt-6 grid gap-4">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card
            v-for="agent in agents"
            :key="agent.id"
            class="cursor-pointer transition-all hover:shadow-md"
            :class="selectedAgent?.id === agent.id ? 'ring-2 ring-primary' : ''"
            @click="selectedAgent = selectedAgent?.id === agent.id ? null : agent"
          >
            <CardContent class="pt-6">
              <div class="flex items-start justify-between gap-3">
                <div class="flex items-start gap-3 min-w-0">
                  <Avatar class="size-10 shrink-0">
                    <AvatarFallback class="text-xs font-mono">
                      {{ agent.name.split(' ').map(w => w[0]).join('') }}
                    </AvatarFallback>
                  </Avatar>
                  <div class="min-w-0">
                    <p class="font-semibold text-sm truncate">{{ agent.name }}</p>
                    <p class="text-xs text-muted-foreground mt-0.5 line-clamp-2">{{ agent.description }}</p>
                  </div>
                </div>
                <Badge
                  :class="[getStatus(agent.status).bg, getStatus(agent.status).text]"
                  variant="secondary"
                  class="shrink-0 gap-1.5"
                >
                  <span :class="['size-1.5 rounded-full', getStatus(agent.status).dot]" />
                  {{ agent.status }}
                </Badge>
              </div>

              <div class="grid grid-cols-3 gap-3 mt-4 pt-4 border-t">
                <div>
                  <p class="text-[10px] uppercase tracking-wider text-muted-foreground">Last run</p>
                  <p class="text-sm font-medium mt-0.5">{{ timeAgo(agent.lastRunAt) }}</p>
                </div>
                <div>
                  <p class="text-[10px] uppercase tracking-wider text-muted-foreground">Success</p>
                  <p class="text-sm font-medium mt-0.5">{{ agent.successRate }}%</p>
                </div>
                <div>
                  <p class="text-[10px] uppercase tracking-wider text-muted-foreground">Avg time</p>
                  <p class="text-sm font-medium mt-0.5">{{ formatDuration(agent.avgDurationSec) }}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <!-- Selected agent detail -->
        <Card v-if="selectedAgent">
          <CardHeader>
            <CardTitle class="text-base">{{ selectedAgent.name }} — Recent Runs</CardTitle>
            <CardDescription>{{ selectedAgent.description }}</CardDescription>
          </CardHeader>
          <CardContent>
            <div v-if="agentRuns.length === 0" class="text-sm text-muted-foreground py-4 text-center">
              No recent runs for this agent.
            </div>
            <!-- Desktop table -->
            <Table v-else class="hidden sm:table">
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Records</TableHead>
                  <TableHead>Summary</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="run in agentRuns" :key="run.id">
                  <TableCell>
                    <Badge :class="[getStatus(run.status).bg, getStatus(run.status).text]" variant="secondary" class="gap-1.5 text-xs">
                      <span :class="['size-1.5 rounded-full', getStatus(run.status).dot]" />
                      {{ run.status }}
                    </Badge>
                  </TableCell>
                  <TableCell class="text-xs">{{ run.trigger }}</TableCell>
                  <TableCell class="text-xs">{{ timeAgo(run.startedAt) }}</TableCell>
                  <TableCell class="text-xs font-mono">{{ formatDuration(run.durationSec) }}</TableCell>
                  <TableCell class="text-xs font-mono">{{ run.recordsProcessed }}</TableCell>
                  <TableCell class="text-xs max-w-[300px]">
                    <p class="truncate">{{ run.summary }}</p>
                    <p v-if="run.error" class="text-red-600 text-[10px] mt-0.5 truncate">{{ run.error }}</p>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
            <!-- Mobile cards -->
            <div v-if="agentRuns.length" class="sm:hidden space-y-2">
              <div v-for="run in agentRuns" :key="run.id" class="rounded-lg border bg-card p-3">
                <div class="flex items-center justify-between">
                  <Badge :class="[getStatus(run.status).bg, getStatus(run.status).text]" variant="secondary" class="gap-1.5 text-xs">
                    <span :class="['size-1.5 rounded-full', getStatus(run.status).dot]" />
                    {{ run.status }}
                  </Badge>
                  <span class="text-[11px] text-muted-foreground">{{ timeAgo(run.startedAt) }}</span>
                </div>
                <p class="text-sm mt-1.5 line-clamp-2">{{ run.summary }}</p>
                <div class="flex gap-3 mt-1 text-[11px] text-muted-foreground">
                  <span>{{ run.trigger }}</span>
                  <span>{{ formatDuration(run.durationSec) }}</span>
                  <span>{{ run.recordsProcessed }} records</span>
                </div>
                <p v-if="run.error" class="text-[11px] text-red-600 mt-1 truncate">{{ run.error }}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </TabsContent>

      <!-- ═══ Task Runs ═══ -->
      <TabsContent value="runs" class="mt-6">
        <Card>
          <CardHeader>
            <CardTitle class="text-base">All Task Runs</CardTitle>
            <CardDescription>Chronological log of every agent execution.</CardDescription>
          </CardHeader>
          <CardContent>
            <div class="space-y-3">
              <div
                v-for="run in taskRuns"
                :key="run.id"
                class="flex items-start gap-3 rounded-lg border p-4 transition-colors hover:bg-muted/30"
              >
                <div class="mt-0.5">
                  <span :class="['block size-2.5 rounded-full', getStatus(run.status).dot]" />
                </div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-sm font-medium">{{ run.agentName }}</span>
                    <Badge variant="outline" class="text-[10px]">{{ run.trigger }}</Badge>
                    <span class="text-xs text-muted-foreground ml-auto">{{ timeAgo(run.startedAt) }}</span>
                  </div>
                  <p class="text-sm text-muted-foreground mt-1">{{ run.summary }}</p>
                  <div class="flex gap-4 mt-2 text-xs text-muted-foreground">
                    <span v-if="run.durationSec !== null">{{ formatDuration(run.durationSec) }}</span>
                    <span v-if="run.recordsProcessed">{{ run.recordsProcessed }} records</span>
                    <span v-if="run.qbTable" class="font-mono">{{ run.qbTable }}</span>
                  </div>
                  <p v-if="run.error" class="text-xs text-red-600 mt-1.5 p-2 rounded bg-red-50 dark:bg-red-950/20">
                    {{ run.error }}
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </TabsContent>

      <!-- ═══ Schedules ═══ -->
      <TabsContent value="schedules" class="mt-6">
        <Card>
          <CardHeader>
            <CardTitle class="text-base">CRON Schedules</CardTitle>
            <CardDescription>Agents with recurring schedules and their next run times.</CardDescription>
          </CardHeader>
          <CardContent>
            <!-- Desktop table -->
            <Table class="hidden sm:table">
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Last Run</TableHead>
                  <TableHead>Next Run</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Success Rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="agent in agents.filter(a => a.type === 'cron')" :key="agent.id">
                  <TableCell>
                    <div>
                      <p class="font-medium text-sm">{{ agent.name }}</p>
                      <p class="text-xs text-muted-foreground truncate max-w-[200px]">{{ agent.description }}</p>
                    </div>
                  </TableCell>
                  <TableCell class="text-sm font-mono">{{ agent.schedule }}</TableCell>
                  <TableCell class="text-xs">{{ timeAgo(agent.lastRunAt) }}</TableCell>
                  <TableCell class="text-xs">
                    {{ agent.nextRunAt ? timeAgo(agent.nextRunAt) : '—' }}
                  </TableCell>
                  <TableCell>
                    <Badge :class="[getStatus(agent.status).bg, getStatus(agent.status).text]" variant="secondary" class="gap-1.5 text-xs">
                      <span :class="['size-1.5 rounded-full', getStatus(agent.status).dot]" />
                      {{ agent.status }}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div class="flex items-center gap-2">
                      <div class="h-1.5 w-16 rounded-full bg-muted overflow-hidden">
                        <div
                          class="h-full rounded-full"
                          :class="agent.successRate > 95 ? 'bg-emerald-500' : agent.successRate > 90 ? 'bg-amber-500' : 'bg-red-500'"
                          :style="{ width: `${agent.successRate}%` }"
                        />
                      </div>
                      <span class="text-xs font-mono">{{ agent.successRate }}%</span>
                    </div>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
            <!-- Mobile cards -->
            <div class="sm:hidden space-y-2">
              <div v-for="agent in agents.filter(a => a.type === 'cron')" :key="agent.id" class="rounded-lg border p-3">
                <div class="flex items-center justify-between">
                  <p class="text-sm font-medium">{{ agent.name }}</p>
                  <Badge :class="[getStatus(agent.status).bg, getStatus(agent.status).text]" variant="secondary" class="gap-1.5 text-xs">
                    <span :class="['size-1.5 rounded-full', getStatus(agent.status).dot]" />
                    {{ agent.status }}
                  </Badge>
                </div>
                <p class="text-xs text-muted-foreground mt-0.5">{{ agent.schedule }}</p>
                <div class="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground">
                  <span>Last: {{ timeAgo(agent.lastRunAt) }}</span>
                  <span>Next: {{ agent.nextRunAt ? timeAgo(agent.nextRunAt) : '—' }}</span>
                  <div class="flex items-center gap-1 ml-auto">
                    <div class="h-1 w-10 rounded-full bg-muted overflow-hidden">
                      <div class="h-full rounded-full" :class="agent.successRate > 95 ? 'bg-emerald-500' : agent.successRate > 90 ? 'bg-amber-500' : 'bg-red-500'" :style="{ width: `${agent.successRate}%` }" />
                    </div>
                    <span class="text-[10px] font-mono">{{ agent.successRate }}%</span>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <!-- Integration placeholder -->
        <Card class="mt-6 border-dashed">
          <CardContent class="pt-6 text-center py-12">
            <div class="inline-flex size-12 items-center justify-center rounded-full bg-muted mb-4">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>
            </div>
            <p class="font-medium">OpenClaw Integration</p>
            <p class="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
              Connect to OpenClaw to pull live agent status, task queues, execution logs, and CRON schedules.
              This section will replace mock data with real-time agent monitoring.
            </p>
            <div class="mt-6 text-left max-w-sm mx-auto space-y-2 text-sm text-muted-foreground">
              <p class="font-medium text-foreground text-xs uppercase tracking-wider">Integration checklist:</p>
              <label class="flex items-center gap-2"><input type="checkbox" disabled /> OpenClaw API endpoint URL</label>
              <label class="flex items-center gap-2"><input type="checkbox" disabled /> Authentication method (API key, OAuth)</label>
              <label class="flex items-center gap-2"><input type="checkbox" disabled /> Agent registry endpoint</label>
              <label class="flex items-center gap-2"><input type="checkbox" disabled /> Task run history endpoint</label>
              <label class="flex items-center gap-2"><input type="checkbox" disabled /> CRON schedule endpoint</label>
              <label class="flex items-center gap-2"><input type="checkbox" disabled /> Webhook for real-time status updates</label>
              <label class="flex items-center gap-2"><input type="checkbox" disabled /> Execution log/output format</label>
            </div>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  </div>
</template>
