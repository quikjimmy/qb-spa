<script setup lang="ts">
import { ref } from 'vue'
import { Badge } from '@/components/ui/badge'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

defineProps<{
  runs: Array<Record<string, unknown>>
}>()

function fmt(iso?: unknown): string {
  if (!iso || typeof iso !== 'string') return '—'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : d.toLocaleString()
}

const expandedRunId = ref<string | null>(null)

function preview(run: Record<string, unknown>): string {
  const raw = run.result_json || run.error || run.payload_json
  if (!raw) return 'No result yet.'
  if (typeof raw !== 'string') return JSON.stringify(raw, null, 2)
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

function parsedResult(run: Record<string, unknown>): Record<string, any> {
  const raw = run.result_json
  if (typeof raw !== 'string') return typeof raw === 'object' && raw ? raw as Record<string, any> : {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function runtime(run: Record<string, unknown>): string {
  const result = parsedResult(run)
  return String(result.runtime || run.task_runtime || 'builtin')
}

function orchestrationRuntime(run: Record<string, unknown>): string {
  const result = parsedResult(run)
  return String(result.orchestration_runtime || result.payload?.orchestration_runtime || '')
}

function workflowKey(run: Record<string, unknown>): string {
  const result = parsedResult(run)
  return String(
    result.openclaw?.result?.workflow_key
    || result.payload?.workflow_key
    || ''
  )
}

function runtimeTone(run: Record<string, unknown>): string {
  return runtime(run) === 'openclaw'
    ? 'bg-indigo-100 text-indigo-800'
    : 'bg-muted text-muted-foreground'
}
</script>

<template>
  <div class="rounded-lg border overflow-hidden">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Role</TableHead>
          <TableHead>Task</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Trigger</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <template v-for="run in runs" :key="String(run.id)">
          <TableRow class="cursor-pointer" @click="expandedRunId = expandedRunId === String(run.id) ? null : String(run.id)">
            <TableCell>{{ run.role_name || '—' }}</TableCell>
            <TableCell>{{ run.task_name || '—' }}</TableCell>
            <TableCell>
              <div class="flex flex-wrap items-center gap-2">
                <span class="capitalize">{{ run.status || '—' }}</span>
                <Badge :class="runtimeTone(run)" class="capitalize">{{ runtime(run) }}</Badge>
              </div>
            </TableCell>
            <TableCell class="capitalize">{{ run.trigger || '—' }}</TableCell>
            <TableCell>{{ fmt(run.created_at) }}</TableCell>
          </TableRow>
          <TableRow v-if="expandedRunId === String(run.id)">
            <TableCell colspan="5" class="bg-muted/40">
              <div class="mb-3 flex flex-wrap gap-2">
                <Badge :class="runtimeTone(run)" class="capitalize">{{ runtime(run) }}</Badge>
                <Badge v-if="orchestrationRuntime(run)" variant="secondary">{{ orchestrationRuntime(run) }}</Badge>
                <Badge v-if="workflowKey(run)" variant="secondary">{{ workflowKey(run) }}</Badge>
              </div>
              <pre class="whitespace-pre-wrap break-words text-[11px]">{{ preview(run) }}</pre>
            </TableCell>
          </TableRow>
        </template>
      </TableBody>
    </Table>
  </div>
</template>
