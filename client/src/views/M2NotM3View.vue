<script setup lang="ts">
// M2 · Not M3 — six KPI tiles for the M3 pipeline (mirroring QB
// reports 950/1036/1039/1034/1035/1040) above a single sortable table
// of every project sitting in an actionable M3 state. Per-bucket
// drill-through lives on the Funding Dashboard; this page is a flat
// audit list with the same shell (filter drawer, sticky sortable
// header, h-scroll KPI strip).
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import DataFreshness from '@/components/DataFreshness.vue'
import { openProjectWithEvent } from '@/lib/openProject'
import { localTodayIso } from '@/lib/dates'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Label } from '@/components/ui/label'

interface Bucket { count: number; expectedAmount: number; label: string }
interface Row {
  recordId: number
  customerName: string
  state: string; status: string; lender: string; closer: string
  salesDate: string
  m3Status: string
  m3ExpectedAmount: number; m3NetReceived: number
  m3RequestedDate: string; m3ApprovedDate: string
  m3RejectedDate: string;  m3DepositDate: string
  m3LastFundingCheckDate: string
  m2Status: string
  m2RequestedDate: string; m2ApprovedDate: string
  m2RejectedDate: string;  m2DepositDate: string; m2NetReceived: number
  systemPrice: number; systemSizeKw: number
}
interface OverviewResp {
  asOf: string
  buckets: Record<string, Bucket>
  rows: Row[]
  appliedFilters?: { state?: string; closer?: string; lender?: string }
}
interface FilterOptions { states: string[]; closers: string[]; lenders: string[] }

const auth = useAuthStore()
const router = useRouter()
const data = ref<OverviewResp | null>(null)
const loading = ref(true)
const err = ref('')
let loadSeq = 0
let inFlight: AbortController | null = null
let lastLoadStartedAt = 0
const RETURN_REFRESH_DEBOUNCE_MS = 750

// Filters — shared key with Funding Dashboard so a scope set there
// carries over here.
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
  fState.value = ''; fCloser.value = ''; fLender.value = ''
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
    const res = await fetch(`/api/funding/m2-not-m3${qs ? '?' + qs : ''}`, { headers: hdrs(), cache: 'no-store', signal: inFlight.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const next = await res.json() as OverviewResp
    if (seq === loadSeq) data.value = next
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (seq === loadSeq) { loading.value = false; inFlight = null }
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

function applyFilter(key: 'state' | 'closer' | 'lender', value: string) {
  if (key === 'state')  fState.value  = fState.value  === value ? '' : value
  if (key === 'closer') fCloser.value = fCloser.value === value ? '' : value
  if (key === 'lender') fLender.value = fLender.value === value ? '' : value
  persistFilters(); void load()
}

function openProject(rid: number, e?: MouseEvent) { openProjectWithEvent(router, rid, e) }

// ─── Formatting ───────────────────────────────────────────────
function fmtMoney(n: number): string {
  if (!n) return '$0'
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`
  return `$${Math.round(n)}`
}
function fmtNum(n: number): string { return Math.round(n).toLocaleString() }
function fmtDate(s: string): string { return s ? s.slice(0, 10) : '—' }

function daysSinceNum(s: string): number | null {
  if (!s) return null
  const then = new Date(s.slice(0, 10) + 'T00:00:00').getTime()
  if (!Number.isFinite(then)) return null
  const now = new Date(localTodayIso() + 'T00:00:00').getTime()
  const d = Math.floor((now - then) / 86400000)
  return d >= 0 ? d : null
}

function m2RefDate(r: Row): string {
  return r.m2DepositDate || r.m2ApprovedDate || r.m2RequestedDate || ''
}
function daysSinceM2(r: Row): string {
  const d = daysSinceNum(m2RefDate(r))
  return d === null ? '—' : `${d}d`
}

// M2 cell — same priority chain + colors as the M1 · Not M2 page.
function m2Cell(r: Row): { text: string; tone: string } {
  const received = !!r.m2DepositDate && r.m2NetReceived > 0
  if (received) return { text: r.m2DepositDate.slice(0, 10), tone: 'text-emerald-600' }
  if (r.m2RejectedDate) return { text: `R ${r.m2RejectedDate.slice(0, 10)}`, tone: 'text-rose-600' }
  if (r.m2ApprovedDate) return { text: `A ${r.m2ApprovedDate.slice(0, 10)}`, tone: 'text-amber-600' }
  if (r.m2RequestedDate) return { text: `S ${r.m2RequestedDate.slice(0, 10)}`, tone: 'text-sky-600' }
  return { text: '—', tone: 'text-muted-foreground' }
}
// M3 cell — same single-column R/A/S syntax for the M3 milestone.
function m3Cell(r: Row): { text: string; tone: string } {
  const received = !!r.m3DepositDate && r.m3NetReceived > 0
  if (received) return { text: r.m3DepositDate.slice(0, 10), tone: 'text-emerald-600' }
  if (r.m3RejectedDate) return { text: `R ${r.m3RejectedDate.slice(0, 10)}`, tone: 'text-rose-600' }
  if (r.m3ApprovedDate) return { text: `A ${r.m3ApprovedDate.slice(0, 10)}`, tone: 'text-amber-600' }
  if (r.m3RequestedDate) return { text: `S ${r.m3RequestedDate.slice(0, 10)}`, tone: 'text-sky-600' }
  return { text: '—', tone: 'text-muted-foreground' }
}

// Accent palette per bucket — rose for Rejected (actionable failure),
// amber for Stale Follow-Up (warning), rest match the funding palette.
type Accent = 'sky' | 'violet' | 'emerald' | 'slate' | 'amber' | 'rose'
const ACCENT_BY_KEY: Record<string, Accent> = {
  'M2NotM3:ready':    'sky',
  'M2NotM3:pending':  'violet',
  'M2NotM3:approved': 'emerald',
  'M2NotM3:notReady': 'slate',
  'M2NotM3:followUp': 'amber',
  'M2NotM3:rejected': 'rose',
}
function accentFor(bucketKey: string): Accent { return ACCENT_BY_KEY[bucketKey] || 'sky' }
function stripClass(accent: Accent): string {
  return ({ sky: 'bg-sky-500', violet: 'bg-violet-500', emerald: 'bg-emerald-500', slate: 'bg-slate-400', amber: 'bg-amber-500', rose: 'bg-rose-500' })[accent]
}
function textClass(accent: Accent): string {
  return ({ sky: 'text-sky-600', violet: 'text-violet-600', emerald: 'text-emerald-600', slate: 'text-slate-600', amber: 'text-amber-600', rose: 'text-rose-600' })[accent]
}

interface BucketView { key: string; bucket: Bucket; accent: Accent }
const BUCKET_ORDER = ['M2NotM3:ready', 'M2NotM3:pending', 'M2NotM3:approved', 'M2NotM3:notReady', 'M2NotM3:followUp', 'M2NotM3:rejected']
const activeBuckets = computed<BucketView[]>(() => {
  if (!data.value) return []
  return BUCKET_ORDER
    .filter(k => data.value!.buckets[k])
    .map(k => ({ key: k, bucket: data.value!.buckets[k]!, accent: accentFor(k) }))
})

const KPI_STRIP_CLASS = 'flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1 min-w-0 snap-x'
const KPI_TILE_WIDTH = 'flex-none w-[180px] snap-start'

// ─── Table sort (single column, 3-state desc → asc → off) ─────
type SortCol = 'customer' | 'state' | 'status' | 'lender' | 'sale' | 'm2date' | 'm3date' | 'm3status' | 'daysSinceM2' | 'expected' | 'kw'
const sort = ref<{ col: SortCol; dir: 'asc' | 'desc' } | null>(null)
function m3RefDate(r: Row): string {
  return r.m3DepositDate || r.m3RejectedDate || r.m3ApprovedDate || r.m3RequestedDate || ''
}
const SORT_KEY: Record<SortCol, (r: Row) => string | number> = {
  customer:    r => (r.customerName || '').toLowerCase(),
  state:       r => (r.state || '').toLowerCase(),
  status:      r => (r.status || '').toLowerCase(),
  lender:      r => (r.lender || '').toLowerCase(),
  sale:        r => r.salesDate || '',
  m2date:      r => m2RefDate(r),
  m3date:      r => m3RefDate(r),
  m3status:    r => (r.m3Status || '').toLowerCase(),
  daysSinceM2: r => { const d = m2RefDate(r); return d ? Date.now() - new Date(d).getTime() : -Infinity },
  expected:    r => r.m3ExpectedAmount || 0,
  kw:          r => r.systemSizeKw || 0,
}
function toggleSort(col: SortCol) {
  const cur = sort.value
  if (!cur || cur.col !== col) sort.value = { col, dir: 'desc' }
  else if (cur.dir === 'desc')  sort.value = { col, dir: 'asc' }
  else                          sort.value = null
}
function sortIndicator(col: SortCol): string {
  const s = sort.value
  if (!s || s.col !== col) return ''
  return s.dir === 'desc' ? '▼' : '▲'
}
const sortedRows = computed<Row[]>(() => {
  const rows = data.value?.rows || []
  if (!sort.value) return rows
  const k = SORT_KEY[sort.value.col]
  const sign = sort.value.dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const av = k(a), bv = k(b)
    if (av < bv) return -1 * sign
    if (av > bv) return  1 * sign
    return 0
  })
})

const totals = computed(() => {
  const rows = data.value?.rows || []
  return {
    count: rows.length,
    kw: Math.round(rows.reduce((s, r) => s + r.systemSizeKw, 0) * 10) / 10,
    rev: Math.round(rows.reduce((s, r) => s + r.m3ExpectedAmount, 0)),
  }
})
</script>

<template>
  <div class="grid gap-3 min-w-0">
    <!-- Header -->
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex flex-col gap-0.5 min-w-0">
        <h1 class="text-2xl font-semibold tracking-tight">M2 · Not M3</h1>
        <DataFreshness resource="projects" label="Cache" @refreshed="load" />
      </div>
      <p v-if="data" class="text-[11px] tabular-nums shrink-0 text-muted-foreground self-end">
        {{ totals.count }} projects · {{ totals.kw }} kW · {{ fmtMoney(totals.rev) }} expected
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

    <template v-else-if="data">
      <!-- KPI strip — informational; drill-through lives on the Funding Dashboard. -->
      <section aria-label="M2 · Not M3 KPIs" :class="KPI_STRIP_CLASS">
        <div
          v-for="b in activeBuckets" :key="b.key"
          class="rounded-xl border bg-card p-3 min-w-0 relative overflow-hidden"
          :class="KPI_TILE_WIDTH"
        >
          <div class="absolute top-0 left-0 right-0 h-[3px]" :class="stripClass(b.accent)" />
          <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">{{ b.bucket.label }}</p>
          <p class="mt-1 flex items-baseline gap-1.5 min-w-0">
            <span class="text-2xl font-extrabold tabular-nums leading-none" :class="textClass(b.accent)">{{ fmtNum(b.bucket.count) }}</span>
            <span class="text-[11px] font-semibold tabular-nums text-muted-foreground truncate">/ {{ fmtMoney(b.bucket.expectedAmount) }}</span>
          </p>
          <p class="mt-1.5 text-[9px] font-semibold tabular-nums text-muted-foreground">expected</p>
        </div>
      </section>

      <!-- Unified table — all projects in any actionable M3 state. -->
      <div v-if="data.rows.length === 0" class="rounded-xl bg-card p-6 text-sm text-muted-foreground italic">
        No projects match this filter.
      </div>
      <div v-else class="rounded-xl border bg-card overflow-hidden min-w-0">
        <div class="overflow-auto max-h-[80vh]">
          <table class="w-full text-[11px] tabular-nums min-w-[840px]">
            <thead class="bg-card text-muted-foreground sticky top-0 z-10 shadow-[0_1px_0_0_hsl(var(--border))]">
              <tr>
                <th class="text-left font-medium px-3 py-2 cursor-pointer select-none hover:text-foreground" @click="toggleSort('customer')">Customer <span class="text-[9px] opacity-70">{{ sortIndicator('customer') }}</span></th>
                <th class="text-left font-medium px-2 py-2 cursor-pointer select-none hover:text-foreground" @click="toggleSort('state')">State <span class="text-[9px] opacity-70">{{ sortIndicator('state') }}</span></th>
                <th class="text-left font-medium px-2 py-2 cursor-pointer select-none hover:text-foreground" @click="toggleSort('status')">Status <span class="text-[9px] opacity-70">{{ sortIndicator('status') }}</span></th>
                <th class="text-left font-medium px-2 py-2 cursor-pointer select-none hover:text-foreground" @click="toggleSort('lender')">Lender <span class="text-[9px] opacity-70">{{ sortIndicator('lender') }}</span></th>
                <th class="text-left font-medium px-2 py-2 cursor-pointer select-none hover:text-foreground" @click="toggleSort('sale')">Sale <span class="text-[9px] opacity-70">{{ sortIndicator('sale') }}</span></th>
                <th class="text-left font-medium px-2 py-2 cursor-pointer select-none hover:text-foreground" @click="toggleSort('m2date')">M2 <span class="text-[9px] opacity-70">{{ sortIndicator('m2date') }}</span></th>
                <th class="text-left font-medium px-2 py-2 cursor-pointer select-none hover:text-foreground" title="M3 milestone — S submitted · A approved · R rejected (deposit when received)" @click="toggleSort('m3date')">M3 <span class="text-[9px] opacity-70">{{ sortIndicator('m3date') }}</span></th>
                <th class="text-left font-medium px-2 py-2 cursor-pointer select-none hover:text-foreground" @click="toggleSort('m3status')">M3 Status <span class="text-[9px] opacity-70">{{ sortIndicator('m3status') }}</span></th>
                <th class="text-right font-medium px-2 py-2 cursor-pointer select-none hover:text-foreground" title="Days since M2 (deposit > approved > requested)" @click="toggleSort('daysSinceM2')"><span class="text-[9px] opacity-70">{{ sortIndicator('daysSinceM2') }}</span> Since M2</th>
                <th class="text-right font-medium px-3 py-2 cursor-pointer select-none hover:text-foreground" @click="toggleSort('expected')"><span class="text-[9px] opacity-70">{{ sortIndicator('expected') }}</span> Expected</th>
                <th class="text-right font-medium px-2 py-2 cursor-pointer select-none hover:text-foreground" @click="toggleSort('kw')"><span class="text-[9px] opacity-70">{{ sortIndicator('kw') }}</span> kW</th>
              </tr>
            </thead>
            <tbody class="divide-y">
              <tr
                v-for="r in sortedRows" :key="r.recordId"
                class="hover:bg-muted/30 cursor-pointer"
                @click="openProject(r.recordId, $event)"
                @auxclick.prevent="openProject(r.recordId, $event)"
              >
                <td class="px-3 py-1.5 font-medium truncate max-w-[180px]" :title="r.customerName">{{ r.customerName || '—' }}</td>
                <td class="px-2 py-1.5 truncate max-w-[80px]">{{ r.state || '—' }}</td>
                <td class="px-2 py-1.5 truncate max-w-[100px]">{{ r.status || '—' }}</td>
                <td class="px-2 py-1.5 truncate max-w-[120px]">{{ r.lender || '—' }}</td>
                <td class="px-2 py-1.5 font-mono text-muted-foreground">{{ fmtDate(r.salesDate) }}</td>
                <td class="px-2 py-1.5 font-mono font-semibold" :class="m2Cell(r).tone">{{ m2Cell(r).text }}</td>
                <td class="px-2 py-1.5 font-mono font-semibold" :class="m3Cell(r).tone">{{ m3Cell(r).text }}</td>
                <td class="px-2 py-1.5 truncate max-w-[140px]" :title="r.m3Status">{{ r.m3Status || '—' }}</td>
                <td class="text-right px-2 py-1.5 text-muted-foreground">{{ daysSinceM2(r) }}</td>
                <td class="text-right px-3 py-1.5">{{ fmtMoney(r.m3ExpectedAmount) }}</td>
                <td class="text-right px-2 py-1.5 text-muted-foreground">{{ Math.round(r.systemSizeKw * 10) / 10 }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>
