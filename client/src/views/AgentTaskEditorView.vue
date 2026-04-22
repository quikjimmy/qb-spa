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
    pendingPatch.value = patch
    messages.value.push({
      role: 'assistant',
      content: `${data.reply || 'I proposed a draft update.'}\n\n${summarizePatch(patch)}\n\nApply these changes if this matches what you want.`,
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
  return {
    coordinator: 'Paige Prymak',
    day: new Date().toLocaleDateString(undefined, { weekday: 'long' }),
    installs: [{ rid: 12345, customer_name: 'Sample Project', location: 'Tampa, FL', lender: 'GoodLeap', permit_status: 'Permit approved', system_kw: 8.4 }],
    attention_items: [{ rid: 12347, project_name: 'Patel Residence', issue: 'Install complete, no inspection', context: 'Final inspection not confirmed after install completion.', system_kw: 7.2 }],
    wins: ['Sample win for output validation'],
  }
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
              <Button v-if="pendingPatch && !isRequested" size="sm" class="h-8 text-xs" @click="applyPendingPatch">Apply proposed changes</Button>
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
            <div class="space-y-2">
                <Label>Task name</Label>
                <Input v-model="draft.name" :disabled="isRequested" />
            </div>
            <div class="space-y-2">
              <Label>Instructions</Label>
              <textarea v-model="draft.instructions" :disabled="isRequested" class="min-h-72 w-full rounded-md border bg-background px-3 py-2 text-xs" />
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
