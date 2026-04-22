<script setup lang="ts">
import { ref } from 'vue'
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
            <TableCell class="capitalize">{{ run.status || '—' }}</TableCell>
            <TableCell class="capitalize">{{ run.trigger || '—' }}</TableCell>
            <TableCell>{{ fmt(run.created_at) }}</TableCell>
          </TableRow>
          <TableRow v-if="expandedRunId === String(run.id)">
            <TableCell colspan="5" class="bg-muted/40">
              <pre class="whitespace-pre-wrap break-words text-[11px]">{{ preview(run) }}</pre>
            </TableCell>
          </TableRow>
        </template>
      </TableBody>
    </Table>
  </div>
</template>
