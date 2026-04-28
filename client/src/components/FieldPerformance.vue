<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'

use([CanvasRenderer, BarChart, GridComponent, TooltipComponent, LegendComponent])

// Field Performance — install volume + cycle-time analytics.
// Aggregates from project_cache via /api/field/performance.
//
// Layout (mobile-first):
//   1. Filter strip (date preset, basis toggle, day-unit toggle)
//   2. KPI tiles row (canonical app KPI shape — see docs/ui-component-specs.md)
//   3. Time-series bar chart with data labels
//   4. Pivot table titled "INSTALL COMPLETE · {DIMENSION}" with chip
//      strip immediately above for dimension switching, totals row
//      at the bottom.
//   5. Decile table — same dimension chip strip, numeric grid with
//      D10..D100 + Mean across columns, dimension values down rows,
//      totals row at the bottom. Mobile collapses to D20 / Mean /
//      D90 / Max.

interface Headline {
  total_count: number
  total_kw: number
  completed_count: number
  completed_kw: number
}
interface SeriesPoint { bucket: string; count: number; kw: number }
interface PivotRow {
  dimension_value: string
  count: number
  kw: number
  install_dur_mean: number
  install_dur_p90: number
  sale_to_install_mean: number
  sale_to_install_p90: number
}
interface DecileRow {
  dimension_value: string
  count: number
  kw: number
  d10: number; d20: number; d30: number; d40: number; d50: number
  d60: number; d70: number; d80: number; d90: number; d100: number
  mean: number
}
interface PerfResp {
  window: { from: string; to: string; days: number }
  date_basis: 'scheduled' | 'completed'
  dimension: string
  day_unit: 'biz' | 'cal'
  granularity: 'day' | 'week' | 'month'
  headline: Headline
  series: SeriesPoint[]
  pivot: PivotRow[]
  pivot_total: PivotRow
  deciles: { rows: DecileRow[]; total: DecileRow }
}

type Dimension =
  | 'sales_office' | 'state' | 'sales_company' | 'lender'
  | 'closer' | 'setter' | 'area_director'
  | 'ahj_name' | 'utility_company' | 'mpu_callout'

const DIMENSIONS: Array<{ key: Dimension; label: string }> = [
  { key: 'sales_office', label: 'Sales Office' },
  { key: 'state', label: 'State' },
  { key: 'sales_company', label: 'Sales Co' },
  { key: 'lender', label: 'Lender' },
  { key: 'closer', label: 'Closer' },
  { key: 'setter', label: 'Setter' },
  { key: 'area_director', label: 'Area Dir' },
  { key: 'ahj_name', label: 'AHJ' },
  { key: 'utility_company', label: 'Utility' },
  { key: 'mpu_callout', label: 'Elec Upgrade' },
]

const auth = useAuthStore()

// ─── Filter state ─────────────────────────────────────────
type DatePreset = 'last_30' | 'last_60' | 'last_90' | 'this_month' | 'this_quarter' | 'this_year' | 'custom'
const datePreset = ref<DatePreset>('last_90')
const fromDate = ref('')
const toDate = ref('')
const dateBasis = ref<'scheduled' | 'completed'>('completed')
const dimension = ref<Dimension>('sales_office')
const dayUnit = ref<'biz' | 'cal'>('biz')

function fmtLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function applyPreset(key: DatePreset) {
  datePreset.value = key
  if (key === 'custom') return
  const today = new Date()
  const to = fmtLocalDate(today)
  const back = (n: number) => { const d = new Date(today); d.setDate(d.getDate() - n); return fmtLocalDate(d) }
  if (key === 'last_30') { fromDate.value = back(29); toDate.value = to }
  else if (key === 'last_60') { fromDate.value = back(59); toDate.value = to }
  else if (key === 'last_90') { fromDate.value = back(89); toDate.value = to }
  else if (key === 'this_month') { fromDate.value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`; toDate.value = to }
  else if (key === 'this_quarter') { fromDate.value = `${today.getFullYear()}-${String(Math.floor(today.getMonth() / 3) * 3 + 1).padStart(2, '0')}-01`; toDate.value = to }
  else if (key === 'this_year') { fromDate.value = `${today.getFullYear()}-01-01`; toDate.value = to }
}
applyPreset('last_90')

// When the user types into either date input, drop out of preset mode
// so the active state on the preset buttons doesn't lie.
function onCustomDate() { datePreset.value = 'custom' }

// Mobile breakpoint — used to thin chart margins below sm so bars
// fill more horizontal space on a 390px screen.
const isMobile = ref(typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches)
let mq: MediaQueryList | null = null
onMounted(() => {
  if (typeof window !== 'undefined') {
    mq = window.matchMedia('(max-width: 639px)')
    const sync = () => { isMobile.value = mq!.matches }
    mq.addEventListener('change', sync)
    sync()
  }
})

// ─── Data ─────────────────────────────────────────────────
const data = ref<PerfResp | null>(null)
const loading = ref(false)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const p = new URLSearchParams()
    if (fromDate.value) p.set('from', fromDate.value)
    if (toDate.value) p.set('to', toDate.value)
    p.set('date_basis', dateBasis.value)
    p.set('dimension', dimension.value)
    p.set('day_unit', dayUnit.value)
    const res = await fetch(`/api/field/performance?${p}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    if (!res.ok) {
      error.value = `HTTP ${res.status}`
      return
    }
    data.value = await res.json() as PerfResp
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

watch([fromDate, toDate, dateBasis, dimension, dayUnit], load)
onMounted(load)

// ─── ECharts options ──────────────────────────────────────
function fmtBucket(bucket: string, granularity: string): string {
  if (granularity === 'month') {
    const [y, m] = bucket.split('-')
    if (!y || !m) return bucket
    const d = new Date(Number(y), Number(m) - 1, 1)
    return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
  }
  const d = new Date(bucket)
  if (isNaN(d.getTime())) return bucket
  if (granularity === 'week') {
    // Mon–Sun week — label with the Monday's date so the user can
    // map a bar back to a specific week.
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const chartOption = computed(() => {
  const series = data.value?.series || []
  const granularity = data.value?.granularity || 'day'
  // Tighter horizontal margins on mobile so bars fill the screen.
  // containLabel still pads inside for axis labels — we just don't
  // reserve dead space for them on top of that.
  const grid = isMobile.value
    ? { top: 32, right: 4, bottom: 36, left: 4, containLabel: true }
    : { top: 32, right: 16, bottom: 36, left: 44, containLabel: true }
  return {
    grid,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (items: Array<{ name: string; value: number; seriesName: string }>) => {
        if (!items.length) return ''
        const head = items[0]?.name || ''
        const lines = items.map(it => `${it.seriesName}: <b>${it.value}</b>`)
        return `<div class="text-xs"><div class="font-semibold mb-1">${head}</div>${lines.join('<br>')}</div>`
      },
    },
    legend: { bottom: 0, textStyle: { fontSize: 11 } },
    xAxis: {
      type: 'category',
      data: series.map(s => fmtBucket(s.bucket, granularity)),
      axisLabel: { fontSize: 10, hideOverlap: true },
      axisLine: { lineStyle: { color: '#cbd5e1' } },
    },
    yAxis: [
      {
        type: 'value',
        position: 'left',
        name: 'Installs',
        nameTextStyle: { fontSize: 10 },
        axisLabel: { fontSize: 10 },
        splitLine: { lineStyle: { color: '#e2e8f0' } },
      },
      {
        type: 'value',
        position: 'right',
        name: 'kW',
        nameTextStyle: { fontSize: 10 },
        axisLabel: { fontSize: 10 },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: 'Installs',
        type: 'bar',
        yAxisIndex: 0,
        itemStyle: { color: '#0ea5e9', borderRadius: [4, 4, 0, 0] },
        // Data labels above each bar — small and subtle so they don't
        // crowd at high-density windows but visible enough to scan.
        label: {
          show: true,
          position: 'top',
          fontSize: 9,
          color: '#0369a1',
          formatter: (p: { value: number }) => p.value > 0 ? String(p.value) : '',
        },
        data: series.map(s => s.count),
      },
      {
        name: 'kW',
        type: 'bar',
        yAxisIndex: 1,
        itemStyle: { color: '#10b981', borderRadius: [4, 4, 0, 0] },
        label: {
          show: true,
          position: 'top',
          fontSize: 9,
          color: '#047857',
          formatter: (p: { value: number }) => p.value > 0 ? p.value.toFixed(1) : '',
        },
        data: series.map(s => s.kw),
      },
    ],
  }
})

// ─── Pivot sort ───────────────────────────────────────────
type SortKey = 'count' | 'kw' | 'install_dur_mean' | 'install_dur_p90' | 'sale_to_install_mean' | 'sale_to_install_p90'
const sortKey = ref<SortKey>('count')
const sortDir = ref<'desc' | 'asc'>('desc')
function setSort(k: SortKey) {
  if (sortKey.value === k) sortDir.value = sortDir.value === 'desc' ? 'asc' : 'desc'
  else { sortKey.value = k; sortDir.value = 'desc' }
}
const sortedPivot = computed(() => {
  const rows = [...(data.value?.pivot || [])]
  rows.sort((a, b) => {
    const av = (a[sortKey.value] as number) || 0
    const bv = (b[sortKey.value] as number) || 0
    return sortDir.value === 'desc' ? bv - av : av - bv
  })
  return rows
})

// ─── Decile sort ──────────────────────────────────────────
type DecSortKey = 'count' | 'kw' | 'd20' | 'mean' | 'd90' | 'd100'
const decSortKey = ref<DecSortKey>('count')
const decSortDir = ref<'desc' | 'asc'>('desc')
function setDecSort(k: DecSortKey) {
  if (decSortKey.value === k) decSortDir.value = decSortDir.value === 'desc' ? 'asc' : 'desc'
  else { decSortKey.value = k; decSortDir.value = 'desc' }
}
const sortedDecile = computed(() => {
  const rows = [...(data.value?.deciles.rows || [])]
  rows.sort((a, b) => {
    const av = (a[decSortKey.value] as number) || 0
    const bv = (b[decSortKey.value] as number) || 0
    return decSortDir.value === 'desc' ? bv - av : av - bv
  })
  return rows
})

// ─── Helpers ──────────────────────────────────────────────
function fmtNum(n: number): string { return (n || 0).toLocaleString() }
function fmtDays(n: number): string { return n > 0 ? `${n.toFixed(1)}` : '—' }
function fmtKw(n: number): string { return `${(n || 0).toFixed(1)}` }
function caretFor(k: SortKey): string {
  if (sortKey.value !== k) return ''
  return sortDir.value === 'desc' ? '↓' : '↑'
}
function caretForDec(k: DecSortKey): string {
  if (decSortKey.value !== k) return ''
  return decSortDir.value === 'desc' ? '↓' : '↑'
}

const dimensionLabel = computed(() => DIMENSIONS.find(d => d.key === dimension.value)?.label || dimension.value)
const dimensionLabelUpper = computed(() => dimensionLabel.value.toUpperCase())
</script>

<template>
  <div class="grid gap-3 min-w-0">
    <!-- Filter strip — date presets + basis/unit toggles. The dimension
         chip strip lives directly above each table to keep selection
         visually attached to what's being grouped. -->
    <div class="grid gap-2 min-w-0">
      <div class="flex flex-wrap items-center gap-1.5 min-w-0">
        <button v-for="p in [
          { k: 'last_30', l: '30d' },
          { k: 'last_60', l: '60d' },
          { k: 'last_90', l: '90d' },
          { k: 'this_month', l: 'Mo' },
          { k: 'this_quarter', l: 'Qtr' },
          { k: 'this_year', l: 'YTD' },
        ] as Array<{ k: DatePreset; l: string }>" :key="p.k"
          class="px-2 py-0.5 rounded-full border text-[10px] font-medium transition-colors whitespace-nowrap"
          :class="datePreset === p.k ? 'bg-foreground text-background border-foreground' : 'bg-card hover:bg-muted'"
          @click="applyPreset(p.k)"
        >{{ p.l }}</button>
      </div>
      <!-- Custom from/to inputs — same shape as ProjectsView so the
           pattern feels consistent across the app. Typing in either
           switches the preset row to "custom" so the highlight is
           honest. -->
      <div class="flex items-center gap-1.5 flex-wrap min-w-0">
        <input
          v-model="fromDate" type="date"
          class="h-7 w-[125px] rounded border bg-card px-2 text-[11px] tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          @change="onCustomDate"
        />
        <span class="text-[11px] text-muted-foreground">—</span>
        <input
          v-model="toDate" type="date"
          class="h-7 w-[125px] rounded border bg-card px-2 text-[11px] tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          @change="onCustomDate"
        />
        <span v-if="datePreset === 'custom'" class="text-[10px] text-muted-foreground">custom</span>
      </div>

      <div class="flex items-center gap-2 flex-wrap min-w-0">
        <div class="inline-flex rounded-md border overflow-hidden">
          <button class="px-2 py-1 text-[11px] font-medium" :class="dateBasis === 'scheduled' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'" @click="dateBasis = 'scheduled'">Scheduled</button>
          <button class="px-2 py-1 text-[11px] font-medium" :class="dateBasis === 'completed' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'" @click="dateBasis = 'completed'">Completed</button>
        </div>
        <div class="inline-flex rounded-md border overflow-hidden">
          <button class="px-2 py-1 text-[11px] font-medium" :class="dayUnit === 'biz' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'" @click="dayUnit = 'biz'">Biz days</button>
          <button class="px-2 py-1 text-[11px] font-medium" :class="dayUnit === 'cal' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'" @click="dayUnit = 'cal'">Cal days</button>
        </div>
      </div>
    </div>

    <div v-if="loading && !data" class="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">Loading performance…</div>
    <div v-else-if="error" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{{ error }}</div>

    <template v-else-if="data">
      <!-- KPI tiles — canonical app KPI shape. See docs/ui-component-specs.md -->
      <div class="grid grid-cols-2 gap-2 min-w-0">
        <div class="rounded-xl border bg-card p-3 min-w-0 relative overflow-hidden">
          <div class="absolute top-0 left-0 right-0 h-[3px] bg-sky-500" />
          <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Installs ({{ data.date_basis }})</p>
          <p class="mt-1 flex items-baseline gap-1.5 min-w-0">
            <span class="text-2xl font-extrabold tabular-nums text-sky-600 leading-none">{{ fmtNum(data.headline.total_count) }}</span>
            <span class="text-[11px] font-semibold tabular-nums text-muted-foreground truncate">/ {{ fmtKw(data.headline.total_kw) }} kW</span>
          </p>
        </div>
        <div class="rounded-xl border bg-card p-3 min-w-0 relative overflow-hidden">
          <div class="absolute top-0 left-0 right-0 h-[3px] bg-emerald-500" />
          <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Completed (with dates)</p>
          <p class="mt-1 flex items-baseline gap-1.5 min-w-0">
            <span class="text-2xl font-extrabold tabular-nums text-emerald-600 leading-none">{{ fmtNum(data.headline.completed_count) }}</span>
            <span class="text-[11px] font-semibold tabular-nums text-muted-foreground truncate">/ {{ fmtKw(data.headline.completed_kw) }} kW</span>
          </p>
        </div>
      </div>

      <!-- Time series chart — header keeps p-3, but the chart body
           drops side padding on mobile so the bars fill the full
           viewport width. ECharts grid margins also tighten on
           mobile (see chartOption). -->
      <div class="rounded-xl border bg-card min-w-0 overflow-hidden">
        <div class="px-3 pt-3 pb-1 flex items-center justify-between flex-wrap gap-1">
          <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Volume by {{ data.granularity }}</p>
          <p class="text-[10px] text-muted-foreground">{{ data.granularity === 'week' ? 'Mon–Sun · ' : '' }}x-axis: {{ data.granularity }}</p>
        </div>
        <div class="px-0 sm:px-3 pb-3">
          <VChart :option="chartOption" autoresize :style="{ height: isMobile ? '300px' : '260px' }" class="w-full" />
        </div>
      </div>

      <!-- Pivot table — title leads with dimension; dimension chip strip
           sits directly above the card so the user can switch grouping
           in-place without scrolling back to the top filter strip. -->
      <div class="grid gap-1.5 min-w-0">
        <div class="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1 min-w-0">
          <button v-for="d in DIMENSIONS" :key="d.key"
            class="flex-none px-2.5 py-1 rounded-full border text-[11px] font-medium transition-colors whitespace-nowrap"
            :class="dimension === d.key ? 'bg-foreground text-background border-foreground' : 'bg-card hover:bg-muted'"
            @click="dimension = d.key"
          >{{ d.label }}</button>
        </div>

        <div class="rounded-xl border bg-card overflow-hidden min-w-0">
          <div class="px-3 py-2 border-b flex items-baseline justify-between gap-2 flex-wrap">
            <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">INSTALL COMPLETE · {{ dimensionLabelUpper }}</p>
            <p class="text-[10px] text-muted-foreground">{{ sortedPivot.length }} {{ sortedPivot.length === 1 ? 'bucket' : 'buckets' }} · {{ dayUnit === 'biz' ? 'business' : 'calendar' }} days</p>
          </div>

          <!-- Desktop -->
          <div class="hidden sm:block">
            <table class="w-full text-[11px] tabular-nums">
              <thead class="bg-muted/30 text-muted-foreground">
                <tr>
                  <th class="text-left font-medium px-3 py-2">{{ dimensionLabel }}</th>
                  <th class="text-right font-medium px-2 py-2 cursor-pointer hover:text-foreground" @click="setSort('count')">Count {{ caretFor('count') }}</th>
                  <th class="text-right font-medium px-2 py-2 cursor-pointer hover:text-foreground" @click="setSort('kw')">kW {{ caretFor('kw') }}</th>
                  <th class="text-right font-medium px-2 py-2 cursor-pointer hover:text-foreground" @click="setSort('install_dur_mean')">Inst dur μ {{ caretFor('install_dur_mean') }}</th>
                  <th class="text-right font-medium px-2 py-2 cursor-pointer hover:text-foreground" @click="setSort('install_dur_p90')">Inst dur P90 {{ caretFor('install_dur_p90') }}</th>
                  <th class="text-right font-medium px-2 py-2 cursor-pointer hover:text-foreground" @click="setSort('sale_to_install_mean')">Sale→Inst μ {{ caretFor('sale_to_install_mean') }}</th>
                  <th class="text-right font-medium px-2 py-2 cursor-pointer hover:text-foreground" @click="setSort('sale_to_install_p90')">Sale→Inst P90 {{ caretFor('sale_to_install_p90') }}</th>
                </tr>
              </thead>
              <tbody class="divide-y">
                <tr v-for="r in sortedPivot" :key="r.dimension_value" class="hover:bg-muted/30">
                  <td class="px-3 py-1.5 font-medium truncate max-w-[180px]" :title="r.dimension_value">{{ r.dimension_value }}</td>
                  <td class="text-right px-2">{{ fmtNum(r.count) }}</td>
                  <td class="text-right px-2">{{ fmtKw(r.kw) }}</td>
                  <td class="text-right px-2">{{ fmtDays(r.install_dur_mean) }}</td>
                  <td class="text-right px-2">{{ fmtDays(r.install_dur_p90) }}</td>
                  <td class="text-right px-2">{{ fmtDays(r.sale_to_install_mean) }}</td>
                  <td class="text-right px-2">{{ fmtDays(r.sale_to_install_p90) }}</td>
                </tr>
                <tr v-if="sortedPivot.length === 0">
                  <td colspan="7" class="text-center py-6 text-muted-foreground">No installs in this window.</td>
                </tr>
              </tbody>
              <tfoot v-if="sortedPivot.length > 0" class="border-t-2 bg-muted/20 font-semibold">
                <tr>
                  <td class="px-3 py-1.5">Total</td>
                  <td class="text-right px-2">{{ fmtNum(data.pivot_total.count) }}</td>
                  <td class="text-right px-2">{{ fmtKw(data.pivot_total.kw) }}</td>
                  <td class="text-right px-2">{{ fmtDays(data.pivot_total.install_dur_mean) }}</td>
                  <td class="text-right px-2">{{ fmtDays(data.pivot_total.install_dur_p90) }}</td>
                  <td class="text-right px-2">{{ fmtDays(data.pivot_total.sale_to_install_mean) }}</td>
                  <td class="text-right px-2">{{ fmtDays(data.pivot_total.sale_to_install_p90) }}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <!-- Mobile cards -->
          <div class="sm:hidden divide-y">
            <div v-for="r in sortedPivot" :key="r.dimension_value" class="px-3 py-2 min-w-0">
              <p class="font-semibold text-[12px] truncate" :title="r.dimension_value">{{ r.dimension_value }}</p>
              <div class="grid grid-cols-3 gap-1.5 mt-1 text-[10px] tabular-nums">
                <div class="rounded bg-muted/30 px-2 py-1 min-w-0">
                  <p class="text-[9px] uppercase tracking-wider text-muted-foreground">Count</p>
                  <p class="font-semibold">{{ fmtNum(r.count) }}</p>
                </div>
                <div class="rounded bg-muted/30 px-2 py-1 min-w-0">
                  <p class="text-[9px] uppercase tracking-wider text-muted-foreground">kW</p>
                  <p class="font-semibold">{{ fmtKw(r.kw) }}</p>
                </div>
                <div class="rounded bg-muted/30 px-2 py-1 min-w-0">
                  <p class="text-[9px] uppercase tracking-wider text-muted-foreground">Inst μ</p>
                  <p class="font-semibold">{{ fmtDays(r.install_dur_mean) }}</p>
                </div>
                <div class="rounded bg-muted/30 px-2 py-1 min-w-0">
                  <p class="text-[9px] uppercase tracking-wider text-muted-foreground">Inst P90</p>
                  <p class="font-semibold">{{ fmtDays(r.install_dur_p90) }}</p>
                </div>
                <div class="rounded bg-muted/30 px-2 py-1 min-w-0">
                  <p class="text-[9px] uppercase tracking-wider text-muted-foreground">Sale→Inst μ</p>
                  <p class="font-semibold">{{ fmtDays(r.sale_to_install_mean) }}</p>
                </div>
                <div class="rounded bg-muted/30 px-2 py-1 min-w-0">
                  <p class="text-[9px] uppercase tracking-wider text-muted-foreground">Sale→Inst P90</p>
                  <p class="font-semibold">{{ fmtDays(r.sale_to_install_p90) }}</p>
                </div>
              </div>
            </div>
            <div v-if="sortedPivot.length === 0" class="px-3 py-6 text-center text-muted-foreground text-[11px]">No installs in this window.</div>
            <div v-if="sortedPivot.length > 0" class="px-3 py-2 bg-muted/30 min-w-0">
              <p class="font-semibold text-[12px]">Total</p>
              <div class="grid grid-cols-3 gap-1.5 mt-1 text-[10px] tabular-nums">
                <div class="rounded bg-muted/40 px-2 py-1 min-w-0"><p class="text-[9px] uppercase tracking-wider text-muted-foreground">Count</p><p class="font-semibold">{{ fmtNum(data.pivot_total.count) }}</p></div>
                <div class="rounded bg-muted/40 px-2 py-1 min-w-0"><p class="text-[9px] uppercase tracking-wider text-muted-foreground">kW</p><p class="font-semibold">{{ fmtKw(data.pivot_total.kw) }}</p></div>
                <div class="rounded bg-muted/40 px-2 py-1 min-w-0"><p class="text-[9px] uppercase tracking-wider text-muted-foreground">Inst μ</p><p class="font-semibold">{{ fmtDays(data.pivot_total.install_dur_mean) }}</p></div>
                <div class="rounded bg-muted/40 px-2 py-1 min-w-0"><p class="text-[9px] uppercase tracking-wider text-muted-foreground">Inst P90</p><p class="font-semibold">{{ fmtDays(data.pivot_total.install_dur_p90) }}</p></div>
                <div class="rounded bg-muted/40 px-2 py-1 min-w-0"><p class="text-[9px] uppercase tracking-wider text-muted-foreground">Sale→Inst μ</p><p class="font-semibold">{{ fmtDays(data.pivot_total.sale_to_install_mean) }}</p></div>
                <div class="rounded bg-muted/40 px-2 py-1 min-w-0"><p class="text-[9px] uppercase tracking-wider text-muted-foreground">Sale→Inst P90</p><p class="font-semibold">{{ fmtDays(data.pivot_total.sale_to_install_p90) }}</p></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Decile table — pure numeric grid, dimension on Y, decile on X.
           Mobile collapses to D20 / Mean / D90 / Max only. Total row
           at the bottom uses the cross-window stats from the server. -->
      <div class="grid gap-1.5 min-w-0">
        <div class="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1 min-w-0">
          <button v-for="d in DIMENSIONS" :key="d.key"
            class="flex-none px-2.5 py-1 rounded-full border text-[11px] font-medium transition-colors whitespace-nowrap"
            :class="dimension === d.key ? 'bg-foreground text-background border-foreground' : 'bg-card hover:bg-muted'"
            @click="dimension = d.key"
          >{{ d.label }}</button>
        </div>

        <div class="rounded-xl border bg-card overflow-hidden min-w-0">
          <div class="px-3 py-2 border-b flex items-baseline justify-between gap-2 flex-wrap">
            <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">INSTALL DURATION DECILES · {{ dimensionLabelUpper }}</p>
            <p class="text-[10px] text-muted-foreground">{{ dayUnit === 'biz' ? 'business' : 'calendar' }} days · D100 = max</p>
          </div>

          <!-- Desktop: full decile grid -->
          <div class="hidden sm:block overflow-x-auto">
            <table class="w-full text-[11px] tabular-nums">
              <thead class="bg-muted/30 text-muted-foreground">
                <tr>
                  <th class="text-left font-medium px-3 py-2 sticky left-0 bg-muted/30 z-[1]">{{ dimensionLabel }}</th>
                  <th class="text-right font-medium px-2 py-2 cursor-pointer hover:text-foreground" @click="setDecSort('count')">n {{ caretForDec('count') }}</th>
                  <th class="text-right font-medium px-2 py-2">D10</th>
                  <th class="text-right font-medium px-2 py-2">D20</th>
                  <th class="text-right font-medium px-2 py-2">D30</th>
                  <th class="text-right font-medium px-2 py-2">D40</th>
                  <th class="text-right font-medium px-2 py-2">D50</th>
                  <th class="text-right font-medium px-2 py-2">D60</th>
                  <th class="text-right font-medium px-2 py-2">D70</th>
                  <th class="text-right font-medium px-2 py-2">D80</th>
                  <th class="text-right font-medium px-2 py-2 cursor-pointer hover:text-foreground" @click="setDecSort('d90')">D90 {{ caretForDec('d90') }}</th>
                  <th class="text-right font-medium px-2 py-2 cursor-pointer hover:text-foreground" @click="setDecSort('d100')">Max {{ caretForDec('d100') }}</th>
                  <th class="text-right font-medium px-2 py-2 cursor-pointer hover:text-foreground" @click="setDecSort('mean')">Mean {{ caretForDec('mean') }}</th>
                </tr>
              </thead>
              <tbody class="divide-y">
                <tr v-for="r in sortedDecile" :key="r.dimension_value" class="hover:bg-muted/30">
                  <td class="px-3 py-1.5 font-medium truncate max-w-[180px] sticky left-0 bg-card hover:bg-muted/30 z-[1]" :title="r.dimension_value">{{ r.dimension_value }}</td>
                  <td class="text-right px-2">{{ fmtNum(r.count) }}</td>
                  <td class="text-right px-2">{{ fmtDays(r.d10) }}</td>
                  <td class="text-right px-2">{{ fmtDays(r.d20) }}</td>
                  <td class="text-right px-2">{{ fmtDays(r.d30) }}</td>
                  <td class="text-right px-2">{{ fmtDays(r.d40) }}</td>
                  <td class="text-right px-2">{{ fmtDays(r.d50) }}</td>
                  <td class="text-right px-2">{{ fmtDays(r.d60) }}</td>
                  <td class="text-right px-2">{{ fmtDays(r.d70) }}</td>
                  <td class="text-right px-2">{{ fmtDays(r.d80) }}</td>
                  <td class="text-right px-2">{{ fmtDays(r.d90) }}</td>
                  <td class="text-right px-2">{{ fmtDays(r.d100) }}</td>
                  <td class="text-right px-2 font-semibold">{{ fmtDays(r.mean) }}</td>
                </tr>
                <tr v-if="sortedDecile.length === 0">
                  <td colspan="13" class="text-center py-6 text-muted-foreground">No completed installs in this window.</td>
                </tr>
              </tbody>
              <tfoot v-if="sortedDecile.length > 0" class="border-t-2 bg-muted/20 font-semibold">
                <tr>
                  <td class="px-3 py-1.5 sticky left-0 bg-muted/20 z-[1]">Total</td>
                  <td class="text-right px-2">{{ fmtNum(data.deciles.total.count) }}</td>
                  <td class="text-right px-2">{{ fmtDays(data.deciles.total.d10) }}</td>
                  <td class="text-right px-2">{{ fmtDays(data.deciles.total.d20) }}</td>
                  <td class="text-right px-2">{{ fmtDays(data.deciles.total.d30) }}</td>
                  <td class="text-right px-2">{{ fmtDays(data.deciles.total.d40) }}</td>
                  <td class="text-right px-2">{{ fmtDays(data.deciles.total.d50) }}</td>
                  <td class="text-right px-2">{{ fmtDays(data.deciles.total.d60) }}</td>
                  <td class="text-right px-2">{{ fmtDays(data.deciles.total.d70) }}</td>
                  <td class="text-right px-2">{{ fmtDays(data.deciles.total.d80) }}</td>
                  <td class="text-right px-2">{{ fmtDays(data.deciles.total.d90) }}</td>
                  <td class="text-right px-2">{{ fmtDays(data.deciles.total.d100) }}</td>
                  <td class="text-right px-2">{{ fmtDays(data.deciles.total.mean) }}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <!-- Mobile: D20 / Mean / D90 / Max -->
          <div class="sm:hidden">
            <table class="w-full text-[11px] tabular-nums">
              <thead class="bg-muted/30 text-muted-foreground">
                <tr>
                  <th class="text-left font-medium px-2 py-2">{{ dimensionLabel }}</th>
                  <th class="text-right font-medium px-1.5 py-2 cursor-pointer hover:text-foreground" @click="setDecSort('d20')">D20 {{ caretForDec('d20') }}</th>
                  <th class="text-right font-medium px-1.5 py-2 cursor-pointer hover:text-foreground" @click="setDecSort('mean')">Mean {{ caretForDec('mean') }}</th>
                  <th class="text-right font-medium px-1.5 py-2 cursor-pointer hover:text-foreground" @click="setDecSort('d90')">D90 {{ caretForDec('d90') }}</th>
                  <th class="text-right font-medium px-1.5 py-2 cursor-pointer hover:text-foreground" @click="setDecSort('d100')">Max {{ caretForDec('d100') }}</th>
                </tr>
              </thead>
              <tbody class="divide-y">
                <tr v-for="r in sortedDecile" :key="r.dimension_value" class="hover:bg-muted/30">
                  <td class="px-2 py-1.5 font-medium truncate max-w-[110px]" :title="r.dimension_value">{{ r.dimension_value }}</td>
                  <td class="text-right px-1.5">{{ fmtDays(r.d20) }}</td>
                  <td class="text-right px-1.5 font-semibold">{{ fmtDays(r.mean) }}</td>
                  <td class="text-right px-1.5">{{ fmtDays(r.d90) }}</td>
                  <td class="text-right px-1.5">{{ fmtDays(r.d100) }}</td>
                </tr>
                <tr v-if="sortedDecile.length === 0">
                  <td colspan="5" class="text-center py-6 text-muted-foreground">No completed installs.</td>
                </tr>
              </tbody>
              <tfoot v-if="sortedDecile.length > 0" class="border-t-2 bg-muted/20 font-semibold">
                <tr>
                  <td class="px-2 py-1.5">Total</td>
                  <td class="text-right px-1.5">{{ fmtDays(data.deciles.total.d20) }}</td>
                  <td class="text-right px-1.5">{{ fmtDays(data.deciles.total.mean) }}</td>
                  <td class="text-right px-1.5">{{ fmtDays(data.deciles.total.d90) }}</td>
                  <td class="text-right px-1.5">{{ fmtDays(data.deciles.total.d100) }}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
