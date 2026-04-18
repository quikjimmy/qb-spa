<script setup lang="ts">
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { getStatusConfig } from '@/lib/status'
import { fmtDate } from '@/lib/dates'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { BarChart, BoxplotChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import VChart from 'vue-echarts'

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
const filterOptions = ref<any>({ states: [], lenders: [], epcs: [] })

const fState = ref(''); const fLender = ref(''); const fEpc = ref('Kin Home')
const datePreset = ref('last_30'); const dateFrom = ref(''); const dateTo = ref('')
const useBizDays = ref(false)
const drillLabel = ref(''); const drillProjects = ref<any[]>([]); const drillLoading = ref(false)
const refreshing = ref(false)

async function refreshCaches() {
  refreshing.value = true
  try {
    await Promise.all([
      fetch('/api/projects/refresh', { method: 'POST', headers: hdrs() }),
      fetch('/api/analytics/inspx/refresh', { method: 'POST', headers: hdrs() }),
      fetch('/api/analytics/inspx/refresh-arrivy', { method: 'POST', headers: hdrs() }),
    ])
    await loadData()
  } finally { refreshing.value = false }
}

function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }
function lt() { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}` }

const presets = [
  { key: 'last_30', label: '30d' }, { key: 'last_60', label: '60d' }, { key: 'last_90', label: '90d' },
  { key: 'this_month', label: 'Mo' }, { key: 'this_quarter', label: 'Qtr' }, { key: 'this_year', label: 'YTD' },
  { key: 'last_month', label: 'L.Mo' }, { key: 'last_quarter', label: 'L.Qtr' }, { key: 'last_year', label: 'L.Yr' },
  { key: 'all', label: 'All' },
]

function applyPreset(key: string) {
  datePreset.value = key; const t = new Date()
  const f = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
  const to = f(t)
  if (key === 'last_30') { const d = new Date(t); d.setDate(d.getDate()-30); dateFrom.value = f(d); dateTo.value = to }
  else if (key === 'last_60') { const d = new Date(t); d.setDate(d.getDate()-60); dateFrom.value = f(d); dateTo.value = to }
  else if (key === 'last_90') { const d = new Date(t); d.setDate(d.getDate()-90); dateFrom.value = f(d); dateTo.value = to }
  else if (key === 'this_month') { dateFrom.value = `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-01`; dateTo.value = to }
  else if (key === 'this_quarter') { dateFrom.value = `${t.getFullYear()}-${String(Math.floor(t.getMonth()/3)*3+1).padStart(2,'0')}-01`; dateTo.value = to }
  else if (key === 'this_year') { dateFrom.value = `${t.getFullYear()}-01-01`; dateTo.value = to }
  else if (key === 'last_month') { const d = new Date(t.getFullYear(),t.getMonth()-1,1); dateFrom.value = f(d); dateTo.value = f(new Date(t.getFullYear(),t.getMonth(),0)) }
  else if (key === 'last_quarter') { const q = Math.floor(t.getMonth()/3); const d = new Date(t.getFullYear(),(q-1)*3,1); dateFrom.value = f(d); dateTo.value = f(new Date(t.getFullYear(),q*3,0)) }
  else if (key === 'last_year') { dateFrom.value = `${t.getFullYear()-1}-01-01`; dateTo.value = `${t.getFullYear()-1}-12-31` }
  else { dateFrom.value = ''; dateTo.value = '' }
  loadData()
}

async function loadData() {
  loading.value = true
  const p = new URLSearchParams({ today: lt() })
  if (fState.value) p.set('state', fState.value); if (fLender.value) p.set('lender', fLender.value); if (fEpc.value) p.set('epc', fEpc.value)
  if (dateFrom.value) p.set('date_from', dateFrom.value); if (dateTo.value) p.set('date_to', dateTo.value)
  if (useBizDays.value) p.set('biz_days', '1')
  try {
    const res = await fetch(`/api/analytics/inspx?${p}`, { headers: hdrs() }); const d = await res.json()
    kpi.value = d.kpi; passedByMonth.value = d.charts.passedByMonth; instToInspxBoxes.value = d.charts.instToInspxBoxes
    byState.value = d.charts.byState; aging.value = d.charts.aging; agingTotal.value = d.charts.agingTotal
    activeFails.value = d.charts.activeFails; outcomesByMonth.value = d.charts.outcomesByMonth
    scheduledOnDay.value = d.charts.scheduledOnDay; filterOptions.value = d.filters
  } finally { loading.value = false }
}

function sf(k: string, v: string) { const val = v === '__all__' ? '' : v; if (k === 'state') fState.value = val; else if (k === 'lender') fLender.value = val; else if (k === 'epc') fEpc.value = val; loadData() }

const hasActiveFilters = computed(() => fState.value || fLender.value || fEpc.value !== 'Kin Home' || datePreset.value !== 'last_30' || useBizDays.value)
function resetAll() { fState.value = ''; fLender.value = ''; fEpc.value = 'Kin Home'; useBizDays.value = false; drillLabel.value = ''; drillProjects.value = []; applyPreset('last_30') }
const dayUnit = computed(() => useBizDays.value ? 'biz days' : 'days')

async function drill(label: string, pipeline: string) {
  drillLabel.value = label; drillLoading.value = true; drillProjects.value = []
  const p = new URLSearchParams({ limit: '200', today: lt() })
  if (fEpc.value) p.set('epc', fEpc.value); if (fState.value) p.set('state', fState.value); if (fLender.value) p.set('lender', fLender.value); p.set('pipeline', pipeline)
  try { drillProjects.value = (await (await fetch(`/api/projects?${p}`, { headers: hdrs() })).json()).projects } finally { drillLoading.value = false }
  await nextTick(); document.getElementById('drill-list')?.scrollIntoView({ behavior: 'smooth' })
}
function closeDrill() { drillLabel.value = ''; drillProjects.value = [] }
function openProject(rid: number) { window.open(`https://kin.quickbase.com/nav/app/br9kwm8bk/table/br9kwm8na/action/dr?rid=${rid}&rl=bzuz`, '_blank') }

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
      { name: 'Pass', type: 'bar' as const, stack: 'a', data: d.map((r: any) => r.pass_first), itemStyle: { color: '#10b981' } },
      { name: 'Fail-Pass', type: 'bar' as const, stack: 'a', data: d.map((r: any) => r.fail_pass), itemStyle: { color: '#f9a8d4' } },
      { name: 'Sched', type: 'bar' as const, stack: 'a', data: d.map((r: any) => r.scheduled), itemStyle: { color: '#3b82f6' } },
      { name: 'Fail', type: 'bar' as const, stack: 'a', data: d.map((r: any) => r.fail), itemStyle: { color: '#ef4444' } },
      { name: 'N/A', type: 'bar' as const, stack: 'a', data: d.map((r: any) => r.na), itemStyle: { color: '#d1d5db' } },
    ] }
})

const schedChart = computed(() => ({ tooltip: { trigger: 'axis' as const }, grid: { top: 20, bottom: 5, left: 5, right: 5, containLabel: true }, xAxis: { type: 'category' as const, data: scheduledOnDay.value.map((r: any) => fp(r.day)), axisLabel: { fontSize: 9, rotate: 45 } }, yAxis: { type: 'value' as const, axisLabel: { fontSize: 9 } }, series: [{ type: 'bar' as const, data: scheduledOnDay.value.map((r: any) => r.count), itemStyle: { color: '#8b5cf6', borderRadius: [3,3,0,0] }, label: lb }] }))

onMounted(() => applyPreset('last_30'))
</script>

<template>
  <div class="grid gap-2 sm:gap-3 max-w-full">
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <RouterLink to="/projects" class="text-muted-foreground hover:text-foreground"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg></RouterLink>
        <h1 class="text-xl sm:text-2xl font-semibold tracking-tight">Inspections</h1>
      </div>
      <button class="text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0" :disabled="refreshing" @click="refreshCaches">{{ refreshing ? 'Refreshing...' : 'Refresh' }}</button>
    </div>

    <div class="flex gap-1.5 flex-wrap items-center">
      <Select :model-value="fEpc || '__all__'" @update:model-value="(v: string) => sf('epc', v)"><SelectTrigger class="h-7 w-auto text-[11px]"><SelectValue placeholder="EPC" /></SelectTrigger><SelectContent><SelectItem value="__all__">All EPCs</SelectItem><SelectItem v-for="e in filterOptions.epcs" :key="e" :value="e">{{ e }}</SelectItem></SelectContent></Select>
      <Select :model-value="fLender || '__all__'" @update:model-value="(v: string) => sf('lender', v)"><SelectTrigger class="h-7 w-auto text-[11px]"><SelectValue placeholder="Lender" /></SelectTrigger><SelectContent><SelectItem value="__all__">All</SelectItem><SelectItem v-for="l in filterOptions.lenders" :key="l" :value="l">{{ l }}</SelectItem></SelectContent></Select>
      <Select :model-value="fState || '__all__'" @update:model-value="(v: string) => sf('state', v)"><SelectTrigger class="h-7 w-auto text-[11px]"><SelectValue placeholder="State" /></SelectTrigger><SelectContent><SelectItem value="__all__">All</SelectItem><SelectItem v-for="s in filterOptions.states" :key="s" :value="s">{{ s }}</SelectItem></SelectContent></Select>
      <button v-if="hasActiveFilters" class="text-[11px] text-muted-foreground hover:text-foreground shrink-0" @click="resetAll">Reset</button>
    </div>

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
        { l: '#Scheduled', v: kpi.scheduled, cl: 'text-blue-600', b: 'bg-blue-500' },
        { l: '#Passed', v: kpi.passed, s: kpi.pctPassed + '% pass', cl: 'text-emerald-600', b: 'bg-emerald-500' },
        { l: '1st Time', v: kpi.firstTime, s: kpi.pctFirstTime + '% rate', cl: 'text-teal-600', b: 'bg-teal-500' },
        { l: 'Median', v: (kpi.overallMedian ?? 0) + 'd', s: 'inst→inspx', cl: 'text-foreground', b: 'bg-foreground' },
      ]" :key="c.l" class="flex-none rounded-xl px-3 py-2 w-[105px] sm:w-[115px] bg-card">
        <div class="h-[3px] rounded-full -mt-0.5 mb-1" :class="c.b" />
        <p class="text-[9px] sm:text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">{{ c.l }}</p>
        <p class="text-lg sm:text-xl font-extrabold mt-0.5" :class="c.cl">{{ c.v ?? 0 }}</p>
        <p v-if="c.s" class="text-[10px] text-muted-foreground">{{ c.s }}</p>
      </div>
      <button class="flex-none rounded-xl px-3 py-2 w-[105px] sm:w-[115px] bg-card hover:shadow-md active:scale-[0.97] text-left" @click="drill('Days Since Inst','needInspx')">
        <div class="h-[3px] rounded-full -mt-0.5 mb-1 bg-red-500" />
        <p class="text-[9px] sm:text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Since Inst</p>
        <p class="text-lg sm:text-xl font-extrabold mt-0.5 text-red-600">{{ kpi.avgDaysSinceInst ?? 0 }}d</p>
        <p class="text-[10px] text-muted-foreground">avg {{ dayUnit }}</p>
      </button>
      <button class="flex-none rounded-xl px-3 py-2 w-[105px] sm:w-[115px] bg-red-50 hover:shadow-md active:scale-[0.97] text-left" @click="drill('Need INSPX','needInspx')">
        <div class="h-[3px] rounded-full -mt-0.5 mb-1 bg-red-500" />
        <p class="text-[9px] sm:text-[10px] font-semibold uppercase tracking-wider text-red-600">Need INSPX</p>
        <p class="text-lg sm:text-xl font-extrabold mt-0.5 text-red-600">{{ kpi.needInspx ?? 0 }}</p>
      </button>
    </div>

    <div v-if="loading" class="space-y-3"><div v-for="i in 3" :key="i" class="rounded-xl bg-card h-40 animate-pulse" /></div>

    <template v-else>
      <!-- Row 1: #Passed + Scheduled on a Day -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div class="rounded-xl bg-card p-3"><h3 class="text-xs font-semibold mb-2">#Passed by Month</h3><VChart :option="passedChart" style="height:180px" autoresize /></div>
        <div class="rounded-xl bg-card p-3"><h3 class="text-xs font-semibold mb-2">Inspections Scheduled (by booking date)</h3><VChart :option="schedChart" style="height:180px" autoresize /></div>
      </div>

      <!-- Row 2: Install→Inspx box plot -->
      <div class="rounded-xl bg-card p-3">
        <div class="flex items-center gap-3 mb-2">
          <h3 class="text-xs font-semibold">Install → Inspection (days)</h3>
          <span class="text-[10px] text-muted-foreground">Median: {{ kpi.overallMedian }}d</span>
        </div>
        <VChart :option="boxChart" style="height:220px" autoresize />
      </div>

      <!-- Row 3: State table + Aging -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <!-- State breakdown -->
        <div class="rounded-xl bg-card p-3">
          <h3 class="text-xs font-semibold mb-2">By State</h3>
          <table class="w-full text-[11px]" style="table-layout:fixed">
            <thead><tr class="text-muted-foreground"><th class="text-left font-semibold py-1" style="width:25%">State</th><th class="text-right font-semibold py-1">#Sch</th><th class="text-right font-semibold py-1">#Pass</th><th class="text-right font-semibold py-1">#1st</th><th class="text-right font-semibold py-1">%1st</th><th class="text-right font-semibold py-1">Days</th></tr></thead>
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

        <!-- Aging -->
        <div class="rounded-xl bg-card p-3">
          <h3 class="text-xs font-semibold mb-2">Need Inspection — Aging</h3>
          <VChart :option="agingChart" style="height:150px" autoresize />
          <table class="w-full mt-2 text-[11px]" style="table-layout:fixed">
            <thead><tr class="text-muted-foreground"><th class="text-left font-semibold py-0.5">Bucket</th><th class="text-right font-semibold py-0.5">#</th><th class="text-right font-semibold py-0.5 text-blue-500">Sched</th><th class="text-right font-semibold py-0.5">%</th></tr></thead>
            <tbody>
              <tr v-for="b in aging" :key="b.label" class="border-t border-border/30 cursor-pointer hover:bg-muted/30" @click="drill(b.label,'needInspx')">
                <td class="py-1 font-medium">{{ b.label }}</td>
                <td class="py-1 text-right font-mono" :class="b.count ? 'text-red-600 font-bold' : 'text-muted-foreground'">{{ b.count }}</td>
                <td class="py-1 text-right font-mono text-blue-600">{{ b.scheduled }}</td>
                <td class="py-1 text-right font-mono text-muted-foreground">{{ agingTotal ? Math.round(b.count/agingTotal*100) : 0 }}%</td>
              </tr>
              <tr class="border-t-2 border-border font-bold"><td class="py-1 text-[9px] text-muted-foreground uppercase">Total</td><td class="py-1 text-right font-mono">{{ agingTotal }}</td><td class="py-1 text-right font-mono text-blue-600">{{ aging.reduce((s: number, b: any) => s + (b.scheduled || 0), 0) }}</td><td class="py-1 text-right font-mono">100%</td></tr>
            </tbody>
          </table>
          <div class="flex items-center gap-2 mt-2 text-xs"><span class="text-muted-foreground">Active Fails:</span><span class="font-bold text-red-600">{{ activeFails }}</span></div>
        </div>
      </div>

      <!-- Row 4: Outcomes by install month -->
      <div class="rounded-xl bg-card p-3">
        <h3 class="text-xs font-semibold mb-2">Inspection Outcomes by Install Month</h3>
        <VChart :option="outcomesChart" style="height:280px" autoresize />
      </div>
    </template>

    <!-- Drill -->
    <div v-if="drillLabel" id="drill-list" class="rounded-xl bg-card p-3">
      <div class="flex items-center justify-between mb-2"><h3 class="text-xs font-semibold">{{ drillLabel }} — {{ drillProjects.length }}</h3><button class="text-[11px] text-muted-foreground" @click="closeDrill">Close</button></div>
      <div v-if="drillLoading" class="space-y-2"><div v-for="i in 3" :key="i" class="h-10 rounded bg-muted/50 animate-pulse" /></div>
      <div v-else class="space-y-1">
        <div v-for="p in drillProjects" :key="(p as any).record_id" class="rounded-lg border-l-[3px] border border-border bg-background px-3 py-2 cursor-pointer hover:bg-muted/30" :class="getStatusConfig((p as any).status).border" @click="openProject((p as any).record_id)">
          <p class="text-sm font-semibold truncate">{{ (p as any).customer_name }}</p>
          <div class="flex gap-3 mt-0.5 text-[11px] text-muted-foreground">
            <span v-if="(p as any).coordinator">{{ (p as any).coordinator }}</span>
            <span v-if="(p as any).install_completed">Inst: {{ fmtDate((p as any).install_completed) }}</span>
            <span v-if="(p as any).inspection_scheduled">Sched: {{ fmtDate((p as any).inspection_scheduled) }}</span>
            <span v-if="(p as any).inspection_passed">Pass: {{ fmtDate((p as any).inspection_passed) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
.no-scrollbar::-webkit-scrollbar { display: none; }
</style>
