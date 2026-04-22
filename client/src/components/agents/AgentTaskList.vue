<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { RouterLink } from 'vue-router'

interface AgentTask {
  id: number
  name: string
  task_type: string
  instructions: string
  enabled: number
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
}>()

function fmt(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

function samplePayload(task: AgentTask): Record<string, unknown> | null {
  if (!isPcDigest(task)) return null
  return {
    coordinator: 'Paige',
    day: new Date().toLocaleDateString(undefined, { weekday: 'long' }),
    installs: [
      {
        rid: 12345,
        customer_name: 'Winters Residence',
        location: 'Tampa, FL',
        lender: 'GoodLeap',
        permit_status: 'Permit approved yesterday',
        system_kw: 8.4,
      },
      {
        rid: 12346,
        customer_name: 'Sanchez Residence',
        location: 'Orlando, FL',
        lender: 'Mosaic',
        permit_status: 'NO PERMIT — submitted 2026-04-08, 13d pending',
        system_kw: 10.1,
      },
    ],
    attention_items: [
      {
        rid: 12346,
        project_name: 'Sanchez Residence',
        issue: 'Permit pending 13 days',
        context: 'AHJ follow-up needed before install can stay on schedule.',
        system_kw: 10.1,
      },
      {
        rid: 12347,
        project_name: 'Patel Residence',
        issue: 'Inspection overdue',
        context: 'Final inspection not confirmed after install completion.',
        system_kw: 7.2,
      },
    ],
    wins: [
      'Three permits approved yesterday',
      'Two installs cleared for scheduling',
    ],
  }
}

function isPcDigest(task: AgentTask): boolean {
  return task.name === 'Generate daily coordinator digest'
}

function livePayload(task: AgentTask): Record<string, unknown> | null {
  if (!isPcDigest(task)) return null
  return {
    use_live_data: true,
    coordinator: 'Paige Prymak',
    coordinator_email: 'paige@kinhome.com',
    inspection_days: 30,
  }
}
</script>

<template>
  <div class="space-y-2">
    <div v-for="task in tasks" :key="task.id" class="rounded-lg border px-3 py-2">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="text-sm font-medium truncate">{{ task.name }}</p>
          <p class="text-[11px] text-muted-foreground capitalize">{{ task.task_type }}</p>
          <p class="mt-1 text-[11px] text-muted-foreground leading-relaxed">{{ task.instructions }}</p>
          <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
            <span v-if="task.cron_expr">Cron {{ task.cron_expr }}</span>
            <span v-if="task.timezone">{{ task.timezone }}</span>
            <span>Next {{ fmt(task.next_run_at) }}</span>
            <span>Last {{ fmt(task.last_run_at) }}</span>
          </div>
        </div>
        <div class="flex shrink-0 flex-col gap-2">
          <Button v-if="!isPcDigest(task)" size="sm" variant="outline" class="h-7 text-[11px]" :disabled="runningTaskId === task.id || task.enabled !== 1" @click="emit('run', task.id)">
            {{ runningTaskId === task.id ? 'Running...' : 'Run now' }}
          </Button>
          <Button v-if="samplePayload(task)" size="sm" variant="outline" class="h-7 text-[11px]" :disabled="runningTaskId === task.id || task.enabled !== 1" @click="emit('run', task.id, samplePayload(task) || undefined)">
            Run sample
          </Button>
          <Button v-if="livePayload(task)" size="sm" variant="outline" class="h-7 text-[11px]" :disabled="runningTaskId === task.id || task.enabled !== 1" @click="emit('run', task.id, livePayload(task) || undefined)">
            Run live
          </Button>
          <Button v-if="isPcDigest(task)" size="sm" class="h-7 text-[11px]" :disabled="runningTaskId === task.id || task.enabled !== 1" @click="emit('deliverPcDigest', task.id)">
            Generate PC dept
          </Button>
          <Button as-child size="sm" variant="outline" class="h-7 text-[11px]">
            <RouterLink :to="`/agents/tasks/${task.id}`">Design task</RouterLink>
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>
