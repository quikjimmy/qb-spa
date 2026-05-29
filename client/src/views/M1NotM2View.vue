<script setup lang="ts">
// M1 · Not M2 standalone audit. Mirrors the Installed-Not-M2 audit table
// from BookedBoardedView but lives on its own page with no surrounding
// metrics — just the row list, colored M2 cell, days-since columns,
// click-sort headers, and the stale-M1 urgency highlight.
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import DataFreshness from '@/components/DataFreshness.vue'
import { openProjectWithEvent } from '@/lib/openProject'
import ProjectDetailDialog from '@/components/milestone/ProjectDetailDialog.vue'
import { localTodayIso } from '@/lib/dates'

interface AuditRow {
  recordId: number; customerName: string
  state: string; status: string; closer: string; lender: string
  salesDate: string; installCompleted: string; installScheduled: string; m2Date: string
  m1RequestedDate: string; m2RequestedDate: string
  m2RejectedDate: string; m2ApprovedDate: string; m2NetReceived: number
  systemPrice: number; systemSizeKw: number
}
interface Response {
  asOf: string
  rows: AuditRow[]
  filterOptions: { states: string[]; closers: string[]; lenders: string[] }
  appliedFilters: Record<string, string | undefined>
}

const auth = useAuthStore()
const router = useRouter()
const data = ref<Response | null>(null)
const loading = ref(true)
const err = ref('')
let loadSeq = 0
let inFlight: AbortController | null = null
let lastLoadStartedAt = 0
const RETURN_REFRESH_DEBOUNCE_MS = 750

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
    const res = await fetch('/api/funding/m1-not-m2', {
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
  void load()
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
// been sitting > 5 days. These are the rows that need eyes first.
function isUrgent(r: AuditRow): boolean {
  if (r.m2RequestedDate) return false
  const m1Age = daysSinceNum(r.m1RequestedDate)
  return m1Age !== null && m1Age > 5
}

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

function sortedRows(): AuditRow[] {
  const rows = data.value?.rows || []
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
}

function totals() {
  const rows = data.value?.rows || []
  return {
    count: rows.length,
    kw: Math.round(rows.reduce((s, r) => s + r.systemSizeKw, 0) * 10) / 10,
    rev: Math.round(rows.reduce((s, r) => s + r.systemPrice, 0)),
  }
}
</script>

<template>
  <div class="grid grid-cols-1 gap-3 min-w-0 max-w-full">
    <div class="flex flex-wrap items-baseline justify-between gap-3">
      <div class="flex flex-col gap-0.5 min-w-0">
        <h1 class="text-2xl font-semibold tracking-tight">M1 · Not M2</h1>
        <DataFreshness resource="projects" label="Data" @refreshed="load" />
      </div>
      <p v-if="data" class="text-[11px] tabular-nums shrink-0 text-muted-foreground">
        {{ data.rows.length }} projects · {{ totals().kw }} kW · {{ fmtMoney(totals().rev) }}
      </p>
    </div>

    <p v-if="loading" class="text-sm text-muted-foreground italic">Loading…</p>
    <p v-else-if="err" class="text-sm text-red-600 font-semibold">Failed to load: {{ err }}</p>
    <div v-else-if="data && data.rows.length === 0" class="rounded-xl bg-card p-6 text-sm text-muted-foreground italic">
      No projects match this filter.
    </div>
    <div v-else-if="data" class="rounded-xl bg-card overflow-hidden">
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
            <tr v-for="r in sortedRows()" :key="r.recordId" class="border-t border-border/30 cursor-pointer"
                :class="isUrgent(r) ? 'bg-red-50/60 hover:bg-red-100/60 dark:bg-red-950/30 dark:hover:bg-red-950/50' : 'hover:bg-muted/30'"
                @click="openProject(r.recordId, $event)"
                @auxclick.prevent="openProject(r.recordId, $event)">
              <td class="p-1.5 font-medium truncate max-w-[160px]">{{ r.customerName || '—' }}</td>
              <td class="p-1.5 truncate max-w-[80px]">{{ r.state || '—' }}</td>
              <td class="p-1.5 truncate max-w-[100px]">{{ r.status || '—' }}</td>
              <td class="p-1.5 truncate max-w-[80px]">{{ r.lender || '—' }}</td>
              <td class="p-1.5 font-mono text-muted-foreground">{{ fmtAuditDate(r.salesDate) }}</td>
              <td class="p-1.5 font-mono font-semibold" :class="installCell(r).tone">{{ installCell(r).text }}</td>
              <td class="p-1.5 font-mono font-semibold" :class="m2Cell(r).tone">{{ m2Cell(r).text }}</td>
              <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ daysSince(r.m1RequestedDate) }}</td>
              <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ daysSince(r.m2RequestedDate) }}</td>
              <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ daysSince(r.installScheduled) }}</td>
              <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ Math.round(r.systemSizeKw * 10) / 10 }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <ProjectDetailDialog
    :project="selectedProject"
    @update:open="(v) => { if (!v) selectedProject = null }"
  />
</template>
