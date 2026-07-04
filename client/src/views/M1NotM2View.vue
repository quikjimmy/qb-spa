<script setup lang="ts">
// M1 · Not M2 standalone audit. Mirrors the Installed-Not-M2 audit table
// from BookedBoardedView but lives on its own page with a M2-progress KPI
// strip (same style as M2 · Not M3), the shared funding filter drawer,
// and a "future scheduled install" quick filter — above the row list with
// its colored M2 cell, days-since columns, click-sort headers, and the
// stale-M1 urgency highlight.
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import DataFreshness from '@/components/DataFreshness.vue'
import { openProjectWithEvent } from '@/lib/openProject'
import { isBlockerLive } from '@/lib/fundingNotes'
import ProjectDetailDialog from '@/components/milestone/ProjectDetailDialog.vue'
import { localTodayIso } from '@/lib/dates'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Label } from '@/components/ui/label'

interface AuditRow {
  recordId: number; customerName: string
  state: string; status: string; closer: string; lender: string
  salesDate: string; installCompleted: string; installScheduled: string; m2Date: string
  m1RequestedDate: string; m2RequestedDate: string
  m2RejectedDate: string; m2ApprovedDate: string; m2NetReceived: number
  m2Status: string; m2ExpectedAmount: number
  m2NotReadyNote: string; m2FundingNote: string
  systemPrice: number; systemSizeKw: number
}
interface Response {
  asOf: string
  rows: AuditRow[]
  filterOptions: { states: string[]; closers: string[]; lenders: string[] }
  appliedFilters: Record<string, string | undefined>
}
interface FilterOptions { states: string[]; closers: string[]; lenders: string[] }

const auth = useAuthStore()
const router = useRouter()
const data = ref<Response | null>(null)
const loading = ref(true)
const err = ref('')
let loadSeq = 0
let inFlight: AbortController | null = null
let lastLoadStartedAt = 0
const RETURN_REFRESH_DEBOUNCE_MS = 750

// Filters — shared key with the Funding Dashboard / M2 · Not M3 so a
// scope set on one funding report carries across the others.
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
// Install-timing quick filter — client-side, session-only (not shared).
// 'future' = scheduled to be completed after today and not yet completed.
const fInstall = ref<'all' | 'future' | 'notFuture'>('all')
const filterOptions = ref<FilterOptions>({ states: [], closers: [], lenders: [] })
const hasFilters = computed(() => !!(fState.value || fCloser.value || fLender.value || fInstall.value !== 'all'))
const showFilterDrawer = ref(false)
function filterQS(): string {
  const p: string[] = []
  if (fState.value)  p.push(`state=${encodeURIComponent(fState.value)}`)
  if (fCloser.value) p.push(`closer=${encodeURIComponent(fCloser.value)}`)
  if (fLender.value) p.push(`lender=${encodeURIComponent(fLender.value)}`)
  return p.join('&')
}
function persistFilters() {
  try { localStorage.setItem(FILTERS_KEY, JSON.stringify({ state: fState.value, closer: fCloser.value, lender: fLender.value })) } catch { /* ignore */ }
}
function clearFilters() {
  fState.value = ''; fCloser.value = ''; fLender.value = ''; fInstall.value = 'all'; activeKpi.value = null
  persistFilters(); void load()
}
function applyFilter(key: 'state' | 'closer' | 'lender', value: string) {
  if (key === 'state')  fState.value  = fState.value  === value ? '' : value
  if (key === 'closer') fCloser.value = fCloser.value === value ? '' : value
  if (key === 'lender') fLender.value = fLender.value === value ? '' : value
  persistFilters(); void load()
}
async function loadFilterOptions() {
  try {
    const res = await fetch('/api/funding/filter-options', { headers: hdrs() })
    if (res.ok) filterOptions.value = await res.json() as FilterOptions
  } catch { /* keep defaults */ }
}

function hdrs() { return { Authorization: `Bearer ${auth.token}` } }

async function load(opts: { showLoading?: boolean } = {}) {
  const showLoading = opts.showLoading ?? !data.value
  const seq = ++loadSeq
  inFlight?.abort()
  inFlight = new AbortController()
  lastLoadStartedAt = Date.now()
  loading.value = showLoading
  err.value = ''
  try {
    const qs = filterQS()
    const res = await fetch(`/api/funding/m1-not-m2${qs ? '?' + qs : ''}`, {
      headers: hdrs(),
      cache: 'no-store',
      signal: inFlight.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const next = await res.json() as Response
    if (seq === loadSeq) data.value = next
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (seq === loadSeq) {
      loading.value = false
      inFlight = null
    }
  }
}

function refreshOnReturn() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  if (Date.now() - lastLoadStartedAt < RETURN_REFRESH_DEBOUNCE_MS) return
  void load({ showLoading: false })
}

onMounted(() => {
  void load(); void loadFilterOptions()
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', refreshOnReturn)
    window.addEventListener('pageshow', refreshOnReturn)
    document.addEventListener('visibilitychange', refreshOnReturn)
  }
})

onBeforeUnmount(() => {
  inFlight?.abort()
  if (typeof window !== 'undefined') {
    window.removeEventListener('focus', refreshOnReturn)
    window.removeEventListener('pageshow', refreshOnReturn)
    document.removeEventListener('visibilitychange', refreshOnReturn)
  }
})

// Project drawer — plain click opens the lite right-side bump-out
// (same component the PTO / Design / Permit / PC / Inspx dashboards
// use). Modifier clicks fall through to the full /projects/:id route
// in a new tab.
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
    openProjectWithEvent(router, rid, e)
  }
}

function fmtMoney(n: number): string {
  if (!n) return '$0'
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`
  return `$${Math.round(n)}`
}
function fmtNum(n: number): string { return Math.round(n).toLocaleString() }
function fmtAuditDate(s: string): string { return s ? s.slice(0, 10) : '—' }

// Install cell: completed wins (green, "C date"); otherwise scheduled
// shows as blue "S date" if the date is today or in the future, red
// "S date" when the scheduled date is already past (overdue install).
function installCell(r: AuditRow): { text: string; tone: string } {
  if (r.installCompleted) return { text: `C ${r.installCompleted.slice(0, 10)}`, tone: 'text-emerald-600' }
  if (r.installScheduled) {
    const date = r.installScheduled.slice(0, 10)
    const overdue = date < localTodayIso()
    return { text: `S ${date}`, tone: overdue ? 'text-red-600' : 'text-blue-600' }
  }
  return { text: '—', tone: 'text-muted-foreground' }
}

function m2Cell(r: AuditRow): { text: string; tone: string } {
  const received = !!r.m2Date && r.m2NetReceived > 0
  if (received) return { text: r.m2Date.slice(0, 10), tone: 'text-emerald-600' }
  if (r.m2RejectedDate) return { text: `R ${r.m2RejectedDate.slice(0, 10)}`, tone: 'text-red-600' }
  if (r.m2ApprovedDate) return { text: `A ${r.m2ApprovedDate.slice(0, 10)}`, tone: 'text-amber-600' }
  if (r.m2RequestedDate) return { text: `S ${r.m2RequestedDate.slice(0, 10)}`, tone: 'text-blue-600' }
  return { text: '—', tone: 'text-muted-foreground' }
}

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

// Same urgency rule as the B&B audit: no M2 submitted yet AND M1 has
// been sitting > 5 days. These are the rows that need eyes first — and
// the population behind the "M2 Aged" KPI tile.
function isUrgent(r: AuditRow): boolean {
  if (r.m2RequestedDate) return false
  const m1Age = daysSinceNum(r.m1RequestedDate)
  return m1Age !== null && m1Age > 5
}

// Install-timing quick filter applied client-side so it narrows the KPI
// tiles and the table together. A row is "future scheduled" when it has
// a scheduled date after today and isn't completed yet.
//   future    → keep only future-scheduled rows
//   notFuture → drop future-scheduled rows (everything else)
//   all       → no install filter
function isFutureScheduled(r: AuditRow): boolean {
  return !r.installCompleted && !!r.installScheduled && r.installScheduled.slice(0, 10) > localTodayIso()
}
const visibleRows = computed<AuditRow[]>(() => {
  const rows = data.value?.rows || []
  if (fInstall.value === 'all') return rows
  return rows.filter(r => fInstall.value === 'future' ? isFutureScheduled(r) : !isFutureScheduled(r))
})

// ─── KPI tiles — same style as M2 · Not M3, computed from the visible
// rows so they always match the table. M2 Aged reuses the row-highlight
// rule exactly. No funding-check recency gate: this is a chase list, so
// every actionable row in a status counts. Clicking a tile filters the
// table below to that bucket for quick analysis (click again to clear).
type Accent = 'sky' | 'violet' | 'emerald' | 'rose'
function stripClass(accent: Accent): string {
  return ({ sky: 'bg-sky-500', violet: 'bg-violet-500', emerald: 'bg-emerald-500', rose: 'bg-rose-500' })[accent]
}
function textClass(accent: Accent): string {
  return ({ sky: 'text-sky-600', violet: 'text-violet-600', emerald: 'text-emerald-600', rose: 'text-rose-600' })[accent]
}
function ringClass(accent: Accent): string {
  return ({ sky: 'ring-sky-500', violet: 'ring-violet-500', emerald: 'ring-emerald-500', rose: 'ring-rose-500' })[accent]
}
interface KpiDef { key: string; label: string; accent: Accent; pred: (r: AuditRow) => boolean }
const KPI_DEFS: KpiDef[] = [
  { key: 'ready',    label: 'Ready to Request M2',   accent: 'sky',     pred: r => r.m2Status === 'Ready to Request M2' },
  { key: 'pending',  label: 'Pending M2 Approval',   accent: 'violet',  pred: r => r.m2Status === 'Pending M2 Approval' || r.m2Status === 'Pending M2 Deposit' },
  { key: 'approved', label: 'M2 Approved · Not Recv', accent: 'emerald', pred: r => r.m2Status === 'M2 Approved' },
  { key: 'aged',     label: 'M2 Aged',               accent: 'rose',    pred: isUrgent },
]
interface Kpi extends KpiDef { count: number; expectedAmount: number }
const kpis = computed<Kpi[]>(() => {
  const rows = visibleRows.value
  return KPI_DEFS.map(def => {
    const agg = rows.reduce((a, r) => def.pred(r)
      ? { count: a.count + 1, expectedAmount: a.expectedAmount + (r.m2ExpectedAmount || 0) }
      : a, { count: 0, expectedAmount: 0 })
    return { ...def, ...agg }
  })
})

// Active KPI tile — when set, the table below shows only that bucket's
// rows. Tiles keep showing the full (install-scoped) counts so you can
// switch between buckets.
const activeKpi = ref<string | null>(null)
function toggleKpi(key: string) { activeKpi.value = activeKpi.value === key ? null : key }
const filteredRows = computed<AuditRow[]>(() => {
  if (!activeKpi.value) return visibleRows.value
  const def = KPI_DEFS.find(d => d.key === activeKpi.value)
  return def ? visibleRows.value.filter(def.pred) : visibleRows.value
})

const KPI_STRIP_CLASS = 'flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1 min-w-0 snap-x'
const KPI_TILE_WIDTH = 'flex-none w-[180px] snap-start'

type SortCol =
  | 'customerName' | 'state' | 'status' | 'closer' | 'lender'
  | 'salesDate' | 'install' | 'm2' | 'm1d' | 'm2d' | 'schedDays' | 'systemSizeKw'
type SortDir = 'asc' | 'desc'
const sort = ref<{ col: SortCol; dir: SortDir } | null>(null)
const NUMERIC_DEFAULT_DESC: SortCol[] = ['systemSizeKw', 'm1d', 'm2d', 'schedDays']

function toggleSort(col: SortCol) {
  const cur = sort.value
  const firstDir: SortDir = NUMERIC_DEFAULT_DESC.includes(col) ? 'desc' : 'asc'
  if (!cur || cur.col !== col) { sort.value = { col, dir: firstDir }; return }
  if (cur.dir === firstDir) { sort.value = { col, dir: firstDir === 'asc' ? 'desc' : 'asc' }; return }
  sort.value = null
}
function sortArrow(col: SortCol): string {
  const cur = sort.value
  if (!cur || cur.col !== col) return ''
  return cur.dir === 'asc' ? ' ↑' : ' ↓'
}

function sortKey(r: AuditRow, col: SortCol): string | number | null {
  switch (col) {
    case 'customerName':     return (r.customerName || '').toLowerCase()
    case 'state':            return (r.state || '').toLowerCase()
    case 'status':           return (r.status || '').toLowerCase()
    case 'closer':           return (r.closer || '').toLowerCase()
    case 'lender':           return (r.lender || '').toLowerCase()
    case 'salesDate':        return r.salesDate || ''
    case 'systemSizeKw':     return r.systemSizeKw
    case 'm1d':              return daysSinceNum(r.m1RequestedDate)
    case 'm2d':              return daysSinceNum(r.m2RequestedDate)
    case 'schedDays':        return daysSinceNum(r.installScheduled)
    // Install column: complete sorts after scheduled (priority 2 vs 1),
    // tie-break by date.
    case 'install': {
      if (r.installCompleted) return `2_${r.installCompleted}`
      if (r.installScheduled) return `1_${r.installScheduled}`
      return `0_`
    }
    case 'm2': {
      const received = !!r.m2Date && r.m2NetReceived > 0
      if (received)           return `4_${r.m2Date}`
      if (r.m2RejectedDate)   return `3_${r.m2RejectedDate}`
      if (r.m2ApprovedDate)   return `2_${r.m2ApprovedDate}`
      if (r.m2RequestedDate)  return `1_${r.m2RequestedDate}`
      return `0_`
    }
  }
}

const sortedRows = computed<AuditRow[]>(() => {
  const rows = filteredRows.value
  if (!sort.value) return rows
  const { col, dir } = sort.value
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const av = sortKey(a, col)
    const bv = sortKey(b, col)
    const aEmpty = av === null || av === '' || av === undefined
    const bEmpty = bv === null || bv === '' || bv === undefined
    if (aEmpty && bEmpty) return 0
    if (aEmpty) return 1
    if (bEmpty) return -1
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sign
    return String(av).localeCompare(String(bv)) * sign
  })
})

const totals = computed(() => {
  const rows = filteredRows.value
  return {
    count: rows.length,
    kw: Math.round(rows.reduce((s, r) => s + r.systemSizeKw, 0) * 10) / 10,
    rev: Math.round(rows.reduce((s, r) => s + r.systemPrice, 0)),
  }
})
</script>

<template>
  <div class="grid grid-cols-1 gap-3 min-w-0 max-w-full">
    <div class="flex flex-wrap items-baseline justify-between gap-3">
      <div class="flex flex-col gap-0.5 min-w-0">
        <h1 class="text-2xl font-semibold tracking-tight">M1 · Not M2</h1>
        <DataFreshness resource="projects" label="Data" @refreshed="load" />
      </div>
      <p v-if="data" class="text-[11px] tabular-nums shrink-0 text-muted-foreground">
        {{ totals.count }} projects · {{ totals.kw }} kW · {{ fmtMoney(totals.rev) }}
      </p>
    </div>

    <!-- Filter-icon drawer row -->
    <div class="flex flex-wrap items-center gap-2">
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

    <div v-if="showFilterDrawer" class="rounded-xl border bg-card p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
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
      <div class="space-y-1.5">
        <Label class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Install</Label>
        <Select :model-value="fInstall" @update:model-value="v => fInstall = (v === 'future' || v === 'notFuture') ? v : 'all'">
          <SelectTrigger class="h-8 text-xs"><SelectValue placeholder="All installs" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All installs</SelectItem>
            <SelectItem value="future">Future scheduled</SelectItem>
            <SelectItem value="notFuture">Exclude future</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>

    <p v-if="loading" class="text-sm text-muted-foreground italic">Loading…</p>
    <p v-else-if="err" class="text-sm text-red-600 font-semibold">Failed to load: {{ err }}</p>

    <template v-else-if="data">
      <!-- KPI strip — M2 progress for the M1 · Not M2 population. Click a
           tile to filter the table below to that bucket. -->
      <section aria-label="M1 · Not M2 KPIs" :class="KPI_STRIP_CLASS">
        <button
          v-for="k in kpis" :key="k.key"
          type="button"
          class="rounded-xl border bg-card p-3 min-w-0 relative overflow-hidden text-left transition-shadow hover:shadow-sm"
          :class="[KPI_TILE_WIDTH, activeKpi === k.key ? `ring-2 ${ringClass(k.accent)}` : '']"
          :aria-pressed="activeKpi === k.key"
          @click="toggleKpi(k.key)"
        >
          <div class="absolute top-0 left-0 right-0 h-[3px]" :class="stripClass(k.accent)" />
          <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">{{ k.label }}</p>
          <p class="mt-1 flex items-baseline gap-1.5 min-w-0">
            <span class="text-2xl font-extrabold tabular-nums leading-none" :class="textClass(k.accent)">{{ fmtNum(k.count) }}</span>
            <span class="text-[11px] font-semibold tabular-nums text-muted-foreground truncate">/ {{ fmtMoney(k.expectedAmount) }}</span>
          </p>
          <p class="mt-1.5 text-[9px] font-semibold tabular-nums text-muted-foreground">{{ activeKpi === k.key ? 'filtering · tap to clear' : 'expected' }}</p>
        </button>
      </section>

      <div v-if="sortedRows.length === 0" class="rounded-xl bg-card p-6 text-sm text-muted-foreground italic">
        No projects match this filter.
      </div>
      <div v-else class="rounded-xl bg-card overflow-hidden">
        <div class="overflow-auto max-h-[80vh]">
          <table class="w-full text-[10px] min-w-[840px]" style="table-layout:auto">
            <thead class="sticky top-0">
              <tr class="text-muted-foreground bg-muted">
                <th class="text-left font-semibold p-1.5 cursor-pointer select-none hover:text-foreground" @click="toggleSort('customerName')">Customer{{ sortArrow('customerName') }}</th>
                <th class="text-left font-semibold p-1.5 cursor-pointer select-none hover:text-foreground" @click="toggleSort('state')">State{{ sortArrow('state') }}</th>
                <th class="text-left font-semibold p-1.5 cursor-pointer select-none hover:text-foreground" @click="toggleSort('status')">Status{{ sortArrow('status') }}</th>
                <th class="text-left font-semibold p-1.5 cursor-pointer select-none hover:text-foreground" @click="toggleSort('lender')">Lender{{ sortArrow('lender') }}</th>
                <th class="text-left font-semibold p-1.5 cursor-pointer select-none hover:text-foreground" @click="toggleSort('salesDate')">Sale{{ sortArrow('salesDate') }}</th>
                <th class="text-left font-semibold p-1.5 cursor-pointer select-none hover:text-foreground" @click="toggleSort('install')">Inst{{ sortArrow('install') }}</th>
                <th class="text-left font-semibold p-1.5 cursor-pointer select-none hover:text-foreground" @click="toggleSort('m2')">M2{{ sortArrow('m2') }}</th>
                <th class="text-right font-semibold p-1.5 cursor-pointer select-none hover:text-foreground" title="Days since M1 requested" @click="toggleSort('m1d')">M1d{{ sortArrow('m1d') }}</th>
                <th class="text-right font-semibold p-1.5 cursor-pointer select-none hover:text-foreground" title="Days since M2 requested" @click="toggleSort('m2d')">M2d{{ sortArrow('m2d') }}</th>
                <th class="text-right font-semibold p-1.5 cursor-pointer select-none hover:text-foreground" title="Days since install was scheduled" @click="toggleSort('schedDays')">SchedD{{ sortArrow('schedDays') }}</th>
                <th class="text-right font-semibold p-1.5 cursor-pointer select-none hover:text-foreground" @click="toggleSort('systemSizeKw')">kW{{ sortArrow('systemSizeKw') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in sortedRows" :key="r.recordId" class="border-t border-border/30 cursor-pointer"
                  :class="isUrgent(r) ? 'bg-red-50/60 hover:bg-red-100/60 dark:bg-red-950/30 dark:hover:bg-red-950/50' : 'hover:bg-muted/30'"
                  @click="openProject(r.recordId, $event)"
                  @auxclick.prevent="openProject(r.recordId, $event)">
                <td class="p-1.5 font-medium truncate max-w-[160px]">{{ r.customerName || '—' }}</td>
                <td class="p-1.5 truncate max-w-[80px]">{{ r.state || '—' }}</td>
                <td class="p-1.5 truncate max-w-[100px]">{{ r.status || '—' }}</td>
                <td class="p-1.5 truncate max-w-[80px]">{{ r.lender || '—' }}</td>
                <td class="p-1.5 font-mono text-muted-foreground">{{ fmtAuditDate(r.salesDate) }}</td>
                <td class="p-1.5 font-mono font-semibold" :class="installCell(r).tone">{{ installCell(r).text }}</td>
                <td class="p-1.5 max-w-[200px]" :title="r.m2NotReadyNote || r.m2Status">
                  <div class="font-mono font-semibold" :class="m2Cell(r).tone">{{ m2Cell(r).text }}</div>
                  <div v-if="r.m2NotReadyNote && isBlockerLive(r.m2Status)" class="truncate text-[9px] font-sans text-amber-700/90 leading-tight">{{ r.m2NotReadyNote }}</div>
                </td>
                <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ daysSince(r.m1RequestedDate) }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ daysSince(r.m2RequestedDate) }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ daysSince(r.installScheduled) }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ Math.round(r.systemSizeKw * 10) / 10 }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>

  <ProjectDetailDialog
    :project="selectedProject"
    context="funding"
    @update:open="(v) => { if (!v) selectedProject = null }"
  />
</template>
