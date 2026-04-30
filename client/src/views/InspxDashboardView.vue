<script setup lang="ts">
// Inspection milestone dashboard — migrated to use the shared
// milestone primitives in @/components/milestone. Inspection-specific
// surfaces (charts, By-State table, Aging table) stay inline; the
// shell, filter bar, date preset bar, KPI strip, and drill list are
// the reusable building blocks.

import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { BarChart, BoxplotChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import VChart from 'vue-echarts'

import MilestoneShell from '@/components/milestone/MilestoneShell.vue'
import MilestoneFilterBar, { type FilterDef } from '@/components/milestone/MilestoneFilterBar.vue'
import MilestoneDatePresetBar from '@/components/milestone/MilestoneDatePresetBar.vue'
import MilestoneKpiStrip from '@/components/milestone/MilestoneKpiStrip.vue'
import MilestoneProjectsTable, { type ColumnDef } from '@/components/milestone/MilestoneProjectsTable.vue'
import ProjectDetailDialog from '@/components/milestone/ProjectDetailDialog.vue'
import MilestoneDecileTable, { type DecileRow } from '@/components/milestone/MilestoneDecileTable.vue'

use([CanvasRenderer, BarChart, BoxplotChart, GridComponent, TooltipComponent, LegendComponent])

const auth = useAuthStore()
const loading = ref(true)
const kpi = ref<any>({})
const passedByMonth = ref<any[]>([])
const instToInspxBoxes = ref<any[]>([])
const byState = ref<any[]>([])
const aging = ref<any[]>([])
const agingTotal = ref(0); const activeFails = ref(0)
const outcomesByMonth = ref<any[]>([])
const scheduledOnDay = ref<any[]>([])
const filterOptions = ref<{ states: string[]; lenders: string[]; epcs: string[]; ahjs: string[]; utilities: string[] }>({ states: [], lenders: [], epcs: [], ahjs: [], utilities: [] })

const fState = ref(''); const fLender = ref(''); const fEpc = ref('Kin Home')
const fAhj = ref(''); const fUtility = ref('')
const datePreset = ref('last_30'); const dateFrom = ref(''); const dateTo = ref('')
const useBizDays = ref(false)
const drillLabel = ref(''); const drillProjects = ref<any[]>([]); const drillLoading = ref(false)

function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }
function lt() { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}` }

async function loadData() {
  loading.value = true
  const p = new URLSearchParams({ today: lt() })
  if (fState.value)   p.set('state', fState.value)
  if (fLender.value)  p.set('lender', fLender.value)
  if (fEpc.value)     p.set('epc', fEpc.value)
  if (fAhj.value)     p.set('ahj', fAhj.value)
  if (fUtility.value) p.set('utility', fUtility.value)
  if (dateFrom.value) p.set('date_from', dateFrom.value)
  if (dateTo.value)   p.set('date_to', dateTo.value)
  if (useBizDays.value) p.set('biz_days', '1')
  try {
    const res = await fetch(`/api/analytics/inspx?${p}`, { headers: hdrs() })
    const d = await res.json()
    kpi.value = d.kpi
    passedByMonth.value = d.charts.passedByMonth
    instToInspxBoxes.value = d.charts.instToInspxBoxes
    byState.value = d.charts.byState
    aging.value = d.charts.aging
    agingTotal.value = d.charts.agingTotal
    activeFails.value = d.charts.activeFails
    outcomesByMonth.value = d.charts.outcomesByMonth
    scheduledOnDay.value = d.charts.scheduledOnDay
    filterOptions.value = d.filters
  } finally { loading.value = false }
}

// ── Filter bar binding ──
// Canonical milestone filter set: EPC, Lender, State, AHJ, Utility.
// Order is intentional and the same across milestones.
const filterDefs = computed<FilterDef[]>(() => [
  { key: 'epc',     placeholder: 'EPC',     allLabel: 'All EPCs', options: filterOptions.value.epcs      || [], value: fEpc.value,    defaultValue: 'Kin Home' },
  { key: 'lender',  placeholder: 'Lender',                        options: filterOptions.value.lenders   || [], value: fLender.value  },
  { key: 'state',   placeholder: 'State',                         options: filterOptions.value.states    || [], value: fState.value   },
  { key: 'ahj',     placeholder: 'AHJ',                           options: filterOptions.value.ahjs      || [], value: fAhj.value     },
  { key: 'utility', placeholder: 'Utility',                       options: filterOptions.value.utilities || [], value: fUtility.value },
])
function onFilter(key: string, value: string) {
  if (key === 'epc')          fEpc.value = value
  else if (key === 'lender')  fLender.value = value
  else if (key === 'state')   fState.value = value
  else if (key === 'ahj')     fAhj.value = value
  else if (key === 'utility') fUtility.value = value
  loadData()
}
function onReset() {
  fState.value = ''; fLender.value = ''; fEpc.value = 'Kin Home'
  fAhj.value = ''; fUtility.value = ''
  useBizDays.value = false
  drillLabel.value = ''; drillProjects.value = []
  // Reset preset to default range — DatePresetBar's @change wiring
  // will recompute dateFrom/dateTo and call loadData.
  datePreset.value = 'last_30'
  applyDatePreset('last_30', false)
}
const extraActive = computed(() => datePreset.value !== 'last_30' || useBizDays.value)

// ── Date preset binding ──
function applyDatePreset(preset: string, biz: boolean) {
  const t = new Date()
  const f = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
  const to = f(t)
  if (preset === 'last_30')      { const d = new Date(t); d.setDate(d.getDate()-30); dateFrom.value = f(d); dateTo.value = to }
  else if (preset === 'last_60') { const d = new Date(t); d.setDate(d.getDate()-60); dateFrom.value = f(d); dateTo.value = to }
  else if (preset === 'last_90') { const d = new Date(t); d.setDate(d.getDate()-90); dateFrom.value = f(d); dateTo.value = to }
  else if (preset === 'this_month')   { dateFrom.value = `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-01`; dateTo.value = to }
  else if (preset === 'this_quarter') { dateFrom.value = `${t.getFullYear()}-${String(Math.floor(t.getMonth()/3)*3+1).padStart(2,'0')}-01`; dateTo.value = to }
  else if (preset === 'this_year')    { dateFrom.value = `${t.getFullYear()}-01-01`; dateTo.value = to }
  else if (preset === 'last_month')   { const d = new Date(t.getFullYear(),t.getMonth()-1,1); dateFrom.value = f(d); dateTo.value = f(new Date(t.getFullYear(),t.getMonth(),0)) }
  else if (preset === 'last_quarter') { const q = Math.floor(t.getMonth()/3); const d = new Date(t.getFullYear(),(q-1)*3,1); dateFrom.value = f(d); dateTo.value = f(new Date(t.getFullYear(),q*3,0)) }
  else if (preset === 'last_year')    { dateFrom.value = `${t.getFullYear()-1}-01-01`; dateTo.value = `${t.getFullYear()-1}-12-31` }
  else { dateFrom.value = ''; dateTo.value = '' }
  useBizDays.value = biz
  loadData()
}
function onDateChange(payload: { preset: string; from: string; to: string; bizDays: boolean }) {
  // DatePresetBar already resolved the range — trust it instead of
  // recomputing. Mirror useBizDays + dateFrom/dateTo and refetch.
  datePreset.value = payload.preset
  dateFrom.value = payload.from
  dateTo.value = payload.to
  useBizDays.value = payload.bizDays
  loadData()
}

const dayUnit = computed(() => useBizDays.value ? 'biz days' : 'days')

// ── KPI tiles binding ──
// Per-page directive: only the NEED INSPX tile drills into the new
// projects table. SINCE INST is informational — no drill.
const kpiTiles = computed(() => [
  { key: 'scheduled', label: '#Scheduled', value: kpi.value.scheduled ?? 0,                         tone: 'info'    as const },
  { key: 'passed',    label: '#Passed',    value: kpi.value.passed ?? 0,    sub: `${kpi.value.pctPassed ?? 0}% pass`,    tone: 'success' as const },
  { key: 'first',     label: '1st Time',   value: kpi.value.firstTime ?? 0, sub: `${kpi.value.pctFirstTime ?? 0}% rate`, tone: 'teal'    as const },
  { key: 'median',    label: 'Median',     value: `${kpi.value.overallMedian ?? 0}d`, sub: 'inst→inspx',                  tone: 'neutral' as const },
  { key: 'sinceInst', label: 'Since Inst', value: `${kpi.value.avgDaysSinceInst ?? 0}d`, sub: `avg ${dayUnit.value}`,     tone: 'danger'  as const },
  { key: 'needInspx', label: 'Need INSPX', value: kpi.value.needInspx ?? 0,                         tone: 'danger'  as const, drill: true, bg: 'danger-soft' as const },
])
function onKpiDrill(key: string) {
  if (key === 'needInspx') drill('Need INSPX', 'needInspx')
}

// ── Drill (skinny projects table + lite project dialog) ──
//
// Inspection-specific column lineup. Customer first (sticky-left
// on desktop), then the dates that matter for the inspection
// milestone, ending with the actor (coordinator).
const drillColumns: ColumnDef[] = [
  { key: 'customer_name',          label: 'Customer' },
  { key: 'state',                  label: 'State',     width: '60px' },
  { key: 'install_completed',      label: 'Inst Done', align: 'right' },
  { key: 'inspection_scheduled',   label: 'Sched',     align: 'right' },
  { key: 'inspection_passed',      label: 'Passed',    align: 'right' },
  { key: 'coordinator',            label: 'PC' },
]
const selectedProject = ref<Record<string, unknown> | null>(null)

async function drill(label: string, pipeline: string) {
  drillLabel.value = label; drillLoading.value = true; drillProjects.value = []
  const p = new URLSearchParams({ limit: '200', today: lt() })
  if (fEpc.value)    p.set('epc', fEpc.value)
  if (fState.value)  p.set('state', fState.value)
  if (fLender.value) p.set('lender', fLender.value)
  if (fAhj.value)    p.set('ahj', fAhj.value)
  if (fUtility.value) p.set('utility', fUtility.value)
  p.set('pipeline', pipeline)
  try {
    drillProjects.value = (await (await fetch(`/api/projects?${p}`, { headers: hdrs() })).json()).projects
  } finally { drillLoading.value = false }
  await nextTick()
  document.getElementById('milestone-projects-table')?.scrollIntoView({ behavior: 'smooth' })
}
function closeDrill() { drillLabel.value = ''; drillProjects.value = [] }

// Chart bar clicks — drill the *exact* cohort that contributes to the
// bar. ECharts gives us dataIndex; we look up the raw `period` from
// the underlying series array (server returns "YYYY-MM" or
// "YYYY-MM-DD" depending on smart-grouping). The drill endpoint
// expands period into a date range + applies the dashboard filters.
async function drillBucket(metric: 'passed' | 'scheduled_for' | 'booking', period: string, label: string) {
  drillLabel.value = label
  drillLoading.value = true
  drillProjects.value = []
  const p = new URLSearchParams({ metric, period, limit: '500' })
  if (fEpc.value)     p.set('epc', fEpc.value)
  if (fLender.value)  p.set('lender', fLender.value)
  if (fState.value)   p.set('state', fState.value)
  if (fAhj.value)     p.set('ahj', fAhj.value)
  if (fUtility.value) p.set('utility', fUtility.value)
  try {
    const res = await fetch(`/api/analytics/inspx/drill?${p}`, { headers: hdrs() })
    if (!res.ok) return
    const d = await res.json() as { projects: Array<Record<string, unknown>> }
    drillProjects.value = d.projects || []
  } finally { drillLoading.value = false }
  await nextTick()
  document.getElementById('milestone-projects-table')?.scrollIntoView({ behavior: 'smooth' })
}
function onPassedBarClick(p: { dataIndex: number; name: string }) {
  const row = passedByMonth.value[p.dataIndex] as { period?: string; month?: string } | undefined
  const period = row?.period || row?.month
  if (!period) return
  drillBucket('passed', period, `#Passed · ${p.name}`)
}
function onSchedBarClick(p: { dataIndex: number; name: string }) {
  const row = scheduledOnDay.value[p.dataIndex] as { period?: string; day?: string } | undefined
  const period = row?.period || row?.day
  if (!period) return
  drillBucket('booking', period, `Booked · ${p.name}`)
}

// ── Charts ──
const lb = { show: true, fontSize: 9, position: 'top' as const }
function fp(p: string) { if (p.length === 10) return new Date(p+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}); if (p.length === 7) { const [y,m] = p.split('-'); return new Date(parseInt(y!),parseInt(m!)-1).toLocaleDateString('en-US',{month:'short'})+" '"+y!.slice(2) }; return p }

const passedChart = computed(() => ({ tooltip: { trigger: 'axis' as const }, grid: { top: 20, bottom: 5, left: 5, right: 5, containLabel: true }, xAxis: { type: 'category' as const, data: passedByMonth.value.map((r: any) => fp(r.period || r.month)), axisLabel: { fontSize: 9, rotate: passedByMonth.value.length > 6 ? 45 : 0 } }, yAxis: { type: 'value' as const, axisLabel: { fontSize: 9 } }, series: [{ type: 'bar' as const, data: passedByMonth.value.map((r: any) => r.count), itemStyle: { color: '#10b981', borderRadius: [3,3,0,0] }, label: lb }] }))

const boxChart = computed(() => {
  const d = instToInspxBoxes.value.slice(-13)
  return { tooltip: { trigger: 'item' as const, formatter: (p: any) => `<b>${p.name}</b><br/>Min: ${p.value[0]} ${dayUnit.value}<br/>P25: ${p.value[1]}<br/>Median: ${p.value[2]}<br/>P90: ${p.value[3]}<br/>Max: ${p.value[4]}` },
    grid: { top: 10, bottom: 5, left: 5, right: 5, containLabel: true },
    xAxis: { type: 'category' as const, data: d.map((r: any) => fp(r.month)), axisLabel: { fontSize: 9 } },
    yAxis: { type: 'value' as const, name: dayUnit.value, nameTextStyle: { fontSize: 9 }, axisLabel: { fontSize: 9 } },
    series: [{ type: 'boxplot' as const, data: d.map((r: any) => [r.p0, r.p25, r.p50, r.p90, r.p100]), itemStyle: { color: '#3b82f6', borderColor: '#3b82f6' } }] }
})

const agingChart = computed(() => ({ tooltip: { trigger: 'axis' as const }, grid: { top: 15, bottom: 5, left: 5, right: 5, containLabel: true }, xAxis: { type: 'category' as const, data: aging.value.map((b: any) => b.label), axisLabel: { fontSize: 9 } }, yAxis: { type: 'value' as const, axisLabel: { fontSize: 9 } }, series: [{ type: 'bar' as const, data: aging.value.map((b: any) => b.count), itemStyle: { color: '#ef4444', borderRadius: [3,3,0,0] }, label: lb }] }))

const outcomesChart = computed(() => {
  const d = [...outcomesByMonth.value].reverse().slice(0, 12).reverse()
  return { tooltip: { trigger: 'axis' as const, formatter: (p: any) => { const t = p.reduce((s: number, i: any) => s + i.value, 0); return `<b>${p[0].name}</b><br/>`+p.map((i: any) => `<span style="color:${i.color}">●</span> ${i.seriesName}: ${i.value} (${t?Math.round(i.value/t*100):0}%)`).join('<br/>') } },
    legend: { data: ['Pass','Fail-Pass','Sched','Fail','N/A'], top: 0, textStyle: { fontSize: 9 } }, grid: { top: 22, bottom: 5, left: 5, right: 5, containLabel: true },
    xAxis: { type: 'value' as const, axisLabel: { fontSize: 9 } }, yAxis: { type: 'category' as const, data: d.map((r: any) => fp(r.month)), axisLabel: { fontSize: 9 } },
    series: [
      { name: 'Pass',      type: 'bar' as const, stack: 'a', data: d.map((r: any) => r.pass_first), itemStyle: { color: '#10b981' } },
      { name: 'Fail-Pass', type: 'bar' as const, stack: 'a', data: d.map((r: any) => r.fail_pass),  itemStyle: { color: '#f9a8d4' } },
      { name: 'Sched',     type: 'bar' as const, stack: 'a', data: d.map((r: any) => r.scheduled),  itemStyle: { color: '#3b82f6' } },
      { name: 'Fail',      type: 'bar' as const, stack: 'a', data: d.map((r: any) => r.fail),       itemStyle: { color: '#ef4444' } },
      { name: 'N/A',       type: 'bar' as const, stack: 'a', data: d.map((r: any) => r.na),         itemStyle: { color: '#d1d5db' } },
    ] }
})

// Booking-date chart — server now buckets weekly when range ≤ 90d,
// monthly otherwise (same logic as #Passed). r.period carries the
// bucket key; fp() formats month / day labels appropriately.
const schedChart = computed(() => ({
  tooltip: { trigger: 'axis' as const },
  grid: { top: 20, bottom: 5, left: 5, right: 5, containLabel: true },
  xAxis: {
    type: 'category' as const,
    data: scheduledOnDay.value.map((r: any) => fp(r.period || r.day)),
    axisLabel: { fontSize: 9, rotate: scheduledOnDay.value.length > 6 ? 45 : 0 },
  },
  yAxis: { type: 'value' as const, axisLabel: { fontSize: 9 } },
  series: [{
    type: 'bar' as const,
    data: scheduledOnDay.value.map((r: any) => r.count),
    itemStyle: { color: '#8b5cf6', borderRadius: [3, 3, 0, 0] },
    label: lb,
  }],
}))

// Slice mirrors the box plot's last 13 months so the mean / % rows
// underneath line up directly with the box columns.
const boxSlice = computed(() => instToInspxBoxes.value.slice(-13))

// ── Decile table ──
// Two metrics, configurable dimension + cal/biz pass-through.
const decileMetrics = [
  { key: 'install_to_pass',        label: 'Install → Inspection Passed' },
  { key: 'install_to_first_sched', label: 'Install → First Inspection Scheduled' },
]
const decileDimensions = [
  { key: 'state',   label: 'State' },
  { key: 'lender',  label: 'Lender' },
  { key: 'epc',     label: 'EPC' },
  { key: 'ahj',     label: 'AHJ' },
  { key: 'utility', label: 'Utility' },
]
const decileMetric    = ref('install_to_pass')
const decileDimension = ref<'state' | 'lender' | 'epc' | 'ahj' | 'utility'>('state')
const decileRows      = ref<DecileRow[]>([])
const decileTotal     = ref<DecileRow | null>(null)
const decileLoading   = ref(false)

async function loadDeciles() {
  decileLoading.value = true
  try {
    const p = new URLSearchParams({ today: lt() })
    p.set('metric', decileMetric.value)
    p.set('dimension', decileDimension.value)
    if (dateFrom.value) p.set('from', dateFrom.value)
    if (dateTo.value)   p.set('to', dateTo.value)
    if (useBizDays.value) p.set('biz_days', '1')
    const res = await fetch(`/api/analytics/inspx/deciles?${p}`, { headers: hdrs() })
    if (!res.ok) return
    const d = await res.json() as { rows: DecileRow[]; total: DecileRow }
    decileRows.value = d.rows || []
    decileTotal.value = d.total || null
  } finally { decileLoading.value = false }
}

// Re-fetch deciles whenever any of the dimensions that affect them
// change. Filters affect headline analytics only — deciles operate on
// the global pool — so we deliberately don't watch state/lender/etc.
watch([decileMetric, decileDimension, dateFrom, dateTo, useBizDays], loadDeciles)

onMounted(() => { applyDatePreset('last_30', false); loadDeciles() })
</script>

<template>
  <MilestoneShell title="Inspection">
    <template #filters>
      <MilestoneFilterBar
        :filters="filterDefs"
        :extra-active="extraActive"
        @update="onFilter"
        @reset="onReset"
      />
    </template>

    <template #dates>
      <MilestoneDatePresetBar
        :preset="datePreset"
        :biz-days="useBizDays"
        @update:preset="(k: string) => (datePreset = k)"
        @update:biz-days="(v: boolean) => (useBizDays = v)"
        @change="onDateChange"
      />
    </template>

    <template #kpis>
      <MilestoneKpiStrip :tiles="kpiTiles" @drill="onKpiDrill" />
    </template>

    <template #charts>
      <div v-if="loading" class="space-y-3">
        <div v-for="i in 3" :key="i" class="rounded-xl bg-card h-40 animate-pulse" />
      </div>

      <template v-else>
        <!-- Row 1: #Passed + Scheduled on a Day. Bars are clickable —
             tap a bucket to drill its projects into the table below. -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div class="rounded-xl bg-card p-3">
            <h3 class="text-xs font-semibold mb-2">#Passed by Month</h3>
            <VChart :option="passedChart" style="height:180px" autoresize @click="onPassedBarClick" />
          </div>
          <div class="rounded-xl bg-card p-3">
            <h3 class="text-xs font-semibold mb-2">Inspections Scheduled (by booking date)</h3>
            <VChart :option="schedChart" style="height:180px" autoresize @click="onSchedBarClick" />
          </div>
        </div>

        <!-- Row 2: Install→Inspx box plot + mean / % passed rows -->
        <div class="rounded-xl bg-card p-3">
          <div class="flex items-start justify-between gap-2 mb-2">
            <div>
              <h3 class="text-xs font-semibold">Install → Inspection ({{ dayUnit }})</h3>
              <p class="text-[10px] text-muted-foreground">Median: {{ kpi.overallMedian }}{{ useBizDays ? 'b' : 'd' }} · matched on install month</p>
            </div>
          </div>
          <VChart :option="boxChart" style="height:220px" autoresize />
          <!-- Mean ({{ dayUnit }}) + % installs passed inspection per
               month — matches PTO box plot's footer table. -->
          <div v-if="boxSlice.length" class="overflow-x-auto no-scrollbar mt-1">
            <table class="w-full text-[10px]" style="table-layout:fixed">
              <tbody>
                <tr>
                  <td v-for="r in boxSlice" :key="'mean-' + r.month" class="text-center text-red-600 font-bold py-0.5">{{ r.mean ?? '—' }}</td>
                </tr>
                <tr>
                  <td v-for="r in boxSlice" :key="'pct-' + r.month" class="text-center text-muted-foreground py-0.5">{{ r.pctPassed }}%</td>
                </tr>
              </tbody>
            </table>
            <div class="flex gap-4 mt-1 text-[9px] text-muted-foreground">
              <span class="flex items-center gap-1"><span class="inline-block w-2 h-2 bg-red-500 rotate-45" /> Mean ({{ dayUnit }})</span>
              <span>% = installs passed inspection that month</span>
            </div>
          </div>
        </div>

        <!-- Row 3: State table + Aging -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div class="rounded-xl bg-card p-3">
            <h3 class="text-xs font-semibold mb-2">By State</h3>
            <table class="w-full text-[11px]" style="table-layout:fixed">
              <thead>
                <tr class="text-muted-foreground">
                  <th class="text-left font-semibold py-1" style="width:25%">State</th>
                  <th class="text-right font-semibold py-1">#Sch</th>
                  <th class="text-right font-semibold py-1">#Pass</th>
                  <th class="text-right font-semibold py-1">#1st</th>
                  <th class="text-right font-semibold py-1">%1st</th>
                  <th class="text-right font-semibold py-1">Days</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in byState" :key="r.state" class="border-t border-border/30">
                  <td class="py-1 font-medium truncate">{{ r.state }}</td>
                  <td class="py-1 text-right font-mono">{{ r.sched }}</td>
                  <td class="py-1 text-right font-mono text-emerald-600">{{ r.passed }}</td>
                  <td class="py-1 text-right font-mono text-teal-600">{{ r.first_time }}</td>
                  <td class="py-1 text-right font-mono">{{ r.passed ? Math.round(r.first_time/r.passed*100) : 0 }}%</td>
                  <td class="py-1 text-right font-mono text-muted-foreground">{{ Math.round(r.avg_days || 0) }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="rounded-xl bg-card p-3">
            <h3 class="text-xs font-semibold mb-2">Need Inspection — Aging</h3>
            <VChart :option="agingChart" style="height:150px" autoresize />
            <table class="w-full mt-2 text-[11px]" style="table-layout:fixed">
              <thead>
                <tr class="text-muted-foreground">
                  <th class="text-left font-semibold py-0.5">Bucket</th>
                  <th class="text-right font-semibold py-0.5">#</th>
                  <th class="text-right font-semibold py-0.5 text-blue-500">Sched</th>
                  <th class="text-right font-semibold py-0.5">%</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="b in aging"
                  :key="b.label"
                  class="border-t border-border/30 cursor-pointer hover:bg-muted/30"
                  @click="drill(b.label,'needInspx')"
                >
                  <td class="py-1 font-medium">{{ b.label }}</td>
                  <td class="py-1 text-right font-mono" :class="b.count ? 'text-red-600 font-bold' : 'text-muted-foreground'">{{ b.count }}</td>
                  <td class="py-1 text-right font-mono text-blue-600">{{ b.scheduled }}</td>
                  <td class="py-1 text-right font-mono text-muted-foreground">{{ agingTotal ? Math.round(b.count/agingTotal*100) : 0 }}%</td>
                </tr>
                <tr class="border-t-2 border-border font-bold">
                  <td class="py-1 text-[9px] text-muted-foreground uppercase">Total</td>
                  <td class="py-1 text-right font-mono">{{ agingTotal }}</td>
                  <td class="py-1 text-right font-mono text-blue-600">{{ aging.reduce((s: number, b: any) => s + (b.scheduled || 0), 0) }}</td>
                  <td class="py-1 text-right font-mono">100%</td>
                </tr>
              </tbody>
            </table>
            <div class="flex items-center gap-2 mt-2 text-xs">
              <span class="text-muted-foreground">Active Fails:</span>
              <span class="font-bold text-red-600">{{ activeFails }}</span>
            </div>
          </div>
        </div>

        <!-- Row 4: Outcomes by install month -->
        <div class="rounded-xl bg-card p-3">
          <h3 class="text-xs font-semibold mb-2">Inspection Outcomes by Install Month</h3>
          <VChart :option="outcomesChart" style="height:280px" autoresize />
        </div>

        <!-- Row 5: Decile table — selectable KPI metric × dimension. -->
        <MilestoneDecileTable
          title="Inspection deciles"
          :metric="decileMetric"
          :metrics="decileMetrics"
          :dimension="decileDimension"
          :dimensions="decileDimensions"
          :day-unit="useBizDays ? 'biz' : 'cal'"
          :rows="decileRows"
          :total="decileTotal"
          :loading="decileLoading"
          @update:metric="(k: string) => (decileMetric = k)"
          @update:dimension="(k: string) => (decileDimension = k as typeof decileDimension)"
        />
      </template>
    </template>

    <template #drill>
      <MilestoneProjectsTable
        v-if="drillLabel"
        :title="drillLabel"
        :columns="drillColumns"
        :projects="drillProjects"
        :loading="drillLoading"
        @select="(p) => (selectedProject = p)"
        @close="closeDrill"
      />
    </template>
  </MilestoneShell>

  <!-- Lite project view — slides in from the right. Closing returns to
       the drill table so the user keeps their place. "Open full view"
       on the dialog navigates to /projects/<rid>. -->
  <ProjectDetailDialog
    :project="selectedProject"
    @update:open="(v) => { if (!v) selectedProject = null }"
  />
</template>
