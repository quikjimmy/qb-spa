<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { useAuthStore } from '@/stores/auth'
import AriWorkspace from '@/components/agents/AriWorkspace.vue'
import AgentOrgChart from '@/components/agents/AgentOrgChart.vue'
import AgentApprovalQueue from '@/components/agents/AgentApprovalQueue.vue'
import AgentInbox from '@/components/agents/AgentInbox.vue'

const auth = useAuthStore()
function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

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
const canAccessLab = ref(false)
const labLoading = ref(false)
const creatingAgent = ref(false)
const runningId = ref<number | null>(null)
const runOutput = ref<Record<number, string>>({})
const newAgent = ref({ name: '', objective: '', llm: '', department: '' })

const statusTone: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  submitted: 'bg-amber-100 text-amber-800',
  approved: 'bg-emerald-100 text-emerald-800',
  paused: 'bg-violet-100 text-violet-800',
  retired: 'bg-slate-100 text-slate-600',
}

const labSummary = computed(() => {
  const total = myAgents.value.length
  const active = myAgents.value.filter(a => a.status === 'approved').length
  const submitted = myAgents.value.filter(a => a.status === 'submitted').length
  return { total, active, submitted }
})

async function loadLabStatus() {
  labLoading.value = true
  try {
    const res = await fetch('/api/agent-lab/status', { headers: hdrs() })
    if (res.ok) canAccessLab.value = !!(await res.json()).can_access
  } finally { labLoading.value = false }
}

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

async function loadLabData() {
  await Promise.all([loadMyAgents(), loadLlms(), loadMyBudget(), loadMyDepartments(), loadLabStatus()])
}

async function createAgent() {
  if (!newAgent.value.name.trim() || !newAgent.value.objective.trim() || !newAgent.value.llm) return
  creatingAgent.value = true
  try {
    const res = await fetch('/api/user-agents', {
      method: 'POST', headers: hdrs(), body: JSON.stringify(newAgent.value),
    })
    if (res.ok) {
      newAgent.value = { name: '', objective: '', llm: '', department: '' }
      await loadLabData()
    }
  } finally { creatingAgent.value = false }
}

async function act(id: number, action: 'submit' | 'pause' | 'resume' | 'retire' | 'delete') {
  const method = action === 'delete' ? 'DELETE' : 'POST'
  const res = await fetch(`/api/user-agents/${id}${action === 'delete' ? '' : '/' + action}`, {
    method,
    headers: hdrs(),
    body: action === 'submit' ? JSON.stringify({ submission_note: '' }) : undefined,
  })
  if (res.ok) await loadLabData()
}

async function runOnce(agent: UserAgent) {
  runningId.value = agent.id
  try {
    const res = await fetch(`/api/user-agents/${agent.id}/run-once`, {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify({ prompt: agent.objective }),
    })
    const data = await res.json().catch(() => ({})) as { output?: string; error?: string }
    runOutput.value = { ...runOutput.value, [agent.id]: data.output || data.error || 'No output returned.' }
    await loadLabData()
  } finally { runningId.value = null }
}

onMounted(async () => {
  await loadLabData()
})
</script>

<template>
  <div class="grid gap-4">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">Agent Operations</h1>
        <p class="text-sm text-muted-foreground">Dashboard for production agents, routines, goals, issues, and the experimental lab.</p>
      </div>
      <Button variant="outline" size="sm" class="h-8 text-xs" @click="loadLabData">Refresh</Button>
    </div>

    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
      <Card>
        <CardContent class="pt-4">
          <p class="text-[11px] uppercase tracking-wide text-muted-foreground">Inbox</p>
          <p class="text-2xl font-semibold">{{ labSummary.submitted }}</p>
          <p class="text-[11px] text-muted-foreground">Lab submissions</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="pt-4">
          <p class="text-[11px] uppercase tracking-wide text-muted-foreground">Issues</p>
          <p class="text-2xl font-semibold">Review</p>
          <p class="text-[11px] text-muted-foreground">Approvals and failed runs</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="pt-4">
          <p class="text-[11px] uppercase tracking-wide text-muted-foreground">Routines</p>
          <p class="text-2xl font-semibold">Cron</p>
          <p class="text-[11px] text-muted-foreground">Scheduled task records</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="pt-4">
          <p class="text-[11px] uppercase tracking-wide text-muted-foreground">Goals</p>
          <p class="text-2xl font-semibold">Active</p>
          <p class="text-[11px] text-muted-foreground">Role objectives</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="pt-4">
          <p class="text-[11px] uppercase tracking-wide text-muted-foreground">Projects</p>
          <p class="text-2xl font-semibold">PC</p>
          <p class="text-[11px] text-muted-foreground">Department workflows</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="pt-4">
          <p class="text-[11px] uppercase tracking-wide text-muted-foreground">Tasks</p>
          <p class="text-2xl font-semibold">Run</p>
          <p class="text-[11px] text-muted-foreground">Manual and scheduled</p>
        </CardContent>
      </Card>
    </div>

    <section class="space-y-4">
      <div>
        <h2 class="text-lg font-semibold">Org Chart And Agent Dashboards</h2>
        <p class="text-sm text-muted-foreground">Click any visual node to inspect that agent, its routines, goals, current status, and recent runs.</p>
      </div>
      <AgentApprovalQueue />
      <AgentOrgChart />
    </section>

    <section class="space-y-4">
      <AgentInbox />
    </section>

    <section class="space-y-4">
      <div>
        <h2 class="text-lg font-semibold">Production Front Door</h2>
        <p class="text-sm text-muted-foreground">Ari is the seeded Project Coordinators manager, but the model supports every production agent.</p>
      </div>
      <AriWorkspace />
    </section>

    <section class="space-y-4">
      <div>
        <h2 class="text-lg font-semibold">Agent Lab</h2>
        <p class="text-sm text-muted-foreground">Experimental custom agents stay separate from production routing.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Agent Lab</CardTitle>
          <CardDescription>Admin-only unless explicitly feature-flagged.</CardDescription>
        </CardHeader>
        <CardContent v-if="labLoading" class="text-sm text-muted-foreground">Loading lab access...</CardContent>
        <CardContent v-else-if="!canAccessLab" class="text-sm text-muted-foreground">
          Agent Lab is admin-only unless explicitly feature-flagged.
        </CardContent>
        <CardContent v-else class="space-y-4">
          <div class="grid gap-3 sm:grid-cols-3">
            <div class="rounded-lg border px-3 py-2">
              <p class="text-[11px] uppercase tracking-wide text-muted-foreground">My Lab Agents</p>
              <p class="text-2xl font-semibold">{{ labSummary.total }}</p>
            </div>
            <div class="rounded-lg border px-3 py-2">
              <p class="text-[11px] uppercase tracking-wide text-muted-foreground">Approved</p>
              <p class="text-2xl font-semibold">{{ labSummary.active }}</p>
            </div>
            <div class="rounded-lg border px-3 py-2">
              <p class="text-[11px] uppercase tracking-wide text-muted-foreground">Budget</p>
              <p class="text-2xl font-semibold">{{ myBudget ? `${myBudget.tokens_used_month.toLocaleString()} / ${myBudget.monthly_token_cap.toLocaleString()}` : '—' }}</p>
            </div>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Create Lab Agent</CardTitle>
              <CardDescription>Use custom agents here for experiments, not for production routing.</CardDescription>
            </CardHeader>
            <CardContent class="grid gap-3">
              <div class="grid gap-2 sm:grid-cols-2">
                <div class="space-y-1.5">
                  <Label>Name</Label>
                  <Input v-model="newAgent.name" placeholder="Project digest helper" />
                </div>
                <div class="space-y-1.5">
                  <Label>LLM</Label>
                  <Select :model-value="newAgent.llm || '__empty__'" @update:model-value="(v:string) => newAgent.llm = v === '__empty__' ? '' : v">
                    <SelectTrigger><SelectValue placeholder="Select model" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__empty__" disabled>Select model</SelectItem>
                      <SelectItem v-for="opt in llmOptions" :key="opt.id" :value="opt.id">{{ opt.label }}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div class="space-y-1.5">
                <Label>Objective</Label>
                <textarea v-model="newAgent.objective" class="min-h-[110px] w-full rounded-md border bg-background px-3 py-2 text-sm" placeholder="What should this lab agent do?" />
              </div>
              <div class="space-y-1.5">
                <Label>Department</Label>
                <Select :model-value="newAgent.department || '__none__'" @update:model-value="(v:string) => newAgent.department = v === '__none__' ? '' : v">
                  <SelectTrigger><SelectValue placeholder="Optional department" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No department</SelectItem>
                    <SelectItem v-for="dept in myDepartments" :key="dept.id" :value="dept.name">{{ dept.name }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Button class="h-8 text-xs" :disabled="creatingAgent" @click="createAgent">{{ creatingAgent ? 'Creating...' : 'Create Agent' }}</Button>
              </div>
            </CardContent>
          </Card>

          <div class="grid gap-3">
            <Card v-for="agent in myAgents" :key="agent.id">
              <CardHeader>
                <div class="flex flex-wrap items-center gap-2">
                  <CardTitle class="text-base">{{ agent.name }}</CardTitle>
                  <Badge :class="statusTone[agent.status] || statusTone.draft">{{ agent.status }}</Badge>
                  <Badge variant="secondary">{{ agent.llm }}</Badge>
                  <Badge v-if="agent.department" variant="secondary">{{ agent.department }}</Badge>
                </div>
                <CardDescription>{{ agent.objective }}</CardDescription>
              </CardHeader>
              <CardContent class="space-y-3">
                <div class="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                  <span>Budget {{ agent.tokens_used_month.toLocaleString() }} / {{ agent.monthly_token_cap.toLocaleString() }}</span>
                  <span>Updated {{ new Date(agent.updated_at).toLocaleString() }}</span>
                </div>
                <div class="flex flex-wrap gap-2">
                  <Button v-if="agent.status === 'draft'" size="sm" variant="outline" class="h-7 text-[11px]" @click="act(agent.id, 'submit')">Submit</Button>
                  <Button v-if="agent.status === 'approved'" size="sm" variant="outline" class="h-7 text-[11px]" @click="act(agent.id, 'pause')">Pause</Button>
                  <Button v-if="agent.status === 'paused'" size="sm" variant="outline" class="h-7 text-[11px]" @click="act(agent.id, 'resume')">Resume</Button>
                  <Button v-if="agent.status !== 'retired'" size="sm" variant="outline" class="h-7 text-[11px]" :disabled="runningId === agent.id" @click="runOnce(agent)">{{ runningId === agent.id ? 'Running...' : 'Run once' }}</Button>
                  <Button v-if="agent.status !== 'retired'" size="sm" variant="outline" class="h-7 text-[11px]" @click="act(agent.id, 'retire')">Retire</Button>
                  <Button v-if="agent.status === 'draft'" size="sm" variant="outline" class="h-7 text-[11px]" @click="act(agent.id, 'delete')">Delete</Button>
                </div>
                <div v-if="runOutput[agent.id]" class="rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap break-words">{{ runOutput[agent.id] }}</div>
              </CardContent>
            </Card>
            <p v-if="myAgents.length === 0" class="text-sm text-muted-foreground">No lab agents yet.</p>
          </div>
        </CardContent>
      </Card>
    </section>
  </div>
</template>
