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
import { localTodayIso } from '@/lib/dates'
import { openProjectWithEvent } from '@/lib/openProject'

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
interface AgingBucket { key: string; label: string; min: number; max: number | null; count: number; kw: number; rev: number }
interface StuckDeal {
  gap: GapKey; recordId: number; customerName: string
  state: string; closer: string; coordinator: string; lender: string
  anchorDate: string; days: number; slaDays: number
  severity: 'warn' | 'red'; blocker: string
  systemPrice: number; systemSizeKw: number
}
interface AgingGap { buckets: AgingBucket[]; warnCount: number; redCount: number; stuck: StuckDeal[] }
interface CycleStats { n: number; min: number; p25: number; median: number; p75: number; max: number }
interface CycleWindow { window: '30d' | '60d' | '90d'; current: CycleStats; prior: CycleStats }
interface CycleTransition { stage: string; windows: CycleWindow[] }
interface MacdPoint { date: string; count: number; ma30: number; ma60: number; macd: number; signal: number; histogram: number }
interface DrillRow { name: string; count: number; kw: number; rev: number; daysSupply: number; p25: number; p50: number; p75: number; p90: number; max: number }
interface AuditRow {
  recordId: number; customerName: string
  state: string; status: string; closer: string; lender: string
  salesDate: string; installCompleted: string; m2Date: string; m3Date: string
  dcaDate: string; dcaStatus: string
  m1RequestedDate: string; m2RequestedDate: string
  m2RejectedDate: string; m2ApprovedDate: string; m2NetReceived: number
  systemPrice: number; systemSizeKw: number; cancelDate: string
}
interface SLA {
  bookedToInstalled: { warn: number; red: number }
  installedToM2: { warn: number; red: number }
  m2ToM3: { warn: number; red: number }
  m3ToDca: { warn: number; red: number }
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
    m3NotDca: GapMetric
  }
  aging: Record<GapKey, AgingGap>
  cycleTime: { transitions: CycleTransition[] }
  macd: { subject: string; points: MacdPoint[]; high52w: { date: string; count: number } | null }
  audit: Record<GapKey, AuditRow[]>
  filterOptions: { states: string[]; closers: string[]; lenders: string[] }
  appliedFilters: { state?: string; closer?: string; lender?: string }
}
type Unit = '#' | 'kW' | '$'
type Timeframe = 'yesterday' | '7d' | 'mtd' | '30d' | '60d' | 'ytd' | 'custom'
type GapKey = 'soldNotInstalled' | 'installedNotM2' | 'm2NotM3' | 'm3NotDca'
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
const drillTotal = ref<DrillRow | null>(null)
const drillLoading = ref(false)

// Filter drawer toggle.
const showDrawer = ref(false)

// Audit cheat-table accordions — collapsed by default to keep the page
// reasonable. Each gap expands independently.
const auditOpen = ref<Record<GapKey, boolean>>({
  soldNotInstalled: false,
  installedNotM2: false,
  m2NotM3: false,
  m3NotDca: false,
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
  if (!drillGap.value) { drillRows.value = []; drillTotal.value = null; return }
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
    if (res.ok) {
      const payload = await res.json() as { rows: DrillRow[]; total?: DrillRow }
      drillRows.value = payload.rows
      drillTotal.value = payload.total || null
    }
  } catch { /* non-fatal */ } finally { drillLoading.value = false }
}

// ─── Setters ─────────────────────────────────────────────
function setState(s: unknown)     { const value = String(s ?? ''); fState.value = value === '__all__' ? '' : value; persist(); load() }
function setCloser(s: unknown)    { const value = String(s ?? ''); fCloser.value = value === '__all__' ? '' : value; persist(); load() }
function setLender(s: unknown)    { const value = String(s ?? ''); fLender.value = value === '__all__' ? '' : value; persist(); load() }
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
    await load()
    setTimeout(() => document.getElementById('bb-selected-kpi')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100)
  }
}
async function setDimension(d: Dimension) { drillDim.value = d; persist(); await loadDrill() }
function closeDrill() { drillGap.value = null; drillRows.value = []; drillTotal.value = null; persist() }

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

// Trend of one window's median vs the next-larger window's median.
// 30d row → compares to 60d, 60d row → compares to 90d, 90d row → no
// peer to compare against. Faster (smaller current median) = green.
// Only the median is compared per the spec — p25/p75 aren't enough
// signal on their own to flip the tone.
function cycleTrend(t: CycleTransition, idx: number): { tone: string; arrow: string; text: string } {
  const w = t.windows[idx]
  const next = t.windows[idx + 1]
  if (!w || !next) return { tone: 'text-muted-foreground/40', arrow: '·', text: '—' }
  if (!w.current.n || !next.current.n) return { tone: 'text-muted-foreground/40', arrow: '·', text: '—' }
  const delta = w.current.median - next.current.median
  if (delta === 0) return { tone: 'text-muted-foreground', arrow: '·', text: 'flat' }
  if (delta < 0) return { tone: 'text-emerald-600 font-semibold', arrow: '↓', text: `${Math.abs(delta)}d` }
  return { tone: 'text-amber-600 font-semibold', arrow: '↑', text: `${delta}d` }
}

// ─── Cycle-time drill ───────────────────────────────────
// Click a transition card → drill panel below the cycle section opens
// with a per-dimension breakdown of medians for the selected stage.
// Same dimension picker as the gap drill so the user gets identical
// muscle memory.
interface CycleDrillRow { name: string; n: number; min: number; p25: number; median: number; p75: number; max: number }
const TRANSITION_COLS: Record<string, { from: string; to: string }> = {
  'Booked → Installed':  { from: 'sales_date',        to: 'install_completed' },
  'Installed → PTO':     { from: 'install_completed', to: 'pto_approved' },
  'Install → M2 Funded': { from: 'install_completed', to: 'm2_deposit_date' },
  'M2 → M3 Funded':      { from: 'm2_deposit_date',   to: 'm3_deposit_date' },
  'Booked → M3 (full)':  { from: 'sales_date',        to: 'm3_deposit_date' },
  'Booked → DCA':        { from: 'sales_date',        to: 'dca_actual_deposit' },
}
const cycleDrillStage = ref<string | null>(null)
const cycleDrillDim = ref<Dimension>('state')
const cycleDrillWindow = ref<'30d' | '60d' | '90d'>('90d')
const cycleDrillRows = ref<CycleDrillRow[]>([])
const cycleDrillLoading = ref(false)

async function loadCycleDrill() {
  if (!cycleDrillStage.value) { cycleDrillRows.value = []; return }
  const cols = TRANSITION_COLS[cycleDrillStage.value]
  if (!cols) return
  cycleDrillLoading.value = true
  const params = new URLSearchParams({
    from: cols.from, to: cols.to,
    dimension: cycleDrillDim.value,
    window: cycleDrillWindow.value,
  })
  if (fState.value)  params.set('state', fState.value)
  if (fCloser.value) params.set('closer', fCloser.value)
  if (fLender.value) params.set('lender', fLender.value)
  if (asOf.value && asOf.value !== localTodayIso()) params.set('asOf', asOf.value)
  try {
    const res = await fetch(`/api/reports/booked-and-boarded/cycle-drill?${params}`, { headers: hdrs() })
    if (res.ok) cycleDrillRows.value = (await res.json()).rows as CycleDrillRow[]
  } catch { /* non-fatal */ } finally { cycleDrillLoading.value = false }
}
async function selectTransition(stage: string) {
  cycleDrillStage.value = cycleDrillStage.value === stage ? null : stage
  if (cycleDrillStage.value) {
    await loadCycleDrill()
    setTimeout(() => document.getElementById('bb-cycle-drill')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100)
  }
}
async function setCycleDrillDim(d: Dimension) { cycleDrillDim.value = d; await loadCycleDrill() }
async function setCycleDrillWindow(w: '30d' | '60d' | '90d') { cycleDrillWindow.value = w; await loadCycleDrill() }
function closeCycleDrill() { cycleDrillStage.value = null }

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
  const high52w = data.value.macd.high52w
  const dates = points.map(p => p.date)
  // Highlight the daily bar that matches the 52w high date (when it falls
  // inside the visible window) by passing structured data instead of plain
  // numbers — ECharts honors per-point itemStyle on bar series.
  const highlightDate = high52w?.date
  const counts = points.map(p => p.date === highlightDate
    ? { value: p.count, itemStyle: { color: 'rgba(16,185,129,0.95)' } }
    : p.count
  )
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
    // Legend swatches are forced to flat rects (no series point/circle).
    // Each line series sets a top-level `color` so the swatch matches the
    // actual line color — relying on `lineStyle.color` alone leaves the
    // legend on ECharts' default palette and they diverge.
    legend: { top: 4, right: 16, textStyle: { fontSize: 10 }, icon: 'rect', itemWidth: 14, itemHeight: 8, data: ['Daily', '30d MA', '60d MA', 'MACD', 'Signal'] },
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
      { name: 'Daily', type: 'bar', data: counts, color: 'rgba(100,116,139,0.45)', itemStyle: { color: 'rgba(100,116,139,0.45)' } },
      { name: '30d MA', type: 'line', data: ma30, smooth: true, symbol: 'none', color: '#3b82f6', lineStyle: { color: '#3b82f6', width: 2.5 } },
      { name: '60d MA', type: 'line', data: ma60, smooth: true, symbol: 'none', color: '#f59e0b', lineStyle: { color: '#f59e0b', width: 2.5 } },
      // Bottom panel — MACD spread (purple, distinct from 30d MA blue),
      // signal line (red), histogram (conditional green/red).
      { name: 'MACD', type: 'line', data: macd, smooth: true, symbol: 'none',
        xAxisIndex: 1, yAxisIndex: 1, color: '#8b5cf6', lineStyle: { color: '#8b5cf6', width: 2 } },
      { name: 'Signal', type: 'line', data: signal, smooth: true, symbol: 'none',
        xAxisIndex: 1, yAxisIndex: 1, color: '#ef4444', lineStyle: { color: '#ef4444', width: 2 } },
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

function openProject(rid: number, e?: MouseEvent) {
  openProjectWithEvent(router, rid, e)
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
  soldNotInstalled: { label: 'Booked · Not Installed', subtitle: 'Active/Hold pre-install pipeline (matches ProjectsView preInstall + future + WIP)',         color: 'text-blue-600',    bar: 'bg-blue-600' },
  installedNotM2:   { label: 'Installed · Not M2',   subtitle: 'Install completed but M2 not received OR M2 was clawed back (net ≤ 0) — the cash gap.',      color: 'text-violet-600',  bar: 'bg-violet-600' },
  m2NotM3:          { label: 'M2 · Not M3',          subtitle: 'M2 received and not clawed back, waiting on final M3 deposit (or M3 was clawed back).',      color: 'text-emerald-600', bar: 'bg-emerald-600' },
  m3NotDca:         { label: 'M3 · Not DCA',         subtitle: 'DCA-eligible projects with M3 funded but no DCA deposit or positive DCA cash received.',     color: 'text-amber-600',   bar: 'bg-amber-600' },
}

// Audit ordering — same key order so the cheat table at the bottom
// reads in the same visual flow as the KPI strip.
const AUDIT_ORDER: GapKey[] = ['soldNotInstalled', 'installedNotM2', 'm2NotM3', 'm3NotDca']

const selectedAging = computed(() => {
  if (!data.value || !drillGap.value) return null
  return data.value.aging[drillGap.value]
})
const selectedStuckRows = computed(() => {
  if (!data.value || !drillGap.value) return []
  return [...data.value.aging[drillGap.value].stuck]
    .sort((a, b) => {
      const sev = (b.severity === 'red' ? 1 : 0) - (a.severity === 'red' ? 1 : 0)
      return sev || b.days - a.days || b.systemPrice - a.systemPrice
    })
    .slice(0, 100)
})
const slaTotals = computed(() => {
  if (!selectedAging.value) return { red: 0, warn: 0 }
  return { red: selectedAging.value.redCount, warn: selectedAging.value.warnCount }
})

function agingPct(bucket: AgingBucket, key: GapKey): number {
  const total = data.value?.gaps[key].count || 0
  if (!total) return 0
  return Math.max(4, Math.min(100, Math.round((bucket.count / total) * 100)))
}
function agingBucketTone(bucket: AgingBucket, key: GapKey): string {
  const sla = data.value?.sla
  if (!sla) return 'bg-muted'
  const red =
    key === 'soldNotInstalled' ? sla.bookedToInstalled.red :
    key === 'installedNotM2' ? sla.installedToM2.red :
    key === 'm2NotM3' ? sla.m2ToM3.red :
    sla.m3ToDca.red
  const warn =
    key === 'soldNotInstalled' ? sla.bookedToInstalled.warn :
    key === 'installedNotM2' ? sla.installedToM2.warn :
    key === 'm2NotM3' ? sla.m2ToM3.warn :
    sla.m3ToDca.warn
  if (bucket.min >= red) return 'bg-red-500'
  if (bucket.min >= warn) return 'bg-amber-500'
  return 'bg-emerald-500'
}
function stuckTone(severity: StuckDeal['severity']): string {
  return severity === 'red'
    ? 'bg-red-50 text-red-700 ring-red-200'
    : 'bg-amber-50 text-amber-700 ring-amber-200'
}

const emptyDrillTotal: DrillRow = { name: 'Total', count: 0, kw: 0, rev: 0, daysSupply: 0, p25: 0, p50: 0, p75: 0, p90: 0, max: 0 }
const drillDisplayTotal = computed(() => drillTotal.value || emptyDrillTotal)
const drillDisplayMetric = computed<Metric>(() => {
  if (!data.value || !drillGap.value) return { count: 0, kw: 0, rev: 0 }
  return data.value.gaps[drillGap.value]
})

function auditSummary(key: GapKey): Metric {
  const rows = data.value?.audit[key] || []
  return {
    count: rows.length,
    kw: Math.round(rows.reduce((sum, r) => sum + r.systemSizeKw, 0) * 10) / 10,
    rev: Math.round(rows.reduce((sum, r) => sum + r.systemPrice, 0)),
  }
}

// Tiny "(date)" label for an empty-string date — keeps the audit table
// from showing blank cells while still being clear it's missing data.
function fmtAuditDate(s: string): string { return s ? s.slice(0, 10) : '—' }

// "2025-07-26" → "Jul 26, 2025"
function fmtPrettyDate(s: string): string {
  if (!s) return '—'
  const d = new Date(s.slice(0, 10) + 'T00:00:00')
  if (!Number.isFinite(d.getTime())) return s
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// M2 cell: pick the most-advanced milestone date and a color that maps
// to the current funding state. Priority: received > rejected > approved
// > submitted. "Received" means a deposit date AND positive net (a
// clawback shows as the deposit date but stays red-leaning via rejected).
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

// Click-to-sort for the Installed · Not M2 audit only. Other dropdowns
// keep their server-side default (kept simple per the ask).
type AuditSortCol =
  | 'recordId' | 'customerName' | 'state' | 'status' | 'closer' | 'lender'
  | 'salesDate' | 'installCompleted' | 'm2' | 'm1d' | 'm2d' | 'systemPrice' | 'systemSizeKw'
type SortDir = 'asc' | 'desc'
// null = back to server default (install_completed asc — the unsorted view).
// Numeric / days columns first-click descending (largest first); date/text
// first-click ascending. Three clicks on the same header cycles back to null.
const installedNotM2Sort = ref<{ col: AuditSortCol; dir: SortDir } | null>(null)
const NUMERIC_DEFAULT_DESC: AuditSortCol[] = ['recordId', 'systemPrice', 'systemSizeKw', 'm1d', 'm2d']

function toggleInm2Sort(col: AuditSortCol) {
  const cur = installedNotM2Sort.value
  const firstDir: SortDir = NUMERIC_DEFAULT_DESC.includes(col) ? 'desc' : 'asc'
  if (!cur || cur.col !== col) {
    installedNotM2Sort.value = { col, dir: firstDir }
    return
  }
  if (cur.dir === firstDir) {
    installedNotM2Sort.value = { col, dir: firstDir === 'asc' ? 'desc' : 'asc' }
    return
  }
  installedNotM2Sort.value = null
}

function inm2SortArrow(col: AuditSortCol): string {
  const cur = installedNotM2Sort.value
  if (!cur || cur.col !== col) return ''
  return cur.dir === 'asc' ? ' ↑' : ' ↓'
}

function inm2SortKey(r: AuditRow, col: AuditSortCol): string | number | null {
  switch (col) {
    case 'recordId':         return r.recordId
    case 'customerName':     return (r.customerName || '').toLowerCase()
    case 'state':            return (r.state || '').toLowerCase()
    case 'status':           return (r.status || '').toLowerCase()
    case 'closer':           return (r.closer || '').toLowerCase()
    case 'lender':           return (r.lender || '').toLowerCase()
    case 'salesDate':        return r.salesDate || ''
    case 'installCompleted': return r.installCompleted || ''
    case 'systemPrice':      return r.systemPrice
    case 'systemSizeKw':     return r.systemSizeKw
    case 'm1d':              return daysSinceNum(r.m1RequestedDate)
    case 'm2d':              return daysSinceNum(r.m2RequestedDate)
    case 'm2': {
      // Composite key: status priority (4=received, 3=rejected, 2=approved,
      // 1=submitted, 0=none) then the effective date, so rows cluster by
      // funding state and tie-break by date.
      const received = !!r.m2Date && r.m2NetReceived > 0
      if (received)           return `4_${r.m2Date}`
      if (r.m2RejectedDate)   return `3_${r.m2RejectedDate}`
      if (r.m2ApprovedDate)   return `2_${r.m2ApprovedDate}`
      if (r.m2RequestedDate)  return `1_${r.m2RequestedDate}`
      return `0_`
    }
  }
}

// Stale-M1 highlight: installed projects with no M2 yet submitted and an
// M1 request that's been sitting > 5 days. These are the rows the team
// should be unblocking first.
function isInm2Urgent(r: AuditRow): boolean {
  if (r.m2RequestedDate) return false
  const m1Age = daysSinceNum(r.m1RequestedDate)
  return m1Age !== null && m1Age > 5
}

function sortedAuditRows(key: GapKey): AuditRow[] {
  const rows = data.value?.audit[key] || []
  if (key !== 'installedNotM2' || !installedNotM2Sort.value) return rows
  const { col, dir } = installedNotM2Sort.value
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const av = inm2SortKey(a, col)
    const bv = inm2SortKey(b, col)
    // null / empty always sort last regardless of direction so blank
    // rows don't dominate the top of an asc sort.
    const aEmpty = av === null || av === '' || av === undefined
    const bEmpty = bv === null || bv === '' || bv === undefined
    if (aEmpty && bEmpty) return 0
    if (aEmpty) return 1
    if (bEmpty) return -1
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sign
    return String(av).localeCompare(String(bv)) * sign
  })
}
</script>

<template>
  <div class="grid grid-cols-1 gap-3 min-w-0 max-w-full">
    <!-- Header: title + freshness + as-of -->
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex flex-col gap-0.5 min-w-0">
        <h1 class="text-2xl font-semibold tracking-tight">Booked &amp; Boarded</h1>
        <DataFreshness resource="projects" label="Data" @refreshed="load" />
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

      <!-- ═══ KPI strip ═══ -->
      <section class="space-y-2">
        <h2 class="text-xs font-semibold uppercase tracking-widest text-muted-foreground">KPIs · click to drill</h2>
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
            <p class="mt-1 text-[9px] font-semibold tabular-nums text-muted-foreground">
              {{ fmtMoney(data.gaps[key as GapKey].rev) }} gross
            </p>
            <!-- Mini metrics — context the user wants visible without
                 drilling. Booked-Not-Installed gets days-supply + mean age.
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
              <template v-else>
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

      <!-- ═══ Selected KPI detail ═══ -->
      <section
        v-if="drillGap && selectedAging"
        id="bb-selected-kpi"
        class="space-y-3 rounded-2xl border border-foreground/15 bg-muted/20 p-3 shadow-sm"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Selected KPI</p>
            <h2 class="text-sm font-bold truncate" :class="GAP_META[drillGap].color">{{ GAP_META[drillGap].label }}</h2>
            <p class="text-[10px] text-muted-foreground">{{ GAP_META[drillGap].subtitle }}</p>
          </div>
          <button class="text-xs text-muted-foreground hover:text-foreground shrink-0" @click="closeDrill">Close</button>
        </div>

        <div class="border-t border-border/60 pt-3 space-y-2">
          <div class="flex items-baseline justify-between gap-2 flex-wrap">
            <h3 class="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Aging &amp; SLA</h3>
            <p class="text-[10px] text-muted-foreground tabular-nums">
              {{ slaTotals.red }} red · {{ slaTotals.warn }} warn · {{ fmtNum(data.gaps[drillGap].count) }} rows
            </p>
          </div>

          <div class="grid grid-cols-5 gap-1.5">
            <div v-for="b in selectedAging.buckets" :key="`${drillGap}-${b.key}`" class="min-w-0 rounded-lg border border-border/50 bg-background/70 p-2">
              <div class="h-1.5 rounded-full bg-muted overflow-hidden">
                <div class="h-full rounded-full" :class="agingBucketTone(b, drillGap)" :style="{ width: `${agingPct(b, drillGap)}%` }" />
              </div>
              <p class="mt-1 text-[9px] text-muted-foreground truncate">{{ b.label }}</p>
              <p class="text-[13px] font-bold tabular-nums leading-none">{{ fmtNum(b.count) }}</p>
              <p class="text-[8px] text-muted-foreground tabular-nums truncate">{{ fmtKw(b.kw) }}</p>
            </div>
          </div>
        </div>

        <div class="border-t border-border/60 pt-3 space-y-2">
          <div class="flex items-baseline justify-between gap-2 flex-wrap">
            <h3 class="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Needs Action</h3>
            <p class="text-[10px] text-muted-foreground tabular-nums">Top {{ selectedStuckRows.length }}</p>
          </div>
          <div v-if="selectedStuckRows.length" class="overflow-auto max-h-[520px] rounded-xl border border-border/60">
            <table class="w-full text-[10px] min-w-[700px]" style="table-layout:auto">
              <thead>
                <tr class="text-muted-foreground bg-muted/50">
                  <th class="text-left font-semibold p-1.5">Customer</th>
                  <th class="text-left font-semibold p-1.5">Owner</th>
                  <th class="text-left font-semibold p-1.5">State</th>
                  <th class="text-right font-semibold p-1.5">Days</th>
                  <th class="text-right font-semibold p-1.5">kW</th>
                  <th class="text-right font-semibold p-1.5">$</th>
                  <th class="text-left font-semibold p-1.5">Blocker</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in selectedStuckRows" :key="`${r.gap}-${r.recordId}`" class="border-t border-border/30 hover:bg-muted/30 cursor-pointer" @click="openProject(r.recordId, $event)" @auxclick.prevent="openProject(r.recordId, $event)">
                  <td class="p-1.5 font-medium max-w-[160px] truncate">{{ r.customerName || '—' }}</td>
                  <td class="p-1.5 max-w-[160px] truncate">
                    <span>{{ r.closer || r.coordinator || '—' }}</span>
                    <span v-if="r.closer && r.coordinator" class="text-muted-foreground"> · {{ r.coordinator }}</span>
                  </td>
                  <td class="p-1.5 truncate">{{ r.state || '—' }}</td>
                  <td class="p-1.5 text-right">
                    <span class="inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold ring-1 ring-inset tabular-nums" :class="stuckTone(r.severity)">
                      {{ r.days }}
                    </span>
                  </td>
                  <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ Math.round(r.systemSizeKw * 10) / 10 }}</td>
                  <td class="p-1.5 text-right font-mono tabular-nums">{{ fmtMoney(r.systemPrice) }}</td>
                  <td class="p-1.5 max-w-[240px] truncate text-muted-foreground" :title="r.blocker">{{ r.blocker }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-else class="rounded-xl border border-border/60 px-3 py-4 text-center text-[11px] text-muted-foreground">
            No records past the warning threshold for this KPI.
          </div>
        </div>
      </section>

      <!-- ═══ Inline drill panel — sits right under the KPI strip so the
           "click chip → see breakdown" interaction is immediately
           visible without scrolling. ═══ -->
      <section v-if="drillGap" id="bb-drill" class="space-y-2 rounded-2xl border border-foreground/15 bg-card p-3 shadow-sm">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-baseline gap-2 min-w-0">
            <h2 class="text-xs font-semibold uppercase tracking-widest text-muted-foreground truncate">Drill · {{ GAP_META[drillGap].label }}</h2>
            <span class="text-[10px] text-muted-foreground tabular-nums shrink-0">{{ fmtNum(drillDisplayMetric.count) }} records</span>
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
        <div v-else class="rounded-xl border border-border/60 overflow-auto">
          <table class="w-full text-[11px] min-w-[720px]" style="table-layout:fixed">
            <thead>
              <tr class="text-muted-foreground bg-muted/30">
                <th class="text-left font-semibold p-2" style="width:24%">{{ DIMENSIONS.find(d => d.key === drillDim)?.label }}</th>
                <th class="text-right font-semibold p-1.5">Count</th>
                <th class="text-right font-semibold p-1.5">kW</th>
                <th class="text-right font-semibold p-1.5">$ Rev</th>
                <th v-if="drillGap === 'soldNotInstalled'" class="text-right font-semibold p-1.5 hidden md:table-cell">Days Supply</th>
                <th class="text-right font-semibold p-1.5 hidden sm:table-cell">P25</th>
                <th class="text-right font-semibold p-1.5">P50</th>
                <th class="text-right font-semibold p-1.5 hidden sm:table-cell">P75</th>
                <th class="text-right font-semibold p-1.5 hidden sm:table-cell">P90</th>
                <th class="text-right font-semibold p-1.5 hidden sm:table-cell">Max</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in drillRows" :key="r.name" class="border-t border-border/30">
                <td class="p-2 font-medium truncate">{{ r.name }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums font-semibold">{{ fmtNum(r.count) }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ fmtKw(r.kw) }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums">{{ fmtMoney(r.rev) }}</td>
                <td v-if="drillGap === 'soldNotInstalled'" class="p-1.5 text-right font-mono tabular-nums hidden md:table-cell" :class="r.daysSupply > 60 ? 'text-amber-600 font-semibold' : 'text-muted-foreground'">{{ r.daysSupply }}d</td>
                <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground hidden sm:table-cell">{{ r.p25 }}d</td>
                <td class="p-1.5 text-right font-mono tabular-nums font-bold">{{ r.p50 }}d</td>
                <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground hidden sm:table-cell">{{ r.p75 }}d</td>
                <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground hidden sm:table-cell">{{ r.p90 }}d</td>
                <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground hidden sm:table-cell">{{ r.max }}d</td>
              </tr>
              <tr class="border-t-2 border-border font-bold">
                <td class="p-2 text-muted-foreground text-[9px] uppercase">Total</td>
                <td class="p-1.5 text-right font-mono tabular-nums">{{ fmtNum(drillDisplayMetric.count) }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums">{{ fmtKw(drillDisplayMetric.kw) }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums">{{ fmtMoney(drillDisplayMetric.rev) }}</td>
                <td v-if="drillGap === 'soldNotInstalled'" class="p-1.5 text-right font-mono tabular-nums hidden md:table-cell">{{ drillDisplayTotal.daysSupply }}d</td>
                <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground hidden sm:table-cell">{{ drillDisplayTotal.p25 }}d</td>
                <td class="p-1.5 text-right font-mono tabular-nums">{{ drillDisplayTotal.p50 }}d</td>
                <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground hidden sm:table-cell">{{ drillDisplayTotal.p75 }}d</td>
                <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground hidden sm:table-cell">{{ drillDisplayTotal.p90 }}d</td>
                <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground hidden sm:table-cell">{{ drillDisplayTotal.max }}d</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- ═══ Cycle Time deep-dive ═══
           One sub-card per transition. Each card is clickable — opens
           the cycle drill panel below the section with per-dimension
           medians for the selected transition. Trend column compares
           each row's median to the next-larger window's median (30d
           vs 60d, 60d vs 90d) so the user can see if cycles are
           speeding up or slowing down recently. -->
      <section class="space-y-2">
        <h2 class="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Cycle Time · 30 / 60 / 90d Rolling</h2>
        <p class="text-[10px] text-muted-foreground italic">Click a transition to drill into per-dimension medians below.</p>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-2">
          <button
            type="button"
            v-for="t in data.cycleTime.transitions" :key="t.stage"
            class="rounded-xl bg-card overflow-hidden text-left w-full transition-all active:scale-[0.998] hover:bg-muted/20"
            :class="[
              t.stage.startsWith('Booked → M3') ? 'ring-1 ring-foreground/10' : '',
              cycleDrillStage === t.stage ? 'ring-2 ring-foreground/30' : '',
            ]"
            @click="selectTransition(t.stage)"
          >
            <div class="px-3 pt-2 pb-1 flex items-baseline justify-between">
              <p class="text-[11px] font-semibold" :class="t.stage.startsWith('Booked → M3') ? 'text-foreground' : 'text-muted-foreground'">{{ t.stage }}</p>
              <p class="text-[9px] text-muted-foreground">days · n=samples · ↓=faster</p>
            </div>
            <table class="w-full text-[11px]" style="table-layout:fixed">
              <thead>
                <tr class="text-muted-foreground bg-muted/30">
                  <th class="text-left font-semibold p-1.5" style="width:32%">Window</th>
                  <th class="text-right font-semibold p-1.5">n</th>
                  <th class="text-right font-semibold p-1.5">Min</th>
                  <th class="text-right font-semibold p-1.5">P25</th>
                  <th class="text-right font-semibold p-1.5">Med</th>
                  <th class="text-right font-semibold p-1.5">P75</th>
                  <th class="text-right font-semibold p-1.5">Max</th>
                  <th class="text-right font-semibold p-1.5">vs PY</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(w, i) in t.windows" :key="w.window" class="border-t border-border/30">
                  <!-- Window cell holds the trend chip inline so it reads
                       "30d · ↓3d vs 60d" instead of stealing a column. -->
                  <td class="p-1.5">
                    <span class="font-medium">{{ w.window }}</span>
                    <template v-if="i < t.windows.length - 1">
                      <span class="text-muted-foreground/60"> · </span>
                      <span class="font-mono tabular-nums" :class="cycleTrend(t, i).tone">
                        {{ cycleTrend(t, i).arrow }}{{ cycleTrend(t, i).text }}
                      </span>
                      <span class="text-muted-foreground/60"> vs {{ t.windows[i + 1]?.window }}</span>
                    </template>
                  </td>
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
          </button>
        </div>
      </section>

      <!-- ═══ Cycle drill panel ═══ — appears below the cycle grid when
           a transition is clicked. Shows per-dimension breakdown of
           median + percentiles for the selected stage. -->
      <section v-if="cycleDrillStage" id="bb-cycle-drill" class="space-y-2">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-baseline gap-2 min-w-0">
            <h2 class="text-xs font-semibold uppercase tracking-widest text-muted-foreground truncate">Cycle Drill · {{ cycleDrillStage }}</h2>
            <span class="text-[10px] text-muted-foreground tabular-nums shrink-0">{{ cycleDrillRows.length }} rows</span>
          </div>
          <button class="text-xs text-muted-foreground hover:text-foreground" @click="closeCycleDrill">Close</button>
        </div>
        <div class="flex items-center gap-1 flex-wrap">
          <!-- Window picker — same 30/60/90d as the cycle cards. -->
          <div class="flex gap-0.5 p-0.5 bg-muted rounded-lg">
            <button
              v-for="w in (['30d','60d','90d'] as const)" :key="w"
              class="px-2.5 py-1 text-[10px] font-medium rounded transition-colors"
              :class="cycleDrillWindow === w ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'"
              @click="setCycleDrillWindow(w)"
            >{{ w }}</button>
          </div>
          <!-- Same dimension picker as the gap drill so muscle memory carries over. -->
          <button
            v-for="d in DIMENSIONS" :key="d.key"
            class="px-3 py-1 rounded-full text-[11px] font-semibold border whitespace-nowrap transition-colors"
            :class="cycleDrillDim === d.key
              ? 'bg-foreground text-background border-foreground'
              : 'bg-card border-border text-muted-foreground hover:text-foreground'"
            @click="setCycleDrillDim(d.key)"
          >{{ d.label }}</button>
        </div>
        <div v-if="cycleDrillLoading" class="rounded-xl bg-card p-8 text-center text-xs text-muted-foreground">Loading…</div>
        <div v-else-if="cycleDrillRows.length === 0" class="rounded-xl bg-card p-8 text-center text-xs text-muted-foreground">No samples for this dimension.</div>
        <div v-else class="rounded-xl bg-card overflow-hidden">
          <table class="w-full text-[11px]" style="table-layout:fixed">
            <thead>
              <tr class="text-muted-foreground bg-muted/30">
                <th class="text-left font-semibold p-1.5" style="width:32%">{{ DIMENSIONS.find(d => d.key === cycleDrillDim)?.label }}</th>
                <th class="text-right font-semibold p-1.5">n</th>
                <th class="text-right font-semibold p-1.5">Min</th>
                <th class="text-right font-semibold p-1.5">P25</th>
                <th class="text-right font-semibold p-1.5">Med</th>
                <th class="text-right font-semibold p-1.5">P75</th>
                <th class="text-right font-semibold p-1.5">Max</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in cycleDrillRows" :key="r.name" class="border-t border-border/30">
                <td class="p-1.5 font-medium truncate" :title="r.name">{{ r.name }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ r.n }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ r.min }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ r.p25 }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums font-bold">{{ r.median }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ r.p75 }}</td>
                <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ r.max }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- ═══ MACD-style sales momentum chart (md+) — at bottom because
           it's a deeper analytical view, not a daily-glance number. ═══ -->
      <section class="space-y-2 hidden md:block">
        <h2 class="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Sales Momentum · 180d</h2>
        <div class="rounded-xl bg-card p-3 relative">
          <div v-if="data.macd.high52w" class="absolute top-2 left-4 text-[11px] text-muted-foreground z-10 pointer-events-none">
            <span class="font-semibold text-emerald-700">52w high</span>
            <span class="tabular-nums"> · {{ data.macd.high52w.count }} on {{ fmtPrettyDate(data.macd.high52w.date) }}</span>
          </div>
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
          <p class="text-[10px] text-muted-foreground italic">Click a section to expand</p>
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
            <p class="text-[10px] tabular-nums shrink-0 text-muted-foreground">
              {{ fmtNum(auditSummary(key).count) }} · {{ fmtKw(auditSummary(key).kw) }} · {{ fmtMoney(auditSummary(key).rev) }}
            </p>
          </button>
          <div v-if="auditOpen[key]">
            <div v-if="data.audit[key].length === 0" class="px-3 pb-3 text-[11px] text-muted-foreground italic">No records in this bucket.</div>
            <div v-else class="overflow-auto max-h-[480px]">
              <table class="w-full text-[10px] min-w-[840px]" style="table-layout:auto">
                <thead class="sticky top-0">
                  <tr class="text-muted-foreground bg-muted">
                    <th v-if="key !== 'installedNotM2'" class="text-left font-semibold p-1.5">RID</th>
                    <th class="text-left font-semibold p-1.5" :class="key === 'installedNotM2' ? 'cursor-pointer select-none hover:text-foreground' : ''" @click="key === 'installedNotM2' && toggleInm2Sort('customerName')">Customer<span v-if="key === 'installedNotM2'">{{ inm2SortArrow('customerName') }}</span></th>
                    <th class="text-left font-semibold p-1.5" :class="key === 'installedNotM2' ? 'cursor-pointer select-none hover:text-foreground' : ''" @click="key === 'installedNotM2' && toggleInm2Sort('state')">State<span v-if="key === 'installedNotM2'">{{ inm2SortArrow('state') }}</span></th>
                    <th class="text-left font-semibold p-1.5" :class="key === 'installedNotM2' ? 'cursor-pointer select-none hover:text-foreground' : ''" @click="key === 'installedNotM2' && toggleInm2Sort('status')">Status<span v-if="key === 'installedNotM2'">{{ inm2SortArrow('status') }}</span></th>
                    <th class="text-left font-semibold p-1.5" :class="key === 'installedNotM2' ? 'cursor-pointer select-none hover:text-foreground' : ''" @click="key === 'installedNotM2' && toggleInm2Sort('closer')">Closer<span v-if="key === 'installedNotM2'">{{ inm2SortArrow('closer') }}</span></th>
                    <th class="text-left font-semibold p-1.5" :class="key === 'installedNotM2' ? 'cursor-pointer select-none hover:text-foreground' : ''" @click="key === 'installedNotM2' && toggleInm2Sort('lender')">Lender<span v-if="key === 'installedNotM2'">{{ inm2SortArrow('lender') }}</span></th>
                    <th class="text-left font-semibold p-1.5" :class="key === 'installedNotM2' ? 'cursor-pointer select-none hover:text-foreground' : ''" @click="key === 'installedNotM2' && toggleInm2Sort('salesDate')">Sale<span v-if="key === 'installedNotM2'">{{ inm2SortArrow('salesDate') }}</span></th>
                    <th class="text-left font-semibold p-1.5" :class="key === 'installedNotM2' ? 'cursor-pointer select-none hover:text-foreground' : ''" @click="key === 'installedNotM2' && toggleInm2Sort('installCompleted')">Inst<span v-if="key === 'installedNotM2'">{{ inm2SortArrow('installCompleted') }}</span></th>
                    <th class="text-left font-semibold p-1.5" :class="key === 'installedNotM2' ? 'cursor-pointer select-none hover:text-foreground' : ''" @click="key === 'installedNotM2' && toggleInm2Sort('m2')">M2<span v-if="key === 'installedNotM2'">{{ inm2SortArrow('m2') }}</span></th>
                    <th class="text-right font-semibold p-1.5" :class="key === 'installedNotM2' ? 'cursor-pointer select-none hover:text-foreground' : ''" title="Days since M1 requested" @click="key === 'installedNotM2' && toggleInm2Sort('m1d')">M1d<span v-if="key === 'installedNotM2'">{{ inm2SortArrow('m1d') }}</span></th>
                    <th class="text-right font-semibold p-1.5" :class="key === 'installedNotM2' ? 'cursor-pointer select-none hover:text-foreground' : ''" title="Days since M2 requested" @click="key === 'installedNotM2' && toggleInm2Sort('m2d')">M2d<span v-if="key === 'installedNotM2'">{{ inm2SortArrow('m2d') }}</span></th>
                    <th class="text-right font-semibold p-1.5" :class="key === 'installedNotM2' ? 'cursor-pointer select-none hover:text-foreground' : ''" @click="key === 'installedNotM2' && toggleInm2Sort('systemPrice')">$<span v-if="key === 'installedNotM2'">{{ inm2SortArrow('systemPrice') }}</span></th>
                    <th class="text-right font-semibold p-1.5" :class="key === 'installedNotM2' ? 'cursor-pointer select-none hover:text-foreground' : ''" @click="key === 'installedNotM2' && toggleInm2Sort('systemSizeKw')">kW<span v-if="key === 'installedNotM2'">{{ inm2SortArrow('systemSizeKw') }}</span></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in sortedAuditRows(key)" :key="`${key}-${r.recordId}`" class="border-t border-border/30 cursor-pointer" :class="key === 'installedNotM2' && isInm2Urgent(r) ? 'bg-red-50/60 hover:bg-red-100/60 dark:bg-red-950/30 dark:hover:bg-red-950/50' : 'hover:bg-muted/30'" @click="openProject(r.recordId, $event)" @auxclick.prevent="openProject(r.recordId, $event)">
                    <td v-if="key !== 'installedNotM2'" class="p-1.5 font-mono text-muted-foreground">{{ r.recordId }}</td>
                    <td class="p-1.5 font-medium truncate max-w-[160px]">{{ r.customerName || '—' }}</td>
                    <td class="p-1.5 truncate max-w-[80px]">{{ r.state || '—' }}</td>
                    <td class="p-1.5 truncate max-w-[100px]">{{ r.status || '—' }}</td>
                    <td class="p-1.5 truncate max-w-[100px]">{{ r.closer || '—' }}</td>
                    <td class="p-1.5 truncate max-w-[80px]">{{ r.lender || '—' }}</td>
                    <td class="p-1.5 font-mono text-muted-foreground">{{ fmtAuditDate(r.salesDate) }}</td>
                    <td class="p-1.5 font-mono text-muted-foreground">{{ fmtAuditDate(r.installCompleted) }}</td>
                    <td class="p-1.5 font-mono font-semibold" :class="m2Cell(r).tone">{{ m2Cell(r).text }}</td>
                    <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ daysSince(r.m1RequestedDate) }}</td>
                    <td class="p-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ daysSince(r.m2RequestedDate) }}</td>
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
