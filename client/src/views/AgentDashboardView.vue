<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import AgentInbox from '@/components/agents/AgentInbox.vue'
import AgentOrgNode from '@/components/agents/AgentOrgNode.vue'
import AgentRunsTable from '@/components/agents/AgentRunsTable.vue'
import AgentTaskList from '@/components/agents/AgentTaskList.vue'
import { useAuthStore } from '@/stores/auth'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

interface RoleNode {
  id: number
  name: string
  slug: string
  objective: string
  execution_mode: string
  parent_role_id?: number | null
  department?: string | null
  status: string
  pending_approvals?: number
  latest_run?: { status?: string; created_at?: string } | null
  goals?: Array<Record<string, unknown>>
  tasks?: Array<Record<string, unknown>>
  children?: RoleNode[]
}

const roots = ref<RoleNode[]>([])
const flat = ref<RoleNode[]>([])
const runs = ref<Array<Record<string, unknown>>>([])
const view = ref<'dashboard' | 'org' | 'tasks'>('dashboard')
const runningTaskId = ref<number | null>(null)
const deliveryMessage = ref('')

const agentId = computed(() => Number(route.params.id))
const agent = computed(() => flat.value.find(row => row.id === agentId.value) || null)
const agentRuns = computed(() => runs.value.filter(run => Number(run.agent_role_id) === agentId.value))

function fmt(iso?: string | null): string {
  if (!iso) return 'No runs yet'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : d.toLocaleString()
}

async function load() {
  const [rolesRes, runsRes] = await Promise.all([
    fetch('/api/agent-org/roles', { headers: hdrs() }),
    fetch(`/api/agent-org/runs?role_id=${agentId.value}&limit=30`, { headers: hdrs() }),
  ])
  if (rolesRes.ok) {
    const data = await rolesRes.json()
    roots.value = data.roots || []
    flat.value = data.flat || []
  }
  if (runsRes.ok) runs.value = (await runsRes.json()).rows || []
}

async function runTask(taskId: number, payload: Record<string, unknown> = {}) {
  runningTaskId.value = taskId
  try {
    await fetch(`/api/agent-org/tasks/${taskId}/run`, { method: 'POST', headers: hdrs(), body: JSON.stringify(payload) })
    await load()
  } finally { runningTaskId.value = null }
}

async function deliverPcDigest(taskId: number) {
  runningTaskId.value = taskId
  deliveryMessage.value = ''
  try {
    const res = await fetch(`/api/agent-org/tasks/${taskId}/deliver-pc-digest`, {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify({ inspection_days: 30 }),
    })
    const data = await res.json().catch(() => ({}))
    deliveryMessage.value = res.ok
      ? `Delivered ${data.delivered || 0} of ${data.expected_recipients || 0}; failed ${data.failed || 0}.`
      : data.error || `Delivery failed (${res.status})`
    await load()
  } finally { runningTaskId.value = null }
}

onMounted(load)
</script>

<template>
  <div class="grid gap-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <Button variant="ghost" size="sm" class="h-8 px-0 text-xs" @click="router.push('/agents')">Back to agents</Button>
        <h1 class="text-2xl font-semibold tracking-tight">{{ agent?.name || 'Agent' }}</h1>
        <p class="text-sm text-muted-foreground">{{ agent?.department || 'Production' }} · {{ agent?.execution_mode || 'agent' }}</p>
      </div>
      <Button variant="outline" size="sm" class="h-8 text-xs" @click="load">Refresh</Button>
    </div>

    <AgentInbox />

    <p v-if="deliveryMessage" class="rounded-md border bg-muted px-3 py-2 text-sm">{{ deliveryMessage }}</p>

    <div v-if="agent" class="flex flex-wrap gap-2 border-b">
      <button class="px-3 py-2 text-sm" :class="view === 'dashboard' ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground'" @click="view = 'dashboard'">Dashboard</button>
      <button class="px-3 py-2 text-sm" :class="view === 'org' ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground'" @click="view = 'org'">Org chart</button>
      <button class="px-3 py-2 text-sm" :class="view === 'tasks' ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground'" @click="view = 'tasks'">Tasks</button>
    </div>

    <div v-if="!agent" class="text-sm text-muted-foreground">Agent not found.</div>

    <div v-else-if="view === 'dashboard'" class="grid gap-4">
      <Card>
        <CardHeader>
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>{{ agent.name }}</CardTitle>
              <CardDescription>{{ agent.objective }}</CardDescription>
            </div>
            <Badge :class="agent.status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-muted text-muted-foreground'">{{ agent.status }}</Badge>
          </div>
        </CardHeader>
        <CardContent class="grid gap-3 sm:grid-cols-4">
          <div class="rounded-lg border px-3 py-2"><p class="text-[11px] text-muted-foreground">Tasks</p><p class="text-xl font-semibold">{{ agent.tasks?.length || 0 }}</p></div>
          <div class="rounded-lg border px-3 py-2"><p class="text-[11px] text-muted-foreground">Workers</p><p class="text-xl font-semibold">{{ agent.children?.length || 0 }}</p></div>
          <div class="rounded-lg border px-3 py-2"><p class="text-[11px] text-muted-foreground">Approvals</p><p class="text-xl font-semibold">{{ agent.pending_approvals || 0 }}</p></div>
          <div class="rounded-lg border px-3 py-2"><p class="text-[11px] text-muted-foreground">Last run</p><p class="truncate text-sm font-medium">{{ fmt(agent.latest_run?.created_at || null) }}</p></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <AgentRunsTable :runs="agentRuns" />
        </CardContent>
      </Card>
    </div>

    <Card v-else-if="view === 'org'">
      <CardHeader>
        <CardTitle>Org Chart</CardTitle>
        <CardDescription>Click an agent to open its dashboard.</CardDescription>
      </CardHeader>
      <CardContent>
        <div class="overflow-x-auto pb-2">
          <div class="flex min-w-max justify-center gap-8 px-1 py-3 md:min-w-0">
            <AgentOrgNode
              v-for="root in roots"
              :key="root.id"
              :role="root"
              :selected-role-id="agent.id"
              @select="(role) => router.push(`/agents/${role.id}`)"
            />
          </div>
        </div>
      </CardContent>
    </Card>

    <Card v-else>
      <CardHeader>
        <CardTitle>Tasks</CardTitle>
        <CardDescription>Tasks owned by this agent. Detection tasks surface recommendations first; draft tasks stay human-reviewed before anything happens outside Agent Ops.</CardDescription>
      </CardHeader>
      <CardContent>
        <div class="mb-4 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Agent experience:
          Ari workers run bounded tasks and return structured findings.
          User experience:
          humans review those findings in Agent Ops, then decide whether to approve, edit, dismiss, or create follow-up work.
        </div>
        <AgentTaskList
          :tasks="agent.tasks as any"
          :running-task-id="runningTaskId"
          @run="runTask"
          @deliver-pc-digest="deliverPcDigest"
          @changed="load"
        />
        <div v-if="agent.children?.length" class="mt-5 space-y-3">
          <p class="text-sm font-medium">Worker tasks</p>
          <div v-for="child in agent.children" :key="child.id" class="rounded-lg border p-3">
            <div class="mb-2 flex items-center justify-between gap-2">
              <RouterLink :to="`/agents/${child.id}`" class="text-sm font-medium hover:underline">{{ child.name }}</RouterLink>
              <span class="text-[11px] text-muted-foreground">{{ child.tasks?.length || 0 }} tasks</span>
            </div>
            <AgentTaskList :tasks="child.tasks as any" :running-task-id="runningTaskId" @run="runTask" @deliver-pc-digest="deliverPcDigest" @changed="load" />
          </div>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
