<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/auth'
import { RouterLink } from 'vue-router'

interface AgentTask {
  id: number
  name: string
  task_type: string
  runtime?: string
  instructions: string
  enabled: number
  output_schema_json?: string | Record<string, unknown> | null
  cron_expr?: string | null
  timezone?: string | null
  next_run_at?: string | null
  last_run_at?: string | null
}

defineProps<{
  tasks: AgentTask[]
  runningTaskId?: number | null
}>()

const emit = defineEmits<{
  (e: 'run', taskId: number, payload?: Record<string, unknown>): void
  (e: 'deliverPcDigest', taskId: number): void
  (e: 'changed'): void
}>()

const auth = useAuthStore()

function hdrs() {
  return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }
}

function fmt(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

function isPcDigest(task: AgentTask): boolean {
  return task.name === 'Generate daily coordinator digest'
}

function schema(task: AgentTask): Record<string, unknown> {
  if (!task.output_schema_json) return {}
  if (typeof task.output_schema_json === 'object') return task.output_schema_json
  try {
    return JSON.parse(task.output_schema_json)
  } catch {
    return {}
  }
}

function workflowLabel(task: AgentTask): string {
  const data = schema(task)
  if (data['workflow'] === 'case_workflow') return 'Investigate -> review'
  if (data['workflow'] === 'detect_review') return 'Detect -> review'
  if (data['approval_required'] === true) return 'Draft -> approval'
  if (isPcDigest(task)) return 'Digest delivery'
  return 'Run on demand'
}

function workflowTone(task: AgentTask): string {
  const data = schema(task)
  if (data['workflow'] === 'case_workflow') return 'bg-indigo-100 text-indigo-800'
  if (data['workflow'] === 'detect_review') return 'bg-amber-100 text-amber-800'
  if (data['approval_required'] === true) return 'bg-sky-100 text-sky-800'
  if (isPcDigest(task)) return 'bg-emerald-100 text-emerald-800'
  return 'bg-muted text-muted-foreground'
}

function runLabel(task: AgentTask): string {
  if (isPcDigest(task)) return 'Deliver to PCs'
  const data = schema(task)
  if (data['workflow'] === 'case_workflow') return 'Run workflow'
  if (data['workflow'] === 'detect_review') return 'Run scan'
  if (data['approval_required'] === true) return 'Draft now'
  return 'Run now'
}

async function deleteTask(task: AgentTask) {
  const ok = window.confirm(`Delete "${task.name}"?\n\nThis removes the task, its schedule, and any saved edit drafts. Past run history will stay attached to the agent but no longer point to this task.`)
  if (!ok) return
  const res = await fetch(`/api/agent-org/tasks/${task.id}`, {
    method: 'DELETE',
    headers: hdrs(),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    window.alert(data.error || `Delete failed (${res.status})`)
    return
  }
  emit('changed')
}
</script>

<template>
  <div class="space-y-2">
    <div v-for="task in tasks" :key="task.id" class="rounded-lg border px-3 py-2">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <p class="text-sm font-medium truncate">{{ task.name }}</p>
            <span class="rounded-full px-2 py-0.5 text-[10px] font-medium" :class="workflowTone(task)">{{ workflowLabel(task) }}</span>
          </div>
          <p class="text-[11px] text-muted-foreground capitalize">{{ task.task_type }}</p>
          <p class="mt-1 text-[11px] text-muted-foreground leading-relaxed">{{ task.instructions }}</p>
          <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
            <span v-if="task.runtime">Runtime {{ task.runtime }}</span>
            <span v-if="task.cron_expr">Cron {{ task.cron_expr }}</span>
            <span v-if="task.timezone">{{ task.timezone }}</span>
            <span>Next {{ fmt(task.next_run_at) }}</span>
            <span>Last {{ fmt(task.last_run_at) }}</span>
          </div>
        </div>
        <div class="flex shrink-0 flex-col gap-2">
          <Button v-if="!isPcDigest(task)" size="sm" variant="outline" class="h-7 text-[11px]" :disabled="runningTaskId === task.id || task.enabled !== 1" @click="emit('run', task.id)">
            {{ runningTaskId === task.id ? 'Running...' : runLabel(task) }}
          </Button>
          <Button v-if="isPcDigest(task)" size="sm" class="h-7 text-[11px]" :disabled="runningTaskId === task.id || task.enabled !== 1" @click="emit('deliverPcDigest', task.id)">
            {{ runningTaskId === task.id ? 'Running...' : runLabel(task) }}
          </Button>
          <Button as-child size="sm" variant="outline" class="h-7 text-[11px]">
            <RouterLink :to="`/agents/tasks/${task.id}`">Design task</RouterLink>
          </Button>
          <Button v-if="auth.isAdmin" size="sm" variant="outline" class="h-7 text-[11px] text-destructive hover:text-destructive" @click="deleteTask(task)">
            Delete
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>
