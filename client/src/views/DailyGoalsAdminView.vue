<script setup lang="ts">
// Admin editor for the daily goals that drive /scoreboard.
// Editable per goal: department (FK), label, active toggle, and a
// 15-day target window (7 prior + today + 7 future, all editable).
// Past targets are immutable; today and forward can be staged then
// saved with a single per-goal Save button.

import { computed, onMounted, ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-vue-next'

interface TargetWindowEntry {
  date: string
  target: number
  editable: boolean
}

interface GoalRow {
  id: number
  slug: string
  department_id: number | null
  department: string
  label: string
  kind: 'count' | 'empty_bucket'
  sort_order: number
  active: number
  data_source: string | null
  today_target: number
  yesterday_target: number
  target_window: TargetWindowEntry[]
}

interface Department {
  id: number
  name: string
}

interface DataSource {
  key: string
  label: string
}

interface CustomSource {
  id: number
  key: string
  label: string
  report_id: number
  table_id: string
  group_by_field_id: number
  kind: 'count' | 'snapshot'
}

interface TestResult {
  total_rows: number
  snapshot_count: number
  last_7_days: Array<{ date: string; count: number }>
  group_by_field_id: number
  available_fields: number[]
  sample_row: Record<string, { value: unknown }>
}

interface EditState {
  label: string
  departmentId: string  // bound to <select>; "" means unchanged
  active: boolean
  dataSource: string  // "" = mock fallback (NULL in DB)
  // Per-date target inputs, keyed by ISO date. Only entries for
  // editable dates are written back.
  targets: Record<string, string>
  dirty: boolean
  expanded: boolean
  saving: boolean
  deleting: boolean
  error: string
}

const auth = useAuthStore()
const goals = ref<GoalRow[]>([])
const departments = ref<Department[]>([])
const sources = ref<DataSource[]>([])
const edits = ref<Record<number, EditState>>({})
const loading = ref(true)
const loadError = ref('')

// "+ New Goal" dialog state.
const showNewGoalDialog = ref(false)
const newGoalLabel = ref('')
const newGoalDeptId = ref<string>('')
const newGoalKind = ref<'count' | 'empty_bucket'>('count')
const newGoalTarget = ref<string>('0')
const newGoalSource = ref<string>('')
const newGoalError = ref('')
const newGoalSaving = ref(false)

// Scrolling-banner messages — admin curated, shown on /scoreboard.

// Custom (admin-defined, QB-report-backed) data sources.
const customSources = ref<CustomSource[]>([])
const customSourcesLoading = ref(false)
const showCustomSourceDialog = ref(false)
const csForm = ref({
  key: '',
  label: '',
  report_url: '',  // pasted, we parse out report_id + table_id
  report_id: 0,
  table_id: '',
  group_by_field_id: 1,
  kind: 'count' as 'count' | 'snapshot',
})
const csError = ref('')
const csSaving = ref(false)
const csTesting = ref(false)
const csTestResult = ref<TestResult | null>(null)
const csEditingId = ref<number | null>(null)

// "+ New Department" dialog state. `dialogGoalId` tracks which goal's
// dropdown triggered the dialog — on successful create we auto-select
// the new department for that goal.
const showNewDeptDialog = ref(false)
const dialogGoalId = ref<number | null>(null)
const newDeptName = ref('')
const newDeptError = ref('')
const newDeptSaving = ref(false)

const rows = computed(() =>
  goals.value
    .map(goal => {
      const edit = edits.value[goal.id]
      return edit ? { goal, edit } : null
    })
    .filter((r): r is { goal: GoalRow; edit: EditState } => r !== null),
)

function hdrs(): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.token}`,
    'Content-Type': 'application/json',
  }
}

function seedEdit(g: GoalRow, expanded: boolean = false): EditState {
  const targets: Record<string, string> = {}
  for (const t of g.target_window) targets[t.date] = String(t.target)
  return {
    label: g.label,
    departmentId: g.department_id != null ? String(g.department_id) : '',
    active: !!g.active,
    dataSource: g.data_source ?? '',
    targets,
    dirty: false,
    expanded,
    saving: false,
    deleting: false,
    error: '',
  }
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const res = await fetch('/api/daily-goals', { headers: hdrs() })
    if (!res.ok) {
      loadError.value = `Failed to load (${res.status})`
      return
    }
    const data = (await res.json()) as { goals: GoalRow[]; departments: Department[]; sources?: DataSource[] }
    goals.value = data.goals
    departments.value = data.departments
    sources.value = data.sources ?? []
    edits.value = {}
    for (const g of data.goals) edits.value[g.id] = seedEdit(g)
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Network error'
  } finally {
    loading.value = false
  }
}

function markDirty(id: number): void {
  const e = edits.value[id]
  if (e) e.dirty = true
}

function toggleExpand(id: number): void {
  const e = edits.value[id]
  if (e) e.expanded = !e.expanded
}

// Format the date header inside the 15-day strip. "Wed 5/20" — terse
// because we have 15 of them.
function dateHeader(iso: string): { dow: string; md: string } {
  const d = new Date(`${iso}T00:00:00`)
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] ?? ''
  const md = `${d.getMonth() + 1}/${d.getDate()}`
  return { dow, md }
}

function isToday(iso: string): boolean {
  const today = new Date()
  const m = String(today.getMonth() + 1).padStart(2, '0')
  const d = String(today.getDate()).padStart(2, '0')
  return iso === `${today.getFullYear()}-${m}-${d}`
}

async function save(g: GoalRow): Promise<void> {
  const e = edits.value[g.id]
  if (!e) return
  if (e.label.trim().length === 0) {
    e.error = 'Label cannot be empty'
    return
  }
  e.saving = true
  e.error = ''

  // Collect target edits for today + future dates. The server rejects
  // past-date edits, so we filter client-side too for clarity.
  const isEmpty = g.kind === 'empty_bucket'
  const targets: Array<{ date: string; target: number }> = []
  if (!isEmpty) {
    for (const t of g.target_window) {
      if (!t.editable) continue
      const v = Number(e.targets[t.date])
      if (!Number.isFinite(v) || v < 0) {
        e.error = `Invalid target for ${t.date}`
        e.saving = false
        return
      }
      // Only send entries that actually changed to keep the wire small.
      if (v !== t.target) targets.push({ date: t.date, target: v })
    }
  }

  const body: Record<string, unknown> = {
    label: e.label.trim(),
    active: e.active,
    // "" → server reads this as null (mock fallback)
    data_source: e.dataSource === '' ? null : e.dataSource,
  }
  if (e.departmentId !== '') {
    body['department_id'] = Number(e.departmentId)
  }
  if (targets.length > 0) body['targets'] = targets

  try {
    const res = await fetch(`/api/daily-goals/${g.id}`, {
      method: 'PUT',
      headers: hdrs(),
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      e.error = (err as { error?: string }).error || `Save failed (${res.status})`
      return
    }
    const data = (await res.json()) as { goal: GoalRow }
    const idx = goals.value.findIndex(x => x.id === g.id)
    if (idx >= 0) goals.value[idx] = data.goal
    edits.value[g.id] = seedEdit(data.goal, e.expanded)
  } catch (err) {
    e.error = err instanceof Error ? err.message : 'Network error'
  } finally {
    const refreshed = edits.value[g.id]
    if (refreshed) refreshed.saving = false
  }
}

async function deleteGoal(g: GoalRow): Promise<void> {
  const e = edits.value[g.id]
  if (!e) return
  if (!window.confirm(`Delete "${g.label}"? This removes the goal and all its targets and history.`)) return
  e.deleting = true
  e.error = ''
  try {
    const res = await fetch(`/api/daily-goals/${g.id}`, {
      method: 'DELETE',
      headers: hdrs(),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      e.error = (err as { error?: string }).error || `Delete failed (${res.status})`
      return
    }
    // Drop from local state without a full refresh.
    goals.value = goals.value.filter(x => x.id !== g.id)
    delete edits.value[g.id]
  } catch (err) {
    e.error = err instanceof Error ? err.message : 'Network error'
  } finally {
    const refreshed = edits.value[g.id]
    if (refreshed) refreshed.deleting = false
  }
}

function openNewGoalDialog(): void {
  newGoalLabel.value = ''
  newGoalDeptId.value = ''
  newGoalKind.value = 'count'
  newGoalTarget.value = '0'
  newGoalSource.value = ''
  newGoalError.value = ''
  showNewGoalDialog.value = true
}

async function createGoal(): Promise<void> {
  const label = newGoalLabel.value.trim()
  if (label.length === 0) {
    newGoalError.value = 'Label required'
    return
  }
  if (newGoalDeptId.value === '') {
    newGoalError.value = 'Pick a department'
    return
  }
  const target = Number(newGoalTarget.value)
  if (!Number.isFinite(target) || target < 0) {
    newGoalError.value = 'Initial target must be a number ≥ 0'
    return
  }
  newGoalSaving.value = true
  newGoalError.value = ''
  try {
    const res = await fetch('/api/daily-goals', {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify({
        label,
        department_id: Number(newGoalDeptId.value),
        kind: newGoalKind.value,
        initial_target: target,
        data_source: newGoalSource.value === '' ? null : newGoalSource.value,
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      newGoalError.value = (err as { error?: string }).error || `Create failed (${res.status})`
      return
    }
    const data = (await res.json()) as { goal: GoalRow }
    goals.value.push(data.goal)
    edits.value[data.goal.id] = seedEdit(data.goal, true) // expand on create
    showNewGoalDialog.value = false
  } catch (err) {
    newGoalError.value = err instanceof Error ? err.message : 'Network error'
  } finally {
    newGoalSaving.value = false
  }
}

function openNewDeptDialog(goalId: number): void {
  dialogGoalId.value = goalId
  newDeptName.value = ''
  newDeptError.value = ''
  showNewDeptDialog.value = true
}

async function createDepartment(): Promise<void> {
  const name = newDeptName.value.trim()
  if (name.length === 0) {
    newDeptError.value = 'Name required'
    return
  }
  newDeptSaving.value = true
  newDeptError.value = ''
  try {
    const res = await fetch('/api/admin/departments', {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify({ name, description: '' }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      newDeptError.value = (err as { error?: string }).error || `Failed (${res.status})`
      return
    }
    const data = (await res.json()) as { id: number; name: string }
    // Re-fetch goals so the departments list reflects the new entry
    // (the /api/daily-goals payload owns the dropdown source).
    await load()
    if (dialogGoalId.value != null) {
      const e = edits.value[dialogGoalId.value]
      if (e) {
        e.departmentId = String(data.id)
        e.dirty = true
      }
    }
    showNewDeptDialog.value = false
  } catch (err) {
    newDeptError.value = err instanceof Error ? err.message : 'Network error'
  } finally {
    newDeptSaving.value = false
  }
}

// OptiSign / TV-stick embed URL generator.
const optisignGenerating = ref(false)
const optisignUrl = ref('')
const optisignMessage = ref('')
async function generateOptisignUrl(): Promise<void> {
  optisignGenerating.value = true
  optisignUrl.value = ''
  optisignMessage.value = ''
  try {
    const res = await fetch('/api/daily-goals/scoreboard-token', {
      method: 'POST',
      headers: hdrs(),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      optisignMessage.value = (err as { error?: string }).error || `Failed (${res.status})`
      return
    }
    const data = (await res.json()) as { token: string }
    const base = window.location.origin
    // TV-locked layout — keeps responsive/mobile overrides from
    // interfering with the OptiSign render.
    optisignUrl.value = `${base}/scoreboard/tv?token=${data.token}`
    try {
      await navigator.clipboard.writeText(optisignUrl.value)
      optisignMessage.value = 'URL copied. Paste into OptiSign as a Web App.'
    } catch {
      optisignMessage.value = 'Token generated — copy the URL below.'
    }
  } catch (e) {
    optisignMessage.value = e instanceof Error ? e.message : 'Network error'
  } finally {
    optisignGenerating.value = false
  }
}

const resettingHits = ref(false)
const resetHitsMessage = ref('')
async function resetTodaysCelebrations(): Promise<void> {
  if (!window.confirm('Clear today\'s celebration history? Any goal currently at met status will re-celebrate on the next scoreboard poll.')) return
  resettingHits.value = true
  resetHitsMessage.value = ''
  try {
    const res = await fetch('/api/daily-goals/hits', {
      method: 'DELETE',
      headers: hdrs(),
    })
    if (!res.ok) {
      resetHitsMessage.value = `Failed (${res.status})`
      return
    }
    const data = (await res.json()) as { cleared: number; date: string }
    resetHitsMessage.value = `Cleared ${data.cleared} hit(s) for ${data.date}. Open the scoreboard — celebrations will re-fire within ~60s.`
  } catch (e) {
    resetHitsMessage.value = e instanceof Error ? e.message : 'Network error'
  } finally {
    resettingHits.value = false
  }
}

// ─── Custom source CRUD ────────────────────────────────

// Pull report ID + table ID out of a pasted QB report URL. QB
// supports two URL shapes — old `/db/{tableId}?...qid={id}` and the
// newer `/nav/app/{appId}/table/{tableId}/action/q?qid={id}`. Both
// land here.
function parseReportUrl(url: string): { report_id: number; table_id: string } | null {
  const tableMatch = url.match(/\/(?:db|table)\/([a-z0-9]+)(?:[\/?]|$)/i)
  const qidMatch = url.match(/[?&]qid=(\d+)/i)
  if (!tableMatch || !qidMatch || !tableMatch[1] || !qidMatch[1]) return null
  return { table_id: tableMatch[1], report_id: Number(qidMatch[1]) }
}

async function loadCustomSources(): Promise<void> {
  customSourcesLoading.value = true
  try {
    const res = await fetch('/api/daily-goals/custom-sources', { headers: hdrs() })
    if (!res.ok) return
    const data = (await res.json()) as { sources: CustomSource[] }
    customSources.value = data.sources
  } finally {
    customSourcesLoading.value = false
  }
}

function openCustomSourceDialog(existing?: CustomSource): void {
  csError.value = ''
  csTestResult.value = null
  if (existing) {
    csEditingId.value = existing.id
    csForm.value = {
      key: existing.key,
      label: existing.label,
      report_url: `https://kin.quickbase.com/db/${existing.table_id}?a=q&qid=${existing.report_id}`,
      report_id: existing.report_id,
      table_id: existing.table_id,
      group_by_field_id: existing.group_by_field_id,
      kind: existing.kind,
    }
  } else {
    csEditingId.value = null
    csForm.value = { key: '', label: '', report_url: '', report_id: 0, table_id: '', group_by_field_id: 1, kind: 'count' }
  }
  showCustomSourceDialog.value = true
}

// Live-derive report_id + table_id from the pasted URL as the user
// types — saves them a step.
function onReportUrlInput(): void {
  const parsed = parseReportUrl(csForm.value.report_url)
  if (parsed) {
    csForm.value.report_id = parsed.report_id
    csForm.value.table_id = parsed.table_id
  }
}

async function testCustomSource(): Promise<void> {
  csError.value = ''
  csTestResult.value = null
  if (!csForm.value.report_id || !csForm.value.table_id) {
    csError.value = 'Paste a QB report URL first'
    return
  }
  csTesting.value = true
  try {
    const res = await fetch('/api/daily-goals/custom-sources/test', {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify({
        report_id: csForm.value.report_id,
        table_id: csForm.value.table_id,
        group_by_field_id: csForm.value.group_by_field_id,
      }),
    })
    const data = await res.json()
    if (!res.ok) {
      csError.value = (data as { error?: string }).error || `Test failed (${res.status})`
      return
    }
    csTestResult.value = data as TestResult
  } catch (e) {
    csError.value = e instanceof Error ? e.message : 'Network error'
  } finally {
    csTesting.value = false
  }
}

async function saveCustomSource(): Promise<void> {
  csError.value = ''
  if (!csForm.value.key.trim() || !csForm.value.label.trim()) {
    csError.value = 'Key + label required'; return
  }
  if (!csForm.value.report_id || !csForm.value.table_id) {
    csError.value = 'Paste a valid QB report URL'; return
  }
  csSaving.value = true
  try {
    const isEdit = csEditingId.value != null
    const url = isEdit
      ? `/api/daily-goals/custom-sources/${csEditingId.value}`
      : '/api/daily-goals/custom-sources'
    const method = isEdit ? 'PUT' : 'POST'
    // Key isn't editable after creation (would orphan goals).
    const body: Record<string, unknown> = {
      label: csForm.value.label.trim(),
      report_id: csForm.value.report_id,
      table_id: csForm.value.table_id,
      group_by_field_id: csForm.value.group_by_field_id,
      kind: csForm.value.kind,
    }
    if (!isEdit) body['key'] = csForm.value.key.trim()
    const res = await fetch(url, { method, headers: hdrs(), body: JSON.stringify(body) })
    const data = await res.json()
    if (!res.ok) {
      csError.value = (data as { error?: string }).error || `Save failed (${res.status})`
      return
    }
    showCustomSourceDialog.value = false
    await Promise.all([loadCustomSources(), load()])  // refresh goal dropdown
  } catch (e) {
    csError.value = e instanceof Error ? e.message : 'Network error'
  } finally {
    csSaving.value = false
  }
}

async function deleteCustomSource(s: CustomSource): Promise<void> {
  const bound = goals.value.filter(g => g.data_source === s.key)
  const msg = bound.length > 0
    ? `Delete "${s.label}"? ${bound.length} goal(s) currently bound to this source will fall back to mock/0 until you rebind them.`
    : `Delete "${s.label}"?`
  if (!window.confirm(msg)) return
  const res = await fetch(`/api/daily-goals/custom-sources/${s.id}`, {
    method: 'DELETE', headers: hdrs(),
  })
  if (res.ok) await Promise.all([loadCustomSources(), load()])
}

onMounted(() => {
  load()
  loadCustomSources()
})
</script>

<template>
  <div class="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
    <!-- Scoreboard controls — small actions that affect the live
         scoreboard rendering. Today's only knob is the celebration
         hit-state reset, used for re-firing the goal-hit takeover
         while iterating. -->
    <Card>
      <CardHeader>
        <CardTitle>Scoreboard Controls</CardTitle>
        <CardDescription>
          Operational knobs for the
          <RouterLink to="/scoreboard" class="underline">live Scoreboard</RouterLink>:
          reset celebration history for re-testing, or generate a
          self-authenticating URL for a TV / OptiSign player.
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-3">
        <div class="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            :disabled="resettingHits"
            @click="resetTodaysCelebrations"
          >
            {{ resettingHits ? 'Resetting…' : 'Reset today\'s celebrations' }}
          </Button>
          <Button
            variant="outline"
            size="sm"
            :disabled="optisignGenerating"
            @click="generateOptisignUrl"
          >
            {{ optisignGenerating ? 'Generating…' : 'Generate OptiSign URL' }}
          </Button>
        </div>
        <p v-if="resetHitsMessage" class="text-[11px] text-muted-foreground">{{ resetHitsMessage }}</p>
        <p v-if="optisignMessage" class="text-[11px] text-muted-foreground">{{ optisignMessage }}</p>
        <div v-if="optisignUrl" class="space-y-1">
          <Label class="text-[10px] uppercase tracking-wider text-muted-foreground">OptiSign URL (1-year token)</Label>
          <Input
            :model-value="optisignUrl"
            type="text"
            readonly
            class="font-mono text-[11px]"
            @focus="(e: Event) => (e.target as HTMLInputElement).select()"
          />
          <p class="text-[10px] text-muted-foreground">
            Paste into OptiSign as a Web App content. Token is read-only and scoped to the scoreboard summary endpoint.
          </p>
        </div>
      </CardContent>
    </Card>

    <!-- Admin-defined data sources backed by saved QB reports. Each
         appears in the goal-editor's Data Source dropdown alongside
         the built-in sources. -->
    <Card>
      <CardHeader class="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle>Custom Data Sources</CardTitle>
          <CardDescription>
            Wrap any saved QuickBase report as a goal data source.
            Paste the report URL, name it, pick which date field
            groups the count, and any goal can bind to it.
          </CardDescription>
        </div>
        <Button class="flex-none" @click="openCustomSourceDialog()">
          <Plus class="w-4 h-4 mr-1" /> New Source
        </Button>
      </CardHeader>
      <CardContent class="space-y-2">
        <p v-if="customSourcesLoading && customSources.length === 0" class="text-sm text-muted-foreground">Loading…</p>
        <p v-else-if="customSources.length === 0" class="text-sm text-muted-foreground">
          No custom sources yet. The built-in sources still work — this is for QB reports you want to wrap yourself.
        </p>
        <ul v-else class="space-y-1.5">
          <li
            v-for="s in customSources"
            :key="s.id"
            class="flex items-center gap-2 text-sm rounded-md border p-2 bg-card"
          >
            <div class="flex-1 min-w-0">
              <p class="font-medium truncate">{{ s.label }}</p>
              <p class="text-[10px] text-muted-foreground tabular-nums truncate">
                {{ s.key }} · report {{ s.report_id }} on {{ s.table_id }} · group by field {{ s.group_by_field_id }} · {{ s.kind }}
              </p>
            </div>
            <Button size="sm" variant="outline" @click="openCustomSourceDialog(s)">Edit</Button>
            <button
              type="button"
              class="flex-none w-7 h-7 rounded-md border flex items-center justify-center text-red-600 hover:bg-red-50 cursor-pointer"
              :aria-label="`Delete ${s.label}`"
              @click="deleteCustomSource(s)"
            >
              <Trash2 class="w-3.5 h-3.5" />
            </button>
          </li>
        </ul>
      </CardContent>
    </Card>

    <Card>
      <CardHeader class="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle>Daily Goal Targets</CardTitle>
          <CardDescription>
            Set today's and the next 7 days' targets for each goal on
            the
            <RouterLink to="/scoreboard" class="underline">Scoreboard</RouterLink>.
            All 15 days are editable — set future targets in advance or
            backfill historical targets to re-grade the win/loss strip.
            Empty-bucket goals are binary pass/fail (target always 0).
          </CardDescription>
        </div>
        <Button class="flex-none" @click="openNewGoalDialog">
          <Plus class="w-4 h-4 mr-1" /> New Goal
        </Button>
      </CardHeader>
      <CardContent class="space-y-3">
        <p v-if="loadError" class="text-sm text-red-600">{{ loadError }}</p>
        <p v-if="loading" class="text-sm text-muted-foreground">Loading…</p>

        <div v-else-if="rows.length === 0" class="text-sm text-muted-foreground">
          No goals configured.
        </div>

        <div v-for="{ goal: g, edit: e } in rows" :key="g.id" class="rounded-xl border bg-card">
          <!-- Compact header row -->
          <div class="flex flex-col sm:flex-row sm:items-center gap-2 p-3">
            <button
              type="button"
              class="flex-none w-7 h-7 rounded-md border flex items-center justify-center hover:bg-muted cursor-pointer"
              :aria-label="e.expanded ? 'Collapse target strip' : 'Expand target strip'"
              @click="toggleExpand(g.id)"
            >
              <ChevronDown v-if="e.expanded" class="w-4 h-4" />
              <ChevronRight v-else class="w-4 h-4" />
            </button>

            <div class="flex-none w-full sm:w-[200px] flex gap-1">
              <Label :for="`dept-${g.id}`" class="sr-only">Department</Label>
              <select
                :id="`dept-${g.id}`"
                v-model="e.departmentId"
                class="flex-1 min-w-0 h-9 px-2 rounded-md border bg-background text-sm"
                @change="markDirty(g.id)"
              >
                <option value="" disabled>Department…</option>
                <option v-for="d in departments" :key="d.id" :value="String(d.id)">
                  {{ d.name }}
                </option>
              </select>
              <button
                type="button"
                class="flex-none w-9 h-9 rounded-md border flex items-center justify-center hover:bg-muted cursor-pointer"
                aria-label="Add new department"
                title="Add new department"
                @click="openNewDeptDialog(g.id)"
              >
                <Plus class="w-4 h-4" />
              </button>
            </div>

            <div class="flex-1 min-w-0">
              <Label :for="`lbl-${g.id}`" class="sr-only">Label</Label>
              <Input
                :id="`lbl-${g.id}`"
                v-model="e.label"
                type="text"
                @input="markDirty(g.id)"
              />
              <p v-if="g.kind === 'empty_bucket'" class="text-[10px] uppercase tracking-wider text-muted-foreground mt-1">
                empty-bucket goal · target locked to 0
              </p>
            </div>

            <div class="flex-none flex items-center gap-3">
              <div class="text-right">
                <p class="text-[10px] uppercase tracking-wider text-muted-foreground">Today</p>
                <p class="text-lg font-extrabold tabular-nums leading-none">{{ g.today_target }}</p>
              </div>
              <div class="flex flex-col items-center gap-1">
                <Switch
                  :model-value="e.active"
                  @update:model-value="(v: boolean) => { e.active = v; markDirty(g.id) }"
                />
                <span class="text-[10px] text-muted-foreground">Active</span>
              </div>
              <Button
                size="sm"
                :disabled="!e.dirty || e.saving"
                @click="save(g)"
              >
                {{ e.saving ? 'Saving…' : 'Save' }}
              </Button>
              <button
                type="button"
                class="flex-none w-8 h-8 rounded-md border flex items-center justify-center text-red-600 hover:bg-red-50 cursor-pointer disabled:opacity-50"
                :disabled="e.deleting"
                :aria-label="`Delete ${g.label}`"
                :title="`Delete ${g.label}`"
                @click="deleteGoal(g)"
              >
                <Trash2 class="w-4 h-4" />
              </button>
            </div>
          </div>

          <p v-if="e.error" class="px-3 pb-2 text-[11px] text-red-600">{{ e.error }}</p>

          <!-- Expanded: data source picker + 15-day target strip -->
          <div v-if="e.expanded" class="border-t bg-muted/30 px-3 py-3 overflow-x-auto space-y-3">
            <div class="flex items-center gap-2 flex-wrap">
              <Label :for="`src-${g.id}`" class="text-[10px] uppercase tracking-wider text-muted-foreground">
                Data source
              </Label>
              <select
                :id="`src-${g.id}`"
                v-model="e.dataSource"
                class="h-8 px-2 rounded-md border bg-background text-xs"
                @change="markDirty(g.id)"
              >
                <option value="">Mock (no live source)</option>
                <option v-for="s in sources" :key="s.key" :value="s.key">
                  {{ s.label }}
                </option>
              </select>
              <span v-if="e.dataSource" class="text-[10px] text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">
                LIVE
              </span>
            </div>
            <p class="text-[10px] uppercase tracking-wider text-muted-foreground">
              Targets · last 7 days · today · next 7 days · all editable
            </p>
            <div class="grid grid-cols-15 gap-1.5 min-w-[900px]" v-if="g.kind !== 'empty_bucket'">
              <div
                v-for="t in g.target_window"
                :key="t.date"
                class="flex flex-col items-stretch"
                :class="{ 'opacity-60': !t.editable }"
              >
                <div class="text-center mb-1">
                  <p class="text-[9px] uppercase tracking-wider text-muted-foreground">
                    {{ dateHeader(t.date).dow }}
                  </p>
                  <p
                    class="text-[10px] tabular-nums"
                    :class="isToday(t.date) ? 'font-bold text-foreground' : 'text-muted-foreground'"
                  >
                    {{ dateHeader(t.date).md }}
                  </p>
                </div>
                <input
                  type="number"
                  min="0"
                  :value="e.targets[t.date]"
                  :disabled="!t.editable"
                  class="w-full h-8 px-1.5 rounded-md border bg-background text-center text-sm tabular-nums disabled:cursor-not-allowed"
                  :class="isToday(t.date) ? 'ring-2 ring-foreground' : ''"
                  @input="(ev) => { e.targets[t.date] = (ev.target as HTMLInputElement).value; markDirty(g.id) }"
                />
              </div>
            </div>
            <p v-else class="text-xs text-muted-foreground">
              No editable targets — empty-bucket goals are always 0.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- New-goal dialog. Triggered by the top "+ New Goal" button.
         Creates a goal with label, department, kind, initial target,
         and optional live data source. -->
    <Dialog v-model:open="showNewGoalDialog">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Goal</DialogTitle>
          <DialogDescription>
            Creates a new KPI that appears on the scoreboard and in
            this admin list. Bind it to a live data source to pull real
            counts from project_cache / ticket_cache, or leave on Mock
            to use deterministic placeholder values.
          </DialogDescription>
        </DialogHeader>
        <div class="grid gap-3">
          <div class="grid gap-1.5">
            <Label for="new-goal-label">Label</Label>
            <Input
              id="new-goal-label"
              v-model="newGoalLabel"
              type="text"
              placeholder="e.g. Site surveys completed"
            />
          </div>
          <div class="grid gap-1.5">
            <Label for="new-goal-dept">Department</Label>
            <select
              id="new-goal-dept"
              v-model="newGoalDeptId"
              class="h-9 px-2 rounded-md border bg-background text-sm"
            >
              <option value="" disabled>Pick a department…</option>
              <option v-for="d in departments" :key="d.id" :value="String(d.id)">
                {{ d.name }}
              </option>
            </select>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div class="grid gap-1.5">
              <Label for="new-goal-kind">Kind</Label>
              <select
                id="new-goal-kind"
                v-model="newGoalKind"
                class="h-9 px-2 rounded-md border bg-background text-sm"
              >
                <option value="count">Count (X of N)</option>
                <option value="empty_bucket">Empty bucket (0 = met)</option>
              </select>
            </div>
            <div class="grid gap-1.5">
              <Label for="new-goal-target">Initial target</Label>
              <Input
                id="new-goal-target"
                v-model="newGoalTarget"
                type="number"
                min="0"
                :disabled="newGoalKind === 'empty_bucket'"
              />
            </div>
          </div>
          <div class="grid gap-1.5">
            <Label for="new-goal-source">Data source</Label>
            <select
              id="new-goal-source"
              v-model="newGoalSource"
              class="h-9 px-2 rounded-md border bg-background text-sm"
            >
              <option value="">Mock (no live source)</option>
              <option v-for="s in sources" :key="s.key" :value="s.key">
                {{ s.label }}
              </option>
            </select>
          </div>
          <p v-if="newGoalError" class="text-[11px] text-red-600">{{ newGoalError }}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" :disabled="newGoalSaving" @click="showNewGoalDialog = false">
            Cancel
          </Button>
          <Button :disabled="newGoalSaving" @click="createGoal">
            {{ newGoalSaving ? 'Creating…' : 'Create' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Custom-source dialog. New/edit a QB-report-backed source.
         Paste the report URL → we parse out report_id + table_id, the
         Test button runs the report once and shows per-day counts so
         the admin can sanity-check the group-by field before saving. -->
    <Dialog v-model:open="showCustomSourceDialog">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{{ csEditingId == null ? 'New' : 'Edit' }} Data Source</DialogTitle>
          <DialogDescription>
            Wraps a saved QuickBase <strong>table-type</strong> report
            as a goal data source. The report's filter stays in QB —
            we just run it on a 60-second cache and count rows. Chart/
            gauge reports return aggregated data instead of raw rows,
            so they can't be grouped by date here. Test first; if you
            see 0 rows, the report is either chart-type or empty.
          </DialogDescription>
        </DialogHeader>
        <div class="grid gap-3">
          <div class="grid gap-1.5">
            <Label for="cs-key">Source key</Label>
            <Input
              id="cs-key"
              v-model="csForm.key"
              type="text"
              placeholder="custom.permits_notify_ahj"
              :disabled="csEditingId != null"
            />
            <p class="text-[10px] text-muted-foreground">
              Lowercase + at least one dot. Locked after creation so goals don't orphan.
            </p>
          </div>
          <div class="grid gap-1.5">
            <Label for="cs-label">Label</Label>
            <Input id="cs-label" v-model="csForm.label" type="text" placeholder="Permits awaiting AHJ notify" />
          </div>
          <div class="grid gap-1.5">
            <Label for="cs-url">QB report URL</Label>
            <Input
              id="cs-url"
              v-model="csForm.report_url"
              type="url"
              placeholder="https://kin.quickbase.com/db/bscs3z866?a=q&qid=65"
              @input="onReportUrlInput"
            />
            <p v-if="csForm.report_id" class="text-[10px] text-muted-foreground">
              report {{ csForm.report_id }} on table {{ csForm.table_id }}
            </p>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div class="grid gap-1.5">
              <Label for="cs-groupby">Group-by field ID</Label>
              <Input id="cs-groupby" v-model.number="csForm.group_by_field_id" type="number" min="1" />
              <p class="text-[10px] text-muted-foreground">
                Field 1 = Date Created; pick a date field that exists on the report
              </p>
            </div>
            <div class="grid gap-1.5">
              <Label for="cs-kind">Kind</Label>
              <select id="cs-kind" v-model="csForm.kind" class="h-9 px-2 rounded-md border bg-background text-sm">
                <option value="count">Per-day count</option>
                <option value="snapshot">Snapshot count</option>
              </select>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" :disabled="csTesting" @click="testCustomSource">
              {{ csTesting ? 'Testing…' : 'Test report' }}
            </Button>
            <p v-if="csTestResult" class="text-[11px] text-muted-foreground tabular-nums">
              Total rows: {{ csTestResult.total_rows }} ·
              Available fields:
              {{ csTestResult.available_fields.slice(0, 8).join(', ') }}{{ csTestResult.available_fields.length > 8 ? '…' : '' }}
            </p>
          </div>
          <div v-if="csTestResult" class="rounded-md border bg-muted/30 p-2 grid grid-cols-7 gap-1 text-center">
            <div v-for="d in csTestResult.last_7_days" :key="d.date" class="text-[10px]">
              <p class="text-muted-foreground tabular-nums">{{ d.date.slice(5) }}</p>
              <p class="font-bold tabular-nums">{{ d.count }}</p>
            </div>
          </div>

          <p v-if="csError" class="text-[11px] text-red-600">{{ csError }}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" :disabled="csSaving" @click="showCustomSourceDialog = false">Cancel</Button>
          <Button :disabled="csSaving" @click="saveCustomSource">
            {{ csSaving ? 'Saving…' : (csEditingId == null ? 'Create' : 'Save') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- New-department dialog. Triggered by the "+" next to any goal's
         department dropdown. POSTs to /api/admin/departments, then
         re-fetches the goals list (which owns the dropdown source) and
         auto-selects the new department for the triggering goal. -->
    <Dialog v-model:open="showNewDeptDialog">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Department</DialogTitle>
          <DialogDescription>
            Creates a department in the canonical list — it'll be
            available in every goal's dropdown, and across the rest of
            the admin (user assignments, permissions).
          </DialogDescription>
        </DialogHeader>
        <div class="grid gap-2">
          <Label for="new-dept-name">Name</Label>
          <Input
            id="new-dept-name"
            v-model="newDeptName"
            type="text"
            placeholder="e.g. Operations"
            @keyup.enter="createDepartment"
          />
          <p v-if="newDeptError" class="text-[11px] text-red-600">{{ newDeptError }}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" :disabled="newDeptSaving" @click="showNewDeptDialog = false">
            Cancel
          </Button>
          <Button :disabled="newDeptSaving || newDeptName.trim().length === 0" @click="createDepartment">
            {{ newDeptSaving ? 'Creating…' : 'Create' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

<style scoped>
/* Tailwind 4 doesn't ship a `grid-cols-15` utility. Define it here so
   the 15-day strip lays out cleanly. */
.grid-cols-15 {
  grid-template-columns: repeat(15, minmax(0, 1fr));
}
</style>
