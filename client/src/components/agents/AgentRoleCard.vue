<script setup lang="ts">
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import AgentTaskList from './AgentTaskList.vue'

defineOptions({ name: 'AgentRoleCard' })

interface RoleNode {
  id: number
  name: string
  slug: string
  description: string | null
  objective: string
  execution_mode: string
  department: string | null
  status: string
  pending_approvals: number
  latest_run?: { status?: string; created_at?: string } | null
  goals: Array<{ id: number; title: string; success_metric?: string | null }>
  tasks: Array<Record<string, unknown>>
  children: RoleNode[]
}

defineProps<{
  role: RoleNode
  runningTaskId?: number | null
}>()

const emit = defineEmits<{
  (e: 'run', taskId: number): void
}>()

function latestText(run?: { status?: string; created_at?: string } | null): string {
  if (!run?.created_at) return 'No runs yet'
  const d = new Date(run.created_at)
  return `${run.status || 'unknown'} · ${isNaN(d.getTime()) ? run.created_at : d.toLocaleString()}`
}
</script>

<template>
  <Card class="min-w-0">
    <CardHeader class="pb-3">
      <div class="flex flex-wrap items-center gap-2">
        <CardTitle class="text-base">{{ role.name }}</CardTitle>
        <Badge variant="secondary" class="text-[10px] capitalize">{{ role.execution_mode }}</Badge>
        <Badge variant="secondary" class="text-[10px] capitalize">{{ role.status }}</Badge>
        <Badge v-if="role.pending_approvals" class="text-[10px] bg-amber-100 text-amber-800">{{ role.pending_approvals }} approvals</Badge>
      </div>
      <CardDescription>{{ role.description || role.objective }}</CardDescription>
      <p class="text-[11px] text-muted-foreground">{{ latestText(role.latest_run as any) }}</p>
    </CardHeader>
    <CardContent class="space-y-4">
      <div v-if="role.goals?.length" class="space-y-1">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Goals</p>
        <div v-for="goal in role.goals" :key="goal.id" class="rounded-md bg-muted/50 px-2.5 py-2">
          <p class="text-sm font-medium">{{ goal.title }}</p>
          <p v-if="goal.success_metric" class="text-[11px] text-muted-foreground">{{ goal.success_metric }}</p>
        </div>
      </div>

      <div v-if="role.tasks?.length" class="space-y-2">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Tasks</p>
        <AgentTaskList :tasks="role.tasks as any" :running-task-id="runningTaskId" @run="emit('run', $event)" />
      </div>

      <div v-if="role.children?.length" class="space-y-3">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Direct Reports</p>
        <div class="grid gap-3 pl-3 border-l">
          <AgentRoleCard v-for="child in role.children" :key="child.id" :role="child" :running-task-id="runningTaskId" @run="emit('run', $event)" />
        </div>
      </div>
    </CardContent>
  </Card>
</template>
