<script setup lang="ts">
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import AgentRunsTable from './AgentRunsTable.vue'
import AgentTaskList from './AgentTaskList.vue'

interface RoleNode {
  id: number
  name: string
  slug: string
  description?: string | null
  objective: string
  execution_mode: string
  department?: string | null
  status: string
  tokens_used_month?: number
  monthly_token_cap?: number
  approval_required?: number
  pending_approvals?: number
  latest_run?: { status?: string; created_at?: string } | null
  goals?: Array<{ id: number; title: string; description?: string | null; success_metric?: string | null; status?: string }>
  tasks?: Array<Record<string, unknown>>
  children?: RoleNode[]
}

const props = defineProps<{
  role: RoleNode | null
  runs: Array<Record<string, unknown>>
  runningTaskId?: number | null
}>()

const emit = defineEmits<{
  (e: 'run', taskId: number, payload?: Record<string, unknown>): void
  (e: 'deliverPcDigest', taskId: number): void
}>()

const isRunning = computed(() => ['queued', 'running'].includes(String(props.role?.latest_run?.status || '')))
const activeTasks = computed(() => (props.role?.tasks || []).filter(task => Number(task.enabled) === 1).length)

function fmt(iso?: string | null): string {
  if (!iso) return 'No runs yet'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : d.toLocaleString()
}
</script>

<template>
  <Card v-if="role">
    <CardHeader>
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <CardTitle>{{ role.name }}</CardTitle>
            <Badge variant="secondary" class="capitalize">{{ role.execution_mode }}</Badge>
            <Badge :class="isRunning ? 'bg-sky-100 text-sky-800' : 'bg-emerald-100 text-emerald-800'">
              {{ isRunning ? 'running now' : role.status }}
            </Badge>
            <Badge v-if="role.pending_approvals" class="bg-amber-100 text-amber-800">{{ role.pending_approvals }} approvals</Badge>
          </div>
          <CardDescription class="mt-1">{{ role.department || 'Production agent' }}</CardDescription>
        </div>
        <Button v-if="role.tasks?.[0]" size="sm" variant="outline" class="h-8 text-xs" :disabled="runningTaskId === Number(role.tasks[0].id)" @click="emit('run', Number(role.tasks[0].id))">
          {{ runningTaskId === Number(role.tasks[0].id) ? 'Running...' : 'Run primary task' }}
        </Button>
      </div>
    </CardHeader>
    <CardContent class="space-y-5">
      <div class="grid gap-3 sm:grid-cols-4">
        <div class="rounded-lg border px-3 py-2">
          <p class="text-[11px] uppercase tracking-wide text-muted-foreground">Tasks</p>
          <p class="text-2xl font-semibold">{{ activeTasks }}</p>
        </div>
        <div class="rounded-lg border px-3 py-2">
          <p class="text-[11px] uppercase tracking-wide text-muted-foreground">Goals</p>
          <p class="text-2xl font-semibold">{{ role.goals?.length || 0 }}</p>
        </div>
        <div class="rounded-lg border px-3 py-2">
          <p class="text-[11px] uppercase tracking-wide text-muted-foreground">Workers</p>
          <p class="text-2xl font-semibold">{{ role.children?.length || 0 }}</p>
        </div>
        <div class="rounded-lg border px-3 py-2">
          <p class="text-[11px] uppercase tracking-wide text-muted-foreground">Last Run</p>
          <p class="truncate text-sm font-medium">{{ fmt(role.latest_run?.created_at || null) }}</p>
        </div>
      </div>

      <div>
        <p class="text-sm font-semibold">Objective</p>
        <p class="mt-1 text-sm text-muted-foreground">{{ role.objective }}</p>
      </div>

      <div v-if="role.goals?.length" class="grid gap-2">
        <p class="text-sm font-semibold">Goals</p>
        <div v-for="goal in role.goals" :key="goal.id" class="rounded-lg border px-3 py-2">
          <p class="text-sm font-medium">{{ goal.title }}</p>
          <p v-if="goal.success_metric" class="text-[11px] text-muted-foreground">{{ goal.success_metric }}</p>
          <p v-if="goal.description" class="mt-1 text-xs text-muted-foreground">{{ goal.description }}</p>
        </div>
      </div>

      <div v-if="role.tasks?.length" class="space-y-2">
        <p class="text-sm font-semibold">Routines And Tasks</p>
        <AgentTaskList
          :tasks="role.tasks as any"
          :running-task-id="runningTaskId"
          @run="(taskId, payload) => emit('run', taskId, payload)"
          @deliver-pc-digest="emit('deliverPcDigest', $event)"
        />
      </div>

      <div class="space-y-2">
        <p class="text-sm font-semibold">Recent Activity</p>
        <AgentRunsTable :runs="runs" />
      </div>
    </CardContent>
  </Card>
</template>
