<script setup lang="ts">
// Admin editor for the daily goals that drive /scoreboard.
// Editable per goal: department (FK), label, active toggle, and a
// 15-day target window (7 prior locked + today + 7 future editable).
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

interface BannerItem {
  id: number
  text: string
  active: number
  priority: number
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
const bannerItems = ref<BannerItem[]>([])
const bannerLoading = ref(false)
const bannerError = ref('')
const newBannerText = ref('')
const newBannerSaving = ref(false)

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

async function loadBanner(): Promise<void> {
  bannerLoading.value = true
  bannerError.value = ''
  try {
    const res = await fetch('/api/daily-goals/banner/all', { headers: hdrs() })
    if (!res.ok) {
      bannerError.value = `Failed (${res.status})`
      return
    }
    const data = (await res.json()) as { items: BannerItem[] }
    bannerItems.value = data.items
  } catch (e) {
    bannerError.value = e instanceof Error ? e.message : 'Network error'
  } finally {
    bannerLoading.value = false
  }
}

async function addBanner(): Promise<void> {
  const text = newBannerText.value.trim()
  if (text.length === 0) return
  newBannerSaving.value = true
  try {
    const res = await fetch('/api/daily-goals/banner', {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify({ text }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      bannerError.value = (err as { error?: string }).error || `Failed (${res.status})`
      return
    }
    newBannerText.value = ''
    await loadBanner()
  } catch (e) {
    bannerError.value = e instanceof Error ? e.message : 'Network error'
  } finally {
    newBannerSaving.value = false
  }
}

async function toggleBanner(item: BannerItem): Promise<void> {
  const res = await fetch(`/api/daily-goals/banner/${item.id}`, {
    method: 'PUT',
    headers: hdrs(),
    body: JSON.stringify({ active: !item.active }),
  })
  if (res.ok) await loadBanner()
}

async function deleteBanner(item: BannerItem): Promise<void> {
  if (!window.confirm(`Delete banner "${item.text}"?`)) return
  const res = await fetch(`/api/daily-goals/banner/${item.id}`, {
    method: 'DELETE',
    headers: hdrs(),
  })
  if (res.ok) await loadBanner()
}

onMounted(() => {
  load()
  loadBanner()
})
</script>

<template>
  <div class="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
    <!-- Scrolling banner messages — shown on the scoreboard ticker
         alongside live goal-hit celebrations. -->
    <Card>
      <CardHeader>
        <CardTitle>Scoreboard Ticker</CardTitle>
        <CardDescription>
          Messages that scroll at the bottom of
          <RouterLink to="/scoreboard" class="underline">the scoreboard</RouterLink>.
          Goal achievements auto-inject into the ticker for ~30s on
          top of these.
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-3">
        <div class="flex gap-2">
          <Input
            v-model="newBannerText"
            type="text"
            placeholder="Announcement, all-hands time, motivational line…"
            @keyup.enter="addBanner"
          />
          <Button :disabled="newBannerSaving || newBannerText.trim().length === 0" @click="addBanner">
            {{ newBannerSaving ? 'Adding…' : 'Add' }}
          </Button>
        </div>
        <p v-if="bannerError" class="text-[11px] text-red-600">{{ bannerError }}</p>
        <p v-if="bannerLoading && bannerItems.length === 0" class="text-sm text-muted-foreground">Loading…</p>
        <p v-else-if="bannerItems.length === 0" class="text-sm text-muted-foreground">
          No banner messages yet.
        </p>
        <ul v-else class="space-y-1.5">
          <li
            v-for="b in bannerItems"
            :key="b.id"
            class="flex items-center gap-2 text-sm"
          >
            <Switch
              :model-value="!!b.active"
              @update:model-value="() => toggleBanner(b)"
            />
            <span
              class="flex-1 min-w-0 truncate"
              :class="b.active ? 'text-foreground' : 'text-muted-foreground line-through'"
            >{{ b.text }}</span>
            <button
              type="button"
              class="flex-none w-7 h-7 rounded-md border flex items-center justify-center text-red-600 hover:bg-red-50 cursor-pointer"
              :aria-label="`Delete banner: ${b.text}`"
              @click="deleteBanner(b)"
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
            Past targets are locked in — editing tomorrow won't change
            yesterday's history. Empty-bucket goals are binary
            pass/fail (target always 0).
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
              Targets · 7 days prior locked · today + 7 days forward editable
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
