<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuthStore } from '@/stores/auth'

interface RoleFlat {
  id: number
  name: string
  slug: string
  objective: string
  description?: string | null
  execution_mode: string
  parent_role_id?: number | null
  department?: string | null
  status: string
  llm: string
  monthly_token_cap: number
  approval_required: number
}

const props = defineProps<{
  roles: RoleFlat[]
}>()

const emit = defineEmits<{
  (e: 'changed'): void
}>()

const auth = useAuthStore()
function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

const selectedRoleId = ref<number | null>(null)
const saving = ref(false)
const message = ref('')

const selectedRole = computed(() => props.roles.find(r => r.id === selectedRoleId.value) || props.roles[0] || null)

const newRole = ref({
  name: '',
  slug: '',
  description: '',
  objective: '',
  execution_mode: 'worker',
  parent_role_id: '',
  department: '',
  status: 'active',
  llm: 'builtin-worker',
  monthly_token_cap: 100000,
  approval_required: 1,
})

const rolePatch = ref({
  parent_role_id: '',
  status: 'active',
  objective: '',
})

const newGoal = ref({
  title: '',
  description: '',
  success_metric: '',
  priority: 3,
})

const newTask = ref({
  name: '',
  task_type: 'custom',
  instructions: '',
  enabled: 1,
})

const newSchedule = ref({
  task_id: '',
  cron_expr: '0 8 * * *',
  timezone: 'America/Los_Angeles',
  enabled: 1,
})

function rolePayload(role: typeof newRole.value) {
  return {
    ...role,
    parent_role_id: role.parent_role_id ? Number(role.parent_role_id) : null,
    monthly_token_cap: Number(role.monthly_token_cap || 0),
    approval_required: Number(role.approval_required),
    is_lab_only: 0,
  }
}

async function saveJson(url: string, method: 'POST' | 'PATCH', payload: Record<string, unknown>) {
  saving.value = true
  message.value = ''
  try {
    const res = await fetch(url, { method, headers: hdrs(), body: JSON.stringify(payload) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      message.value = data.error || `Save failed (${res.status})`
      return false
    }
    message.value = 'Saved'
    emit('changed')
    return true
  } finally { saving.value = false }
}

async function createRole() {
  if (!newRole.value.name.trim() || !newRole.value.slug.trim() || !newRole.value.objective.trim()) return
  const ok = await saveJson('/api/agent-org/roles', 'POST', rolePayload(newRole.value))
  if (ok) newRole.value = { name: '', slug: '', description: '', objective: '', execution_mode: 'worker', parent_role_id: '', department: '', status: 'active', llm: 'builtin-worker', monthly_token_cap: 100000, approval_required: 1 }
}

async function updateRole() {
  const role = selectedRole.value
  if (!role) return
  await saveJson(`/api/agent-org/roles/${role.id}`, 'PATCH', {
    parent_role_id: rolePatch.value.parent_role_id ? Number(rolePatch.value.parent_role_id) : null,
    status: rolePatch.value.status || role.status,
    objective: rolePatch.value.objective || role.objective,
  })
}

async function createGoal() {
  const role = selectedRole.value
  if (!role || !newGoal.value.title.trim()) return
  const ok = await saveJson('/api/agent-org/goals', 'POST', {
    agent_role_id: role.id,
    ...newGoal.value,
    priority: Number(newGoal.value.priority || 3),
    status: 'active',
  })
  if (ok) newGoal.value = { title: '', description: '', success_metric: '', priority: 3 }
}

async function createTask() {
  const role = selectedRole.value
  if (!role || !newTask.value.name.trim() || !newTask.value.instructions.trim()) return
  const ok = await saveJson('/api/agent-org/tasks', 'POST', {
    agent_role_id: role.id,
    ...newTask.value,
    enabled: Number(newTask.value.enabled),
  })
  if (ok) newTask.value = { name: '', task_type: 'custom', instructions: '', enabled: 1 }
}

async function createSchedule() {
  if (!newSchedule.value.task_id || !newSchedule.value.cron_expr.trim()) return
  const ok = await saveJson('/api/agent-org/schedules', 'POST', {
    task_id: Number(newSchedule.value.task_id),
    cron_expr: newSchedule.value.cron_expr,
    timezone: newSchedule.value.timezone,
    enabled: Number(newSchedule.value.enabled),
  })
  if (ok) newSchedule.value = { task_id: '', cron_expr: '0 8 * * *', timezone: 'America/Los_Angeles', enabled: 1 }
}

function syncPatchFromSelected() {
  const role = selectedRole.value
  if (!role) return
  rolePatch.value = {
    parent_role_id: role.parent_role_id ? String(role.parent_role_id) : '',
    status: role.status,
    objective: role.objective,
  }
}

watch(() => props.roles, () => {
  if (!selectedRoleId.value && props.roles.length) {
    selectedRoleId.value = props.roles[0]!.id
    syncPatchFromSelected()
  }
}, { immediate: true })
</script>

<template>
  <Card v-if="auth.isAdmin">
    <CardHeader>
      <CardTitle>Production Agent Controls</CardTitle>
      <CardDescription>Generic controls for all production roles. Ari is just one role in this model.</CardDescription>
    </CardHeader>
    <CardContent class="grid gap-5">
      <p v-if="message" class="text-xs" :class="message === 'Saved' ? 'text-emerald-700' : 'text-red-600'">{{ message }}</p>

      <div class="grid gap-3 rounded-lg border p-3">
        <p class="text-sm font-semibold">Create Role</p>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-1.5"><Label>Name</Label><Input v-model="newRole.name" /></div>
          <div class="space-y-1.5"><Label>Slug</Label><Input v-model="newRole.slug" placeholder="ops-executive-agent" /></div>
          <div class="space-y-1.5"><Label>Department</Label><Input v-model="newRole.department" /></div>
          <div class="space-y-1.5">
            <Label>Parent</Label>
            <select v-model="newRole.parent_role_id" class="h-9 w-full rounded-md border bg-background px-2 text-sm">
              <option value="">No parent</option>
              <option v-for="role in roles" :key="role.id" :value="role.id">{{ role.name }}</option>
            </select>
          </div>
          <div class="space-y-1.5">
            <Label>Mode</Label>
            <select v-model="newRole.execution_mode" class="h-9 w-full rounded-md border bg-background px-2 text-sm">
              <option value="singleton">Singleton</option>
              <option value="manager">Manager</option>
              <option value="worker">Worker</option>
            </select>
          </div>
          <div class="space-y-1.5"><Label>LLM</Label><Input v-model="newRole.llm" /></div>
        </div>
        <div class="space-y-1.5"><Label>Objective</Label><textarea v-model="newRole.objective" class="min-h-[80px] w-full rounded-md border bg-background px-3 py-2 text-sm" /></div>
        <div class="space-y-1.5"><Label>Description</Label><Input v-model="newRole.description" /></div>
        <Button class="h-8 w-fit text-xs" :disabled="saving" @click="createRole">Create role</Button>
      </div>

      <div class="grid gap-3 rounded-lg border p-3">
        <p class="text-sm font-semibold">Edit Selected Role</p>
        <div class="grid gap-3 sm:grid-cols-3">
          <div class="space-y-1.5">
            <Label>Role</Label>
            <select v-model.number="selectedRoleId" class="h-9 w-full rounded-md border bg-background px-2 text-sm" @change="syncPatchFromSelected">
              <option v-for="role in roles" :key="role.id" :value="role.id">{{ role.name }}</option>
            </select>
          </div>
          <div class="space-y-1.5">
            <Label>Parent</Label>
            <select v-model="rolePatch.parent_role_id" class="h-9 w-full rounded-md border bg-background px-2 text-sm">
              <option value="">No parent</option>
              <option v-for="role in roles.filter(r => r.id !== selectedRole?.id)" :key="role.id" :value="role.id">{{ role.name }}</option>
            </select>
          </div>
          <div class="space-y-1.5">
            <Label>Status</Label>
            <select v-model="rolePatch.status" class="h-9 w-full rounded-md border bg-background px-2 text-sm">
              <option value="draft">Draft</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="retired">Retired</option>
            </select>
          </div>
        </div>
        <div class="space-y-1.5"><Label>Objective</Label><textarea v-model="rolePatch.objective" class="min-h-[80px] w-full rounded-md border bg-background px-3 py-2 text-sm" /></div>
        <Button class="h-8 w-fit text-xs" :disabled="saving || !selectedRole" @click="updateRole">Update role</Button>
      </div>

      <div class="grid gap-3 rounded-lg border p-3">
        <p class="text-sm font-semibold">Add Goal To Selected Role</p>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-1.5"><Label>Title</Label><Input v-model="newGoal.title" /></div>
          <div class="space-y-1.5"><Label>Priority</Label><Input v-model.number="newGoal.priority" type="number" /></div>
        </div>
        <div class="space-y-1.5"><Label>Success Metric</Label><Input v-model="newGoal.success_metric" /></div>
        <div class="space-y-1.5"><Label>Description</Label><textarea v-model="newGoal.description" class="min-h-[70px] w-full rounded-md border bg-background px-3 py-2 text-sm" /></div>
        <Button class="h-8 w-fit text-xs" :disabled="saving || !selectedRole" @click="createGoal">Add goal</Button>
      </div>

      <div class="grid gap-3 rounded-lg border p-3">
        <p class="text-sm font-semibold">Add Task To Selected Role</p>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-1.5"><Label>Name</Label><Input v-model="newTask.name" /></div>
          <div class="space-y-1.5">
            <Label>Type</Label>
            <select v-model="newTask.task_type" class="h-9 w-full rounded-md border bg-background px-2 text-sm">
              <option value="summary">Summary</option>
              <option value="outreach">Outreach</option>
              <option value="classification">Classification</option>
              <option value="escalation">Escalation</option>
              <option value="digest">Digest</option>
              <option value="custom">Custom</option>
            </select>
          </div>
        </div>
        <div class="space-y-1.5"><Label>Instructions</Label><textarea v-model="newTask.instructions" class="min-h-[90px] w-full rounded-md border bg-background px-3 py-2 text-sm" /></div>
        <Button class="h-8 w-fit text-xs" :disabled="saving || !selectedRole" @click="createTask">Add task</Button>
      </div>

      <div class="grid gap-3 rounded-lg border p-3">
        <p class="text-sm font-semibold">Create Schedule</p>
        <div class="grid gap-3 sm:grid-cols-3">
          <div class="space-y-1.5">
            <Label>Task ID</Label>
            <Input v-model="newSchedule.task_id" placeholder="Task id from org chart" />
          </div>
          <div class="space-y-1.5"><Label>Cron</Label><Input v-model="newSchedule.cron_expr" /></div>
          <div class="space-y-1.5"><Label>Timezone</Label><Input v-model="newSchedule.timezone" /></div>
        </div>
        <Button class="h-8 w-fit text-xs" :disabled="saving" @click="createSchedule">Create schedule</Button>
      </div>
    </CardContent>
  </Card>
</template>
