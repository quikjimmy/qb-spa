<script setup lang="ts">
import { ref, computed, inject, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import DataFreshness from '@/components/DataFreshness.vue'
import { fmtDate, localTodayIso } from '@/lib/dates'

import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent, MarkLineComponent } from 'echarts/components'
import VChart from 'vue-echarts'

use([CanvasRenderer, BarChart, LineChart, GridComponent, TooltipComponent, LegendComponent, MarkLineComponent])

// ─── Types ───────────────────────────────────────────────
interface Metric { count: number; kw: number; rev: number }
interface FlashStage {
  key: string; label: string
  dayBasis: 'sales' | 'operating'
  yesterday: Metric; last7d: Metric
  mtd: Metric; mtdPace: Metric
  pace30: Metric; pace30Monthly: Metric
  pace60: Metric; pace60Monthly: Metric
  lastMtd: Metric; ytd: Metric; lastYtd: Metric
  isTotal?: boolean
}
interface GapMetric { count: number; kw: number; rev: number; avgAgeDays: number; p90AgeDays: number; oldestDays: number; daysSupply: number }
interface CycleStats { n: number; min: number; p25: number; median: number; p75: number; max: number }
interface CycleWindow { window: '30d' | '60d' | '90d'; current: CycleStats; prior: CycleStats }
interface CycleTransition { stage: string; windows: CycleWindow[] }
interface MacdPoint { date: string; count: number; ma30: number; ma60: number; macd: number; signal: number; histogram: number }
interface DrillRow { name: string; count: number; kw: number; rev: number; daysSupply: number }
interface AuditRow {
  recordId: number; customerName: string
  state: string; status: string; closer: string; lender: string
  salesDate: string; installCompleted: string; m2Date: string; m3Date: string
  systemPrice: number; systemSizeKw: number; cancelDate: string
}
interface SLA {
  bookedToInstalled: { warn: number; red: number }
  installedToM2: { warn: number; red: number }
  m2ToM3: { warn: number; red: number }
  pendingCancel: { warn: number; red: number }
}
interface Report {
  asOf: string
  timeframe: { from: string; to: string; key: string }
  sla: SLA
  flash: { stages: FlashStage[]; sellingDaysElapsed: number; sellingDaysTotal: number; operatingDaysElapsed: number; operatingDaysTotal: number }
  gaps: {
    soldNotInstalled: GapMetric
    installedNotM2: GapMetric
    m2NotM3: GapMetric
  }
  cycleTime: { transitions: CycleTransition[] }
  macd: { subject: string; points: MacdPoint[] }
  audit: Record<GapKey, AuditRow[]>
  filterOptions: { states: string[]; closers: string[]; lenders: string[] }
  appliedFilters: { state?: string; closer?: string; lender?: string }
}
type Unit = '#' | 'kW' | '$'
type Timeframe = 'yesterday' | '7d' | 'mtd' | '30d' | '60d' | 'ytd' | 'custom'
type GapKey = 'soldNotInstalled' | 'installedNotM2' | 'm2NotM3'
type Dimension = 'state' | 'closer' | 'setter' | 'sales_office' | 'lender' | 'utility' | 'ahj' | 'area_director' | 'coordinator'
// MACD subject is locked to Booked for v1. Server still accepts a subject
// param so we can expand later without a schema change.
type MacdSubject = 'booked'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

// ─── State (filters) ─────────────────────────────────────
// Source of truth order: URL query → localStorage → defaults. URL wins
// when set so a shared link always overrides any cached preference.
const STORAGE_KEY = 'bb.filters.v1'
function readStored(): Partial<Record<string, string>> {
  if (typeof localStorage === 'undefined') return {}
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') } catch { return {} }
}
const stored = readStored()
const fState = ref((route.query['state'] as string) || stored['state'] || '')
const fCloser = ref((route.query['closer'] as string) || stored['closer'] || '')
const fLender = ref((route.query['lender'] as string) || stored['lender'] || '')
const timeframe = ref<Timeframe>((route.query['timeframe'] as Timeframe) || (stored['timeframe'] as Timeframe) || 'mtd')
const customFrom = ref((route.query['from'] as string) || stored['from'] || '')
const customTo = ref((route.query['to'] as string) || stored['to'] || '')
const asOf = ref((route.query['asOf'] as string) || localTodayIso())
// Default unit = kW (sales/install KPIs in this app are kW-first; the
// $ view is for finance and # is for ops density). Stored value still
// wins for repeat visitors.
const unit = ref<Unit>((route.query['unit'] as Unit) || (stored['unit'] as Unit) || 'kW')
const macdSubject = ref<MacdSubject>('booked')

const data = ref<Report | null>(null)
const loading = ref(true)
const err = ref('')

// Drill panel state — selected gap + dimension + rows.
const drillGap = ref<GapKey | null>((route.query['drill'] as GapKey) || null)
const drillDim = ref<Dimension>((route.query['drillDim'] as Dimension) || 'state')
const drillRows = ref<DrillRow[]>([])
const drillLoading = ref(false)

// Filter drawer toggle.
const showDrawer = ref(false)

// Audit cheat-table accordions — collapsed by default to keep the page
// reasonable. Each gap expands independently.
const auditOpen = ref<Record<GapKey, boolean>>({
  soldNotInstalled: false,
  installedNotM2: false,
  m2NotM3: false,
})

function hdrs() { return { Authorization: `Bearer ${auth.token}` } }

// Persist filter state to localStorage so navigating away + back keeps
// the report exactly where the user left it. URL is also synced for
// shareable links.
function persist() {
  const payload: Record<string, string> = {}
  if (fState.value)   payload['state']   = fState.value
  if (fCloser.value)  payload['closer']  = fCloser.value
  if (fLender.value)  payload['lender']  = fLender.value
  if (timeframe.value !== 'mtd') payload['timeframe'] = timeframe.value
  if (timeframe.value === 'custom') {
    if (customFrom.value) payload['from'] = customFrom.value
    if (customTo.value)   payload['to']   = customTo.value
  }
  if (unit.value !== 'kW') payload['unit'] = unit.value
  if (drillGap.value) payload['drill'] = drillGap.value
  if (drillGap.value && drillDim.value !== 'state') payload['drillDim'] = drillDim.value
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(payload)) } catch { /* ignore */ }
  router.replace({ query: payload })
}

// ─── Load ────────────────────────────────────────────────
async function load() {
  loading.value = true
  err.value = ''
  const params = new URLSearchParams()
  if (fState.value)  params.set('state', fState.value)
  if (fCloser.value) params.set('closer', fCloser.value)
  if (fLender.value) params.set('lender', fLender.value)
  if (timeframe.value !== 'mtd') params.set('timeframe', timeframe.value)
  if (timeframe.value === 'custom') {
    if (customFrom.value) params.set('from', customFrom.value)
    if (customTo.value)   params.set('to',   customTo.value)
  }
  if (asOf.value && asOf.value !== localTodayIso()) params.set('asOf', asOf.value)
  params.set('macd', macdSubject.value)
  try {
    const res = await fetch(`/api/reports/booked-and-boarded?${params}`, { headers: hdrs() })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    data.value = await res.json() as Report
    if (drillGap.value) await loadDrill()  // re-pull drill rows under new filters
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function loadDrill() {
  if (!drillGap.value) { drillRows.value = []; return }
  drillLoading.value = true
  const params = new URLSearchParams({ gap: drillGap.value, dimension: drillDim.value })
  if (fState.value)  params.set('state', fState.value)
  if (fCloser.value) params.set('closer', fCloser.value)
  if (fLender.value) params.set('lender', fLender.value)
  if (timeframe.value !== 'mtd') params.set('timeframe', timeframe.value)
  if (timeframe.value === 'custom') {
    if (customFrom.value) params.set('from', customFrom.value)
    if (customTo.value)   params.set('to',   customTo.value)
  }
  if (asOf.value && asOf.value !== localTodayIso()) params.set('asOf', asOf.value)
  try {
    const res = await fetch(`/api/reports/booked-and-boarded/drill?${params}`, { headers: hdrs() })
    if (res.ok) drillRows.value = (await res.json()).rows as DrillRow[]
  } catch { /* non-fatal */ } finally { drillLoading.value = false }
}

// ─── Setters ─────────────────────────────────────────────
function setState(s: string)     { fState.value = s === '__all__' ? '' : s; persist(); load() }
function setCloser(s: string)    { fCloser.value = s === '__all__' ? '' : s; persist(); load() }
function setLender(s: string)    { fLender.value = s === '__all__' ? '' : s; persist(); load() }
function setTimeframe(t: Timeframe) { timeframe.value = t; persist(); load() }
function setUnit(u: Unit)        { unit.value = u; persist() }

function clearFilters() {
  fState.value = ''; fCloser.value = ''; fLender.value = ''
  timeframe.value = 'mtd'; customFrom.value = ''; customTo.value = ''
  drillGap.value = null
  persist(); load()
}

const hasFilters = computed(() => !!(fState.value || fCloser.value || fLender.value || timeframe.value !== 'mtd'))

// ─── Drill control ───────────────────────────────────────
async function selectGap(g: GapKey) {
  drillGap.value = drillGap.value === g ? null : g
  persist()
  if (drillGap.value) {
    await loadDrill()
    setTimeout(() => document.getElementById('bb-drill')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100)
  }
}
async function setDimension(d: Dimension) { drillDim.value = d; persist(); await loadDrill() }
function closeDrill() { drillGap.value = null; persist() }

// ─── Formatters ──────────────────────────────────────────
function fmtNum(n: number): string { return Math.round(n).toLocaleString() }
function pct(n: number): string { return `${Math.round(n * 100)}%` }
function fmtKw(kw: number): string {
  if (kw >= 1000) return `${(kw / 1000).toFixed(1)} MW`
  return `${Math.round(kw)} kW`
}
// Smart $: $1.2K, $1.2M, or $1,234,567 if between 1k–1m and not rounding.
function fmtMoney(n: number): string {
  if (n === 0) return '$0'
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000)     return `${sign}$${(abs / 1_000).toFixed(1)}K`
  return `${sign}$${Math.round(abs).toLocaleString()}`
}
// Active-unit value for any metric. Drives the page-wide # / kW / $ toggle.
function metricValue(m: Metric | undefined): string {
  if (!m) return '—'
  if (unit.value === 'kW') return fmtKw(m.kw)
  if (unit.value === '$') return fmtMoney(m.rev)
  return fmtNum(m.count)
}
function flashDelta(s: FlashStage): { value: number; tone: string; symbol: string } {
  const cur = unit.value === 'kW' ? s.mtd.kw : unit.value === '$' ? s.mtd.rev : s.mtd.count
  const prev = unit.value === 'kW' ? s.lastMtd.kw : unit.value === '$' ? s.lastMtd.rev : s.lastMtd.count
  const d = cur - prev
  if (d > 0) return { value: d, tone: 'text-emerald-600', symbol: '↑' }
  if (d < 0) return { value: d, tone: 'text-red-500', symbol: '↓' }
  return { value: 0, tone: 'text-muted-foreground', symbol: '·' }
}
function fmtDeltaValue(d: number): string {
  if (unit.value === 'kW') return fmtKw(Math.abs(d))
  if (unit.value === '$') return fmtMoney(Math.abs(d))
  return fmtNum(Math.abs(d))
}

// Cycle time delta vs prior-year same window. Negative delta = faster
// = good (emerald). Positive = slower (amber). Zero or no prior = muted.
function cycleDeltaText(w: CycleWindow): string {
  if (!w.prior.n) return '—'
  const d = w.current.median - w.prior.median
  if (d === 0) return '0d'
  return d > 0 ? `+${d}d` : `${d}d`
}
function cycleDeltaTone(w: CycleWindow): string {
  if (!w.prior.n) return 'text-muted-foreground'
  const d = w.current.median - w.prior.median
  if (d < 0) return 'text-emerald-600 font-semibold'
  if (d > 0) return 'text-amber-600 font-semibold'
  return 'text-muted-foreground'
}

// ─── Timeframe pills ─────────────────────────────────────
const TIMEFRAMES: Array<{ key: Timeframe; label: string }> = [
  { key: 'yesterday', label: 'Yday' },
  { key: '7d', label: '7d' },
  { key: 'mtd', label: 'MTD' },
  { key: '30d', label: '30d' },
  { key: '60d', label: '60d' },
  { key: 'ytd', label: 'YTD' },
]

// ─── MACD chart option ───────────────────────────────────
const macdOption = computed(() => {
  if (!data.value) return {}
  const points = data.value.macd.points
  const dates = points.map(p => p.date)
  const counts = points.map(p => p.count)
  const ma30 = points.map(p => p.ma30)
  const ma60 = points.map(p => p.ma60)
  const macd = points.map(p => p.macd)
  const signal = points.map(p => p.signal)
  const histogram = points.map(p => p.histogram)
  return {
    backgroundColor: 'transparent',
    grid: [
      { left: 50, right: 16, top: 32, height: '55%' },
      { left: 50, right: 16, top: '72%', height: '24%' },
    ],
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
    // Histogram is excluded from the legend because its bars are
    // conditionally green/red — a single legend swatch would mismatch
    // the bar colors and confuse the reader. Bars are still labeled
    // via tooltip on hover.
    legend: { top: 4, right: 16, textStyle: { fontSize: 10 }, data: ['Daily', '30d MA', '60d MA', 'MACD', 'Signal'] },
    xAxis: [
      { type: 'category', data: dates, gridIndex: 0, axisLabel: { fontSize: 9, hideOverlap: true } },
      { type: 'category', data: dates, gridIndex: 1, axisLabel: { fontSize: 9, hideOverlap: true } },
    ],
    yAxis: [
      { type: 'value', gridIndex: 0, axisLabel: { fontSize: 9 } },
      { type: 'value', gridIndex: 1, axisLabel: { fontSize: 9 } },
    ],
    series: [
      // Top panel — daily volume + 30d/60d moving averages.
      { name: 'Daily', type: 'bar', data: counts, itemStyle: { color: 'rgba(100,116,139,0.45)' } },
      { name: '30d MA', type: 'line', data: ma30, smooth: true, symbol: 'none', lineStyle: { color: '#3b82f6', width: 2.5 } },
      { name: '60d MA', type: 'line', data: ma60, smooth: true, symbol: 'none', lineStyle: { color: '#f59e0b', width: 2.5 } },
      // Bottom panel — MACD spread (purple, distinct from 30d MA blue),
      // signal line (red), histogram (conditional green/red).
      { name: 'MACD', type: 'line', data: macd, smooth: true, symbol: 'none',
        xAxisIndex: 1, yAxisIndex: 1, lineStyle: { color: '#8b5cf6', width: 2 } },
      { name: 'Signal', type: 'line', data: signal, smooth: true, symbol: 'none',
        xAxisIndex: 1, yAxisIndex: 1, lineStyle: { color: '#ef4444', width: 2 } },
      { name: 'Histogram', type: 'bar', data: histogram, xAxisIndex: 1, yAxisIndex: 1, itemStyle: {
        color: ({ data: v }: { data: number }) => v >= 0 ? 'rgba(16,185,129,0.7)' : 'rgba(239,68,68,0.7)',
      } },
    ],
  }
})

// ─── Lifecycle ───────────────────────────────────────────
const registerRefresh = inject<(fn: () => Promise<void>) => void>('registerRefresh')
onMounted(() => {
  load()
  registerRefresh?.(load)
})
watch([asOf, customFrom, customTo], () => { persist(); load() })

function openProject(rid: number) {
  router.push({ name: 'project-detail', params: { id: String(rid) } })
}

// Dimensions for the drill switcher.
const DIMENSIONS: Array<{ key: Dimension; label: string }> = [
  { key: 'state', label: 'State' },
  { key: 'closer', label: 'Closer' },
  { key: 'setter', label: 'Setter' },
  { key: 'sales_office', label: 'Office' },
  { key: 'lender', label: 'Lender' },
  { key: 'utility', label: 'Utility' },
  { key: 'ahj', label: 'AHJ' },
  { key: 'area_director', label: 'Area Director' },
  { key: 'coordinator', label: 'PC' },
]

// KPI chip metadata. Bar color matches text color (same -600 shade) so
// the colored line at top reads as the same accent as the headline number.
const GAP_META: Record<GapKey, { label: string; subtitle: string; color: string; bar: string }> = {
  soldNotInstalled: { label: 'Sold · Not Installed', subtitle: 'Active/Hold pre-install pipeline (matches ProjectsView preInstall + future + WIP)',           color: 'text-blue-600',    bar: 'bg-blue-600' },
  installedNotM2:   { label: 'Installed · Not M2',   subtitle: 'Install completed but M2 not received OR M2 was clawed back (net ≤ 0) — the cash gap.',      color: 'text-violet-600',  bar: 'bg-violet-600' },
  m2NotM3:          { label: 'M2 · Not M3',          subtitle: 'M2 received and not clawed back, waiting on final M3 deposit (or M3 was clawed back).',      color: 'text-emerald-600', bar: 'bg-emerald-600' },
}

// Audit ordering — same key order so the cheat table at the bottom
// reads in the same visual flow as the KPI strip.
const AUDIT_ORDER: GapKey[] = ['soldNotInstalled', 'installedNotM2', 'm2NotM3']

// Tiny "(date)" label for an empty-string date — keeps the audit table
// from showing blank cells while still being clear it's missing data.
function fmtAuditDate(s: string): string { return s ? s.slice(0, 10) : '—' }
</script>

<template>
  <div class="grid grid-cols-1 gap-3 min-w-0 max-w-full">
    <!-- Header: title + freshness + as-of -->
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex flex-col gap-0.5 min-w-0">
        <h1 class="text-2xl font-semibold tracking-tight">Booked &amp; Boarded</h1>
        <DataFreshness resource="projects" label="Data" />
      </div>
      <div class="flex items-center gap-2">
        <Input
          v-model="asOf" type="date" class="h-8 w-[140px] text-xs"
          :max="localTodayIso()"
          title="As-of date"
        />
      </div>
    </div>

    <!-- Filter strip: timeframe pills · unit toggle · filter-icon drawer · clear.
         State + Rep + Lender all live in the drawer so the visible
         strip stays compact at 390px. -->
    <div class="flex flex-wrap items-center gap-2">
      <div class="flex gap-0.5 p-0.5 bg-muted rounded-lg">
        <button
          v-for="t in TIMEFRAMES" :key="t.key"
          class="px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors"
          :class="timeframe === t.key ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'"
          @click="setTimeframe(t.key)"
        >{{ t.label }}</button>
      </div>

      <div class="flex gap-0.5 p-0.5 bg-muted rounded-lg">
        <button
          v-for="u in (['#','kW','$'] as Unit[])" :key="u"
          class="px-3 py-1 text-[11px] font-semibold rounded-md transition-colors"
          :class="unit === u ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'"
          @click="setUnit(u)"
        >{{ u }}</button>
      </div>

      <button
        class="relative inline-flex items-center justify-center rounded-md border size-8 transition-colors"
        :class="showDrawer ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'"
        title="More filters"
        @click="showDrawer = !showDrawer"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
      </button>

      <button v-if="hasFilters" class="text-xs text-muted-foreground hover:text-foreground" @click="clearFilters">Clear</button>
    </div>

    <!-- Filter drawer — state + rep + lender + custom date range. -->
    <div v-if="showDrawer" class="rounded-xl border bg-card p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <div class="space-y-1.5">
        <Label class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">State</Label>
        <Select :model-value="fState || '__all__'" @update:model-value="setState">
          <SelectTrigger class="h-8 text-xs"><SelectValue placeholder="All states" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All states</SelectItem>
            <SelectItem v-for="s in data?.filterOptions.states || []" :key="s" :value="s">{{ s }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div class="space-y-1.5">
        <Label class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Sales Rep</Label>
        <Select :model-value="fCloser || '__all__'" @update:model-value="setCloser">
          <SelectTrigger class="h-8 text-xs"><SelectValue placeholder="All reps" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All reps</SelectItem>
            <SelectItem v-for="c in data?.filterOptions.closers || []" :key="c" :value="c">{{ c }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div class="space-y-1.5">
        <Label class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Lender</Label>
        <Select :model-value="fLender || '__all__'" @update:model-value="setLender">
          <SelectTrigger class="h-8 text-xs"><SelectValue placeholder="All lenders" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All lenders</SelectItem>
            <SelectItem v-for="l in data?.filterOptions.lenders || []" :key="l" :value="l">{{ l }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div class="space-y-1.5">
        <Label class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Custom Range</Label>
        <div class="flex items-center gap-1.5">
          <Input v-model="customFrom" type="date" class="h-8 w-full text-xs" @change="setTimeframe('custom')" />
          <span class="text-[11px] text-muted-foreground">—</span>
          <Input v-model="customTo" type="date" class="h-8 w-full text-xs" @change="setTimeframe('custom')" />
        </div>
      </div>
    </div>

    <!-- Loading / error -->
    <div v-if="loading && !data" class="space-y-3">
      <div class="h-32 rounded-xl bg-card animate-pulse" />
      <div class="h-24 rounded-xl bg-card animate-pulse" />
      <div class="h-48 rounded-xl bg-card animate-pulse" />
    </div>
    <div v-else-if="err" class="rounded-xl bg-card p-6 text-center">
      <p class="text-sm text-red-600 font-semibold">Failed to load report</p>
      <p class="text-xs text-muted-foreground mt-1">{{ err }}</p>
    </div>

    <template v-else-if="data">
      <!-- ═══ Daily Flash ═══
           Selected timeframe column gets highlighted (ring + bold) so
           clicking a quick-pill above visibly shifts which number is the
           "headline" — addresses the "filters didn't change much" feel. -->
      <section class="space-y-2">
        <div class="flex items-baseline justify-between gap-2 flex-wrap">
          <h2 class="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Daily Flash</h2>
          <p class="text-[10px] text-muted-foreground">
            sales days <span class="font-semibold">{{ data.flash.sellingDaysElapsed }}/{{ data.flash.sellingDaysTotal }}</span> ·
            operating days <span class="font-semibold">{{ data.flash.operatingDaysElapsed }}/{{ data.flash.operatingDaysTotal }}</span>
          </p>
        </div>
        <div class="rounded-xl bg-card overflow-hidden">
          <table class="w-full text-[11px]" style="table-layout:fixed">
            <thead>
              <tr class="text-muted-foreground bg-muted/30">
                <th class="text-left font-semibold p-2" style="width:22%">Stage</th>
                <th class="text-right font-semibold p-1.5" :class="timeframe === 'yesterday' ? 'text-foreground' : ''">Yday</th>
                <th class="text-right font-semibold p-1.5" :class="timeframe === '7d' ? 'text-foreground' : ''">7d</th>
                <th class="text-right font-semibold p-1.5" :class="timeframe === 'mtd' ? 'text-foreground' : ''">MTD</th>
                <th class="text-right font-semibold p-1.5">Δ vs Last MTD</th>
                <th class="text-right font-semibold p-1.5">MTD Pace</th>
                <th class="text-right font-semibold p-1.5 hidden sm:table-cell" :class="timeframe === '30d' ? 'text-foreground' : ''">30d</th>
                <th class="text-right font-semibold p-1.5 hidden sm:table-cell">30d Pace</th>
                <th class="text-right font-semibold p-1.5 hidden md:table-cell" :class="timeframe === '60d' ? 'text-foreground' : ''">60d</th>
                <th class="text-right font-semibold p-1.5 hidden md:table-cell">60d Pace</th>
                <th class="text-right font-semibold p-1.5 hidden md:table-cell" :class="timeframe === 'ytd' ? 'text-foreground' : ''">YTD</th>
                <th class="text-right font-semibold p-1.5 hidden md:table-cell">Last YTD</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in data.flash.stages" :key="s.key"
                  class="border-t border-border/30"
                  :class="s.isTotal ? 'border-t-2 border-foreground/40 bg-muted/30 font-semibold' : ''">
                <td class="p-2 font-medium truncate">
                  {{ s.label }}
                  <span v-if="!s.isTotal" class="text-[8px] uppercase tracking-widest opacity-50 ml-0.5">{{ s.dayBasis === 'sales' ? 'M-Sa' : 'M-F' }}</span>
                </td>
                <td class="p-1.5 text-right font-mono tabular-nums" :class="[s.yesterday.count ? '' : 'text-muted-foreground/60', timeframe === 'yesterday' ? 'bg-foreground/5 font-bold' : '']">{{ metricValue(s.yesterday) }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums" :class="[s.last7d.count ? '' : 'text-muted-foreground/60', timeframe === '7d' ? 'bg-foreground/5 font-bold' : '']">{{ metricValue(s.last7d) }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums" :class="[timeframe === 'mtd' ? 'bg-foreground/5 font-bold' : 'font-semibold']">{{ metricValue(s.mtd) }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums" :class="flashDelta(s).tone">
                  {{ flashDelta(s).symbol }}{{ fmtDeltaValue(flashDelta(s).value) }}
                </td>
                <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ metricValue(s.mtdPace) }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums hidden sm:table-cell" :class="timeframe === '30d' ? 'bg-foreground/5 font-bold' : ''">{{ metricValue(s.pace30) }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground hidden sm:table-cell">{{ metricValue(s.pace30Monthly) }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums hidden md:table-cell" :class="timeframe === '60d' ? 'bg-foreground/5 font-bold' : ''">{{ metricValue(s.pace60) }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground hidden md:table-cell">{{ metricValue(s.pace60Monthly) }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums hidden md:table-cell" :class="timeframe === 'ytd' ? 'bg-foreground/5 font-bold' : ''">{{ metricValue(s.ytd) }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground hidden md:table-cell">{{ metricValue(s.lastYtd) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- ═══ Gap KPI strip ═══ -->
      <section class="space-y-2">
        <h2 class="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Gap KPIs · click to drill</h2>
        <div class="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1">
          <button
            v-for="(meta, key) in GAP_META" :key="key"
            class="flex-none rounded-xl px-3 py-2 w-[200px] text-left transition-all active:scale-[0.97]"
            :class="drillGap === key ? 'bg-card shadow-md ring-2 ring-foreground/10' : 'bg-card/60 hover:bg-card'"
            :title="meta.subtitle"
            @click="selectGap(key as GapKey)"
          >
            <!-- Bar color matches text color (same -600 shade) so the
                 colored top line reads as the same accent as the headline.
                 Headline format mirrors ProjectsView KPI chips:
                 "{count} / {kW}" with both values in the chip color. -->
            <div class="h-[3px] rounded-full -mt-0.5 mb-1" :class="meta.bar" />
            <p class="text-[9px] font-semibold uppercase tracking-wider truncate" :class="meta.color">{{ meta.label }}</p>
            <p class="mt-0.5 leading-none">
              <span class="text-xl font-extrabold tabular-nums" :class="meta.color">{{ fmtNum(data.gaps[key as GapKey].count) }}</span>
              <span class="text-[10px] font-bold tabular-nums" :class="meta.color"> / {{ fmtKw(data.gaps[key as GapKey].kw) }}</span>
            </p>
            <!-- Mini metrics — context the user wants visible without
                 drilling. Sold-Not-Inst gets days-supply + mean age.
                 Inst-Not-M2 / M2-Not-M3 get mean + P90 days since their
                 anchor stage (live "stuck" indicator). Cancelled gets
                 oldest-only since lost rev is windowed. -->
            <div class="flex flex-wrap items-center gap-x-2 gap-y-0 text-[9px] text-muted-foreground tabular-nums mt-1.5">
              <template v-if="key === 'soldNotInstalled'">
                <span v-if="data.gaps.soldNotInstalled.daysSupply > 0" class="font-semibold" :class="data.gaps.soldNotInstalled.daysSupply > 60 ? 'text-amber-600' : 'text-foreground'">
                  {{ data.gaps.soldNotInstalled.daysSupply }}d supply
                </span>
                <span v-if="data.gaps.soldNotInstalled.avgAgeDays > 0">avg {{ data.gaps.soldNotInstalled.avgAgeDays }}d</span>
                <span v-if="data.gaps.soldNotInstalled.oldestDays > 0">max {{ data.gaps.soldNotInstalled.oldestDays }}d</span>
              </template>
              <template v-else-if="key === 'installedNotM2' || key === 'm2NotM3'">
                <span v-if="data.gaps[key as GapKey].avgAgeDays > 0">avg {{ data.gaps[key as GapKey].avgAgeDays }}d</span>
                <span v-if="data.gaps[key as GapKey].p90AgeDays > 0">P90 {{ data.gaps[key as GapKey].p90AgeDays }}d</span>
                <span v-if="data.gaps[key as GapKey].oldestDays > 0">max {{ data.gaps[key as GapKey].oldestDays }}d</span>
              </template>
            </div>
          </button>
        </div>
        <!-- Selected gap subtitle line — visible to make the metric meaning explicit (mobile users don't see hover tooltips). -->
        <p v-if="drillGap" class="text-[10px] text-muted-foreground italic px-1">{{ GAP_META[drillGap].subtitle }}</p>
      </section>

      <!-- ═══ Inline drill panel — sits right under the KPI strip so the
           "click chip → see breakdown" interaction is immediately
           visible without scrolling. ═══ -->
      <section v-if="drillGap" id="bb-drill" class="space-y-2">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-baseline gap-2 min-w-0">
            <h2 class="text-xs font-semibold uppercase tracking-widest text-muted-foreground truncate">Drill · {{ GAP_META[drillGap].label }}</h2>
            <span class="text-[10px] text-muted-foreground tabular-nums shrink-0">{{ drillRows.length }} rows</span>
          </div>
          <button class="text-xs text-muted-foreground hover:text-foreground" @click="closeDrill">Close</button>
        </div>
        <div class="flex gap-1 overflow-x-auto no-scrollbar pb-1">
          <button
            v-for="d in DIMENSIONS" :key="d.key"
            class="px-3 py-1 rounded-full text-[11px] font-semibold border whitespace-nowrap transition-colors"
            :class="drillDim === d.key
              ? 'bg-foreground text-background border-foreground'
              : 'bg-card border-border text-muted-foreground hover:text-foreground'"
            @click="setDimension(d.key)"
          >{{ d.label }}</button>
        </div>
        <div v-if="drillLoading" class="rounded-xl bg-card p-8 text-center text-xs text-muted-foreground">Loading…</div>
        <div v-else-if="drillRows.length === 0" class="rounded-xl bg-card p-8 text-center text-xs text-muted-foreground">No rows for this dimension.</div>
        <div v-else class="rounded-xl bg-card overflow-hidden">
          <table class="w-full text-[11px]" style="table-layout:fixed">
            <thead>
              <tr class="text-muted-foreground bg-muted/30">
                <th class="text-left font-semibold p-2" style="width:36%">{{ DIMENSIONS.find(d => d.key === drillDim)?.label }}</th>
                <th class="text-right font-semibold p-1.5">Count</th>
                <th class="text-right font-semibold p-1.5">kW</th>
                <th class="text-right font-semibold p-1.5">$ Rev</th>
                <th v-if="drillGap === 'soldNotInstalled'" class="text-right font-semibold p-1.5">Days Supply</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in drillRows" :key="r.name" class="border-t border-border/30">
                <td class="p-2 font-medium truncate">{{ r.name }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums font-semibold">{{ fmtNum(r.count) }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ fmtKw(r.kw) }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums">{{ fmtMoney(r.rev) }}</td>
                <td v-if="drillGap === 'soldNotInstalled'" class="p-1.5 text-right font-mono tabular-nums" :class="r.daysSupply > 60 ? 'text-amber-600 font-semibold' : 'text-muted-foreground'">{{ r.daysSupply }}d</td>
              </tr>
              <tr class="border-t-2 border-border font-bold">
                <td class="p-2 text-muted-foreground text-[9px] uppercase">Total</td>
                <td class="p-1.5 text-right font-mono tabular-nums">{{ fmtNum(drillRows.reduce((s,r) => s+r.count, 0)) }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums">{{ fmtKw(drillRows.reduce((s,r) => s+r.kw, 0)) }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums">{{ fmtMoney(drillRows.reduce((s,r) => s+r.rev, 0)) }}</td>
                <td v-if="drillGap === 'soldNotInstalled'" class="p-1.5"></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- ═══ Cycle Time deep-dive ═══
           One sub-card per transition. Mobile shows a compact 90d
           median + delta vs prior year. Desktop expands to the full
           30/60/90d × min/p25/median/p75/max grid plus prior-year
           median deltas. -->
      <section class="space-y-2">
        <h2 class="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Cycle Time · 30 / 60 / 90d Rolling</h2>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-2">
          <div
            v-for="t in data.cycleTime.transitions" :key="t.stage"
            class="rounded-xl bg-card overflow-hidden"
            :class="t.stage.startsWith('Booked → M3') ? 'ring-1 ring-foreground/10' : ''"
          >
            <div class="px-3 pt-2 pb-1 flex items-baseline justify-between">
              <p class="text-[11px] font-semibold" :class="t.stage.startsWith('Booked → M3') ? 'text-foreground' : 'text-muted-foreground'">{{ t.stage }}</p>
              <p class="text-[9px] text-muted-foreground">days, n = sample size</p>
            </div>
            <table class="w-full text-[11px]" style="table-layout:fixed">
              <thead>
                <tr class="text-muted-foreground bg-muted/30">
                  <th class="text-left font-semibold p-1.5" style="width:14%">Win</th>
                  <th class="text-right font-semibold p-1.5">n</th>
                  <th class="text-right font-semibold p-1.5">Min</th>
                  <th class="text-right font-semibold p-1.5">P25</th>
                  <th class="text-right font-semibold p-1.5">Median</th>
                  <th class="text-right font-semibold p-1.5">P75</th>
                  <th class="text-right font-semibold p-1.5">Max</th>
                  <th class="text-right font-semibold p-1.5">Δ vs PY</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="w in t.windows" :key="w.window" class="border-t border-border/30">
                  <td class="p-1.5 font-medium">{{ w.window }}</td>
                  <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ w.current.n }}</td>
                  <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ w.current.min }}</td>
                  <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ w.current.p25 }}</td>
                  <td class="p-1.5 text-right font-mono tabular-nums font-bold">{{ w.current.median }}</td>
                  <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ w.current.p75 }}</td>
                  <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ w.current.max }}</td>
                  <td class="p-1.5 text-right font-mono tabular-nums" :class="cycleDeltaTone(w)">{{ cycleDeltaText(w) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <!-- ═══ MACD-style sales momentum chart (md+) — at bottom because
           it's a deeper analytical view, not a daily-glance number. ═══ -->
      <section class="space-y-2 hidden md:block">
        <h2 class="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Sales Momentum · 180d</h2>
        <div class="rounded-xl bg-card p-3">
          <VChart :option="macdOption" style="height:340px" autoresize />
          <p class="text-[9px] text-muted-foreground mt-1">
            Upper: daily Booked count + 30/60d moving averages. Lower: MACD spread (30d−60d) with 9d EMA signal and momentum histogram (green = positive momentum, red = negative).
          </p>
        </div>
      </section>

      <!-- ═══ Audit cheat table — every record in each KPI bucket so
           you can reconcile the widget count against actual rows.
           Each gap collapses to a header by default; click to expand
           the full row list. Sticky header inside scrollable container
           keeps the column labels visible while scanning long lists. ═══ -->
      <section class="space-y-2 pb-8">
        <div class="flex items-baseline gap-2 flex-wrap">
          <h2 class="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Audit · All Records per KPI</h2>
          <p class="text-[10px] text-muted-foreground italic">Click a section to expand · ✓ widget = rows means the count is reconciled</p>
        </div>
        <div
          v-for="key in AUDIT_ORDER" :key="`audit-${key}`"
          class="rounded-xl bg-card overflow-hidden"
        >
          <button
            class="w-full px-3 py-2 flex items-baseline justify-between gap-2 hover:bg-muted/30 transition-colors"
            @click="auditOpen[key] = !auditOpen[key]"
          >
            <div class="flex items-baseline gap-2 min-w-0">
              <span class="text-[10px] text-muted-foreground">{{ auditOpen[key] ? '▾' : '▸' }}</span>
              <span class="text-[11px] font-semibold" :class="GAP_META[key].color">{{ GAP_META[key].label }}</span>
            </div>
            <p class="text-[10px] tabular-nums shrink-0" :class="data.gaps[key].count === data.audit[key].length ? 'text-emerald-600' : 'text-amber-600 font-semibold'">
              {{ data.gaps[key].count === data.audit[key].length ? '✓ ' : '⚠ ' }}widget {{ data.gaps[key].count }} · rows {{ data.audit[key].length }}
            </p>
          </button>
          <div v-if="auditOpen[key]">
            <div v-if="data.audit[key].length === 0" class="px-3 pb-3 text-[11px] text-muted-foreground italic">No records in this bucket.</div>
            <div v-else class="overflow-auto max-h-[480px]">
              <table class="w-full text-[10px] min-w-[760px]" style="table-layout:auto">
                <thead class="sticky top-0">
                  <tr class="text-muted-foreground bg-muted">
                    <th class="text-left font-semibold p-1.5">RID</th>
                    <th class="text-left font-semibold p-1.5">Customer</th>
                    <th class="text-left font-semibold p-1.5">State</th>
                    <th class="text-left font-semibold p-1.5">Status</th>
                    <th class="text-left font-semibold p-1.5">Closer</th>
                    <th class="text-left font-semibold p-1.5">Lender</th>
                    <th class="text-left font-semibold p-1.5">Sale</th>
                    <th class="text-left font-semibold p-1.5">Inst</th>
                    <th class="text-left font-semibold p-1.5">M2</th>
                    <th class="text-left font-semibold p-1.5">M3</th>
                    <th v-if="key === 'cancelledLost' || key === 'pendingAtRisk'" class="text-left font-semibold p-1.5">Cancel</th>
                    <th class="text-right font-semibold p-1.5">$</th>
                    <th class="text-right font-semibold p-1.5">kW</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in data.audit[key]" :key="`${key}-${r.recordId}`" class="border-t border-border/30 hover:bg-muted/30 cursor-pointer" @click="openProject(r.recordId)">
                    <td class="p-1.5 font-mono text-muted-foreground">{{ r.recordId }}</td>
                    <td class="p-1.5 font-medium truncate max-w-[160px]">{{ r.customerName || '—' }}</td>
                    <td class="p-1.5 truncate max-w-[80px]">{{ r.state || '—' }}</td>
                    <td class="p-1.5 truncate max-w-[100px]">{{ r.status || '—' }}</td>
                    <td class="p-1.5 truncate max-w-[100px]">{{ r.closer || '—' }}</td>
                    <td class="p-1.5 truncate max-w-[80px]">{{ r.lender || '—' }}</td>
                    <td class="p-1.5 font-mono text-muted-foreground">{{ fmtAuditDate(r.salesDate) }}</td>
                    <td class="p-1.5 font-mono text-muted-foreground">{{ fmtAuditDate(r.installCompleted) }}</td>
                    <td class="p-1.5 font-mono text-muted-foreground">{{ fmtAuditDate(r.m2Date) }}</td>
                    <td class="p-1.5 font-mono text-muted-foreground">{{ fmtAuditDate(r.m3Date) }}</td>
                    <td v-if="key === 'cancelledLost' || key === 'pendingAtRisk'" class="p-1.5 font-mono text-muted-foreground">{{ fmtAuditDate(r.cancelDate) }}</td>
                    <td class="p-1.5 text-right font-mono tabular-nums">{{ fmtMoney(r.systemPrice) }}</td>
                    <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ Math.round(r.systemSizeKw * 10) / 10 }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
.no-scrollbar::-webkit-scrollbar { display: none; }
</style>
