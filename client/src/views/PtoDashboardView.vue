<script setup lang="ts">
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { getStatusConfig } from '@/lib/status'
import DataFreshness from '@/components/DataFreshness.vue'
import { fmtDate } from '@/lib/dates'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { BarChart, BoxplotChart, ScatterChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import VChart from 'vue-echarts'

use([CanvasRenderer, BarChart, BoxplotChart, ScatterChart, GridComponent, TooltipComponent, LegendComponent])

const auth = useAuthStore()

const loading = ref(true)
const kpi = ref<any>({})
const ptoSubmitted = ref<any[]>([])
const ptoApproved = ref<any[]>([])
const boxes = ref<any[]>([])
const boxesByInstall = ref<any[]>([])
const aging = ref<any[]>([])
const installed = ref<any[]>([])
const nemPivot = ref<any[]>([])
const fireList = ref<any[]>([])
const staleQueue = ref<any[]>([])
const filterOptions = ref<any>({ states: [], lenders: [], epcs: [], nemUsers: [] })

const fState = ref(''); const fLender = ref(''); const fEpc = ref('Kin Home'); const fNemUser = ref('')
const datePreset = ref('last_30'); const dateFrom = ref(''); const dateTo = ref('')
const boxMetric = ref<'inst' | 'sale'>('inst'); const useBizDays = ref(false)
const activeTab = ref<'charts' | 'fire' | 'stale' | 'nem' | 'blockers'>('charts')
const drillLabel = ref(''); const drillProjects = ref<any[]>([]); const drillLoading = ref(false)
const refreshing = ref(false)

async function refreshCaches() {
  refreshing.value = true
  try {
    await Promise.all([
      fetch('/api/projects/refresh', { method: 'POST', headers: hdrs() }),
      fetch('/api/pto/refresh', { method: 'POST', headers: hdrs() }),
    ])
    await loadData()
  } finally { refreshing.value = false }
}

// PTO cache data (blockers)
const ptoRecords = ref<any[]>([])
const ptoStats = ref<{ blocked: number; slaMissed: number; rejected: number; withOpenTickets: number }>({ blocked: 0, slaMissed: 0, rejected: 0, withOpenTickets: 0 })
const ptoLoading = ref(false)

async function loadPtoCache(filter?: string) {
  ptoLoading.value = true
  const p = new URLSearchParams({ limit: '100' })
  if (fState.value) p.set('state', fState.value)
  if (fLender.value) p.set('lender', fLender.value)
  if (fEpc.value) p.set('epc', fEpc.value)
  if (fNemUser.value) p.set('assigned_user', fNemUser.value)
  if (filter === 'blockers') p.set('has_blockers', '1')
  else if (filter === 'needs_sub') p.set('needs_sub', '1')
  else if (filter === 'stale') p.set('stale', '1')
  try {
    const res = await fetch(`/api/pto?${p}`, { headers: hdrs() })
    const d = await res.json()
    ptoRecords.value = d.items; ptoStats.value = d.stats
  } finally { ptoLoading.value = false }
}

function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }
function lt() { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}` }

const presets = [
  { key: 'last_30', label: '30d' }, { key: 'last_60', label: '60d' }, { key: 'last_90', label: '90d' },
  { key: 'this_month', label: 'Mo' }, { key: 'this_quarter', label: 'Qtr' }, { key: 'this_year', label: 'YTD' },
  { key: 'last_month', label: 'L.Mo' }, { key: 'last_quarter', label: 'L.Qtr' }, { key: 'last_year', label: 'L.Yr' },
  { key: 'all', label: 'All' },
]

function applyPreset(key: string) {
  datePreset.value = key; const t = new Date()
  const f = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const to = f(t)
  if (key === 'last_30') { const d = new Date(t); d.setDate(d.getDate() - 30); dateFrom.value = f(d); dateTo.value = to }
  else if (key === 'last_60') { const d = new Date(t); d.setDate(d.getDate() - 60); dateFrom.value = f(d); dateTo.value = to }
  else if (key === 'last_90') { const d = new Date(t); d.setDate(d.getDate() - 90); dateFrom.value = f(d); dateTo.value = to }
  else if (key === 'this_month') { dateFrom.value = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-01`; dateTo.value = to }
  else if (key === 'this_quarter') { dateFrom.value = `${t.getFullYear()}-${String(Math.floor(t.getMonth() / 3) * 3 + 1).padStart(2, '0')}-01`; dateTo.value = to }
  else if (key === 'this_year') { dateFrom.value = `${t.getFullYear()}-01-01`; dateTo.value = to }
  else if (key === 'last_month') { const d = new Date(t.getFullYear(), t.getMonth() - 1, 1); dateFrom.value = f(d); dateTo.value = f(new Date(t.getFullYear(), t.getMonth(), 0)) }
  else if (key === 'last_quarter') { const q = Math.floor(t.getMonth() / 3); const d = new Date(t.getFullYear(), (q - 1) * 3, 1); dateFrom.value = f(d); dateTo.value = f(new Date(t.getFullYear(), q * 3, 0)) }
  else if (key === 'last_year') { dateFrom.value = `${t.getFullYear() - 1}-01-01`; dateTo.value = `${t.getFullYear() - 1}-12-31` }
  else { dateFrom.value = ''; dateTo.value = '' }
  loadData()
}

async function loadData() {
  loading.value = true
  const p = new URLSearchParams({ today: lt() })
  if (fState.value) p.set('state', fState.value); if (fLender.value) p.set('lender', fLender.value)
  if (fEpc.value) p.set('epc', fEpc.value); if (fNemUser.value) p.set('nem_user', fNemUser.value)
  if (dateFrom.value) p.set('date_from', dateFrom.value); if (dateTo.value) p.set('date_to', dateTo.value)
  if (useBizDays.value) p.set('biz_days', '1')
  try {
    const res = await fetch(`/api/analytics/pto?${p}`, { headers: hdrs() }); const d = await res.json()
    kpi.value = d.kpi; ptoSubmitted.value = d.charts.ptoSubmitted; ptoApproved.value = d.charts.ptoApproved
    boxes.value = d.charts.timeToPtoBoxes
    boxesByInstall.value = d.charts.timeToPtoBoxesByInstall || []
    aging.value = d.charts.aging; installed.value = d.charts.installedByMonth
    nemPivot.value = d.pivot?.nemUser || []; fireList.value = d.lists?.fire || []; staleQueue.value = d.lists?.stale || []
    filterOptions.value = d.filters
  } finally { loading.value = false }
  reloadPtoCacheIfNeeded()
}

function sf(k: string, v: string) { const val = v === '__all__' ? '' : v; if (k === 'state') fState.value = val; else if (k === 'lender') fLender.value = val; else if (k === 'epc') fEpc.value = val; else if (k === 'nem_user') fNemUser.value = val; loadData() }

const hasActiveFilters = computed(() => fState.value || fLender.value || fNemUser.value || fEpc.value !== 'Kin Home' || datePreset.value !== 'last_30' || useBizDays.value)

function resetAll() { fState.value = ''; fLender.value = ''; fEpc.value = 'Kin Home'; fNemUser.value = ''; useBizDays.value = false; drillLabel.value = ''; drillProjects.value = []; activeTab.value = 'charts'; applyPreset('last_30') }

async function drill(label: string, pipeline: string) {
  drillLabel.value = label; drillLoading.value = true; drillProjects.value = []
  const p = new URLSearchParams({ limit: '200', today: lt() })
  if (fEpc.value) p.set('epc', fEpc.value); if (fState.value) p.set('state', fState.value); if (fLender.value) p.set('lender', fLender.value); p.set('pipeline', pipeline)
  try { drillProjects.value = (await (await fetch(`/api/projects?${p}`, { headers: hdrs() })).json()).projects } finally { drillLoading.value = false }
  await nextTick(); document.getElementById('drill-list')?.scrollIntoView({ behavior: 'smooth' })
}
function closeDrill() { drillLabel.value = ''; drillProjects.value = [] }
function openProject(rid: number) { window.open(`https://kin.quickbase.com/nav/app/br9kwm8bk/table/br9kwm8na/action/dr?rid=${rid}&rl=bzuz`, '_blank') }

const dayUnit = computed(() => useBizDays.value ? 'biz days' : 'days')
const lb = { show: true, fontSize: 9, position: 'top' as const }

function fp(p: string) {
  if (p.length === 10) return new Date(p + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  if (p.length === 7) { const [y, m] = p.split('-'); return new Date(parseInt(y!), parseInt(m!) - 1).toLocaleDateString('en-US', { month: 'short' }) + " '" + y!.slice(2) }
  return p
}

const subChart = computed(() => ({ tooltip: { trigger: 'axis' as const }, grid: { top: 20, bottom: 5, left: 5, right: 5, containLabel: true }, xAxis: { type: 'category' as const, data: ptoSubmitted.value.map((r: any) => fp(r.period)), axisLabel: { fontSize: 9, rotate: ptoSubmitted.value.length > 6 ? 45 : 0 } }, yAxis: { type: 'value' as const, axisLabel: { fontSize: 9 } }, series: [{ type: 'bar' as const, data: ptoSubmitted.value.map((r: any) => r.count), itemStyle: { color: '#3b82f6', borderRadius: [3, 3, 0, 0] }, label: lb }] }))
const apprChart = computed(() => ({ tooltip: { trigger: 'axis' as const }, grid: { top: 20, bottom: 5, left: 5, right: 5, containLabel: true }, xAxis: { type: 'category' as const, data: ptoApproved.value.map((r: any) => fp(r.period)), axisLabel: { fontSize: 9, rotate: ptoApproved.value.length > 6 ? 45 : 0 } }, yAxis: { type: 'value' as const, axisLabel: { fontSize: 9 } }, series: [{ type: 'bar' as const, data: ptoApproved.value.map((r: any) => r.count), itemStyle: { color: '#10b981', borderRadius: [3, 3, 0, 0] }, label: lb }] }))

const boxXAxisName = computed(() => boxMetric.value === 'inst' ? 'Install Completed Date' : 'Sale Date')
const boxYAxisName = computed(() => (boxMetric.value === 'inst' ? 'Install to PTO' : 'Sale to PTO') + ' (' + dayUnit.value + ')')

// Pick the right dataset for the metric: install-month buckets when looking at
// Inst→PTO (so "April installs" actually appear under April), sale-month
// buckets for Sale→PTO. Each bucketing has its own pctPto denominator (cohort
// size for that calendar month under that bucketing).
const boxSlice = computed(() => {
  const src = boxMetric.value === 'inst' ? boxesByInstall.value : boxes.value
  return src.slice(-13)
})
// Each row carries the month under either `install_month` or `sale_month`
// depending on which dataset it came from. Resolve here so chart + table
// share one accessor.
function boxMonth(r: any): string { return r.install_month || r.sale_month || '' }

const boxChart = computed(() => {
  const d = boxSlice.value; const m = boxMetric.value; const c = m === 'inst' ? '#3b82f6' : '#f59e0b'
  return {
    tooltip: { trigger: 'item' as const, formatter: (p: any) => {
      const idx = p.dataIndex; const row = d[idx]; const x = row?.[m]
      return `<b>${p.name}</b>${row ? ' — ' + row.pctPto + '% PTO (' + row.count + '/' + row.totalProjects + ')' : ''}<br/>` +
        `Mean: ${x?.mean ?? '?'} ${dayUnit.value}<br/>Min: ${p.value[0]}<br/>P25: ${p.value[1]}<br/>P50: ${p.value[2]}<br/>P90: ${p.value[3]}<br/>Max: ${p.value[4]}`
    }},
    grid: { top: 10, bottom: 5, left: 5, right: 5, containLabel: true },
    xAxis: { type: 'category' as const, data: d.map((r: any) => fp(boxMonth(r))), axisLabel: { fontSize: 9 } },
    yAxis: { type: 'value' as const, axisLabel: { fontSize: 9 } },
    series: [
      { type: 'boxplot' as const, data: d.map((r: any) => { const x = r[m]; return [x.p0, x.p25, x.p50, x.p90, x.p100] }), itemStyle: { color: c, borderColor: c } },
      { type: 'scatter' as const, data: d.map((r: any, i: number) => [i, r[m]?.mean ?? 0]), symbol: 'diamond', symbolSize: 8, itemStyle: { color: '#ef4444' }, tooltip: { show: false } },
    ],
  }
})

const agingChart = computed(() => ({ tooltip: { trigger: 'axis' as const }, grid: { top: 15, bottom: 5, left: 5, right: 5, containLabel: true }, xAxis: { type: 'category' as const, data: aging.value.map((b: any) => b.label), axisLabel: { fontSize: 9 } }, yAxis: { type: 'value' as const, axisLabel: { fontSize: 9 } }, series: [{ type: 'bar' as const, data: aging.value.map((b: any) => b.count), itemStyle: { color: '#ef4444', borderRadius: [3, 3, 0, 0] }, label: lb }] }))

const instChart = computed(() => {
  const d = [...installed.value].reverse().slice(0, 12).reverse()
  return { tooltip: { trigger: 'axis' as const, formatter: (p: any) => { const t = p.reduce((s: number, i: any) => s + i.value, 0); return `<b>${p[0].name}</b><br/>` + p.map((i: any) => `<span style="color:${i.color}">●</span> ${i.seriesName}: ${i.value} (${t ? Math.round(i.value / t * 100) : 0}%)`).join('<br/>') } },
    legend: { data: ['PTO Approved', 'PTO Sub', 'No Inspx'], top: 0, textStyle: { fontSize: 9 } }, grid: { top: 22, bottom: 5, left: 5, right: 5, containLabel: true },
    xAxis: { type: 'value' as const, axisLabel: { fontSize: 9 } }, yAxis: { type: 'category' as const, data: d.map((r: any) => fp(r.im || r.inst_month)), axisLabel: { fontSize: 9 } },
    series: [
      { name: 'PTO Approved', type: 'bar' as const, stack: 'a', data: d.map((r: any) => r.pto_appr ?? r.pto_approved), itemStyle: { color: '#10b981' } },
      { name: 'PTO Sub', type: 'bar' as const, stack: 'a', data: d.map((r: any) => r.pto_sub ?? r.pto_submitted), itemStyle: { color: '#3b82f6' } },
      { name: 'No Inspx', type: 'bar' as const, stack: 'a', data: d.map((r: any) => r.no_inspx), itemStyle: { color: '#fca5a5' } },
    ] }
})

watch(activeTab, (tab) => { if (tab === 'blockers') loadPtoCache('blockers') })

// Reload PTO cache when filters change and we're on a tab that uses it
function reloadPtoCacheIfNeeded() {
  if (activeTab.value === 'blockers') loadPtoCache('blockers')
  else loadPtoCache()
}

onMounted(() => { applyPreset('last_30'); loadPtoCache() })
</script>

<template>
  <div class="grid gap-2 sm:gap-3 max-w-full">
    <!-- Header -->
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2 min-w-0">
        <RouterLink to="/projects" class="text-muted-foreground hover:text-foreground"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg></RouterLink>
        <div class="flex flex-col gap-0.5 min-w-0">
          <h1 class="text-xl sm:text-2xl font-semibold tracking-tight">PTO</h1>
          <DataFreshness label="Cache" />
        </div>
      </div>
    </div>

    <!-- Filters -->
    <div class="flex gap-1.5 flex-wrap items-center">
      <Select :model-value="fEpc || '__all__'" @update:model-value="(v: string) => sf('epc', v)"><SelectTrigger class="h-7 w-auto text-[11px]"><SelectValue placeholder="EPC" /></SelectTrigger><SelectContent><SelectItem value="__all__">All EPCs</SelectItem><SelectItem v-for="e in filterOptions.epcs" :key="e" :value="e">{{ e }}</SelectItem></SelectContent></Select>
      <Select :model-value="fLender || '__all__'" @update:model-value="(v: string) => sf('lender', v)"><SelectTrigger class="h-7 w-auto text-[11px]"><SelectValue placeholder="Lender" /></SelectTrigger><SelectContent><SelectItem value="__all__">All</SelectItem><SelectItem v-for="l in filterOptions.lenders" :key="l" :value="l">{{ l }}</SelectItem></SelectContent></Select>
      <Select :model-value="fState || '__all__'" @update:model-value="(v: string) => sf('state', v)"><SelectTrigger class="h-7 w-auto text-[11px]"><SelectValue placeholder="State" /></SelectTrigger><SelectContent><SelectItem value="__all__">All</SelectItem><SelectItem v-for="s in filterOptions.states" :key="s" :value="s">{{ s }}</SelectItem></SelectContent></Select>
      <Select :model-value="fNemUser || '__all__'" @update:model-value="(v: string) => sf('nem_user', v)"><SelectTrigger class="h-7 w-auto text-[11px]"><SelectValue placeholder="User" /></SelectTrigger><SelectContent><SelectItem value="__all__">All Users</SelectItem><SelectItem v-for="n in filterOptions.nemUsers" :key="n" :value="n">{{ n }}</SelectItem></SelectContent></Select>
      <button v-if="hasActiveFilters" class="text-[11px] text-muted-foreground hover:text-foreground shrink-0" @click="resetAll">Reset</button>
    </div>

    <!-- Date + biz/cal -->
    <div class="flex gap-1 items-center overflow-x-auto no-scrollbar">
      <div class="flex gap-0.5 p-0.5 bg-muted rounded-lg shrink-0 mr-1">
        <button class="px-1.5 py-0.5 text-[9px] font-medium rounded" :class="!useBizDays ? 'bg-card shadow-sm' : 'text-muted-foreground'" @click="useBizDays = false; loadData()">Cal</button>
        <button class="px-1.5 py-0.5 text-[9px] font-medium rounded" :class="useBizDays ? 'bg-card shadow-sm' : 'text-muted-foreground'" @click="useBizDays = true; loadData()">Biz</button>
      </div>
      <button v-for="p in presets" :key="p.key" class="px-2 py-0.5 rounded-full text-[9px] font-semibold border whitespace-nowrap shrink-0" :class="datePreset === p.key ? 'bg-foreground text-background border-foreground' : 'bg-card border-border text-muted-foreground'" @click="applyPreset(p.key)">{{ p.label }}</button>
    </div>

    <!-- KPIs -->
    <div class="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1">
      <div v-for="c in [
        { l: '#PTO Sub', v: kpi.ptoSub?.count, s: (kpi.ptoSub?.kw||0).toLocaleString()+' kW', cl: 'text-blue-600', b: 'bg-blue-500' },
        { l: '#Approved', v: kpi.ptoApproved?.count, s: (kpi.ptoApproved?.kw||0).toLocaleString()+' kW', cl: 'text-emerald-600', b: 'bg-emerald-500' },
        { l: 'Inst→PTO', v: kpi.avgInstToPto, s: 'avg '+dayUnit, cl: 'text-foreground', b: 'bg-foreground' },
        { l: 'Since Inst', v: kpi.avgDaysSinceInst, s: 'avg '+dayUnit, cl: 'text-foreground', b: 'bg-foreground' },
      ]" :key="c.l" class="flex-none rounded-xl px-3 py-2 w-[105px] sm:w-[115px] bg-card">
        <div class="h-[3px] rounded-full -mt-0.5 mb-1" :class="c.b" />
        <p class="text-[9px] sm:text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">{{ c.l }}</p>
        <p class="text-lg sm:text-xl font-extrabold mt-0.5" :class="c.cl">{{ c.v ?? 0 }}</p>
        <p class="text-[10px] text-muted-foreground">{{ c.s }}</p>
      </div>
      <button class="flex-none rounded-xl px-3 py-2 w-[105px] sm:w-[115px] bg-card hover:shadow-md active:scale-[0.97] text-left" @click="drill('Need PTO','needPto')">
        <div class="h-[3px] rounded-full -mt-0.5 mb-1 bg-red-500" />
        <p class="text-[9px] sm:text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Need PTO</p>
        <p class="text-lg sm:text-xl font-extrabold mt-0.5 text-red-600">{{ kpi.needPto?.count ?? 0 }}</p>
        <p class="text-[10px] text-muted-foreground">{{ (kpi.needPto?.kw||0).toLocaleString() }} kW</p>
      </button>
      <button v-if="kpi.fireCount" class="flex-none rounded-xl px-3 py-2 w-[105px] sm:w-[115px] bg-red-50 hover:shadow-md active:scale-[0.97] text-left" @click="activeTab = 'fire'">
        <div class="h-[3px] rounded-full -mt-0.5 mb-1 bg-red-500" />
        <p class="text-[9px] sm:text-[10px] font-semibold uppercase tracking-wider text-red-600">SLA Miss</p>
        <p class="text-lg sm:text-xl font-extrabold mt-0.5 text-red-600">{{ kpi.fireCount }}</p>
      </button>
      <button v-if="kpi.staleCount" class="flex-none rounded-xl px-3 py-2 w-[105px] sm:w-[115px] bg-amber-50 hover:shadow-md active:scale-[0.97] text-left" @click="activeTab = 'stale'">
        <div class="h-[3px] rounded-full -mt-0.5 mb-1 bg-amber-400" />
        <p class="text-[9px] sm:text-[10px] font-semibold uppercase tracking-wider text-amber-600">Stale</p>
        <p class="text-lg sm:text-xl font-extrabold mt-0.5 text-amber-600">{{ kpi.staleCount }}</p>
      </button>
    </div>

    <!-- Tabs: Charts / Fire / Stale / NEM -->
    <div class="flex gap-0.5 p-0.5 bg-muted rounded-lg w-fit">
      <button v-for="tab in [{k:'charts',l:'Charts'},{k:'fire',l:'SLA (' + fireList.length + ')'},{k:'stale',l:'Stale (' + staleQueue.length + ')'},{k:'blockers',l:'Blockers (' + ptoStats.blocked + ')'},{k:'nem',l:'By User'}]" :key="tab.k" class="px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors" :class="activeTab === tab.k ? 'bg-card shadow-sm' : 'text-muted-foreground'" @click="activeTab = tab.k as any">{{ tab.l }}</button>
    </div>

    <div v-if="loading" class="space-y-3"><div v-for="i in 3" :key="i" class="rounded-xl bg-card h-40 animate-pulse" /></div>

    <!-- ═══ CHARTS TAB ═══ -->
    <template v-else-if="activeTab === 'charts'">
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div class="rounded-xl bg-card p-3"><h3 class="text-xs font-semibold mb-2">PTO Submitted</h3><VChart :option="subChart" style="height:180px" autoresize @click="(p:any) => drill('Sub: '+p.name,'needPto')" /></div>
        <div class="rounded-xl bg-card p-3"><h3 class="text-xs font-semibold mb-2">PTO Approved</h3><VChart :option="apprChart" style="height:180px" autoresize @click="(p:any) => drill('Appr: '+p.name,'needPto')" /></div>
      </div>
      <div class="rounded-xl bg-card p-3">
        <div class="flex items-start justify-between gap-2 mb-2">
          <div>
            <h3 class="text-xs font-semibold">Time to PTO</h3>
            <p class="text-[10px] text-muted-foreground">{{ boxYAxisName }} by {{ boxXAxisName }}</p>
          </div>
          <div class="flex gap-0.5 p-0.5 bg-muted rounded-lg shrink-0"><button class="px-2 py-0.5 text-[10px] font-medium rounded" :class="boxMetric==='inst'?'bg-card shadow-sm':'text-muted-foreground'" @click="boxMetric='inst'">Inst→PTO</button><button class="px-2 py-0.5 text-[10px] font-medium rounded" :class="boxMetric==='sale'?'bg-card shadow-sm':'text-muted-foreground'" @click="boxMetric='sale'">Sale→PTO</button></div>
        </div>
        <VChart :option="boxChart" style="height:220px" autoresize />
        <!-- Mean + %PTO table -->
        <div v-if="boxSlice.length" class="overflow-x-auto no-scrollbar mt-1">
          <table class="w-full text-[10px]" style="table-layout:fixed">
            <tbody>
              <tr>
                <td v-for="r in boxSlice" :key="boxMonth(r)" class="text-center text-red-600 font-bold py-0.5">{{ r[boxMetric]?.mean ?? '—' }}</td>
              </tr>
              <tr>
                <td v-for="r in boxSlice" :key="boxMonth(r)" class="text-center text-muted-foreground py-0.5">{{ r.pctPto }}%</td>
              </tr>
            </tbody>
          </table>
          <div class="flex gap-4 mt-1 text-[9px] text-muted-foreground">
            <span class="flex items-center gap-1"><span class="inline-block w-2 h-2 bg-red-500 rotate-45" /> Mean ({{ dayUnit }})</span>
            <span>% = PTO rate for {{ boxMetric === 'inst' ? 'install' : 'sale' }} month</span>
          </div>
        </div>
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div class="rounded-xl bg-card p-3">
          <h3 class="text-xs font-semibold mb-2">Inspex Passed, NO PTO</h3>
          <VChart :option="agingChart" style="height:150px" autoresize />
          <table class="w-full mt-2 text-[11px]" style="table-layout:fixed"><thead><tr class="text-muted-foreground"><th class="text-left font-semibold py-0.5">Bucket</th><th class="text-right font-semibold py-0.5">#</th><th class="text-right font-semibold py-0.5">#Sub</th><th class="text-right font-semibold py-0.5">kW</th></tr></thead><tbody>
            <tr v-for="b in aging" :key="b.label" class="border-t border-border/30 cursor-pointer hover:bg-muted/30" @click="drill(b.label,'needPto')"><td class="py-1 font-medium">{{ b.label }}</td><td class="py-1 text-right font-mono" :class="b.count?'text-red-600 font-bold':'text-muted-foreground'">{{ b.count }}</td><td class="py-1 text-right font-mono text-muted-foreground">{{ b.submitted }}</td><td class="py-1 text-right font-mono text-muted-foreground">{{ b.kw?.toLocaleString() }}</td></tr>
            <tr class="border-t-2 border-border font-bold"><td class="py-1 text-muted-foreground text-[9px] uppercase">Total</td><td class="py-1 text-right font-mono">{{ aging.reduce((s:number,b:any)=>s+b.count,0) }}</td><td class="py-1 text-right font-mono text-muted-foreground">{{ aging.reduce((s:number,b:any)=>s+b.submitted,0) }}</td><td class="py-1 text-right font-mono text-muted-foreground">{{ aging.reduce((s:number,b:any)=>s+b.kw,0).toLocaleString() }}</td></tr>
          </tbody></table>
        </div>
        <div class="rounded-xl bg-card p-3"><h3 class="text-xs font-semibold mb-2">Installed Accounts</h3><VChart :option="instChart" style="height:260px" autoresize /></div>
      </div>
    </template>

    <!-- ═══ FIRE LIST (SLA Miss) ═══ -->
    <template v-else-if="activeTab === 'fire'">
      <p class="text-xs text-muted-foreground">Inspection passed 1+ day ago, PTO not yet submitted. Sorted by urgency.</p>
      <div v-if="!fireList.length" class="rounded-xl bg-card p-8 text-center text-muted-foreground text-sm">No SLA misses. All caught up.</div>
      <div v-else class="space-y-1.5">
        <div v-for="p in fireList" :key="p.record_id" class="rounded-lg border-l-[3px] border-l-red-400 border border-border bg-card px-3 py-2 cursor-pointer hover:bg-muted/30" @click="openProject(p.record_id)">
          <div class="flex items-start justify-between gap-2"><p class="text-sm font-semibold truncate">{{ p.customer_name }}</p><Badge class="bg-red-100 text-red-700 text-[10px] shrink-0">{{ p.days }}d</Badge></div>
          <div class="flex gap-3 mt-1 text-[11px] text-muted-foreground"><span v-if="p.nem_user">{{ p.nem_user }}</span><span v-if="p.coordinator">{{ p.coordinator }}</span><span v-if="p.state">{{ p.state }}</span><span v-if="p.inspection_passed">Insp: {{ fmtDate(p.inspection_passed as string) }}</span></div>
        </div>
      </div>
    </template>

    <!-- ═══ STALE QUEUE ═══ -->
    <template v-else-if="activeTab === 'stale'">
      <p class="text-xs text-muted-foreground">PTO submitted 30+ days ago, still not approved. Follow up with utility.</p>
      <div v-if="!staleQueue.length" class="rounded-xl bg-card p-8 text-center text-muted-foreground text-sm">No stale submissions.</div>
      <div v-else class="space-y-1.5">
        <div v-for="p in staleQueue" :key="p.record_id" class="rounded-lg border-l-[3px] border-l-amber-400 border border-border bg-card px-3 py-2 cursor-pointer hover:bg-muted/30" @click="openProject(p.record_id)">
          <div class="flex items-start justify-between gap-2"><p class="text-sm font-semibold truncate">{{ p.customer_name }}</p><Badge class="bg-amber-100 text-amber-700 text-[10px] shrink-0">{{ p.days_since_sub }}d waiting</Badge></div>
          <div class="flex gap-3 mt-1 text-[11px] text-muted-foreground"><span v-if="p.nem_user">{{ p.nem_user }}</span><span v-if="p.coordinator">{{ p.coordinator }}</span><span v-if="p.state">{{ p.state }}</span><span>Sub: {{ fmtDate(p.pto_submitted as string) }}</span></div>
        </div>
      </div>
    </template>

    <!-- ═══ BLOCKERS ═══ -->
    <template v-else-if="activeTab === 'blockers'">
      <div class="flex gap-2 overflow-x-auto no-scrollbar">
        <div v-for="s in [
          { l: 'Blocked', v: ptoStats.blocked, cl: 'text-red-600', b: 'bg-red-500' },
          { l: 'SLA Missed', v: ptoStats.slaMissed, cl: 'text-amber-600', b: 'bg-amber-400' },
          { l: 'Rejected', v: ptoStats.rejected, cl: 'text-violet-600', b: 'bg-violet-500' },
          { l: 'Open Tix', v: ptoStats.withOpenTickets, cl: 'text-blue-600', b: 'bg-blue-500' },
        ]" :key="s.l" class="flex-none rounded-xl px-3 py-2 w-[105px] sm:w-[115px] bg-card">
          <div class="h-[3px] rounded-full -mt-0.5 mb-1" :class="s.b" />
          <p class="text-[9px] sm:text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{{ s.l }}</p>
          <p class="text-lg sm:text-xl font-extrabold mt-0.5" :class="s.cl">{{ s.v }}</p>
        </div>
      </div>
      <p class="text-xs text-muted-foreground">Projects with active PTO blockers. Tap to open in QuickBase.</p>
      <div v-if="ptoLoading" class="space-y-2"><div v-for="i in 5" :key="i" class="h-16 rounded bg-muted/50 animate-pulse" /></div>
      <div v-else-if="!ptoRecords.length" class="rounded-xl bg-card p-8 text-center text-muted-foreground text-sm">No blocked projects.</div>
      <div v-else class="space-y-1.5">
        <div v-for="r in ptoRecords" :key="r.record_id" class="rounded-lg border-l-[3px] border-l-red-400 border border-border bg-card px-3 py-2 cursor-pointer hover:bg-muted/30" @click="openProject(r.project_rid || r.record_id)">
          <div class="flex items-start justify-between gap-2">
            <p class="text-sm font-semibold truncate">{{ r.project_name }}</p>
            <Badge v-if="r.pto_status" class="bg-muted text-muted-foreground text-[10px] shrink-0">{{ r.pto_status }}</Badge>
          </div>
          <!-- Blockers -->
          <p v-if="r.blockers && r.blockers !== '[]'" class="text-xs text-red-600 font-medium mt-1 line-clamp-2">{{ r.blockers }}</p>
          <!-- To-Do -->
          <p v-if="r.pto_todo" class="text-[11px] text-muted-foreground mt-0.5">To-do: {{ r.pto_todo }}</p>
          <!-- Items missing -->
          <p v-if="r.items_missing" class="text-[11px] text-amber-600 mt-0.5 line-clamp-1">Missing: {{ r.items_missing }}</p>
          <!-- Meta -->
          <div class="flex gap-3 mt-1 text-[11px] text-muted-foreground flex-wrap">
            <span v-if="r.assigned_user">{{ r.assigned_user }}</span>
            <span v-if="r.state">{{ r.state }}</span>
            <span v-if="r.open_tickets > 0" class="text-blue-600 font-semibold">{{ r.open_tickets }} open ticket{{ r.open_tickets > 1 ? 's' : '' }}</span>
            <span v-if="r.rejection_count > 0" class="text-violet-600 font-semibold">{{ r.rejection_count }} rejection{{ r.rejection_count > 1 ? 's' : '' }}</span>
            <span v-if="r.sla_met === 0 && r.pto_submitted" class="text-amber-600 font-semibold">SLA missed</span>
          </div>
        </div>
      </div>
    </template>

    <!-- ═══ BY USER PIVOT ═══ -->
    <template v-else-if="activeTab === 'nem'">
      <p class="text-xs text-muted-foreground">PTO pipeline by assigned user. Tap a row to filter the dashboard.</p>
      <div v-if="!nemPivot.length" class="rounded-xl bg-card p-8 text-center text-muted-foreground text-sm">No NEM data.</div>
      <div v-else class="rounded-xl bg-card overflow-hidden">
        <table class="w-full text-[11px]" style="table-layout:fixed">
          <thead><tr class="text-muted-foreground bg-muted/30">
            <th class="text-left font-semibold p-2" style="width:30%">User</th>
            <th class="text-right font-semibold p-1.5">Need</th>
            <th class="text-right font-semibold p-1.5">Sub</th>
            <th class="text-right font-semibold p-1.5 text-red-500">SLA</th>
            <th class="text-right font-semibold p-1.5 text-amber-500">Stale</th>
            <th class="text-right font-semibold p-1.5 text-emerald-500">Appr</th>
          </tr></thead>
          <tbody>
            <tr v-for="r in nemPivot" :key="r.name" class="border-t border-border/30 cursor-pointer hover:bg-muted/30" @click="sf('nem_user', r.name)">
              <td class="p-2 font-medium truncate">{{ r.name }}</td>
              <td class="p-1.5 text-right font-mono" :class="r.need ? 'font-bold' : 'text-muted-foreground'">{{ r.need }}</td>
              <td class="p-1.5 text-right font-mono text-blue-600">{{ r.submitted }}</td>
              <td class="p-1.5 text-right font-mono" :class="r.sla_miss ? 'text-red-600 font-bold' : 'text-muted-foreground'">{{ r.sla_miss }}</td>
              <td class="p-1.5 text-right font-mono" :class="r.stale ? 'text-amber-600 font-bold' : 'text-muted-foreground'">{{ r.stale }}</td>
              <td class="p-1.5 text-right font-mono text-emerald-600">{{ r.approved }}</td>
            </tr>
            <tr class="border-t-2 border-border font-bold">
              <td class="p-2 text-muted-foreground text-[9px] uppercase">Total</td>
              <td class="p-1.5 text-right font-mono">{{ nemPivot.reduce((s:number,r:any)=>s+r.need,0) }}</td>
              <td class="p-1.5 text-right font-mono text-blue-600">{{ nemPivot.reduce((s:number,r:any)=>s+r.submitted,0) }}</td>
              <td class="p-1.5 text-right font-mono text-red-600">{{ nemPivot.reduce((s:number,r:any)=>s+r.sla_miss,0) }}</td>
              <td class="p-1.5 text-right font-mono text-amber-600">{{ nemPivot.reduce((s:number,r:any)=>s+r.stale,0) }}</td>
              <td class="p-1.5 text-right font-mono text-emerald-600">{{ nemPivot.reduce((s:number,r:any)=>s+r.approved,0) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- Drill -->
    <div v-if="drillLabel" id="drill-list" class="rounded-xl bg-card p-3">
      <div class="flex items-center justify-between mb-2"><h3 class="text-xs font-semibold">{{ drillLabel }} — {{ drillProjects.length }}</h3><button class="text-[11px] text-muted-foreground" @click="closeDrill">Close</button></div>
      <div v-if="drillLoading" class="space-y-2"><div v-for="i in 3" :key="i" class="h-10 rounded bg-muted/50 animate-pulse" /></div>
      <div v-else class="space-y-1">
        <div v-for="p in drillProjects" :key="(p as any).record_id" class="rounded-lg border-l-[3px] border border-border bg-background px-3 py-2 cursor-pointer hover:bg-muted/30" :class="getStatusConfig((p as any).status).border" @click="openProject((p as any).record_id)">
          <p class="text-sm font-semibold truncate">{{ (p as any).customer_name }}</p>
          <div class="flex gap-3 mt-0.5 text-[11px] text-muted-foreground"><span v-if="(p as any).coordinator">{{ (p as any).coordinator }}</span><span v-if="(p as any).inspection_passed">Insp: {{ fmtDate((p as any).inspection_passed) }}</span><span v-if="(p as any).pto_submitted">Sub: {{ fmtDate((p as any).pto_submitted) }}</span></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
.no-scrollbar::-webkit-scrollbar { display: none; }
</style>
