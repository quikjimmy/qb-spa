<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

const rows = ref<Array<Record<string, unknown>>>([])
const workItems = ref<Array<Record<string, unknown>>>([])
const loading = ref(false)
const loadingWork = ref(false)
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

function workflowMode(row: Record<string, unknown>): string {
  const body = parsedBody(row)
  if (body.mode === 'case_workflow') return 'Investigate -> review'
  if (body.mode === 'detect_review') return 'Detect -> review'
  if (body.human_review_required) return 'Needs human review'
  return 'Draft / report'
}

function workflowTone(row: Record<string, unknown>): string {
  const body = parsedBody(row)
  if (body.mode === 'case_workflow') return 'bg-indigo-100 text-indigo-800'
  if (body.mode === 'detect_review') return 'bg-amber-100 text-amber-800'
  if (body.human_review_required) return 'bg-sky-100 text-sky-800'
  return 'bg-emerald-100 text-emerald-800'
}

function reviewTone(row: Record<string, unknown>): string {
  if (row.review_status === 'approved') return 'bg-emerald-100 text-emerald-800'
  if (row.review_status === 'dismissed') return 'bg-rose-100 text-rose-800'
  if (row.review_status === 'commented') return 'bg-sky-100 text-sky-800'
  return 'bg-muted text-muted-foreground'
}

function itemRuntime(row: Record<string, unknown>): string {
  const body = parsedBody(row)
  return String(body.runtime || 'builtin')
}

function itemRuntimeTone(row: Record<string, unknown>): string {
  return itemRuntime(row) === 'openclaw'
    ? 'bg-indigo-100 text-indigo-800'
    : 'bg-muted text-muted-foreground'
}

function itemOrchestration(row: Record<string, unknown>): string {
  const body = parsedBody(row)
  return String(body.orchestration_runtime || body.payload?.orchestration_runtime || '')
}

function itemWorkflowKey(row: Record<string, unknown>): string {
  const body = parsedBody(row)
  return String(body.openclaw?.result?.workflow_key || body.payload?.workflow_key || '')
}

function actionFeedbackTone(action: Record<string, any>): string {
  const decision = action.feedback?.decision
  if (decision === 'approved') return 'bg-emerald-100 text-emerald-800'
  if (decision === 'dismissed') return 'bg-rose-100 text-rose-800'
  if (decision === 'commented') return 'bg-sky-100 text-sky-800'
  return 'bg-muted text-muted-foreground'
}

async function load() {
  loading.value = true
  try {
    const params = new URLSearchParams({ limit: '50', scope: scope.value })
    const res = await fetch(`/api/agent-org/delivery/inbox?${params.toString()}`, { headers: hdrs() })
    if (res.ok) rows.value = (await res.json()).rows || []
  } finally { loading.value = false }
}

async function loadWorkItems() {
  loadingWork.value = true
  try {
    const params = new URLSearchParams({ limit: '20', scope: scope.value, status: 'active' })
    const res = await fetch(`/api/agent-org/work-items?${params.toString()}`, { headers: hdrs() })
    if (res.ok) workItems.value = (await res.json()).rows || []
  } finally { loadingWork.value = false }
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

async function reviewItem(id: unknown, decision: 'approved' | 'dismissed' | 'commented') {
  const comment = window.prompt(
    decision === 'commented'
      ? 'Add a comment for this Ari finding'
      : `Optional comment for this ${decision} decision`,
  ) || ''
  const res = await fetch(`/api/agent-org/delivery/inbox/${id}/review`, {
    method: 'POST',
    headers: hdrs(),
    body: JSON.stringify({ decision, comment }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    window.alert(data.error || `Review failed (${res.status})`)
    return
  }
  await load()
  await loadWorkItems()
}

async function reviewAction(rowId: unknown, action: Record<string, unknown>, decision: 'approved' | 'dismissed' | 'commented') {
  const comment = window.prompt(
    decision === 'commented'
      ? 'Add a note for this Ari recommendation'
      : `Optional note for this ${decision} action`,
  ) || ''
  const res = await fetch(`/api/agent-org/delivery/inbox/${rowId}/actions/review`, {
    method: 'POST',
    headers: hdrs(),
    body: JSON.stringify({ action, decision, comment }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    window.alert(data.error || `Action review failed (${res.status})`)
    return
  }
  await load()
}

async function createFollowUpTask(rowId: unknown, action: Record<string, unknown>) {
  const res = await fetch(`/api/agent-org/delivery/inbox/${rowId}/actions/create-task`, {
    method: 'POST',
    headers: hdrs(),
    body: JSON.stringify({ action }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    window.alert(data.error || `Task creation failed (${res.status})`)
    return
  }
  await load()
  await loadWorkItems()
}

async function updateWorkItemStatus(id: unknown, status: 'in_progress' | 'done') {
  const res = await fetch(`/api/agent-org/work-items/${id}`, {
    method: 'PATCH',
    headers: hdrs(),
    body: JSON.stringify({ status }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    window.alert(data.error || `Update failed (${res.status})`)
    return
  }
  await loadWorkItems()
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

onMounted(async () => {
  await load()
  await loadWorkItems()
})
</script>

<template>
  <div class="space-y-4">
  <Card>
    <CardHeader>
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Inbox</CardTitle>
          <CardDescription>Agent outputs delivered for your review and consumption.</CardDescription>
        </div>
        <div class="flex flex-wrap gap-2">
          <Button v-if="auth.isAdmin" :variant="scope === 'mine' ? 'default' : 'outline'" size="sm" class="h-8 text-xs" @click="scope = 'mine'; load()">Mine</Button>
          <Button v-if="auth.isAdmin" :variant="scope === 'all' ? 'default' : 'outline'" size="sm" class="h-8 text-xs" @click="scope = 'all'; load(); loadWorkItems()">All inbox</Button>
          <Button variant="outline" size="sm" class="h-8 text-xs" @click="load(); loadWorkItems()">Refresh</Button>
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
                <Badge :class="workflowTone(row)">{{ workflowMode(row) }}</Badge>
                <Badge :class="itemRuntimeTone(row)" class="capitalize">{{ itemRuntime(row) }}</Badge>
                <Badge :class="reviewTone(row)" class="capitalize">{{ row.review_status || 'pending' }}</Badge>
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

          <div class="flex flex-wrap gap-2">
            <Badge :class="itemRuntimeTone(row)" class="capitalize">{{ itemRuntime(row) }}</Badge>
            <Badge v-if="itemOrchestration(row)" variant="secondary">{{ itemOrchestration(row) }}</Badge>
            <Badge v-if="itemWorkflowKey(row)" variant="secondary">{{ itemWorkflowKey(row) }}</Badge>
          </div>

          <div class="rounded-md border px-3 py-2 text-xs text-muted-foreground">
            Human-in-the-loop:
            <span v-if="parsedBody(row).mode === 'detect_review'">Ari detected an issue and recommended next steps. Review it before any real-world action is taken.</span>
            <span v-else-if="parsedBody(row).human_review_required">This output needs a human decision before anything leaves Agent Ops.</span>
            <span v-else>This item is informational or draft-only and did not take an external action.</span>
          </div>

          <div class="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" class="h-7 text-[11px]" @click="reviewItem(row.id, 'approved')">Approve</Button>
            <Button size="sm" variant="outline" class="h-7 text-[11px]" @click="reviewItem(row.id, 'dismissed')">Dismiss</Button>
            <Button size="sm" variant="outline" class="h-7 text-[11px]" @click="reviewItem(row.id, 'commented')">Comment</Button>
          </div>

          <div v-if="row.review_comment" class="rounded-md border bg-muted/40 px-3 py-2 text-xs">
            <p class="font-medium">Review note</p>
            <p class="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{{ row.review_comment }}</p>
            <p v-if="row.reviewed_at" class="mt-1 text-[11px] text-muted-foreground">Updated {{ fmt(row.reviewed_at) }}</p>
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
            <div v-for="(action, idx) in actions(row)" :key="String(action.project_rid) + String(action.action) + String(idx)" class="rounded-md border bg-background px-3 py-2">
              <div class="flex flex-wrap items-start justify-between gap-2">
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <p class="text-sm font-medium">{{ action.project }}</p>
                    <Badge :class="actionFeedbackTone(action)" class="capitalize">{{ action.feedback?.decision || 'pending' }}</Badge>
                  </div>
                  <p class="text-xs text-muted-foreground">{{ action.issue }}</p>
                  <p class="mt-1 text-[11px]">{{ action.action }}</p>
                  <div class="mt-1 flex flex-wrap gap-2">
                    <Badge v-if="action.classification" variant="secondary" class="capitalize text-[11px]">{{ String(action.classification).replaceAll('_', ' ') }}</Badge>
                    <Badge v-if="action.confidence" variant="secondary" class="capitalize text-[11px]">{{ action.confidence }} confidence</Badge>
                    <Badge v-if="action.next_owner" variant="secondary" class="text-[11px]">{{ action.next_owner }}</Badge>
                  </div>
                  <p v-if="action.recommended_next_step" class="mt-1 text-[11px] text-muted-foreground">{{ action.recommended_next_step }}</p>
                  <p v-if="action.hitl_reason" class="mt-1 text-[11px] text-muted-foreground">
                    Why Ari surfaced this: {{ action.hitl_reason }}
                  </p>
                  <p v-if="action.delayed_ops_revenue" class="mt-1 text-[11px] font-medium">Delayed ops revenue at risk: ${{ Number(action.delayed_ops_revenue).toLocaleString() }}</p>
                  <div v-if="Array.isArray(action.checks) && action.checks.length" class="mt-2 rounded-md border bg-muted/30 px-2 py-2">
                    <p class="text-[11px] font-medium">Checks Ari already ran</p>
                    <div class="mt-1 space-y-1">
                      <div v-for="(check, checkIdx) in action.checks" :key="String(check.worker) + String(checkIdx)" class="text-[11px]">
                        <div class="flex flex-wrap items-center gap-2">
                          <span class="font-medium">{{ check.worker }}</span>
                          <Badge variant="secondary" class="capitalize text-[10px]">{{ check.status }}</Badge>
                          <span class="text-muted-foreground">{{ check.system }}</span>
                        </div>
                        <p class="text-muted-foreground">{{ check.summary }}</p>
                        <p v-if="check.evidence" class="text-muted-foreground/80">{{ check.evidence }}</p>
                      </div>
                    </div>
                  </div>
                  <div v-if="action.feedback?.comment || action.feedback?.created_at" class="mt-2 rounded-md border bg-muted/40 px-2 py-1 text-[11px]">
                    <p v-if="action.feedback?.comment" class="text-muted-foreground whitespace-pre-wrap break-words">{{ action.feedback.comment }}</p>
                    <p v-if="action.feedback?.created_at" class="text-muted-foreground">Saved {{ fmt(action.feedback.created_at) }}</p>
                  </div>
                </div>
                <div class="flex flex-wrap gap-1">
                  <Button size="sm" variant="outline" class="h-7 text-[11px]" @click="reviewAction(row.id, action, 'approved')">Approve</Button>
                  <Button size="sm" variant="outline" class="h-7 text-[11px]" @click="reviewAction(row.id, action, 'dismissed')">Dismiss</Button>
                  <Button size="sm" variant="outline" class="h-7 text-[11px]" @click="reviewAction(row.id, action, 'commented')">Comment</Button>
                  <Button size="sm" variant="outline" class="h-7 text-[11px]" @click="createFollowUpTask(row.id, action)">
                    Create task
                  </Button>
                </div>
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
  <Card>
    <CardHeader>
      <CardTitle>Follow-up Tasks</CardTitle>
      <CardDescription>Project-linked work created from Ari findings and human review.</CardDescription>
    </CardHeader>
    <CardContent class="space-y-2">
      <p v-if="loadingWork" class="text-sm text-muted-foreground">Loading follow-up tasks...</p>
      <p v-else-if="workItems.length === 0" class="text-sm text-muted-foreground">No active follow-up tasks yet.</p>
      <div v-for="item in workItems" :key="String(item.id)" class="rounded-lg border px-3 py-2">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <p class="text-sm font-medium">{{ item.title }}</p>
              <Badge variant="secondary" class="capitalize">{{ item.status }}</Badge>
            </div>
            <p class="text-[11px] text-muted-foreground">{{ item.project_name || 'No linked project' }}<span v-if="item.project_rid"> · #{{ item.project_rid }}</span></p>
            <p v-if="item.detail" class="mt-1 text-[11px] text-muted-foreground whitespace-pre-wrap break-words">{{ item.detail }}</p>
          </div>
          <div class="flex flex-wrap gap-1">
            <Button v-if="item.status === 'open'" size="sm" variant="outline" class="h-7 text-[11px]" @click="updateWorkItemStatus(item.id, 'in_progress')">Start</Button>
            <Button v-if="item.status !== 'done'" size="sm" variant="outline" class="h-7 text-[11px]" @click="updateWorkItemStatus(item.id, 'done')">Done</Button>
          </div>
        </div>
      </div>
    </CardContent>
  </Card>
  </div>
</template>
