<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const router = useRouter()
function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

const roles = ref<Array<Record<string, unknown>>>([])
const llmOptions = ref<Array<{ id: string; label: string }>>([])
const departments = ref<Array<{ id: number; name: string }>>([])
const mode = ref<'production' | 'testing'>('testing')
const saving = ref(false)
const error = ref('')

const production = ref({
  name: '',
  slug: '',
  objective: '',
  description: '',
  execution_mode: 'worker',
  parent_role_id: '',
  department: '',
  llm: 'builtin-worker',
})

const testing = ref({
  name: '',
  objective: '',
  llm: '',
  department: '',
})

async function load() {
  const [rolesRes, llmRes, deptRes] = await Promise.all([
    fetch('/api/agent-org/roles', { headers: hdrs() }),
    fetch('/api/user-agents/llms', { headers: hdrs() }),
    fetch('/api/user-settings/my-departments', { headers: hdrs() }),
  ])
  if (rolesRes.ok) roles.value = (await rolesRes.json()).flat || []
  if (llmRes.ok) llmOptions.value = (await llmRes.json()).options || []
  if (deptRes.ok) departments.value = (await deptRes.json()).departments || []
}

async function save() {
  saving.value = true
  error.value = ''
  try {
    if (mode.value === 'production') {
      const res = await fetch('/api/agent-org/roles', {
        method: 'POST',
        headers: hdrs(),
        body: JSON.stringify({
          ...production.value,
          parent_role_id: production.value.parent_role_id ? Number(production.value.parent_role_id) : null,
          monthly_token_cap: 100000,
          approval_required: 1,
          is_lab_only: 0,
          status: 'active',
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        error.value = data.error || `Create failed (${res.status})`
        return
      }
      router.push('/agents')
      return
    }
    const res = await fetch('/api/user-agents', {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify(testing.value),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      error.value = data.error || `Create failed (${res.status})`
      return
    }
    router.push('/agents')
  } finally { saving.value = false }
}

onMounted(load)
</script>

<template>
  <div class="grid max-w-3xl gap-4">
    <div>
      <Button variant="ghost" size="sm" class="h-8 px-0 text-xs" @click="router.push('/agents')">Back to agents</Button>
      <h1 class="text-2xl font-semibold tracking-tight">Create Agent</h1>
      <p class="text-sm text-muted-foreground">Create a production agent or a personal testing agent.</p>
    </div>

    <Card>
      <CardHeader>
        <CardTitle>Agent Type</CardTitle>
        <CardDescription>Production agents are part of the hierarchy. Testing agents stay in Agent Lab.</CardDescription>
      </CardHeader>
      <CardContent class="flex flex-wrap gap-2">
        <Button :variant="mode === 'testing' ? 'default' : 'outline'" class="h-8 text-xs" @click="mode = 'testing'">Testing</Button>
        <Button v-if="auth.isAdmin" :variant="mode === 'production' ? 'default' : 'outline'" class="h-8 text-xs" @click="mode = 'production'">Production</Button>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>{{ mode === 'production' ? 'Production Agent' : 'Testing Agent' }}</CardTitle>
      </CardHeader>
      <CardContent class="grid gap-4">
        <p v-if="error" class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{{ error }}</p>

        <template v-if="mode === 'production'">
          <div class="grid gap-4 sm:grid-cols-2">
            <div class="space-y-2">
              <Label>Name</Label>
              <Input v-model="production.name" placeholder="Inspection Manager" />
            </div>
            <div class="space-y-2">
              <Label>Slug</Label>
              <Input v-model="production.slug" placeholder="inspection-manager" />
            </div>
          </div>
          <div class="space-y-2">
            <Label>Objective</Label>
            <textarea v-model="production.objective" class="min-h-28 w-full rounded-md border bg-background px-3 py-2 text-sm" />
          </div>
          <div class="grid gap-4 sm:grid-cols-3">
            <div class="space-y-2">
              <Label>Execution mode</Label>
              <select v-model="production.execution_mode" class="h-10 w-full rounded-md border bg-background px-3 text-sm">
                <option value="manager">Manager</option>
                <option value="worker">Worker</option>
                <option value="singleton">Singleton</option>
              </select>
            </div>
            <div class="space-y-2">
              <Label>Parent</Label>
              <select v-model="production.parent_role_id" class="h-10 w-full rounded-md border bg-background px-3 text-sm">
                <option value="">No parent</option>
                <option v-for="role in roles" :key="String(role.id)" :value="String(role.id)">{{ role.name }}</option>
              </select>
            </div>
            <div class="space-y-2">
              <Label>Department</Label>
              <Input v-model="production.department" placeholder="Inspection" />
            </div>
          </div>
        </template>

        <template v-else>
          <div class="grid gap-4 sm:grid-cols-2">
            <div class="space-y-2">
              <Label>Name</Label>
              <Input v-model="testing.name" placeholder="Project digest helper" />
            </div>
            <div class="space-y-2">
              <Label>LLM</Label>
              <Select :model-value="testing.llm || '__empty__'" @update:model-value="(v:any) => testing.llm = String(v) === '__empty__' ? '' : String(v)">
                <SelectTrigger><SelectValue placeholder="Select model" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__empty__" disabled>Select model</SelectItem>
                  <SelectItem v-for="opt in llmOptions" :key="opt.id" :value="opt.id">{{ opt.label }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div class="space-y-2">
            <Label>Objective</Label>
            <textarea v-model="testing.objective" class="min-h-28 w-full rounded-md border bg-background px-3 py-2 text-sm" />
          </div>
          <div class="space-y-2">
            <Label>Department</Label>
            <Select :model-value="testing.department || '__none__'" @update:model-value="(v:any) => testing.department = String(v) === '__none__' ? '' : String(v)">
              <SelectTrigger><SelectValue placeholder="Optional department" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No department</SelectItem>
                <SelectItem v-for="dept in departments" :key="dept.id" :value="dept.name">{{ dept.name }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </template>

        <div>
          <Button class="h-8 text-xs" :disabled="saving" @click="save">{{ saving ? 'Creating...' : 'Create agent' }}</Button>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
