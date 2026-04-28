<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'

use([CanvasRenderer, BarChart, GridComponent, TooltipComponent, LegendComponent])

// Field Performance — install volume + cycle-time analytics, pulling
// from the Performance endpoint that aggregates project_cache. The
// view is filter-driven: date range + date basis (scheduled vs
// completed) + dimension + day unit (biz vs cal).
//
// Layout: filter strip → headline tile → time-series bar chart →
// pivot table → decile table. Mobile-first; tables become stacked
// cards under sm breakpoint.

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
  decile: number
  max_days: number
  total: number
  by_dimension: Record<string, number>
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
  deciles: { rows: DecileRow[]; top_dimension_values: string[] }
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
  if (granularity === 'week') return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const chartOption = computed(() => {
  const series = data.value?.series || []
  const granularity = data.value?.granularity || 'day'
  return {
    grid: { top: 24, right: 16, bottom: 36, left: 44, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (items: Array<{ name: string; value: number; seriesName: string; data: { count?: number; kw?: number } }>) => {
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
        axisLabel: { fontSize: 10 },
        splitLine: { lineStyle: { color: '#e2e8f0' } },
      },
      {
        type: 'value',
        position: 'right',
        name: 'kW',
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
        data: series.map(s => s.count),
      },
      {
        name: 'kW',
        type: 'bar',
        yAxisIndex: 1,
        itemStyle: { color: '#10b981', borderRadius: [4, 4, 0, 0] },
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

// ─── Helpers ──────────────────────────────────────────────
function fmtNum(n: number): string { return (n || 0).toLocaleString() }
function fmtDays(n: number): string { return n > 0 ? `${n.toFixed(1)}d` : '—' }
function fmtKw(n: number): string { return `${(n || 0).toFixed(1)}` }
function caretFor(k: SortKey): string {
  if (sortKey.value !== k) return ''
  return sortDir.value === 'desc' ? '↓' : '↑'
}

const dimensionLabel = computed(() => DIMENSIONS.find(d => d.key === dimension.value)?.label || dimension.value)
</script>

<template>
  <div class="grid gap-3 min-w-0">
    <!-- Filter strip — date presets, dimension picker, basis + unit toggles -->
    <div class="grid gap-2 min-w-0">
      <!-- Date presets + custom inputs -->
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
        <span class="text-[10px] text-muted-foreground tabular-nums">{{ fromDate }} → {{ toDate }}</span>
      </div>

      <!-- Date basis + day unit toggles -->
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

      <!-- Dimension picker — horizontally scrolling chip strip is the
           approved exception to no-h-scroll for filter bars. -->
      <div class="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1 min-w-0">
        <button v-for="d in DIMENSIONS" :key="d.key"
          class="flex-none px-2.5 py-1 rounded-full border text-[11px] font-medium transition-colors whitespace-nowrap"
          :class="dimension === d.key ? 'bg-foreground text-background border-foreground' : 'bg-card hover:bg-muted'"
          @click="dimension = d.key"
        >{{ d.label }}</button>
      </div>
    </div>

    <div v-if="loading && !data" class="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">Loading performance…</div>
    <div v-else-if="error" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{{ error }}</div>

    <template v-else-if="data">
      <!-- Headline tile -->
      <div class="grid grid-cols-2 gap-2 min-w-0">
        <div class="rounded-xl border bg-card p-3 min-w-0">
          <p class="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">Installs ({{ data.date_basis }})</p>
          <p class="text-2xl font-extrabold tabular-nums mt-0.5">{{ fmtNum(data.headline.total_count) }}</p>
          <p class="text-[10px] text-muted-foreground mt-0.5 tabular-nums">{{ fmtKw(data.headline.total_kw) }} kW</p>
        </div>
        <div class="rounded-xl border bg-card p-3 min-w-0">
          <p class="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">Completed (with start + end)</p>
          <p class="text-2xl font-extrabold tabular-nums mt-0.5 text-emerald-600">{{ fmtNum(data.headline.completed_count) }}</p>
          <p class="text-[10px] text-muted-foreground mt-0.5 tabular-nums">{{ fmtKw(data.headline.completed_kw) }} kW</p>
        </div>
      </div>

      <!-- Time series chart -->
      <div class="rounded-xl border bg-card p-3 min-w-0 overflow-hidden">
        <div class="flex items-center justify-between mb-1 flex-wrap gap-1">
          <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Volume by {{ data.granularity }}</p>
          <p class="text-[10px] text-muted-foreground">x-axis: {{ data.granularity }}</p>
        </div>
        <VChart :option="chartOption" autoresize style="height: 240px;" class="w-full" />
      </div>

      <!-- Pivot table — desktop table, mobile card stack -->
      <div class="rounded-xl border bg-card overflow-hidden min-w-0">
        <div class="px-3 py-2 border-b flex items-baseline justify-between gap-2 flex-wrap">
          <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Pivot · {{ dimensionLabel }}</p>
          <p class="text-[10px] text-muted-foreground">{{ sortedPivot.length }} buckets · {{ dayUnit === 'biz' ? 'business days' : 'calendar days' }}</p>
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
        </div>
      </div>

      <!-- Decile distribution -->
      <div class="rounded-xl border bg-card overflow-hidden min-w-0">
        <div class="px-3 py-2 border-b flex items-baseline justify-between gap-2 flex-wrap">
          <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Install duration deciles</p>
          <p class="text-[10px] text-muted-foreground">Top {{ data.deciles.top_dimension_values.length }} {{ dimensionLabel }} values shown · others bucketed</p>
        </div>
        <div class="overflow-hidden">
          <div class="divide-y">
            <div v-for="r in data.deciles.rows" :key="r.decile" class="px-3 py-2 min-w-0">
              <div class="flex items-baseline justify-between gap-2 mb-1 min-w-0">
                <p class="text-[11px] font-semibold tabular-nums">P{{ r.decile }}</p>
                <p class="text-[10px] text-muted-foreground tabular-nums shrink-0">≤ {{ fmtDays(r.max_days) }} · n={{ r.total }}</p>
              </div>
              <!-- Stacked bar: each top dim value -->
              <div v-if="r.total > 0" class="h-2 rounded-full bg-muted overflow-hidden flex">
                <div v-for="(dimVal, i) in [...data.deciles.top_dimension_values, '— Other']" :key="dimVal"
                  v-show="r.by_dimension[dimVal] && r.by_dimension[dimVal] > 0"
                  class="h-full"
                  :class="['bg-sky-500', 'bg-emerald-500', 'bg-violet-500', 'bg-amber-500', 'bg-rose-500', 'bg-teal-500', 'bg-orange-500', 'bg-indigo-500', 'bg-pink-500', 'bg-lime-500', 'bg-stone-400'][i % 11]"
                  :style="{ width: ((r.by_dimension[dimVal] || 0) / r.total * 100) + '%' }"
                  :title="`${dimVal}: ${r.by_dimension[dimVal]}`"
                />
              </div>
              <div v-else class="h-2 rounded-full bg-muted/40" />
            </div>
          </div>
        </div>
        <!-- Legend for the stacked bars -->
        <div v-if="data.deciles.top_dimension_values.length > 0" class="px-3 py-2 border-t flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
          <span v-for="(dimVal, i) in data.deciles.top_dimension_values" :key="dimVal" class="inline-flex items-center gap-1 truncate max-w-[160px]" :title="dimVal">
            <span class="size-2 rounded-sm shrink-0" :class="['bg-sky-500', 'bg-emerald-500', 'bg-violet-500', 'bg-amber-500', 'bg-rose-500', 'bg-teal-500', 'bg-orange-500', 'bg-indigo-500', 'bg-pink-500', 'bg-lime-500'][i % 10]" />
            <span class="truncate">{{ dimVal }}</span>
          </span>
          <span class="inline-flex items-center gap-1">
            <span class="size-2 rounded-sm bg-stone-400" />
            <span>Other</span>
          </span>
        </div>
      </div>
    </template>
  </div>
</template>
