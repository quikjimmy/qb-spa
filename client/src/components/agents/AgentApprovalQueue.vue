<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

const rows = ref<Array<Record<string, unknown>>>([])
const draftRows = ref<Array<Record<string, unknown>>>([])
const loading = ref(false)

async function load() {
  if (!auth.isAdmin) return
  loading.value = true
  try {
    const res = await fetch('/api/agent-approvals', { headers: hdrs() })
    if (res.ok) rows.value = (await res.json()).rows || []
    const draftRes = await fetch('/api/agent-org/task-drafts/review', { headers: hdrs() })
    if (draftRes.ok) draftRows.value = (await draftRes.json()).rows || []
  } finally { loading.value = false }
}

async function review(id: number, action: 'approve' | 'reject') {
  const review_note = window.prompt(action === 'approve' ? 'Approval note (optional)' : 'Reason for rejection (optional)') || ''
  await fetch(`/api/agent-approvals/${id}/${action}`, {
    method: 'POST',
    headers: hdrs(),
    body: JSON.stringify({ review_note }),
  })
  await load()
}

async function reviewDraft(id: number, action: 'approve' | 'reject') {
  const label = action === 'approve' ? 'Approve and promote this draft to production?' : 'Reject this draft?'
  if (!window.confirm(label)) return
  await fetch(`/api/agent-org/task-drafts/${id}/${action}`, {
    method: 'POST',
    headers: hdrs(),
  })
  await load()
}

function parse(raw: unknown): Record<string, any> {
  if (!raw || typeof raw !== 'string') return {}
  try { return JSON.parse(raw) } catch { return {} }
}

onMounted(load)
</script>

<template>
  <Card v-if="auth.isAdmin">
    <CardHeader>
      <CardTitle>Approval Queue</CardTitle>
      <CardDescription>Human gate for irreversible actions.</CardDescription>
    </CardHeader>
    <CardContent class="space-y-2">
      <p v-if="loading" class="text-sm text-muted-foreground">Loading approvals...</p>
      <p v-else-if="rows.length === 0 && draftRows.length === 0" class="text-sm text-muted-foreground">No approvals pending.</p>
      <div v-for="row in draftRows" :key="'draft-' + String(row.id)" class="rounded-lg border px-3 py-2 space-y-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p class="text-sm font-medium">Task draft · {{ row.role_name }} · {{ row.task_name }}</p>
            <p class="text-[11px] text-muted-foreground">
              {{ row.department || 'Production' }} · requested by {{ row.requested_by_name || row.requested_by_email || 'unknown' }}
            </p>
          </div>
          <div class="flex items-center gap-2">
            <Button size="sm" variant="outline" class="h-7 text-[11px]" @click="reviewDraft(Number(row.id), 'approve')">Approve production</Button>
            <Button size="sm" variant="outline" class="h-7 text-[11px]" @click="reviewDraft(Number(row.id), 'reject')">Reject</Button>
          </div>
        </div>
        <div class="rounded bg-muted p-2 text-[10px]">
          <p class="font-medium">Risk review</p>
          <pre class="mt-1 whitespace-pre-wrap break-words">{{ JSON.stringify(parse(row.compliance_review_json), null, 2) }}</pre>
        </div>
        <details class="rounded bg-muted p-2 text-[10px]">
          <summary class="cursor-pointer font-medium">Draft patch</summary>
          <pre class="mt-1 whitespace-pre-wrap break-words">{{ JSON.stringify(parse(row.draft_json), null, 2) }}</pre>
        </details>
      </div>
      <div v-for="row in rows" :key="String(row.id)" class="rounded-lg border px-3 py-2 space-y-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p class="text-sm font-medium">{{ row.role_name }} · {{ row.task_name || 'Task' }}</p>
            <p class="text-[11px] text-muted-foreground capitalize">{{ row.requested_action }}</p>
          </div>
          <div class="flex items-center gap-2">
            <Button size="sm" variant="outline" class="h-7 text-[11px]" @click="review(Number(row.id), 'approve')">Approve</Button>
            <Button size="sm" variant="outline" class="h-7 text-[11px]" @click="review(Number(row.id), 'reject')">Reject</Button>
          </div>
        </div>
        <pre class="whitespace-pre-wrap break-words rounded bg-muted p-2 text-[10px]">{{ row.requested_payload_json }}</pre>
      </div>
    </CardContent>
  </Card>
</template>
