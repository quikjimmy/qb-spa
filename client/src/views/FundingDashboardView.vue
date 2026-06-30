<script setup lang="ts">
// Funding department dashboard — milestone toggle (M1 / M2 / M3 / DCA),
// canonical KPI tiles per milestone, click-to-drill audit dropdowns
// (B&B pattern), and a per-lender pivot for the selected milestone.
// Follows docs/ui-component-specs.md for sizing, color tokens, and
// table shapes.
import { computed, ref, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import DataFreshness from '@/components/DataFreshness.vue'
import { openProjectWithEvent } from '@/lib/openProject'
import { isBlockerLive } from '@/lib/fundingNotes'
import ProjectDetailDialog from '@/components/milestone/ProjectDetailDialog.vue'
import { localTodayIso } from '@/lib/dates'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Label } from '@/components/ui/label'

type Milestone = 'M1' | 'M2' | 'M3' | 'DCA'
type MilestoneMode = Milestone | 'ALL'
const NUMERIC_MILESTONES: Milestone[] = ['M1', 'M2', 'M3', 'DCA']

interface Bucket { count: number; expectedAmount: number; label: string }
interface MilestoneSummary {
  buckets: Record<string, Bucket>
  followUp?: { count: number; expectedAmount: number }
  pendingFollowUp?: { count: number; expectedAmount: number }
}
interface Overview {
  asOf: string
  activeMilestone: Milestone
  milestones: Record<Milestone, MilestoneSummary>
  byLender: Array<{ lender: string; status: string; count: number; expectedAmount: number }>
  appliedFilters?: { state?: string; closer?: string; lender?: string }
}
interface FilterOptions { states: string[]; closers: string[]; lenders: string[] }
interface AuditRow {
  recordId: number
  customerName: string
  state: string; status: string; lender: string
  salesDate: string; installScheduled: string; installCompleted: string
  milestoneStatus: string
  milestoneNotReadyNote: string; milestoneFundingNote: string
  milestoneRequestedDate: string; milestoneApprovedDate: string
  milestoneRejectedDate: string;  milestoneDepositDate: string
  milestoneExpectedAmount: number; milestoneNetReceived: number
  systemPrice: number; systemSizeKw: number
}

const auth = useAuthStore()
const router = useRouter()
const overview = ref<Overview | null>(null)
const loading = ref(true)
const err = ref('')

// Selected milestone — persists in localStorage so a coordinator
// returning to the page stays on the milestone they were last on.
const STORAGE_KEY = 'funding.milestone.v1'
function readStored(): MilestoneMode {
  if (typeof localStorage === 'undefined') return 'M2'
  const v = localStorage.getItem(STORAGE_KEY)
  return v === 'M1' || v === 'M2' || v === 'M3' || v === 'DCA' || v === 'ALL' ? v : 'M2'
}
const milestone = ref<MilestoneMode>(readStored())

// Filters scope every count, lender pivot row, and audit drill to a
// single state / closer / lender. Empty string = unset. Persisted in
// localStorage so navigation in/out keeps the active scope.
const FILTERS_KEY = 'funding.filters.v1'
function readFilters(): { state: string; closer: string; lender: string } {
  if (typeof localStorage === 'undefined') return { state: '', closer: '', lender: '' }
  try {
    const raw = localStorage.getItem(FILTERS_KEY)
    if (!raw) return { state: '', closer: '', lender: '' }
    const v = JSON.parse(raw)
    return { state: v.state || '', closer: v.closer || '', lender: v.lender || '' }
  } catch { return { state: '', closer: '', lender: '' } }
}
const fState  = ref('')
const fCloser = ref('')
const fLender = ref('')
const initial = readFilters()
fState.value  = initial.state
fCloser.value = initial.closer
fLender.value = initial.lender
const filterOptions = ref<FilterOptions>({ states: [], closers: [], lenders: [] })
const hasFilters = computed(() => !!(fState.value || fCloser.value || fLender.value))
const showFilterDrawer = ref(false)
function filterQS() {
  const p: string[] = []
  if (fState.value)  p.push(`state=${encodeURIComponent(fState.value)}`)
  if (fCloser.value) p.push(`closer=${encodeURIComponent(fCloser.value)}`)
  if (fLender.value) p.push(`lender=${encodeURIComponent(fLender.value)}`)
  return p.length ? '&' + p.join('&') : ''
}
function persistFilters() {
  try { localStorage.setItem(FILTERS_KEY, JSON.stringify({ state: fState.value, closer: fCloser.value, lender: fLender.value })) } catch { /* ignore */ }
}
function clearFilters() {
  fState.value = ''
  fCloser.value = ''
  fLender.value = ''
  persistFilters()
  auditRows.value = {}
  auditSort.value = {}
  loadOverview()
}
async function loadFilterOptions() {
  try {
    const res = await fetch('/api/funding/filter-options', { headers: hdrs() })
    if (res.ok) filterOptions.value = await res.json() as FilterOptions
  } catch { /* keep defaults */ }
}

// Per-bucket audit state. Lazy-loaded on first expand; cached after
// to keep toggle interactions snappy.
const auditOpen = ref<Record<string, boolean>>({})
const auditRows = ref<Record<string, AuditRow[]>>({})
const auditLoading = ref<Record<string, boolean>>({})

// Per-bucket sort state. Three-click cycle per column: desc → asc → off.
// Sorting only one column at a time; clicking a different column resets
// to desc on that column.
type SortCol = 'customer' | 'state' | 'status' | 'lender' | 'sale' | 'install' | 'milestone' | 'reqDays' | 'schedDays' | 'expected' | 'kw'
const auditSort = ref<Record<string, { col: SortCol; dir: 'asc' | 'desc' } | null>>({})
const SORT_KEY: Record<SortCol, (r: AuditRow) => string | number> = {
  customer:  r => (r.customerName || '').toLowerCase(),
  state:     r => (r.state || '').toLowerCase(),
  status:    r => (r.status || '').toLowerCase(),
  lender:    r => (r.lender || '').toLowerCase(),
  sale:      r => r.salesDate || '',
  install:   r => r.installCompleted || r.installScheduled || '',
  milestone: r => r.milestoneApprovedDate || r.milestoneRequestedDate || r.milestoneDepositDate || '',
  reqDays:   r => r.milestoneRequestedDate ? Date.now() - new Date(r.milestoneRequestedDate).getTime() : -Infinity,
  schedDays: r => r.installScheduled       ? Date.now() - new Date(r.installScheduled).getTime()       : -Infinity,
  expected:  r => r.milestoneExpectedAmount || 0,
  kw:        r => r.systemSizeKw || 0,
}
function toggleSort(bucketKey: string, col: SortCol) {
  const cur = auditSort.value[bucketKey]
  if (!cur || cur.col !== col) auditSort.value[bucketKey] = { col, dir: 'desc' }
  else if (cur.dir === 'desc')  auditSort.value[bucketKey] = { col, dir: 'asc' }
  else                          auditSort.value[bucketKey] = null
}
function sortIndicator(bucketKey: string, col: SortCol): string {
  const s = auditSort.value[bucketKey]
  if (!s || s.col !== col) return ''
  return s.dir === 'desc' ? '▼' : '▲'
}
function sortedRows(bucketKey: string): AuditRow[] {
  const raw = auditRows.value[bucketKey] || []
  const s = auditSort.value[bucketKey]
  if (!s) return raw
  const k = SORT_KEY[s.col]
  const sign = s.dir === 'asc' ? 1 : -1
  return [...raw].sort((a, b) => {
    const av = k(a), bv = k(b)
    if (av < bv) return -1 * sign
    if (av > bv) return  1 * sign
    return 0
  })
}

function hdrs() { return { Authorization: `Bearer ${auth.token}` } }

async function loadOverview() {
  loading.value = true
  err.value = ''
  try {
    // /overview returns counts for every milestone in one shot; the
    // `milestone` param only picks which one's lender pivot to include.
    // ALL mode doesn't show a pivot, so default to M2 for that query.
    const queryMs = milestone.value === 'ALL' ? 'M2' : milestone.value
    const res = await fetch(`/api/funding/overview?milestone=${queryMs}${filterQS()}`, { headers: hdrs() })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    overview.value = await res.json() as Overview
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function loadAudit(bucketKey: string) {
  if (auditRows.value[bucketKey]) return
  auditLoading.value[bucketKey] = true
  try {
    const res = await fetch(`/api/funding/audit?bucket=${encodeURIComponent(bucketKey)}${filterQS()}`, { headers: hdrs() })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { rows: AuditRow[] }
    auditRows.value[bucketKey] = data.rows
  } catch {
    auditRows.value[bucketKey] = []
  } finally {
    auditLoading.value[bucketKey] = false
  }
}

async function toggleAudit(bucketKey: string) {
  const next = !auditOpen.value[bucketKey]
  auditOpen.value[bucketKey] = next
  if (next) await loadAudit(bucketKey)
}

function setMilestone(m: MilestoneMode) {
  if (milestone.value === m) return
  milestone.value = m
  try { localStorage.setItem(STORAGE_KEY, m) } catch { /* ignore */ }
  // Clear any open audits — they're milestone-specific.
  auditOpen.value = {}
  auditSort.value = {}
  loadOverview()
}

onMounted(() => { loadOverview(); loadFilterOptions() })
watch(milestone, () => {
  // Re-fetch when milestone changes via toggle.
  auditRows.value = {}
  auditSort.value = {}
})
function applyFilter(key: 'state' | 'closer' | 'lender', value: string) {
  // Re-pull data when a filter changes. Existing audits are dropped
  // because their bucket counts are filter-scoped too.
  if (key === 'state')  fState.value  = fState.value  === value ? '' : value
  if (key === 'closer') fCloser.value = fCloser.value === value ? '' : value
  if (key === 'lender') fLender.value = fLender.value === value ? '' : value
  persistFilters()
  auditRows.value = {}
  auditSort.value = {}
  loadOverview()
}

// Project drawer — plain click opens the lite right-side bump-out
// (same component the PTO / Design / Permit / PC / Inspx dashboards
// use). Modifier clicks fall through to the full /projects/:id route
// in a new tab so power users keep their tab-stack flow.
type ProjectRow = Record<string, unknown> & { record_id: number; customer_name: string }
const selectedProject = ref<ProjectRow | null>(null)
async function openProject(rid: number, e?: MouseEvent) {
  if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1)) {
    openProjectWithEvent(router, rid, e)
    return
  }
  try {
    const res = await fetch(`/api/projects/${rid}?live=0`, { headers: hdrs() })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { project: ProjectRow }
    selectedProject.value = data.project
  } catch {
    // If the cache lookup fails, fall through to the full view rather
    // than silently swallowing the click.
    openProjectWithEvent(router, rid, e)
  }
}

// ─── Formatting ───────────────────────────────────────────────
function fmtMoney(n: number): string {
  if (!n) return '$0'
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`
  return `$${Math.round(n)}`
}
function fmtNum(n: number): string { return Math.round(n).toLocaleString() }
function fmtAuditDate(s: string): string { return s ? s.slice(0, 10) : '—' }

function daysSinceNum(s: string): number | null {
  if (!s) return null
  const then = new Date(s.slice(0, 10) + 'T00:00:00').getTime()
  if (!Number.isFinite(then)) return null
  const now = new Date(localTodayIso() + 'T00:00:00').getTime()
  const d = Math.floor((now - then) / 86400000)
  return d >= 0 ? d : null
}
function daysSince(s: string): string {
  const d = daysSinceNum(s)
  return d === null ? '—' : `${d}d`
}

// Install cell: completed = green "C", scheduled future = blue "S",
// scheduled past + not complete = red "S" (overdue install).
function installCell(r: AuditRow): { text: string; tone: string } {
  if (r.installCompleted) return { text: `C ${r.installCompleted.slice(0, 10)}`, tone: 'text-emerald-600' }
  if (r.installScheduled) {
    const date = r.installScheduled.slice(0, 10)
    const overdue = date < localTodayIso()
    return { text: `S ${date}`, tone: overdue ? 'text-rose-600' : 'text-sky-600' }
  }
  return { text: '—', tone: 'text-muted-foreground' }
}

// Milestone date cell: received > rejected > approved > submitted.
function milestoneCell(r: AuditRow): { text: string; tone: string } {
  const received = !!r.milestoneDepositDate && r.milestoneNetReceived > 0
  if (received) return { text: r.milestoneDepositDate.slice(0, 10), tone: 'text-emerald-600' }
  if (r.milestoneRejectedDate) return { text: `R ${r.milestoneRejectedDate.slice(0, 10)}`, tone: 'text-rose-600' }
  if (r.milestoneApprovedDate) return { text: `A ${r.milestoneApprovedDate.slice(0, 10)}`, tone: 'text-amber-600' }
  if (r.milestoneRequestedDate) return { text: `S ${r.milestoneRequestedDate.slice(0, 10)}`, tone: 'text-sky-600' }
  return { text: '—', tone: 'text-muted-foreground' }
}

// ─── Milestone toggle metadata ────────────────────────────────
const MILESTONES: Array<{ key: MilestoneMode; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'M1',  label: 'M1' },
  { key: 'M2',  label: 'M2' },
  { key: 'M3',  label: 'M3' },
  { key: 'DCA', label: 'DCA' },
]

// Accent palette per bucket — canonical color tokens only.
// Sky = primary, Violet = secondary, Emerald = success-leaning,
// Slate = inactive, Amber = warning, Rose = actionable failure.
type Accent = 'sky' | 'violet' | 'emerald' | 'slate' | 'amber' | 'rose'
const ACCENT_MAP: Record<string, Accent> = {
  // M1/M2/M3 share the same accent vocabulary; bucket key suffix wins.
  ready: 'sky', pending: 'violet', approved: 'emerald', notReady: 'slate',
  // DCA-specific
  createEvent: 'sky', pendingDeposit: 'emerald', overdue: 'rose', pendingM3: 'slate',
}
function accentFor(bucketKey: string): Accent {
  const suffix = bucketKey.split(':')[1] || ''
  return ACCENT_MAP[suffix] || 'sky'
}
// Tailwind needs literal class names — return the full token string.
function stripClass(accent: Accent): string {
  return ({ sky: 'bg-sky-500', violet: 'bg-violet-500', emerald: 'bg-emerald-500', slate: 'bg-slate-400', amber: 'bg-amber-500', rose: 'bg-rose-500' })[accent]
}
function textClass(accent: Accent): string {
  return ({ sky: 'text-sky-600', violet: 'text-violet-600', emerald: 'text-emerald-600', slate: 'text-slate-600', amber: 'text-amber-600', rose: 'text-rose-600' })[accent]
}

// Bucket views for a given milestone — status buckets followed by the
// stale follow-up bucket (for M1/M2/M3 only) so both sit in the same
// KPI grid. DCA has no follow-up. Used for both the KPI tile group
// and the audit-section dropdowns.
interface BucketView { key: string; bucket: Bucket; accent: Accent }
function bucketsForMilestone(m: Milestone): BucketView[] {
  if (!overview.value) return []
  const ms = overview.value.milestones[m]
  const list: BucketView[] = Object.entries(ms.buckets).map(([key, bucket]) => ({
    key, bucket, accent: accentFor(key),
  }))
  if (ms.followUp && m !== 'DCA') {
    list.push({
      key: `${m}:followUp`,
      bucket: { count: ms.followUp.count, expectedAmount: ms.followUp.expectedAmount, label: 'Stale Follow-Up' },
      accent: 'rose',
    })
  }
  if (ms.pendingFollowUp && m !== 'DCA') {
    list.push({
      key: `${m}:pendingFollowUp`,
      bucket: { count: ms.pendingFollowUp.count, expectedAmount: ms.pendingFollowUp.expectedAmount, label: 'Pending · Follow-Up' },
      accent: 'amber',
    })
  }
  return list
}

const activeBuckets = computed<BucketView[]>(() => {
  if (milestone.value === 'ALL') return []
  return bucketsForMilestone(milestone.value)
})

// KPI strip is horizontal-scroll instead of grid-wrap — keeps every
// tile at the canonical fixed width and stops them stacking onto a
// second row when there are 5+ buckets (M1/M2/M3 with follow-up
// callouts).
const KPI_STRIP_CLASS = 'flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1 min-w-0 snap-x'
const KPI_TILE_WIDTH = 'flex-none w-[180px] snap-start'

const activeFollowUp = computed(() => {
  if (!overview.value || milestone.value === 'ALL') return null
  return overview.value.milestones[milestone.value]?.followUp ?? null
})

// Follow-up has its own bucket key on the server (M1:followUp etc.) so
// the click-to-drill audit can hit /api/funding/audit with the same
// contract as the other tiles. DCA doesn't have a follow-up bucket.
const followUpKey = computed(() => milestone.value === 'DCA' ? null : `${milestone.value}:followUp`)

// Lender pivot helpers — same shape as the M2-only version, but
// dynamically derived from the active milestone's actionable statuses.
const STATUSES_BY_MS: Record<Milestone, string[]> = {
  M1: ['Ready to Request M1', 'Pending M1 Approval', 'M1 Approved', 'Not Ready for M1'],
  M2: ['Ready to Request M2', 'Pending M2 Approval', 'M2 Approved', 'Not Ready for M2'],
  M3: ['Ready to Request M3', 'Pending M3 Approval', 'M3 Approved', 'Not Ready for M3'],
  DCA: ['Create DCA Event', 'Pending DCA Deposit', 'DCA Overdue', 'Pending M3'],
}
const STATUS_SHORT: Record<string, string> = {
  'Ready to Request M1': 'Ready', 'Pending M1 Approval': 'Pending', 'M1 Approved': 'Approved · Not Recv', 'Not Ready for M1': 'Not Ready',
  'Ready to Request M2': 'Ready', 'Pending M2 Approval': 'Pending', 'M2 Approved': 'Approved · Not Recv', 'Not Ready for M2': 'Not Ready',
  'Ready to Request M3': 'Ready', 'Pending M3 Approval': 'Pending', 'M3 Approved': 'Approved · Not Recv', 'Not Ready for M3': 'Not Ready',
  'Create DCA Event': 'Create Event', 'Pending DCA Deposit': 'Pending Dep', 'DCA Overdue': 'Overdue', 'Pending M3': 'Pending M3',
}
const lenderRows = computed(() => {
  if (!overview.value || milestone.value === 'ALL') return []
  const cols = STATUSES_BY_MS[milestone.value]
  const map = new Map<string, { lender: string; cells: Record<string, Bucket>; totalCount: number; totalAmount: number }>()
  for (const r of overview.value.byLender) {
    let row = map.get(r.lender)
    if (!row) { row = { lender: r.lender, cells: {}, totalCount: 0, totalAmount: 0 }; map.set(r.lender, row) }
    row.cells[r.status] = { count: r.count, expectedAmount: r.expectedAmount, label: r.status }
    row.totalCount += r.count
    row.totalAmount += r.expectedAmount
  }
  return Array.from(map.values()).sort((a, b) => b.totalAmount - a.totalAmount).map(row => ({ ...row, cols }))
})
const lenderTotals = computed(() => {
  if (milestone.value === 'ALL') return { perStatus: {}, totalCount: 0, totalAmount: 0, cols: [] as string[] }
  const cols = STATUSES_BY_MS[milestone.value]
  const perStatus: Record<string, Bucket> = {}
  let totalCount = 0
  let totalAmount = 0
  for (const c of cols) perStatus[c] = { count: 0, expectedAmount: 0, label: c }
  for (const r of overview.value?.byLender ?? []) {
    if (!perStatus[r.status]) continue
    perStatus[r.status]!.count += r.count
    perStatus[r.status]!.expectedAmount += r.expectedAmount
    totalCount += r.count
    totalAmount += r.expectedAmount
  }
  return { perStatus, totalCount, totalAmount, cols }
})

// Audit summary for the collapsible header (count + $ across rows).
function auditSummary(bucketKey: string): { count: number; rev: number } {
  const rows = auditRows.value[bucketKey] || []
  return { count: rows.length, rev: Math.round(rows.reduce((s, r) => s + r.systemPrice, 0)) }
}

// Pull the milestone (M1/M2/M3/DCA) out of a bucket key — the audit
// drill needs this for column labels even when the global view is ALL.
function milestoneForBucket(bucketKey: string): Milestone {
  const head = bucketKey.split(':')[0]
  return (head === 'M1' || head === 'M2' || head === 'M3' || head === 'DCA') ? head : 'M2'
}
</script>

<template>
  <div class="grid gap-3 min-w-0">
    <!-- Header: title + freshness on the left, as-of on the right -->
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex flex-col gap-0.5 min-w-0">
        <h1 class="text-2xl font-semibold tracking-tight">Funding</h1>
        <DataFreshness resource="projects" label="Cache" @refreshed="loadOverview" />
      </div>
      <p v-if="overview" class="text-[11px] tabular-nums text-muted-foreground self-end">
        As of {{ overview.asOf }}
      </p>
    </div>

    <!-- Milestone toggle + filter-icon drawer (BookedBoarded pattern).
         State / Closer / Lender live in the drawer so the visible row
         stays compact; the icon shows a dot when any filter is active. -->
    <div class="flex flex-wrap items-center gap-2">
      <div class="inline-flex rounded-md border overflow-hidden" role="tablist" aria-label="Milestone">
        <button
          v-for="m in MILESTONES" :key="m.key"
          type="button"
          role="tab"
          :aria-selected="milestone === m.key"
          class="px-3 py-1.5 text-[11px] font-medium transition-colors cursor-pointer"
          :class="milestone === m.key ? 'bg-foreground text-background' : 'hover:bg-muted'"
          @click="setMilestone(m.key)"
        >
          {{ m.label }}
        </button>
      </div>

      <button
        class="relative inline-flex items-center justify-center rounded-md border size-8 transition-colors"
        :class="showFilterDrawer ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'"
        :title="hasFilters ? 'Filters · active' : 'More filters'"
        @click="showFilterDrawer = !showFilterDrawer"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
        <span v-if="hasFilters" class="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-rose-500" />
      </button>

      <button v-if="hasFilters" class="text-xs text-muted-foreground hover:text-foreground" @click="clearFilters">Clear</button>
    </div>

    <!-- Filter drawer — state + closer + lender. Hidden by default. -->
    <div v-if="showFilterDrawer" class="rounded-xl border bg-card p-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
      <div class="space-y-1.5">
        <Label class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">State</Label>
        <Select :model-value="fState || '__all__'" @update:model-value="v => applyFilter('state', v === '__all__' ? '' : String(v))">
          <SelectTrigger class="h-8 text-xs"><SelectValue placeholder="All states" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All states</SelectItem>
            <SelectItem v-for="s in filterOptions.states" :key="s" :value="s">{{ s }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div class="space-y-1.5">
        <Label class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Sales Rep</Label>
        <Select :model-value="fCloser || '__all__'" @update:model-value="v => applyFilter('closer', v === '__all__' ? '' : String(v))">
          <SelectTrigger class="h-8 text-xs"><SelectValue placeholder="All reps" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All reps</SelectItem>
            <SelectItem v-for="c in filterOptions.closers" :key="c" :value="c">{{ c }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div class="space-y-1.5">
        <Label class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Lender</Label>
        <Select :model-value="fLender || '__all__'" @update:model-value="v => applyFilter('lender', v === '__all__' ? '' : String(v))">
          <SelectTrigger class="h-8 text-xs"><SelectValue placeholder="All lenders" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All lenders</SelectItem>
            <SelectItem v-for="l in filterOptions.lenders" :key="l" :value="l">{{ l }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>

    <p v-if="loading" class="text-sm text-muted-foreground italic">Loading…</p>
    <div v-else-if="err" class="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
      Failed to load: {{ err }}
    </div>

    <template v-else-if="overview">
      <!-- ═══ KPI tiles · single-milestone view ═══ -->
      <section v-if="milestone !== 'ALL'" aria-label="Status KPIs" :class="KPI_STRIP_CLASS">
        <button
          v-for="b in activeBuckets" :key="b.key"
          type="button"
          class="rounded-xl border bg-card p-3 min-w-0 relative overflow-hidden text-left cursor-pointer hover:bg-muted/30 transition-colors focus:outline-none focus:ring-2 focus:ring-foreground/10"
          :class="[KPI_TILE_WIDTH, auditOpen[b.key] ? 'bg-muted/30 ring-2 ring-foreground/10' : '']"
          :title="`${b.bucket.label} — click to view projects`"
          @click="toggleAudit(b.key)"
        >
          <div class="absolute top-0 left-0 right-0 h-[3px]" :class="stripClass(b.accent)" />
          <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">{{ b.bucket.label }}</p>
          <p class="mt-1 flex items-baseline gap-1.5 min-w-0">
            <span class="text-2xl font-extrabold tabular-nums leading-none" :class="textClass(b.accent)">{{ fmtNum(b.bucket.count) }}</span>
            <span class="text-[11px] font-semibold tabular-nums text-muted-foreground truncate">/ {{ fmtMoney(b.bucket.expectedAmount) }}</span>
          </p>
          <p class="mt-1.5 text-[9px] font-semibold tabular-nums text-muted-foreground">
            {{ auditOpen[b.key] ? 'expected · ▾ open' : 'expected · ▸ tap to drill' }}
          </p>
        </button>
      </section>

      <!-- ═══ KPI tiles · ALL view ═══ Stacked per-milestone tile groups
           with their own section heading. Tiles are click-to-drill — the
           audit list at the bottom aggregates open buckets across all
           milestones into a single section. -->
      <template v-else>
        <section
          v-for="m in NUMERIC_MILESTONES" :key="`tiles-${m}`"
          :aria-label="`${m} status KPIs`"
          class="grid gap-2 min-w-0"
        >
          <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">{{ m }}</p>
          <div :class="KPI_STRIP_CLASS">
            <button
              v-for="b in bucketsForMilestone(m)" :key="b.key"
              type="button"
              class="rounded-xl border bg-card p-3 min-w-0 relative overflow-hidden text-left cursor-pointer hover:bg-muted/30 transition-colors focus:outline-none focus:ring-2 focus:ring-foreground/10"
              :class="[KPI_TILE_WIDTH, auditOpen[b.key] ? 'bg-muted/30 ring-2 ring-foreground/10' : '']"
              :title="`${b.bucket.label} — click to view projects`"
              @click="toggleAudit(b.key)"
            >
              <div class="absolute top-0 left-0 right-0 h-[3px]" :class="stripClass(b.accent)" />
              <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">{{ b.bucket.label }}</p>
              <p class="mt-1 flex items-baseline gap-1.5 min-w-0">
                <span class="text-2xl font-extrabold tabular-nums leading-none" :class="textClass(b.accent)">{{ fmtNum(b.bucket.count) }}</span>
                <span class="text-[11px] font-semibold tabular-nums text-muted-foreground truncate">/ {{ fmtMoney(b.bucket.expectedAmount) }}</span>
              </p>
              <p class="mt-1.5 text-[9px] font-semibold tabular-nums text-muted-foreground">
                {{ auditOpen[b.key] ? 'expected · ▾ open' : 'expected · ▸ tap to drill' }}
              </p>
            </button>
          </div>
        </section>
      </template>

      <!-- ═══ Audit · per-KPI dropdowns (B&B pattern) ═══ -->
      <section class="space-y-2">
        <div class="flex items-baseline gap-2 flex-wrap">
          <h2 class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">AUDIT · {{ milestone === 'ALL' ? 'ALL BUCKETS' : `${milestone} BUCKETS` }}</h2>
          <p class="text-[10px] text-muted-foreground italic">Click a section to expand</p>
        </div>
        <div
          v-for="b in (milestone === 'ALL' ? NUMERIC_MILESTONES.flatMap(bucketsForMilestone) : activeBuckets)" :key="`audit-${b.key}`"
          class="rounded-xl border bg-card overflow-hidden min-w-0"
        >
          <button
            type="button"
            class="w-full px-3 py-2 flex items-baseline justify-between gap-2 hover:bg-muted/30 transition-colors cursor-pointer"
            :aria-expanded="!!auditOpen[b.key]"
            @click="toggleAudit(b.key)"
          >
            <div class="flex items-baseline gap-2 min-w-0">
              <span class="text-[10px] text-muted-foreground">{{ auditOpen[b.key] ? '▾' : '▸' }}</span>
              <span class="text-[11px] font-semibold" :class="textClass(b.accent)">{{ b.bucket.label }}</span>
              <span class="text-[10px] tabular-nums text-muted-foreground">{{ fmtNum(b.bucket.count) }} · {{ fmtMoney(b.bucket.expectedAmount) }} expected</span>
            </div>
            <p v-if="auditOpen[b.key]" class="text-[10px] tabular-nums shrink-0 text-muted-foreground">
              loaded {{ fmtNum(auditSummary(b.key).count) }} · {{ fmtMoney(auditSummary(b.key).rev) }} system $
            </p>
          </button>
          <div v-if="auditOpen[b.key]">
            <p v-if="auditLoading[b.key]" class="px-3 pb-3 text-[11px] text-muted-foreground italic">Loading audit…</p>
            <div v-else-if="(auditRows[b.key] || []).length === 0" class="px-3 pb-3 text-[11px] text-muted-foreground italic">No records in this bucket.</div>
            <template v-else>
              <!-- Desktop table -->
              <div class="hidden sm:block overflow-auto max-h-[480px] border-t">
                <table class="w-full text-[11px] tabular-nums">
                  <thead class="bg-card text-muted-foreground sticky top-0 z-10 shadow-[0_1px_0_0_hsl(var(--border))]">
                    <tr>
                      <th class="text-left font-medium px-3 py-2 cursor-pointer select-none hover:text-foreground" @click="toggleSort(b.key, 'customer')">Customer <span class="text-[9px] opacity-70">{{ sortIndicator(b.key, 'customer') }}</span></th>
                      <th class="text-left font-medium px-2 py-2 cursor-pointer select-none hover:text-foreground" @click="toggleSort(b.key, 'state')">State <span class="text-[9px] opacity-70">{{ sortIndicator(b.key, 'state') }}</span></th>
                      <th class="text-left font-medium px-2 py-2 cursor-pointer select-none hover:text-foreground" @click="toggleSort(b.key, 'status')">Status <span class="text-[9px] opacity-70">{{ sortIndicator(b.key, 'status') }}</span></th>
                      <th class="text-left font-medium px-2 py-2 cursor-pointer select-none hover:text-foreground" @click="toggleSort(b.key, 'lender')">Lender <span class="text-[9px] opacity-70">{{ sortIndicator(b.key, 'lender') }}</span></th>
                      <th class="text-left font-medium px-2 py-2 cursor-pointer select-none hover:text-foreground" @click="toggleSort(b.key, 'sale')">Sale <span class="text-[9px] opacity-70">{{ sortIndicator(b.key, 'sale') }}</span></th>
                      <th class="text-left font-medium px-2 py-2 cursor-pointer select-none hover:text-foreground" @click="toggleSort(b.key, 'install')">Install <span class="text-[9px] opacity-70">{{ sortIndicator(b.key, 'install') }}</span></th>
                      <th class="text-left font-medium px-2 py-2 cursor-pointer select-none hover:text-foreground" @click="toggleSort(b.key, 'milestone')">{{ milestoneForBucket(b.key) }} <span class="text-[9px] opacity-70">{{ sortIndicator(b.key, 'milestone') }}</span></th>
                      <th class="text-right font-medium px-2 py-2 cursor-pointer select-none hover:text-foreground" title="Days since milestone was requested" @click="toggleSort(b.key, 'reqDays')"><span class="text-[9px] opacity-70">{{ sortIndicator(b.key, 'reqDays') }}</span> Req·d</th>
                      <th class="text-right font-medium px-2 py-2 cursor-pointer select-none hover:text-foreground" title="Days since install was scheduled" @click="toggleSort(b.key, 'schedDays')"><span class="text-[9px] opacity-70">{{ sortIndicator(b.key, 'schedDays') }}</span> Sched·d</th>
                      <th class="text-right font-medium px-3 py-2 cursor-pointer select-none hover:text-foreground" @click="toggleSort(b.key, 'expected')"><span class="text-[9px] opacity-70">{{ sortIndicator(b.key, 'expected') }}</span> Expected</th>
                      <th class="text-right font-medium px-2 py-2 cursor-pointer select-none hover:text-foreground" @click="toggleSort(b.key, 'kw')"><span class="text-[9px] opacity-70">{{ sortIndicator(b.key, 'kw') }}</span> kW</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y">
                    <tr
                      v-for="r in sortedRows(b.key)" :key="r.recordId"
                      class="hover:bg-muted/30 cursor-pointer"
                      @click="openProject(r.recordId, $event)"
                      @auxclick.prevent="openProject(r.recordId, $event)"
                    >
                      <td class="px-3 py-1.5 font-medium truncate max-w-[180px]" :title="r.customerName">{{ r.customerName || '—' }}</td>
                      <td class="px-2 py-1.5 truncate max-w-[80px]">{{ r.state || '—' }}</td>
                      <td class="px-2 py-1.5 truncate max-w-[100px]">{{ r.status || '—' }}</td>
                      <td class="px-2 py-1.5 truncate max-w-[120px]">{{ r.lender || '—' }}</td>
                      <td class="px-2 py-1.5 font-mono text-muted-foreground">{{ fmtAuditDate(r.salesDate) }}</td>
                      <td class="px-2 py-1.5 font-mono font-semibold" :class="installCell(r).tone">{{ installCell(r).text }}</td>
                      <td class="px-2 py-1.5 max-w-[200px]" :title="r.milestoneNotReadyNote || r.milestoneStatus">
                        <div class="font-mono font-semibold" :class="milestoneCell(r).tone">{{ milestoneCell(r).text }}</div>
                        <div v-if="r.milestoneNotReadyNote && isBlockerLive(r.milestoneStatus)" class="truncate text-[10px] text-amber-700/90 leading-tight">{{ r.milestoneNotReadyNote }}</div>
                      </td>
                      <td class="text-right px-2 py-1.5 text-muted-foreground">{{ daysSince(r.milestoneRequestedDate) }}</td>
                      <td class="text-right px-2 py-1.5 text-muted-foreground">{{ daysSince(r.installScheduled) }}</td>
                      <td class="text-right px-3 py-1.5">{{ fmtMoney(r.milestoneExpectedAmount) }}</td>
                      <td class="text-right px-2 py-1.5 text-muted-foreground">{{ Math.round(r.systemSizeKw * 10) / 10 }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <!-- Mobile cards -->
              <div class="sm:hidden divide-y border-t">
                <div
                  v-for="r in sortedRows(b.key)" :key="`m-${r.recordId}`"
                  class="px-3 py-2 min-w-0 cursor-pointer hover:bg-muted/30"
                  @click="openProject(r.recordId, $event)"
                  @auxclick.prevent="openProject(r.recordId, $event)"
                >
                  <div class="flex items-baseline justify-between gap-2 min-w-0">
                    <p class="font-semibold text-[12px] truncate" :title="r.customerName">{{ r.customerName || '—' }}</p>
                    <p class="text-[10px] tabular-nums text-muted-foreground shrink-0">{{ fmtMoney(r.milestoneExpectedAmount) }}</p>
                  </div>
                  <p class="text-[10px] text-muted-foreground truncate">{{ r.state || '—' }} · {{ r.lender || '—' }} · {{ r.status || '—' }}</p>
                  <div class="grid grid-cols-3 gap-1.5 mt-1.5 text-[10px] tabular-nums">
                    <div class="rounded bg-muted/30 px-2 py-1 min-w-0">
                      <p class="text-[9px] uppercase tracking-wider text-muted-foreground">Install</p>
                      <p class="font-semibold" :class="installCell(r).tone">{{ installCell(r).text }}</p>
                    </div>
                    <div class="rounded bg-muted/30 px-2 py-1 min-w-0">
                      <p class="text-[9px] uppercase tracking-wider text-muted-foreground">{{ milestoneForBucket(b.key) }}</p>
                      <p class="font-semibold" :class="milestoneCell(r).tone">{{ milestoneCell(r).text }}</p>
                    </div>
                    <div class="rounded bg-muted/30 px-2 py-1 min-w-0">
                      <p class="text-[9px] uppercase tracking-wider text-muted-foreground">Req · d</p>
                      <p class="font-semibold">{{ daysSince(r.milestoneRequestedDate) }}</p>
                    </div>
                  </div>
                  <!-- What's holding it up — the "Not Ready for Funding" reason.
                       Hidden once the milestone is submitted/approved/received so
                       stale blockers don't hang here. -->
                  <p v-if="r.milestoneNotReadyNote && isBlockerLive(r.milestoneStatus)" class="mt-1.5 text-[11px] leading-snug rounded bg-amber-50 text-amber-900 px-2 py-1">
                    {{ r.milestoneNotReadyNote }}
                  </p>
                </div>
              </div>
            </template>
          </div>
        </div>
      </section>

      <!-- ═══ Status by Lender — pivot for the active milestone only;
           hidden in ALL mode since lender breakdown is per-milestone. -->
      <div v-if="milestone !== 'ALL'" class="rounded-xl border bg-card overflow-hidden min-w-0">
        <div class="px-3 py-2 border-b flex items-baseline justify-between gap-2 flex-wrap">
          <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">{{ milestone }} STATUS · BY LENDER</p>
          <p class="text-[10px] text-muted-foreground tabular-nums">{{ lenderRows.length }} lender{{ lenderRows.length === 1 ? '' : 's' }} · sorted by total $</p>
        </div>
        <div v-if="lenderRows.length === 0" class="px-3 py-6 text-center text-[11px] text-muted-foreground italic">
          No projects in actionable {{ milestone }} statuses.
        </div>
        <template v-else>
          <div class="hidden sm:block">
            <table class="w-full text-[11px] tabular-nums">
              <thead class="bg-muted/30 text-muted-foreground">
                <tr>
                  <th class="text-left font-medium px-3 py-2">Lender</th>
                  <th v-for="s in lenderTotals.cols" :key="s" class="text-right font-medium px-2 py-2">{{ STATUS_SHORT[s] || s }}</th>
                  <th class="text-right font-medium px-3 py-2">Total</th>
                </tr>
              </thead>
              <tbody class="divide-y">
                <tr v-for="row in lenderRows" :key="row.lender" class="hover:bg-muted/30">
                  <td class="px-3 py-1.5 font-medium truncate max-w-[200px]" :title="row.lender">{{ row.lender }}</td>
                  <td v-for="s in row.cols" :key="s" class="text-right px-2 py-1.5">
                    <template v-if="row.cells[s]">
                      <span class="font-semibold">{{ row.cells[s]!.count }}</span>
                      <span class="text-[10px] text-muted-foreground ml-1">{{ fmtMoney(row.cells[s]!.expectedAmount) }}</span>
                    </template>
                    <span v-else class="text-muted-foreground">—</span>
                  </td>
                  <td class="text-right px-3 py-1.5 font-semibold">
                    {{ row.totalCount }}
                    <span class="text-[10px] text-muted-foreground font-normal ml-1">{{ fmtMoney(row.totalAmount) }}</span>
                  </td>
                </tr>
              </tbody>
              <tfoot class="border-t-2 bg-muted/20 font-semibold">
                <tr>
                  <td class="px-3 py-1.5">Total</td>
                  <td v-for="s in lenderTotals.cols" :key="s" class="text-right px-2 py-1.5">
                    {{ lenderTotals.perStatus[s]!.count }}
                    <span class="text-[10px] text-muted-foreground font-normal ml-1">{{ fmtMoney(lenderTotals.perStatus[s]!.expectedAmount) }}</span>
                  </td>
                  <td class="text-right px-3 py-1.5">
                    {{ lenderTotals.totalCount }}
                    <span class="text-[10px] text-muted-foreground font-normal ml-1">{{ fmtMoney(lenderTotals.totalAmount) }}</span>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div class="sm:hidden divide-y">
            <div v-for="row in lenderRows" :key="row.lender" class="px-3 py-2 min-w-0">
              <div class="flex items-baseline justify-between gap-2 min-w-0">
                <p class="font-semibold text-[12px] truncate" :title="row.lender">{{ row.lender }}</p>
                <p class="text-[10px] tabular-nums text-muted-foreground shrink-0">{{ row.totalCount }} · {{ fmtMoney(row.totalAmount) }}</p>
              </div>
              <div class="grid grid-cols-2 gap-1.5 mt-1.5 text-[10px] tabular-nums">
                <div v-for="s in row.cols" :key="s" class="rounded bg-muted/30 px-2 py-1 min-w-0">
                  <p class="text-[9px] uppercase tracking-wider text-muted-foreground truncate">{{ STATUS_SHORT[s] || s }}</p>
                  <p class="font-semibold">
                    <template v-if="row.cells[s]">
                      {{ row.cells[s]!.count }}
                      <span class="text-[9px] text-muted-foreground font-normal ml-1">{{ fmtMoney(row.cells[s]!.expectedAmount) }}</span>
                    </template>
                    <span v-else class="text-muted-foreground">—</span>
                  </p>
                </div>
              </div>
            </div>
            <div class="px-3 py-2 bg-muted/30 min-w-0">
              <p class="font-semibold text-[12px]">Total</p>
              <div class="grid grid-cols-2 gap-1.5 mt-1 text-[10px] tabular-nums">
                <div v-for="s in lenderTotals.cols" :key="s" class="rounded bg-muted/40 px-2 py-1 min-w-0">
                  <p class="text-[9px] uppercase tracking-wider text-muted-foreground truncate">{{ STATUS_SHORT[s] || s }}</p>
                  <p class="font-semibold">
                    {{ lenderTotals.perStatus[s]!.count }}
                    <span class="text-[9px] text-muted-foreground font-normal ml-1">{{ fmtMoney(lenderTotals.perStatus[s]!.expectedAmount) }}</span>
                  </p>
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>
    </template>
  </div>

  <!-- Lite project view — right-side bump-out. Setting selectedProject
       to null on close keeps the dashboard's bucket/audit state intact. -->
  <ProjectDetailDialog
    :project="selectedProject"
    context="funding"
    @update:open="(v) => { if (!v) selectedProject = null }"
  />
</template>
