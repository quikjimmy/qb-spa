<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import AgentControlPanel from './AgentControlPanel.vue'
import AgentOrgNode from './AgentOrgNode.vue'
import AgentRoleDashboard from './AgentRoleDashboard.vue'
import { useAuthStore } from '@/stores/auth'

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
const flatRoles = ref<RoleNode[]>([])
const runs = ref<Array<Record<string, unknown>>>([])
const runningTaskId = ref<number | null>(null)
const loading = ref(false)
const selectedRoleId = ref<number | null>(null)
const deliveryMessage = ref('')

const selectedRole = computed(() => flatRoles.value.find(role => role.id === selectedRoleId.value) || flatRoles.value[0] || null)
const selectedRuns = computed(() => runs.value.filter(run => Number(run.agent_role_id) === selectedRole.value?.id))
const runningRoles = computed(() => flatRoles.value.filter(role => ['queued', 'running'].includes(String(role.latest_run?.status || ''))))
const pendingApprovals = computed(() => flatRoles.value.reduce((sum, role) => sum + Number(role.pending_approvals || 0), 0))
const enabledTasks = computed(() => flatRoles.value.reduce((sum, role) => sum + (role.tasks || []).filter(task => Number(task.enabled) === 1).length, 0))

async function load() {
  loading.value = true
  try {
    const [rolesRes, runsRes] = await Promise.all([
      fetch('/api/agent-org/roles', { headers: hdrs() }),
      fetch('/api/agent-org/runs?limit=20', { headers: hdrs() }),
    ])
    if (rolesRes.ok) {
      const data = await rolesRes.json()
      roots.value = data.roots || []
      flatRoles.value = data.flat || []
      if (!selectedRoleId.value && flatRoles.value.length) selectedRoleId.value = flatRoles.value[0]!.id
    }
    if (runsRes.ok) runs.value = (await runsRes.json()).rows || []
  } finally { loading.value = false }
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
    if (res.ok) {
      deliveryMessage.value = `Delivered ${data.delivered || 0} of ${data.expected_recipients || 0}; failed ${data.failed || 0}.`
    } else {
      deliveryMessage.value = data.error || `Delivery failed (${res.status})`
    }
    await load()
  } finally { runningTaskId.value = null }
}

onMounted(load)

watch(selectedRole, async role => {
  if (!role) return
  const res = await fetch(`/api/agent-org/runs?role_id=${role.id}&limit=20`, { headers: hdrs() })
  if (res.ok) {
    const roleRuns = (await res.json()).rows || []
    const otherRuns = runs.value.filter(run => Number(run.agent_role_id) !== role.id)
    runs.value = [...roleRuns, ...otherRuns]
  }
})
</script>

<template>
  <div class="space-y-4">
    <div class="grid gap-3 sm:grid-cols-4">
      <Card>
        <CardContent class="pt-4">
          <p class="text-[11px] uppercase tracking-wide text-muted-foreground">Accessible Agents</p>
          <p class="text-2xl font-semibold">{{ flatRoles.length }}</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="pt-4">
          <p class="text-[11px] uppercase tracking-wide text-muted-foreground">Running Now</p>
          <p class="text-2xl font-semibold">{{ runningRoles.length }}</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="pt-4">
          <p class="text-[11px] uppercase tracking-wide text-muted-foreground">Routines</p>
          <p class="text-2xl font-semibold">{{ enabledTasks }}</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="pt-4">
          <p class="text-[11px] uppercase tracking-wide text-muted-foreground">Issues</p>
          <p class="text-2xl font-semibold">{{ pendingApprovals }}</p>
        </CardContent>
      </Card>
    </div>

    <p v-if="loading" class="text-sm text-muted-foreground">Loading org chart...</p>
    <div v-else class="grid gap-4">
      <AgentControlPanel :roles="flatRoles as any" @changed="load" />
      <p v-if="deliveryMessage" class="rounded-md border bg-muted px-3 py-2 text-sm">{{ deliveryMessage }}</p>

      <Card>
        <CardHeader>
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Visual Org Chart</CardTitle>
              <CardDescription>Click an agent to open its dashboard. Blue means currently queued or running.</CardDescription>
            </div>
            <Button variant="outline" size="sm" class="h-8 text-xs" @click="load">Refresh</Button>
          </div>
        </CardHeader>
        <CardContent class="space-y-3">
          <div class="flex flex-wrap gap-2 text-[11px]">
            <Badge class="bg-sky-100 text-sky-800">Running</Badge>
            <Badge class="bg-amber-100 text-amber-800">Needs review</Badge>
            <Badge class="bg-emerald-100 text-emerald-800">Idle</Badge>
          </div>
          <div class="overflow-x-auto pb-2">
            <div class="flex min-w-max justify-center gap-8 px-1 py-3 md:min-w-0">
              <AgentOrgNode
                v-for="role in roots"
                :key="role.id"
                :role="role"
                :selected-role-id="selectedRoleId"
                @select="selectedRoleId = $event.id"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <AgentRoleDashboard
        :role="selectedRole as any"
        :runs="selectedRuns"
        :running-task-id="runningTaskId"
        @run="runTask"
        @deliver-pc-digest="deliverPcDigest"
      />
    </div>
  </div>
</template>
