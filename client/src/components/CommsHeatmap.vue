<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { HeatmapChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, VisualMapComponent } from 'echarts/components'

use([CanvasRenderer, HeatmapChart, GridComponent, TooltipComponent, VisualMapComponent])

// Inbound-volume heatmap — when the team is busy, rendered as a 7×24
// (day-of-week × hour-of-day) ECharts grid.
//
// Reads /api/dialpad/heatmap which combines inbound calls + inbound
// SMS into one count per bucket. Volume buckets render with a calm
// editorial palette (sky → violet, dimmer → brighter) so high-volume
// cells read as "where the heat is" without any anxiety reds.
//
// Filters: date range (presets + custom), user, department, contact
// center. Department/user/contact-center are optional — leaving any
// blank means "all of that dimension."

interface Bucket { dow: number; hour: number; calls: number; sms: number; total: number }
interface FilterOptions {
  users: Array<{ email: string; name: string | null }>
  departments: Array<{ id: number; name: string }>
  contact_centers: Array<{ value: string; count: number }>
}
interface HeatmapResp {
  window: { from: string; to: string }
  filters_applied: { user_email: string | null; department_id: number | null; contact_center: string | null }
  buckets: Bucket[]
  max_bucket: number
  totals: { calls: number; sms: number; combined: number }
  filter_options: FilterOptions
}

const auth = useAuthStore()

// ─── Filter state ─────────────────────────────────────────
type DatePreset = 'last_30' | 'last_60' | 'last_90' | 'this_month' | 'this_quarter' | 'this_year' | 'custom'
const datePreset = ref<DatePreset>('last_30')
const fromDate = ref('')
const toDate = ref('')
const fUser = ref('')
const fDept = ref<number | ''>('')
const fContactCenter = ref('')

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
applyPreset('last_30')
function onCustomDate() { datePreset.value = 'custom' }

const data = ref<HeatmapResp | null>(null)
const loading = ref(false)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const p = new URLSearchParams()
    if (fromDate.value) p.set('from', fromDate.value)
    if (toDate.value) p.set('to', toDate.value)
    if (fUser.value) p.set('user_email', fUser.value)
    if (fDept.value) p.set('department_id', String(fDept.value))
    if (fContactCenter.value) p.set('contact_center', fContactCenter.value)
    const res = await fetch(`/api/dialpad/heatmap?${p}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    if (!res.ok) { error.value = `HTTP ${res.status}`; return }
    data.value = await res.json() as HeatmapResp
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
watch([fromDate, toDate, fUser, fDept, fContactCenter], load)
onMounted(load)

// ─── ECharts heatmap option ───────────────────────────────
// Day labels are Sunday-first to match SQLite's strftime('%w') = 0
// for Sunday. Hour labels show every 3rd hour to keep mobile readable.
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const HOURS = Array.from({ length: 24 }, (_, i) => i)

function fmtHour(h: number): string {
  if (h === 0) return '12a'
  if (h === 12) return '12p'
  return h < 12 ? `${h}a` : `${h - 12}p`
}

const heatmapData = computed<Array<[number, number, number]>>(() => {
  if (!data.value) return []
  // ECharts heatmap expects [xIndex, yIndex, value]. x = hour, y = day.
  // We want Mon at top, Sat at bottom — flip Sunday to row 6 by mapping.
  // Convention used here: Mon=0, Tue=1, …, Sun=6 (visual order top→bottom).
  return data.value.buckets.map(b => {
    const visualDow = b.dow === 0 ? 6 : b.dow - 1
    return [b.hour, visualDow, b.total] as [number, number, number]
  })
})

const visualDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// Tooltip lookup — keyed by "dow:hour" for fast access during hover.
const bucketLookup = computed<Map<string, Bucket>>(() => {
  const m = new Map<string, Bucket>()
  if (!data.value) return m
  for (const b of data.value.buckets) m.set(`${b.dow}:${b.hour}`, b)
  return m
})

const chartOption = computed(() => {
  const max = Math.max(1, data.value?.max_bucket || 1)
  const lookup = bucketLookup.value
  return {
    grid: { top: 12, right: 16, bottom: 60, left: 38, containLabel: true },
    tooltip: {
      position: 'top',
      formatter: (p: { value: [number, number, number] }) => {
        const [hour, visualDow, total] = p.value
        const realDow = visualDow === 6 ? 0 : visualDow + 1
        const b = lookup.get(`${realDow}:${hour}`)
        const dayLabel = visualDays[visualDow]
        const hourLabel = fmtHour(hour) + '–' + fmtHour((hour + 1) % 24)
        const calls = b?.calls ?? 0
        const sms = b?.sms ?? 0
        return `
          <div class="text-xs">
            <div class="font-semibold mb-0.5">${dayLabel} · ${hourLabel}</div>
            <div>${total} inbound</div>
            <div class="text-[11px] opacity-80">${calls} calls · ${sms} texts</div>
          </div>
        `
      },
    },
    xAxis: {
      type: 'category',
      data: HOURS.map(fmtHour),
      splitArea: { show: false },
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: { fontSize: 9, color: '#64748b', interval: 2 },
    },
    yAxis: {
      type: 'category',
      data: visualDays,
      splitArea: { show: false },
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: { fontSize: 10, color: '#64748b' },
    },
    visualMap: {
      min: 0,
      max,
      calculable: false,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      itemWidth: 12,
      itemHeight: 8,
      textStyle: { fontSize: 10, color: '#64748b' },
      // Editorial calm palette: from the page bg tone up through sky
      // and into violet at the high end. No reds.
      inRange: {
        color: ['#f1f5f9', '#dbeafe', '#bae6fd', '#7dd3fc', '#38bdf8', '#0ea5e9', '#6366f1', '#7c3aed'],
      },
    },
    series: [
      {
        type: 'heatmap',
        data: heatmapData.value,
        label: { show: false },
        emphasis: {
          itemStyle: {
            shadowBlur: 8,
            shadowColor: 'rgba(15, 23, 42, 0.25)',
          },
        },
        progressive: 1000,
        animation: false,
        itemStyle: {
          borderRadius: 3,
          borderWidth: 2,
          borderColor: '#fff',
        },
      },
    ],
  }
})

// ─── Helpers ──────────────────────────────────────────────
function fmtNum(n: number): string { return (n || 0).toLocaleString() }
const peakCell = computed<{ day: string; hour: string; total: number } | null>(() => {
  if (!data.value || data.value.buckets.length === 0) return null
  let best: Bucket | null = null
  for (const b of data.value.buckets) {
    if (!best || b.total > best.total) best = b
  }
  if (!best) return null
  const visualDow = best.dow === 0 ? 6 : best.dow - 1
  return {
    day: visualDays[visualDow] || '',
    hour: `${fmtHour(best.hour)}–${fmtHour((best.hour + 1) % 24)}`,
    total: best.total,
  }
})
</script>

<template>
  <div class="grid gap-3 min-w-0">
    <!-- Filter strip -->
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

      <div class="flex items-center gap-1.5 flex-wrap min-w-0">
        <input v-model="fromDate" type="date"
          class="h-7 w-[125px] rounded border bg-card px-2 text-[11px] tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          @change="onCustomDate" />
        <span class="text-[11px] text-muted-foreground">—</span>
        <input v-model="toDate" type="date"
          class="h-7 w-[125px] rounded border bg-card px-2 text-[11px] tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          @change="onCustomDate" />
      </div>

      <div class="flex items-center gap-1.5 flex-wrap min-w-0">
        <select v-model="fUser"
          class="h-7 rounded border bg-card px-2 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-w-[180px] truncate"
          aria-label="Filter by user"
        >
          <option value="">All users</option>
          <option v-for="u in data?.filter_options.users || []" :key="u.email" :value="u.email">
            {{ u.name || u.email }}
          </option>
        </select>
        <select v-model="fDept"
          class="h-7 rounded border bg-card px-2 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-w-[180px]"
          aria-label="Filter by department"
        >
          <option value="">All departments</option>
          <option v-for="d in data?.filter_options.departments || []" :key="d.id" :value="d.id">
            {{ d.name }}
          </option>
        </select>
        <select v-model="fContactCenter"
          class="h-7 rounded border bg-card px-2 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-w-[180px]"
          aria-label="Filter by contact center"
        >
          <option value="">All entry points</option>
          <option v-for="c in data?.filter_options.contact_centers || []" :key="c.value" :value="c.value">
            {{ c.value }} ({{ c.count }})
          </option>
        </select>
        <button
          v-if="fUser || fDept || fContactCenter"
          class="text-[10px] text-muted-foreground hover:text-foreground"
          @click="fUser = ''; fDept = ''; fContactCenter = ''"
        >Clear</button>
      </div>
    </div>

    <div v-if="loading && !data" class="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">Loading heatmap…</div>
    <div v-else-if="error" class="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{{ error }}</div>

    <template v-else-if="data">
      <!-- Summary tiles — same canonical KPI shape -->
      <div class="grid grid-cols-3 gap-2 min-w-0">
        <div class="rounded-xl border bg-card p-3 min-w-0 relative overflow-hidden">
          <div class="absolute top-0 left-0 right-0 h-[3px] bg-sky-500" />
          <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Inbound calls</p>
          <p class="mt-1 flex items-baseline gap-1.5 min-w-0">
            <span class="text-2xl font-extrabold tabular-nums text-sky-600 leading-none">{{ fmtNum(data.totals.calls) }}</span>
          </p>
        </div>
        <div class="rounded-xl border bg-card p-3 min-w-0 relative overflow-hidden">
          <div class="absolute top-0 left-0 right-0 h-[3px] bg-violet-500" />
          <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Inbound texts</p>
          <p class="mt-1 flex items-baseline gap-1.5 min-w-0">
            <span class="text-2xl font-extrabold tabular-nums text-violet-600 leading-none">{{ fmtNum(data.totals.sms) }}</span>
          </p>
        </div>
        <div class="rounded-xl border bg-card p-3 min-w-0 relative overflow-hidden">
          <div class="absolute top-0 left-0 right-0 h-[3px] bg-emerald-500" />
          <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Peak hour</p>
          <p v-if="peakCell" class="mt-1 flex items-baseline gap-1.5 min-w-0">
            <span class="text-lg font-extrabold tabular-nums text-emerald-600 leading-none truncate">{{ peakCell.day }} {{ peakCell.hour }}</span>
            <span class="text-[11px] font-semibold tabular-nums text-muted-foreground truncate">/ {{ peakCell.total }} inbound</span>
          </p>
          <p v-else class="text-[11px] text-muted-foreground mt-1">No activity</p>
        </div>
      </div>

      <!-- Heatmap chart -->
      <div class="rounded-xl border bg-card min-w-0 overflow-hidden">
        <div class="px-3 pt-3 pb-1 flex items-center justify-between flex-wrap gap-1">
          <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Inbound volume · day × hour</p>
          <p class="text-[10px] text-muted-foreground">Hour buckets in UTC · max cell = {{ data.max_bucket }}</p>
        </div>
        <div class="px-0 sm:px-2 pb-2">
          <VChart :option="chartOption" autoresize style="height: 280px;" class="w-full" />
        </div>
      </div>
    </template>
  </div>
</template>
