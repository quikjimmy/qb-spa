<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuthStore } from '@/stores/auth'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

const task = ref<Record<string, any> | null>(null)
const draftMeta = ref<Record<string, any> | null>(null)
const draft = ref<Record<string, any>>({})
const message = ref('')
const messages = ref<Array<{ role: 'user' | 'assistant' | 'system'; content: string; patch?: Record<string, any> | null; review?: Record<string, any> | null }>>([])
const pendingPatch = ref<Record<string, any> | null>(null)
const review = ref<Record<string, any> | null>(null)
const testOutput = ref<Record<string, any> | null>(null)
const loading = ref(false)
const chatting = ref(false)
const saving = ref(false)
const testing = ref(false)
const requestingReview = ref(false)
const error = ref('')
const saved = ref('')
const users = ref<Array<{ id: number; name: string; email: string }>>([])
const selectedTestUserId = ref<number | ''>('')

const taskId = computed(() => Number(route.params.id))
const criteria = computed(() => [
  { label: 'Department', value: draft.value.department || task.value?.department || 'Production' },
  { label: 'Role', value: task.value?.role_name || 'Agent role' },
  { label: 'Task type', value: draft.value.task_type || task.value?.task_type || 'custom' },
  { label: 'Enabled', value: Number(draft.value.enabled ?? task.value?.enabled ?? 0) === 1 ? 'Yes' : 'No' },
  { label: 'Schedule', value: task.value?.cron_expr ? `${task.value.cron_expr} (${task.value.timezone || 'local'})` : 'Manual' },
])
const isRequested = computed(() => draftMeta.value?.status === 'requested')
const taskSummary = computed(() => ({
  name: draft.value.name || task.value?.name,
  owner: `${task.value?.role_name || 'Agent'} · ${task.value?.department || 'Production'}`,
  type: draft.value.task_type || task.value?.task_type || 'custom',
  status: isRequested.value ? 'In production review' : 'Draft editable',
  schedule: task.value?.cron_expr ? `${task.value.cron_expr} (${task.value.timezone || 'local'})` : 'Manual',
}))
const taskTypes = ['summary', 'outreach', 'classification', 'escalation', 'digest', 'custom']
const proposedDraft = computed(() => pendingPatch.value ? { ...draft.value, ...pendingPatch.value } : null)
const instructionDiff = computed(() => {
  const patchInstructions = pendingPatch.value?.instructions
  if (typeof patchInstructions !== 'string') return []
  return diffLines(String(draft.value.instructions || ''), patchInstructions)
})
const hasPendingPatch = computed(() => pendingPatch.value && Object.keys(pendingPatch.value).length > 0)

function parseJson(raw: unknown, fallback: any) {
  if (!raw) return fallback
  if (typeof raw === 'object') return raw
  try { return JSON.parse(String(raw)) } catch { return fallback }
}

function resetDraftFromTask() {
  if (!task.value) return
  draft.value = {
    name: task.value.name || '',
    task_type: task.value.task_type || 'custom',
    enabled: Number(task.value.enabled ?? 1),
    instructions: task.value.instructions || '',
    input_template_json: parseJson(task.value.input_template_json, {}),
    output_schema_json: parseJson(task.value.output_schema_json, {}),
  }
  if (draftMeta.value?.draft_json) {
    const savedDraft = parseJson(draftMeta.value.draft_json, null)
    if (savedDraft) draft.value = { ...draft.value, ...savedDraft }
  }
  if (draftMeta.value?.compliance_review_json) review.value = parseJson(draftMeta.value.compliance_review_json, null)
  if (draftMeta.value?.status === 'requested') pendingPatch.value = null
  if (task.value?.messages) messages.value = []
  if (messages.value.length === 0) {
    messages.value = [{
      role: 'assistant',
      content: 'Tell me what you want this task to do. I will update the draft, summarize the changes, and run compliance review before anything can move toward production.',
      review: null,
    }]
  }
}

function summarizePatch(patch: Record<string, any>): string {
  const changed = Object.keys(patch || {})
  if (!changed.length) return 'No draft fields changed.'
  return `Updated draft fields: ${changed.join(', ')}.`
}

function diffLines(before: string, after: string) {
  const a = before.split(/\r?\n/)
  const b = after.split(/\r?\n/)
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = (a[i] || '') === (b[j] || '') ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const out: Array<{ type: 'same' | 'added' | 'removed'; text: string }> = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] || '' })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: 'removed', text: a[i] || '' })
      i++
    } else {
      out.push({ type: 'added', text: b[j] || '' })
      j++
    }
  }
  while (i < a.length) out.push({ type: 'removed', text: a[i++] || '' })
  while (j < b.length) out.push({ type: 'added', text: b[j++] || '' })
  return out.filter(line => line.text.trim() || line.type !== 'same')
}

async function loadUsers() {
  if (!auth.isAdmin) return
  const res = await fetch('/api/admin/users', { headers: hdrs() })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return
  users.value = data.users || []
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const res = await fetch(`/api/agent-org/tasks/detail/${taskId.value}`, { headers: hdrs() })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      error.value = data.error || `Load failed (${res.status})`
      return
    }
    task.value = data.task
    draftMeta.value = data.draft
    messages.value = (data.messages || []).map((row: Record<string, any>) => ({
      role: row.role,
      content: row.content,
      patch: parseJson(row.patch_json, null),
      review: parseJson(row.compliance_review_json, null),
    }))
    resetDraftFromTask()
    await loadUsers()
  } finally { loading.value = false }
}

async function ask() {
  const userText = message.value.trim()
  if (!userText) return
  if (isRequested.value) {
    error.value = 'This draft is in production review. Withdraw the review before making more edits.'
    return
  }
  chatting.value = true
  error.value = ''
  saved.value = ''
  messages.value.push({ role: 'user', content: userText })
  message.value = ''
  try {
    const res = await fetch(`/api/agent-org/tasks/${taskId.value}/edit-chat`, {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify({ message: userText, draft: draft.value }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      error.value = data.error || `Chat failed (${res.status})`
      messages.value.push({ role: 'assistant', content: error.value, review: data.review || null })
      return
    }
    review.value = data.review || null
    if (review.value?.review_required === 'blocked') {
      messages.value.push({
        role: 'assistant',
        content: `${review.value.summary} I did not apply this change to the draft.`,
        review: review.value,
      })
      return
    }
    const patch = data.patch || {}
    const changed = Object.keys(patch)
    pendingPatch.value = changed.length ? patch : null
    messages.value.push({
      role: 'assistant',
      content: changed.length
        ? `${data.reply || 'I proposed a draft update.'}\n\n${summarizePatch(patch)}\n\nAccept these changes if this matches what you want.`
        : data.reply || 'I reviewed the task context. Ask me to turn this into draft instructions when you are ready.',
      patch,
      review: review.value,
    })
  } finally { chatting.value = false }
}

function applyPendingPatch() {
  if (!pendingPatch.value || isRequested.value) return
  draft.value = { ...draft.value, ...pendingPatch.value }
  messages.value.push({ role: 'system', content: 'Proposed changes applied to the working draft.', review: review.value })
  pendingPatch.value = null
}

function declinePendingPatch() {
  if (!pendingPatch.value || isRequested.value) return
  pendingPatch.value = null
  messages.value.push({ role: 'system', content: 'Proposed changes declined. Continue the chat with what should change next.', review: review.value })
}

async function saveDraft(): Promise<boolean> {
  if (isRequested.value) {
    error.value = 'This draft is in production review. Withdraw the review before saving more changes.'
    return false
  }
  saving.value = true
  error.value = ''
  saved.value = ''
  try {
    const res = await fetch(`/api/agent-org/tasks/${taskId.value}/draft`, {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify({ draft: draft.value }),
    })
    const data = await res.json().catch(() => ({}))
    review.value = data.review || review.value
    if (!res.ok) {
      error.value = data.error || `Save failed (${res.status})`
      return false
    }
    saved.value = 'Draft progress saved. Production task was not changed.'
    messages.value.push({ role: 'system', content: saved.value, review: data.review || null })
    await load()
    return true
  } finally { saving.value = false }
}

async function withdrawReview() {
  error.value = ''
  saved.value = ''
  const res = await fetch(`/api/agent-org/tasks/${taskId.value}/draft/withdraw-review`, {
    method: 'POST',
    headers: hdrs(),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    error.value = data.error || `Withdraw failed (${res.status})`
    return
  }
  saved.value = 'Production review withdrawn. Draft editing is unlocked.'
  await load()
}

function samplePayload() {
  const selectedUser = users.value.find(user => user.id === Number(selectedTestUserId.value))
  const testUser = selectedUser || auth.user
  if (String(draft.value.name || task.value?.name || '') === 'Generate daily coordinator digest') {
    return {
      use_live_data: true,
      coordinator: testUser?.name || 'Project Coordinator',
      coordinator_email: testUser?.email || '',
      inspection_days: 30,
    }
  }
  return testUser ? { test_user_id: testUser.id, test_user_name: testUser.name, test_user_email: testUser.email } : {}
}

async function testDraft() {
  testing.value = true
  error.value = ''
  testOutput.value = null
  try {
    const res = await fetch(`/api/agent-org/tasks/${taskId.value}/draft/test`, {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify({ draft: draft.value, payload: samplePayload() }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      error.value = data.error || `Test failed (${res.status})`
      return
    }
    testOutput.value = data
    messages.value.push({ role: 'system', content: `Test run completed with status ${data.status}. Review the deliverable preview before requesting production review.` })
  } finally { testing.value = false }
}

async function requestReview() {
  requestingReview.value = true
  error.value = ''
  saved.value = ''
  try {
    const savedDraft = await saveDraft()
    if (!savedDraft) return
    const res = await fetch(`/api/agent-org/tasks/${taskId.value}/draft/request-review`, {
      method: 'POST',
      headers: hdrs(),
    })
    const data = await res.json().catch(() => ({}))
    review.value = data.review || review.value
    if (!res.ok) {
      error.value = data.error || `Review request failed (${res.status})`
      messages.value.push({ role: 'assistant', content: error.value, review: data.review || null })
      return
    }
    saved.value = 'Draft sent for production review. Production task was not changed.'
    messages.value.push({ role: 'system', content: saved.value, review: data.review || null })
    await load()
  } finally { requestingReview.value = false }
}

function reviewClass(level?: string) {
  if (level === 'blocked') return 'bg-red-100 text-red-800'
  if (level === 'risk_compliance') return 'bg-amber-100 text-amber-800'
  if (level === 'manager') return 'bg-yellow-100 text-yellow-800'
  return 'bg-emerald-100 text-emerald-800'
}
</script>

<template>
  <div class="grid gap-4 h-[calc(100vh-6rem)]">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <Button variant="ghost" size="sm" class="h-8 px-0 text-xs" @click="router.push('/agents')">Back to agents</Button>
        <h1 class="text-2xl font-semibold tracking-tight">{{ taskSummary.name || 'Task Designer' }}</h1>
        <p class="text-sm text-muted-foreground">{{ taskSummary.owner }} · {{ taskSummary.type }} · {{ taskSummary.schedule }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Badge v-if="draftMeta?.status" :class="isRequested ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'">{{ taskSummary.status }}</Badge>
        <Badge v-if="review" :class="reviewClass(review.review_required)">Risk {{ review.risk_score }}</Badge>
        <Button variant="outline" size="sm" class="h-8 text-xs" @click="load">Refresh</Button>
      </div>
    </div>

    <p v-if="loading" class="text-sm text-muted-foreground">Loading task...</p>
    <p v-if="error" class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{{ error }}</p>
    <p v-if="saved" class="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{{ saved }}</p>

    <div v-if="task" class="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      <Card class="min-h-0">
        <CardHeader class="border-b">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Chat</CardTitle>
              <CardDescription>Ask for changes. Apply proposed edits only when they match what you want.</CardDescription>
            </div>
            <div class="flex flex-wrap gap-2">
              <Button v-if="hasPendingPatch && !isRequested" size="sm" class="h-8 text-xs" @click="applyPendingPatch">Accept changes</Button>
              <Button v-if="hasPendingPatch && !isRequested" size="sm" variant="outline" class="h-8 text-xs" @click="declinePendingPatch">Decline</Button>
              <Button size="sm" variant="outline" class="h-8 text-xs" :disabled="testing" @click="testDraft">{{ testing ? 'Testing...' : 'Test draft' }}</Button>
              <Button size="sm" variant="outline" class="h-8 text-xs" :disabled="saving || isRequested" @click="saveDraft">{{ saving ? 'Saving...' : 'Save draft' }}</Button>
              <Button v-if="!isRequested" size="sm" variant="outline" class="h-8 text-xs" :disabled="requestingReview || review?.review_required === 'blocked'" @click="requestReview">{{ requestingReview ? 'Requesting...' : 'Request review' }}</Button>
              <Button v-else size="sm" variant="outline" class="h-8 text-xs" @click="withdrawReview">Withdraw review</Button>
            </div>
          </div>
        </CardHeader>
        <CardContent class="grid h-[calc(100vh-15rem)] grid-rows-[1fr_auto] gap-3 p-4">
          <div class="min-h-0 space-y-3 overflow-auto pr-1">
            <div
              v-for="(item, index) in messages"
              :key="index"
              class="flex"
              :class="item.role === 'user' ? 'justify-end' : 'justify-start'"
            >
              <div
                class="max-w-[82%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap"
                :class="item.role === 'user' ? 'bg-primary text-primary-foreground' : item.role === 'system' ? 'border bg-muted text-muted-foreground' : 'border bg-background'"
              >
                {{ item.content }}
                <div v-if="item.review" class="mt-2 flex flex-wrap gap-1">
                  <Badge :class="reviewClass(item.review.review_required)">Risk {{ item.review.risk_score }} / Compliance {{ item.review.compliance_score }}</Badge>
                </div>
              </div>
            </div>
            <div v-if="testOutput" class="rounded-lg border bg-muted/40 p-3 text-sm">
              <p class="font-medium">Test deliverable</p>
              <pre class="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-[11px]">{{ JSON.stringify(testOutput, null, 2) }}</pre>
            </div>
          </div>
          <div class="space-y-2 border-t pt-3">
            <div v-if="auth.isAdmin && users.length" class="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2">
              <Label class="text-xs">Test as user</Label>
              <select v-model="selectedTestUserId" class="h-8 min-w-52 rounded-md border bg-background px-2 text-xs">
                <option value="">Me - {{ auth.user?.name }}</option>
                <option v-for="user in users" :key="user.id" :value="user.id">{{ user.name }} - {{ user.email }}</option>
              </select>
            </div>
            <textarea
              v-model="message"
              class="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm"
              :disabled="isRequested"
              placeholder="Send a request to the AI. Example: make install-complete/no-inspection items create requests for the Inspection agent, and show humans only approval items."
              @keydown.meta.enter.prevent="ask"
              @keydown.ctrl.enter.prevent="ask"
            />
            <div class="flex items-center justify-between gap-2">
              <p class="text-[11px] text-muted-foreground">Uses your saved Ollama credentials. Ctrl/⌘ Enter sends.</p>
              <Button size="sm" class="h-8 text-xs" :disabled="chatting || !message.trim() || isRequested" @click="ask">{{ chatting ? 'Waiting...' : 'Send' }}</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div class="min-h-0 space-y-4 overflow-auto">
        <Card>
          <CardHeader>
            <CardTitle>Task Summary</CardTitle>
            <CardDescription>Production config with unsaved draft overlay.</CardDescription>
          </CardHeader>
          <CardContent class="space-y-2">
            <div v-for="item in criteria" :key="item.label" class="flex items-center justify-between gap-3 border-b py-2 last:border-b-0">
              <span class="text-xs text-muted-foreground">{{ item.label }}</span>
              <span class="max-w-[220px] truncate text-right text-sm font-medium">{{ item.value }}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Draft Config</CardTitle>
            <CardDescription>{{ isRequested ? 'Locked during production review.' : 'Editable draft fields.' }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-3">
            <div v-if="hasPendingPatch" class="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p class="text-sm font-medium text-amber-950">Proposed changes waiting</p>
                  <p class="text-xs text-amber-800">Review the red/green diff before accepting it into the draft.</p>
                </div>
                <div class="flex gap-2">
                  <Button size="sm" class="h-7 text-[11px]" @click="applyPendingPatch">Accept</Button>
                  <Button size="sm" variant="outline" class="h-7 text-[11px]" @click="declinePendingPatch">Decline</Button>
                </div>
              </div>
              <div class="mt-3 space-y-2 text-xs">
                <div v-if="pendingPatch?.name && pendingPatch.name !== draft.name" class="grid gap-1">
                  <p class="font-medium">Task name</p>
                  <p class="rounded bg-red-100 px-2 py-1 text-red-800 line-through">{{ draft.name }}</p>
                  <p class="rounded bg-emerald-100 px-2 py-1 text-emerald-800">{{ pendingPatch.name }}</p>
                </div>
                <div v-if="pendingPatch?.task_type && pendingPatch.task_type !== draft.task_type" class="grid gap-1">
                  <p class="font-medium">Task type</p>
                  <p class="rounded bg-red-100 px-2 py-1 text-red-800 line-through">{{ draft.task_type }}</p>
                  <p class="rounded bg-emerald-100 px-2 py-1 text-emerald-800">{{ pendingPatch.task_type }}</p>
                </div>
                <div v-if="Object.prototype.hasOwnProperty.call(pendingPatch || {}, 'enabled') && Number(pendingPatch?.enabled) !== Number(draft.enabled)" class="grid gap-1">
                  <p class="font-medium">Enabled</p>
                  <p class="rounded bg-red-100 px-2 py-1 text-red-800 line-through">{{ Number(draft.enabled) === 1 ? 'Yes' : 'No' }}</p>
                  <p class="rounded bg-emerald-100 px-2 py-1 text-emerald-800">{{ Number(pendingPatch?.enabled) === 1 ? 'Yes' : 'No' }}</p>
                </div>
                <div v-if="instructionDiff.length" class="grid gap-1">
                  <p class="font-medium">Instructions</p>
                  <div class="max-h-80 overflow-auto rounded-md border bg-background p-2 font-mono text-[11px] leading-relaxed">
                    <p
                      v-for="(line, idx) in instructionDiff"
                      :key="idx"
                      class="whitespace-pre-wrap px-1"
                      :class="line.type === 'removed' ? 'bg-red-100 text-red-800 line-through' : line.type === 'added' ? 'bg-emerald-100 text-emerald-800' : 'text-muted-foreground'"
                    >
                      <span class="select-none">{{ line.type === 'removed' ? '- ' : line.type === 'added' ? '+ ' : '  ' }}</span>{{ line.text }}
                    </p>
                  </div>
                </div>
              </div>
            </div>
            <div class="space-y-2">
                <Label>Task name</Label>
                <Input v-model="draft.name" :disabled="isRequested" />
            </div>
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="space-y-2">
                <Label>Task type</Label>
                <select v-model="draft.task_type" :disabled="isRequested" class="h-9 w-full rounded-md border bg-background px-3 text-sm">
                  <option v-for="type in taskTypes" :key="type" :value="type">{{ type }}</option>
                </select>
              </div>
              <label class="flex items-end gap-2 rounded-md border px-3 py-2 text-sm">
                <input type="checkbox" :checked="Number(draft.enabled) === 1" :disabled="isRequested" @change="draft.enabled = ($event.target as HTMLInputElement).checked ? 1 : 0" />
                Enabled
              </label>
            </div>
            <div class="space-y-2">
              <Label>Instructions</Label>
              <textarea v-model="draft.instructions" :disabled="isRequested" class="min-h-72 w-full rounded-md border bg-background px-3 py-2 text-xs" />
            </div>
            <div v-if="proposedDraft" class="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              Pending proposal preview: {{ proposedDraft.name }} · {{ proposedDraft.task_type }} · {{ Number(proposedDraft.enabled) === 1 ? 'enabled' : 'disabled' }}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle>Risk And Compliance</CardTitle>
                <CardDescription>Determines what review is required before production use.</CardDescription>
              </div>
              <Badge v-if="review" :class="reviewClass(review.review_required)">Risk {{ review.risk_score }} / Compliance {{ review.compliance_score }}</Badge>
            </div>
          </CardHeader>
          <CardContent class="space-y-2">
            <p v-if="!review" class="text-sm text-muted-foreground">No draft review yet. Chat or save draft to run review.</p>
            <template v-else>
              <p class="text-sm">{{ review.summary }}</p>
              <div v-for="finding in review.findings || []" :key="finding.category + finding.text" class="rounded-md border px-3 py-2">
                <div class="flex flex-wrap items-center gap-2">
                  <Badge :class="finding.severity === 'blocked' ? 'bg-red-100 text-red-800' : finding.severity === 'high' ? 'bg-amber-100 text-amber-800' : 'bg-yellow-100 text-yellow-800'">{{ finding.severity }}</Badge>
                  <span class="text-xs font-medium">{{ finding.category }}</span>
                </div>
                <p class="mt-1 text-xs text-muted-foreground">{{ finding.reason }}</p>
                <p v-if="finding.text" class="mt-1 text-[11px]">{{ finding.text }}</p>
              </div>
            </template>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Example</CardTitle>
            <CardDescription>How this task should read when delivered to an inbox.</CardDescription>
          </CardHeader>
          <CardContent class="space-y-3">
            <div class="rounded-md bg-muted p-3 text-sm">
              <p class="font-medium">Daily coordinator digest</p>
              <p class="mt-1 text-muted-foreground">Install complete/no inspection projects are summarized as agent work requests for Inspection. Humans only see approval or input requests.</p>
            </div>
            <div class="rounded-md border px-3 py-2">
              <p class="text-sm font-medium">Recommended agent work</p>
              <p class="text-xs text-muted-foreground">Route project #12345 to Inspection agent: Review inspection blocker.</p>
              <Button size="sm" variant="outline" class="mt-2 h-7 text-[11px]" disabled>Route next</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  </div>
</template>
