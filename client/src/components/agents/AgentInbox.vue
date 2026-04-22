<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

const rows = ref<Array<Record<string, unknown>>>([])
const loading = ref(false)
const expandedId = ref<string | null>(null)
const scope = ref<'mine' | 'all'>('mine')

function fmt(iso?: unknown): string {
  if (!iso || typeof iso !== 'string') return ''
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function preview(row: Record<string, unknown>): string {
  const raw = row.body_json || row.error
  if (!raw) return 'No body available.'
  if (typeof raw !== 'string') return JSON.stringify(raw, null, 2)
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

function parsedBody(row: Record<string, unknown>): Record<string, any> {
  const raw = row.body_json
  if (typeof raw !== 'string') return typeof raw === 'object' && raw ? raw as Record<string, any> : {}
  try {
    return JSON.parse(raw)
  } catch {
    return { summary: raw }
  }
}

function actions(row: Record<string, unknown>): Array<Record<string, any>> {
  const body = parsedBody(row)
  return Array.isArray(body.actions) ? body.actions : []
}

function queryCounts(row: Record<string, unknown>): Record<string, unknown> {
  const body = parsedBody(row)
  return body.payload?.query_counts || {}
}

async function load() {
  loading.value = true
  try {
    const params = new URLSearchParams({ limit: '50', scope: scope.value })
    const res = await fetch(`/api/agent-org/delivery/inbox?${params.toString()}`, { headers: hdrs() })
    if (res.ok) rows.value = (await res.json()).rows || []
  } finally { loading.value = false }
}

async function markRead(id: unknown) {
  await fetch(`/api/agent-org/delivery/inbox/${id}/read`, { method: 'POST', headers: hdrs() })
  await load()
}

async function markUnread(id: unknown) {
  await fetch(`/api/agent-org/delivery/inbox/${id}/unread`, { method: 'POST', headers: hdrs() })
  await load()
}

async function deleteItem(id: unknown) {
  if (!window.confirm('Delete this inbox item?')) return
  await fetch(`/api/agent-org/delivery/inbox/${id}`, { method: 'DELETE', headers: hdrs() })
  await load()
}

async function forwardItem(id: unknown) {
  const email = window.prompt('Forward to team member email')
  if (!email?.trim()) return
  await fetch(`/api/agent-org/delivery/inbox/${id}/forward`, {
    method: 'POST',
    headers: hdrs(),
    body: JSON.stringify({ email: email.trim() }),
  })
  await load()
}

async function toggleExpanded(row: Record<string, unknown>) {
  const id = String(row.id)
  const opening = expandedId.value !== id
  expandedId.value = opening ? id : null
  if (opening && scope.value === 'mine' && !row.read_at) {
    await fetch(`/api/agent-org/delivery/inbox/${row.id}/read`, { method: 'POST', headers: hdrs() })
    row.read_at = new Date().toISOString()
  }
}

onMounted(load)
</script>

<template>
  <Card>
    <CardHeader>
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Inbox</CardTitle>
          <CardDescription>Agent outputs delivered for your review and consumption.</CardDescription>
        </div>
        <div class="flex flex-wrap gap-2">
          <Button v-if="auth.isAdmin" :variant="scope === 'mine' ? 'default' : 'outline'" size="sm" class="h-8 text-xs" @click="scope = 'mine'; load()">Mine</Button>
          <Button v-if="auth.isAdmin" :variant="scope === 'all' ? 'default' : 'outline'" size="sm" class="h-8 text-xs" @click="scope = 'all'; load()">All inbox</Button>
          <Button variant="outline" size="sm" class="h-8 text-xs" @click="load">Refresh</Button>
        </div>
      </div>
    </CardHeader>
    <CardContent class="space-y-2">
      <p v-if="loading" class="text-sm text-muted-foreground">Loading inbox...</p>
      <p v-else-if="rows.length === 0" class="text-sm text-muted-foreground">No delivered agent outputs yet.</p>
      <div v-for="row in rows" :key="String(row.id)" class="rounded-lg border px-3 py-2">
        <button type="button" class="w-full text-left" @click="toggleExpanded(row)">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <p class="truncate text-sm font-medium">{{ row.title }}</p>
                <Badge v-if="!row.read_at" class="bg-sky-100 text-sky-800">new</Badge>
                <Badge variant="secondary" class="capitalize">{{ row.status }}</Badge>
              </div>
              <p class="text-[11px] text-muted-foreground">
                <template v-if="scope === 'all'">{{ row.recipient_name || row.recipient_email }} · </template>
                {{ row.delivery_name || row.task_name || 'Agent delivery' }} · {{ fmt(row.created_at) }}
              </p>
            </div>
            <div v-if="scope === 'mine'" class="flex flex-wrap gap-1">
              <Button v-if="!row.read_at" variant="outline" size="sm" class="h-7 text-[11px]" @click.stop="markRead(row.id)">Read</Button>
              <Button v-else variant="outline" size="sm" class="h-7 text-[11px]" @click.stop="markUnread(row.id)">Unread</Button>
              <Button variant="outline" size="sm" class="h-7 text-[11px]" @click.stop="forwardItem(row.id)">Forward</Button>
              <Button variant="ghost" size="sm" class="h-7 text-[11px] text-destructive hover:text-destructive" @click.stop="deleteItem(row.id)">Delete</Button>
            </div>
          </div>
        </button>
        <div v-if="expandedId === String(row.id)" class="mt-3 space-y-3">
          <div v-if="parsedBody(row).summary" class="rounded-md bg-muted p-3 text-sm whitespace-pre-wrap break-words">
            {{ parsedBody(row).summary }}
          </div>

          <div v-if="Object.keys(queryCounts(row)).length" class="rounded-md border px-3 py-2">
            <p class="text-xs font-semibold">Report inputs</p>
            <div class="mt-2 flex flex-wrap gap-2">
              <Badge v-for="(value, key) in queryCounts(row)" :key="String(key)" variant="secondary" class="text-[11px]">
                {{ String(key).replaceAll('_', ' ') }}: {{ value }}
              </Badge>
            </div>
          </div>

          <div v-if="actions(row).length" class="space-y-2">
            <p class="text-xs font-semibold">Recommended agent work</p>
            <div v-for="action in actions(row)" :key="String(action.project_rid) + String(action.action)" class="rounded-md border bg-background px-3 py-2">
              <div class="flex flex-wrap items-start justify-between gap-2">
                <div class="min-w-0">
                  <p class="text-sm font-medium">{{ action.project }}</p>
                  <p class="text-xs text-muted-foreground">{{ action.issue }}</p>
                  <p class="mt-1 text-[11px]">Route to {{ action.target_department }} agent: {{ action.action }}</p>
                </div>
                <Button size="sm" variant="outline" class="h-7 text-[11px]" disabled>
                  Route next
                </Button>
              </div>
            </div>
          </div>

          <details class="rounded-md border bg-muted/40 p-3">
            <summary class="cursor-pointer text-xs font-medium">Raw payload</summary>
            <pre class="mt-2 max-h-[320px] overflow-auto whitespace-pre-wrap break-words text-[11px]">{{ preview(row) }}</pre>
          </details>
        </div>
      </div>
    </CardContent>
  </Card>
</template>
