<script setup lang="ts">
import { ref, computed, inject, onMounted, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { getStatusConfig } from '@/lib/status'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import VChart from 'vue-echarts'

use([CanvasRenderer, BarChart, GridComponent, TooltipComponent, LegendComponent])

const auth = useAuthStore()

interface OutreachRecord {
  record_id: number
  project_rid: number
  touchpoint_name: string
  note: string
  customer_name: string
  outreach_completed_date: string
  outreach_completed_by: string
  outreach_status: string
  attempts: number
  due_date: string
  next_due_date: string
  preferred_outreach: string
  project_status: string
  project_stage: string
  project_state: string
  project_lender: string
  project_coordinator: string
  display_order: number
  is_unresponsive: number
}

interface UnresponsiveRow {
  record_id: number
  project_rid?: number
  customer_name: string
  touchpoint_name: string
  project_coordinator: string
  project_state: string
  blockers?: string
  pto_status?: string
  source: 'outreach' | 'pto_blocker'
}

interface BlockedNem {
  record_id: number
  customer_name: string
  coordinator: string
  state: string
  nem_submitted: string
  nem_approved: string
  nem_rejected: string
  status: string
}

interface AdderNotify {
  record_id: number
  project_rid: number
  customer_name: string
  product_category: string
  product_name: string
  qty: number | null
  adder_total: number | null
  adder_status: string
  ops_approval_status: string
  whos_paying: string
  project_status: string
  project_closer: string
  project_coordinator: string
  customer_state: string
  date_created: string
  sales_notified_date: string
  sla_start_date: string
  sla_timer_days: number | null
  rep_notified_date: string
}

const loading = ref(true)
const refreshing = ref(false)
const kpi = ref<Record<string, number>>({})
const groups = ref<Record<string, OutreachRecord[]>>({})
const unresponsive = ref<UnresponsiveRow[]>([])
const blockedNem = ref<BlockedNem[]>([])
const filterOptions = ref<{ coordinators: string[]; states: string[]; lenders: string[] }>({ coordinators: [], states: [], lenders: [] })
const cacheInfo = ref<{ total: number; last_refresh: string } | null>(null)

const viewMode = ref<'personal' | 'team'>('team')
const fCoordinator = ref('')
const fState = ref('')
const fLender = ref('')
const search = ref('')
const showFilters = ref(false)
const showAnalytics = ref(false)
const expandedStages = ref<Record<string, boolean>>({})
const expandedExceptions = ref<Record<string, boolean>>({ unresponsive: false, blockedNem: false, adders: false })
const adders = ref<AdderNotify[]>([])
const addersCache = ref<{ total: number; last_refresh: string } | null>(null)
const addersRefreshing = ref(false)

const useBizDays = ref(false)
const dayUnit = computed(() => useBizDays.value ? 'biz days' : 'days')

// Performance section
const PERF_MILESTONES = ['Initial Outreach', 'Check-In', 'Design Approval', 'Permit Submitted', 'Permit Received', 'Install Complete', 'Inspection Scheduled', 'Inspection Complete', 'PTO Approval']
const activePerfMilestone = ref('Initial Outreach')

interface VolumeBucket { period: string; count: number; avg: number; p90: number }
interface CoordMetric { coordinator: string; count: number; avg: number; median: number; p90: number }
interface DrillRow { record_id: number; project_rid: number; customer_name: string; coordinator: string; outreach_completed_date: string; milestone_date: string; days: number; status: string; state: string; lender: string }
interface AnalyticsData { touchpoint: string; binning: string; total: number; byCoordinator: CoordMetric[]; volume: VolumeBucket[]; drillData: DrillRow[] }
const analytics = ref<AnalyticsData | null>(null)
const analyticsLoading = ref(false)
const drillLabel = ref('')
const drillRows = ref<DrillRow[]>([])

// Date presets for analytics
const perfDateFrom = ref('')
const perfDateTo = ref('')
const perfDatePreset = ref('last_90')
const datePresets = [
  { key: 'last_30', label: '30d' }, { key: 'last_60', label: '60d' }, { key: 'last_90', label: '90d' },
  { key: 'this_month', label: 'Mo' }, { key: 'this_quarter', label: 'Qtr' }, { key: 'this_year', label: 'YTD' },
]
function applyPerfPreset(key: string) {
  perfDatePreset.value = key
  const t = new Date()
  const f = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
  const to = f(t)
  if (key === 'last_30') { const d = new Date(t); d.setDate(d.getDate()-30); perfDateFrom.value = f(d); perfDateTo.value = to }
  else if (key === 'last_60') { const d = new Date(t); d.setDate(d.getDate()-60); perfDateFrom.value = f(d); perfDateTo.value = to }
  else if (key === 'last_90') { const d = new Date(t); d.setDate(d.getDate()-90); perfDateFrom.value = f(d); perfDateTo.value = to }
  else if (key === 'this_month') { perfDateFrom.value = `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-01`; perfDateTo.value = to }
  else if (key === 'this_quarter') { perfDateFrom.value = `${t.getFullYear()}-${String(Math.floor(t.getMonth()/3)*3+1).padStart(2,'0')}-01`; perfDateTo.value = to }
  else if (key === 'this_year') { perfDateFrom.value = `${t.getFullYear()}-01-01`; perfDateTo.value = to }
  loadAnalytics()
}
// Init default date range
;(() => { const t = new Date(); const d = new Date(t); d.setDate(d.getDate()-90); const f = (x: Date) => `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`; perfDateFrom.value = f(d); perfDateTo.value = f(t) })()

function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

// Ordered by project milestone lifecycle — color spectrum from cool → warm
const STAGE_ORDER = [
  'Initial Outreach', 'Check-In', 'Design Approval',
  'Permit Submitted', 'Permit Received',
  'Install Complete',
  'Inspection Scheduled', 'Inspection Complete',
  'PTO Approval',
  'Cancel Reactivation', 'Rep Cancel Request',
]

// Color spectrum following project lifecycle: cool blue → green → warm amber → violet finish
const STAGE_CHIPS: Record<string, { bar: string; color: string; label: string }> = {
  'Initial Outreach': { bar: 'bg-blue-500', color: 'text-blue-600', label: 'Init. Outreach' },
  'Check-In':         { bar: 'bg-sky-500', color: 'text-sky-600', label: 'Check-In' },
  'Design Approval':  { bar: 'bg-teal-500', color: 'text-teal-600', label: 'Design Appr.' },
  'Permit Submitted': { bar: 'bg-emerald-500', color: 'text-emerald-600', label: 'Permit Sub.' },
  'Permit Received':  { bar: 'bg-green-500', color: 'text-green-600', label: 'Permit Rec.' },
  'Install Complete':  { bar: 'bg-amber-500', color: 'text-amber-600', label: 'Install Comp.' },
  'Inspection Scheduled': { bar: 'bg-orange-500', color: 'text-orange-600', label: 'Insp. Sched.' },
  'Inspection Complete': { bar: 'bg-rose-500', color: 'text-rose-600', label: 'Insp. Comp.' },
  'PTO Approval':     { bar: 'bg-violet-500', color: 'text-violet-600', label: 'PTO Appr.' },
  'Cancel Reactivation': { bar: 'bg-red-400', color: 'text-red-600', label: 'Cancel React.' },
  'Rep Cancel Request': { bar: 'bg-red-600', color: 'text-red-700', label: 'Rep Cancel' },
}

function chipFor(stage: string) { return STAGE_CHIPS[stage] || { bar: 'bg-muted-foreground', color: 'text-muted-foreground', label: stage } }

async function loadData() {
  loading.value = true
  const params = new URLSearchParams()
  if (viewMode.value === 'personal' && auth.user?.name) params.set('coordinator', auth.user.name)
  else if (fCoordinator.value) params.set('coordinator', fCoordinator.value)
  if (fState.value) params.set('state', fState.value)
  if (fLender.value) params.set('lender', fLender.value)
  try {
    const res = await fetch(`/api/pc-dashboard?${params}`, { headers: hdrs() })
    const data = await res.json()
    kpi.value = data.kpi || {}
    groups.value = data.groups || {}
    unresponsive.value = data.exceptions?.unresponsive || []
    blockedNem.value = data.exceptions?.blockedNem || []
    filterOptions.value = data.filters || { coordinators: [], states: [], lenders: [] }
    cacheInfo.value = data.cache
  } finally { loading.value = false }
}

async function refreshCache() {
  refreshing.value = true
  try {
    await fetch('/api/pc-dashboard/refresh', { method: 'POST', headers: hdrs() })
    await loadData()
  } finally { refreshing.value = false }
}

async function loadAdders() {
  const params = new URLSearchParams()
  if (viewMode.value === 'personal' && auth.user?.name) params.set('coordinator', auth.user.name)
  else if (fCoordinator.value) params.set('coordinator', fCoordinator.value)
  try {
    const res = await fetch(`/api/pc-dashboard/adders?${params}`, { headers: hdrs() })
    if (res.ok) {
      const data = await res.json()
      adders.value = data.rows || []
      addersCache.value = data.cache
    }
  } catch { /* ignore */ }
}

async function refreshAdders() {
  addersRefreshing.value = true
  try {
    await fetch('/api/pc-dashboard/refresh-adders', { method: 'POST', headers: hdrs() })
    await loadAdders()
  } finally { addersRefreshing.value = false }
}

const activeKpi = ref('')
function toggleStage(stage: string) { expandedStages.value = { ...expandedStages.value, [stage]: !expandedStages.value[stage] } }
function selectKpi(stage: string) {
  if (activeKpi.value === stage) { activeKpi.value = ''; expandedStages.value = {} }
  else { activeKpi.value = stage; const fresh: Record<string, boolean> = {}; fresh[stage] = true; expandedStages.value = fresh }
}
function toggleException(key: string) { expandedExceptions.value = { ...expandedExceptions.value, [key]: !expandedExceptions.value[key] } }

function fmtDate(d: string | null) {
  if (!d) return ''
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return ''
  return `${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}`
}

function daysUntil(d: string | null): number | null {
  if (!d) return null
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return null
  return Math.round((dt.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
}

function dueBadge(d: string | null): { label: string; cls: string } {
  const days = daysUntil(d)
  if (days === null) return { label: '', cls: '' }
  if (days < 0) return { label: `${Math.abs(days)}d overdue`, cls: 'bg-red-100 text-red-700' }
  if (days === 0) return { label: 'Today', cls: 'bg-amber-100 text-amber-700' }
  if (days === 1) return { label: 'Tomorrow', cls: 'bg-amber-50 text-amber-600' }
  return { label: `${days}d`, cls: 'bg-muted text-muted-foreground' }
}

function outreachIcon(method: string): string {
  if (!method) return ''
  const m = method.toLowerCase()
  if (m.includes('text') || m.includes('sms')) return 'sms'
  if (m.includes('email')) return 'email'
  if (m.includes('call') || m.includes('phone')) return 'call'
  return ''
}

const totalOutreach = computed(() => Object.values(kpi.value).reduce((a, b) => a + b, 0))

const filteredGroups = computed(() => {
  if (!search.value.trim()) return groups.value
  const q = search.value.toLowerCase()
  const result: Record<string, OutreachRecord[]> = {}
  for (const [stage, records] of Object.entries(groups.value)) {
    const filtered = records.filter(r =>
      (r.customer_name || '').toLowerCase().includes(q) ||
      (r.project_coordinator || '').toLowerCase().includes(q) ||
      (r.project_state || '').toLowerCase().includes(q) ||
      (r.project_lender || '').toLowerCase().includes(q)
    )
    result[stage] = filtered
  }
  return result
})

async function loadAnalytics() {
  analyticsLoading.value = true
  drillLabel.value = ''; drillRows.value = []
  const params = new URLSearchParams()
  params.set('touchpoint', activePerfMilestone.value)
  if (viewMode.value === 'personal' && auth.user?.name) params.set('coordinator', auth.user.name)
  else if (fCoordinator.value) params.set('coordinator', fCoordinator.value)
  if (useBizDays.value) params.set('biz_days', '1')
  if (perfDateFrom.value) params.set('date_from', perfDateFrom.value)
  if (perfDateTo.value) params.set('date_to', perfDateTo.value)
  try {
    const res = await fetch(`/api/pc-dashboard/analytics?${params}`, { headers: hdrs() })
    if (res.ok) analytics.value = await res.json()
  } finally { analyticsLoading.value = false }
}

async function refreshAnalyticsCache() {
  await fetch('/api/pc-dashboard/refresh-analytics', { method: 'POST', headers: hdrs() })
  await loadAnalytics()
}

function selectPerfMilestone(ms: string) {
  activePerfMilestone.value = ms
  loadAnalytics()
}

function drillInto(label: string, rows: DrillRow[]) {
  drillLabel.value = label
  drillRows.value = rows.sort((a, b) => b.outreach_completed_date.localeCompare(a.outreach_completed_date))
}

// Volume chart: bars = count, annotations below = mean + P90
const volumeChart = computed(() => {
  if (!analytics.value?.volume?.length) return null
  const v = analytics.value.volume
  const isWeekly = analytics.value.binning === 'weekly'
  return {
    tooltip: { trigger: 'axis' as const, formatter: (ps: any) => {
      const d = ps[0]; const bucket = v[d.dataIndex]
      return `${d.name}<br/>Volume: <b>${bucket.count}</b><br/>Avg: <b>${bucket.avg}</b> ${dayUnit.value}<br/>P90: <b>${bucket.p90}</b> ${dayUnit.value}`
    }},
    grid: { left: 40, right: 20, top: 10, bottom: 60 },
    xAxis: {
      type: 'category' as const,
      data: v.map(b => isWeekly ? `${b.period.slice(5)}` : b.period.slice(2)),
      axisLabel: { fontSize: 9, rotate: isWeekly ? 45 : 0 },
    },
    yAxis: { type: 'value' as const, name: 'Volume', axisLabel: { fontSize: 9 } },
    series: [{
      type: 'bar' as const, data: v.map(b => b.count),
      itemStyle: { color: '#3b82f6', borderRadius: [4, 4, 0, 0] }, barMaxWidth: 28,
      label: { show: true, position: 'top' as const, fontSize: 9, formatter: (p: any) => {
        const bucket = v[p.dataIndex]; return `${bucket.avg}d`
      }},
      labelLayout: { hideOverlap: true },
    }, {
      type: 'bar' as const, data: v.map(b => b.count),
      barGap: '-100%' as const, silent: true, barMaxWidth: 28,
      itemStyle: { color: 'transparent' },
      label: {
        show: true, position: 'insideBottom' as const, fontSize: 9, fontWeight: 600,
        color: '#fff', formatter: (p: any) => `${v[p.dataIndex].count}`,
      },
    }],
    graphic: v.length > 0 ? [{
      type: 'text' as const, left: 'center' as const, bottom: 5,
      style: {
        text: `Mean: ${(v.reduce((a, b) => a + b.avg * b.count, 0) / v.reduce((a, b) => a + b.count, 0)).toFixed(1)} ${dayUnit.value}  ·  P90: ${(() => { const all = v.flatMap(b => Array(b.count).fill(b.p90) as number[]); all.sort((a: number, b: number) => a - b); return all[Math.floor(all.length * 0.9)] || 0 })()} ${dayUnit.value}`,
        fontSize: 10, fill: '#64748b', fontWeight: 'bold' as const,
      }
    }] : [],
  }
})

// Time-to-event by PC chart
const timeToEventChart = computed(() => {
  if (!analytics.value?.byCoordinator?.length) return null
  const data = analytics.value.byCoordinator
  return {
    tooltip: { trigger: 'axis' as const },
    grid: { left: 110, right: 20, top: 10, bottom: 30 },
    xAxis: { type: 'value' as const, name: dayUnit.value, nameLocation: 'middle' as const, nameGap: 20 },
    yAxis: { type: 'category' as const, data: data.map(d => d.coordinator), axisLabel: { fontSize: 10 } },
    series: [
      {
        name: 'Avg', type: 'bar' as const, data: data.map(d => d.avg),
        itemStyle: { color: '#3b82f6', borderRadius: [0, 4, 4, 0] }, barMaxWidth: 16,
        label: {
          show: true, position: 'insideLeft' as const, fontSize: 9, fontWeight: 600,
          color: '#fff', formatter: (p: any) => `${p.value}`,
        },
      },
      {
        name: 'P90', type: 'bar' as const, data: data.map(d => d.p90),
        itemStyle: { color: '#93c5fd', borderRadius: [0, 4, 4, 0] }, barMaxWidth: 16,
        label: {
          show: true, position: 'insideLeft' as const, fontSize: 9, fontWeight: 600,
          color: '#1e3a8a', formatter: (p: any) => `${p.value}`,
        },
      },
    ],
  }
})

function onChartClick(params: any) {
  if (!analytics.value?.drillData) return
  const coordData = analytics.value.byCoordinator
  if (params.componentType === 'series' && coordData?.[params.dataIndex]) {
    const coord = coordData[params.dataIndex].coordinator
    const rows = analytics.value.drillData.filter(r => r.coordinator === coord)
    drillInto(`${coord} — ${activePerfMilestone.value}`, rows)
  }
}

watch([viewMode, fCoordinator, useBizDays, activePerfMilestone], () => { if (showAnalytics.value) loadAnalytics() })

const registerRefresh = inject<(fn: () => Promise<void>) => void>('registerRefresh')
onMounted(() => { loadData(); loadAdders(); registerRefresh?.(async () => { await loadData(); await loadAdders() }) })
watch([viewMode, fCoordinator], () => { loadAdders() })
</script>

<template>
  <div class="grid gap-2 sm:gap-3">
    <!-- Header (sticky) -->
    <div class="sticky top-0 z-20 bg-background flex items-center justify-between gap-3 -mx-3 px-3 sm:-mx-6 sm:px-6 py-2">
      <div class="flex items-baseline gap-2 min-w-0">
        <h1 class="text-2xl font-semibold tracking-tight">PC Dashboard</h1>
        <span class="text-sm font-medium text-muted-foreground tabular-nums shrink-0">{{ totalOutreach }}</span>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <!-- PC quick filter -->
        <Select :model-value="fCoordinator || '__all__'" @update:model-value="(v: string) => { fCoordinator = v === '__all__' ? '' : v; if (fCoordinator) viewMode = 'team'; loadData() }">
          <SelectTrigger class="h-8 w-auto min-w-[100px] text-xs"><SelectValue placeholder="All PCs" /></SelectTrigger>
          <SelectContent><SelectItem value="__all__">All PCs</SelectItem><SelectItem v-for="c in filterOptions.coordinators" :key="c" :value="c">{{ c }}</SelectItem></SelectContent>
        </Select>
        <!-- Personal / Team toggle -->
        <div class="flex rounded-md border overflow-hidden">
          <button class="px-2.5 h-8 text-xs font-medium transition-colors" :class="viewMode === 'personal' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'" @click="viewMode = 'personal'; fCoordinator = ''; loadData()">Me</button>
          <button class="px-2.5 h-8 text-xs font-medium transition-colors" :class="viewMode === 'team' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'" @click="viewMode = 'team'; loadData()">Team</button>
        </div>
        <Button v-if="auth.isAdmin" variant="outline" class="h-8 text-xs px-2.5" :disabled="refreshing" @click="refreshCache">{{ refreshing ? 'Syncing...' : 'Sync' }}</Button>
      </div>
    </div>

    <!-- KPI strip (matches Projects view layout) -->
    <div class="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1">
      <button v-for="stage in STAGE_ORDER" :key="stage"
        class="flex-none rounded-xl px-3 py-2 w-[105px] sm:w-[115px] text-left transition-all active:scale-[0.97]"
        :class="activeKpi === stage ? 'bg-card shadow-md' : 'bg-card/60 hover:bg-card'"
        @click="selectKpi(stage)"
      >
        <div class="h-[3px] rounded-full -mt-0.5 mb-1" :class="chipFor(stage).bar" />
        <p class="text-[9px] sm:text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">{{ chipFor(stage).label }}</p>
        <p class="mt-0.5">
          <span class="text-lg sm:text-xl font-extrabold" :class="chipFor(stage).color">{{ kpi[stage] || 0 }}</span>
        </p>
      </button>
    </div>

    <!-- Analytics toggle + Cal/Biz -->
    <div class="flex items-center gap-2">
      <button class="inline-flex items-center gap-1.5 rounded-md border px-2.5 h-8 text-xs font-medium transition-colors" :class="showAnalytics ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'" @click="showAnalytics = !showAnalytics; if (showAnalytics && !analytics) { refreshAnalyticsCache() }">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
        Performance
      </button>
      <div v-if="showAnalytics" class="flex rounded-md border overflow-hidden bg-muted/50">
        <button class="px-1.5 py-0.5 text-[9px] font-medium rounded" :class="!useBizDays ? 'bg-card shadow-sm' : 'text-muted-foreground'" @click="useBizDays = false">Cal</button>
        <button class="px-1.5 py-0.5 text-[9px] font-medium rounded" :class="useBizDays ? 'bg-card shadow-sm' : 'text-muted-foreground'" @click="useBizDays = true">Biz</button>
      </div>
      <button v-if="showAnalytics && auth.isAdmin" class="text-[10px] text-muted-foreground hover:text-foreground" @click="refreshAnalyticsCache">Refresh analytics</button>
    </div>

    <!-- Analytics section -->
    <div v-if="showAnalytics" class="space-y-3">
      <!-- Milestone selector KPI strip -->
      <div class="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1">
        <button v-for="ms in PERF_MILESTONES" :key="ms"
          class="flex-none rounded-lg px-2.5 py-1.5 text-[9px] font-semibold uppercase tracking-wider transition-all active:scale-[0.97] whitespace-nowrap"
          :class="activePerfMilestone === ms ? 'bg-primary text-primary-foreground shadow-md' : 'bg-card/60 hover:bg-card text-muted-foreground'"
          @click="selectPerfMilestone(ms)"
        >{{ ms }}</button>
      </div>

      <!-- Date presets -->
      <div class="flex gap-1.5 items-center flex-wrap">
        <button v-for="p in datePresets" :key="p.key"
          class="px-2 py-0.5 rounded border text-[10px] font-medium transition-colors"
          :class="perfDatePreset === p.key ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'"
          @click="applyPerfPreset(p.key)"
        >{{ p.label }}</button>
      </div>

      <div v-if="analyticsLoading" class="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">Loading...</div>
      <template v-else-if="analytics">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <!-- Volume chart -->
          <div class="rounded-xl border bg-card p-4">
            <p class="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">{{ activePerfMilestone }} Volume</p>
            <p class="text-[10px] text-muted-foreground mb-2">{{ analytics.total }} completed · {{ analytics.binning }}</p>
            <VChart v-if="volumeChart" :option="volumeChart" style="height: 200px" autoresize />
            <p v-else class="text-[11px] text-muted-foreground py-4 text-center">No data for this period</p>
          </div>

          <!-- Time-to-event by PC -->
          <div class="rounded-xl border bg-card p-4">
            <p class="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">Time to {{ activePerfMilestone }} by PC</p>
            <p class="text-[10px] text-muted-foreground mb-2">avg + P90 · {{ dayUnit }}</p>
            <VChart v-if="timeToEventChart" :option="timeToEventChart" @click="onChartClick"
              :style="{ height: Math.max(120, (analytics.byCoordinator?.length || 0) * 28) + 'px' }" autoresize />
            <p v-else class="text-[11px] text-muted-foreground py-4 text-center">No data</p>
          </div>
        </div>

        <!-- Drill-down table -->
        <div v-if="drillLabel" class="rounded-xl border bg-card overflow-hidden">
          <div class="flex items-center justify-between px-4 py-2.5 border-b">
            <p class="text-[11px] font-semibold">{{ drillLabel }} <span class="text-muted-foreground font-normal">({{ drillRows.length }})</span></p>
            <button class="text-[10px] text-muted-foreground hover:text-foreground" @click="drillLabel = ''; drillRows = []">Close</button>
          </div>
          <div class="divide-y max-h-[300px] overflow-y-auto">
            <div v-for="r in drillRows" :key="r.record_id" class="px-4 py-2 flex items-center gap-3 text-[11px]">
              <p class="font-medium flex-1 min-w-0 truncate">{{ r.customer_name }}</p>
              <span class="text-muted-foreground">{{ r.milestone_date?.slice(0, 10) }} → {{ r.outreach_completed_date?.slice(0, 10) }}</span>
              <span class="font-semibold tabular-nums" :class="r.days > 7 ? 'text-red-600' : r.days > 3 ? 'text-amber-600' : 'text-emerald-600'">{{ r.days }}d</span>
              <span v-if="r.state" class="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{{ r.state }}</span>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- Search + filter toggle -->
    <div class="flex gap-2 items-center">
      <div class="relative flex-1">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <Input v-model="search" placeholder="Search customer, coordinator, state..." class="pl-8 pr-8 h-8 text-xs" />
        <button v-if="search" @click="search = ''" class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <button class="relative inline-flex items-center justify-center rounded-md border size-8 shrink-0 transition-colors" :class="showFilters ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'" @click="showFilters = !showFilters" title="Filters">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
      </button>
    </div>

    <!-- Filter drawer -->
    <div v-if="showFilters" class="rounded-xl border bg-card p-4 grid grid-cols-2 sm:grid-cols-3 gap-3">
      <div class="space-y-1.5">
        <Label class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">State</Label>
        <Select :model-value="fState || '__all__'" @update:model-value="(v: string) => { fState = v === '__all__' ? '' : v; loadData() }">
          <SelectTrigger class="h-8 text-xs"><SelectValue placeholder="All states" /></SelectTrigger>
          <SelectContent><SelectItem value="__all__">All states</SelectItem><SelectItem v-for="s in filterOptions.states" :key="s" :value="s">{{ s }}</SelectItem></SelectContent>
        </Select>
      </div>
      <div class="space-y-1.5">
        <Label class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Lender</Label>
        <Select :model-value="fLender || '__all__'" @update:model-value="(v: string) => { fLender = v === '__all__' ? '' : v; loadData() }">
          <SelectTrigger class="h-8 text-xs"><SelectValue placeholder="All lenders" /></SelectTrigger>
          <SelectContent><SelectItem value="__all__">All lenders</SelectItem><SelectItem v-for="l in filterOptions.lenders" :key="l" :value="l">{{ l }}</SelectItem></SelectContent>
        </Select>
      </div>
      <div class="space-y-1.5" v-if="viewMode === 'team'">
        <Label class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Clear</Label>
        <button class="text-xs text-muted-foreground hover:text-foreground h-8 flex items-center" @click="fState = ''; fLender = ''; loadData()">Reset filters</button>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading && Object.keys(groups).length === 0" class="space-y-2">
      <div v-for="i in 6" :key="i" class="rounded-lg border bg-card h-14 animate-pulse" />
    </div>

    <!-- Empty -->
    <div v-else-if="totalOutreach === 0" class="rounded-xl border bg-card p-12 text-center">
      <p class="text-muted-foreground">No pending outreach{{ viewMode === 'personal' ? ' for you' : '' }}.</p>
      <Button v-if="auth.isAdmin" variant="outline" size="sm" class="mt-3" @click="refreshCache">Sync from QB</Button>
    </div>

    <!-- Stage-grouped sections -->
    <template v-else>
      <div class="space-y-2">
      <template v-for="stage in STAGE_ORDER" :key="stage">
        <div v-if="(kpi[stage] || 0) > 0 || (filteredGroups[stage] || []).length > 0" class="space-y-1">
          <!-- Stage header -->
          <button class="flex items-center gap-2 w-full h-9" @click="toggleStage(stage)">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground shrink-0 transition-transform" :class="expandedStages[stage] ? 'rotate-180' : ''"><polyline points="6 9 12 15 18 9"/></svg>
            <div class="h-[3px] w-3 rounded-full shrink-0" :class="chipFor(stage).bar" />
            <span class="text-[11px] font-semibold uppercase tracking-widest" :class="chipFor(stage).color">{{ stage }}</span>
            <span class="text-[11px] font-medium text-muted-foreground">({{ (filteredGroups[stage] || []).length }})</span>
          </button>

          <!-- Outreach cards -->
          <div v-if="expandedStages[stage]" class="space-y-1">
            <div v-for="r in (filteredGroups[stage] || [])" :key="r.record_id"
              class="rounded-lg border bg-card px-3 py-2 sm:px-4 sm:py-2.5 flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-4"
            >
              <!-- Left: customer + meta -->
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-1.5">
                  <p class="text-[12px] font-semibold truncate">{{ r.customer_name || 'Unnamed' }}</p>
                  <span v-if="r.project_state" class="text-[9px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{{ r.project_state }}</span>
                  <span v-if="r.project_status" class="inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-semibold" :class="[getStatusConfig(r.project_status).bg, getStatusConfig(r.project_status).text]">{{ r.project_status }}</span>
                </div>
                <p class="text-[10px] text-muted-foreground truncate mt-0.5">
                  <template v-if="r.project_lender">{{ r.project_lender }}</template>
                  <template v-if="viewMode === 'team' && r.project_coordinator"> · {{ r.project_coordinator }}</template>
                  <template v-if="r.attempts"> · {{ r.attempts }} attempt{{ r.attempts === 1 ? '' : 's' }}</template>
                </p>
              </div>

              <!-- Center: preferred outreach method icon -->
              <div v-if="outreachIcon(r.preferred_outreach)" class="shrink-0 hidden sm:block">
                <span class="text-[9px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{{ r.preferred_outreach }}</span>
              </div>

              <!-- Right: due date + update button -->
              <div class="flex items-center gap-2 shrink-0 sm:justify-end sm:min-w-[160px]">
                <div v-if="r.due_date || r.next_due_date">
                  <span v-if="dueBadge(r.due_date || r.next_due_date).label" class="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold" :class="dueBadge(r.due_date || r.next_due_date).cls">
                    {{ dueBadge(r.due_date || r.next_due_date).label }}
                  </span>
                  <span class="text-[10px] text-muted-foreground ml-1">{{ fmtDate(r.due_date || r.next_due_date) }}</span>
                </div>
                <a :href="`https://kin.quickbase.com/db/btvik5kwi?a=er&dfid=10&rid=${r.record_id}`" target="_blank" @click.stop
                  class="inline-flex items-center justify-center rounded-md h-7 px-2.5 text-[10px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors shrink-0"
                >Update</a>
              </div>
            </div>

            <p v-if="(filteredGroups[stage] || []).length === 0" class="text-[11px] text-muted-foreground pl-6 py-1">No records match search.</p>
          </div>
        </div>
      </template>
      </div>

      <!-- ── Exception panels ── -->
      <div class="mt-3 space-y-2">
        <!-- Unresponsive Customers -->
        <div v-if="unresponsive.length > 0" class="rounded-xl border bg-card overflow-hidden">
          <button class="flex items-center justify-between w-full px-4 py-2.5" @click="toggleException('unresponsive')">
            <div class="flex items-center gap-2">
              <span class="size-2 rounded-full bg-amber-500" />
              <span class="text-[11px] font-semibold uppercase tracking-widest text-amber-700">Unresponsive Customers</span>
            </div>
            <div class="flex items-center gap-2">
              <Badge variant="secondary" class="text-[10px]">{{ unresponsive.length }}</Badge>
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground transition-transform" :class="expandedExceptions.unresponsive ? 'rotate-180' : ''"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
          </button>
          <div v-if="expandedExceptions.unresponsive" class="border-t divide-y">
            <div v-for="r in unresponsive" :key="`${r.source}-${r.record_id}`" class="px-4 py-2 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 text-[11px]">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-1.5">
                  <p class="font-medium truncate">{{ r.customer_name }}</p>
                  <span v-if="r.source === 'pto_blocker'" class="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-violet-100 text-violet-700">PTO</span>
                </div>
                <p v-if="r.source === 'pto_blocker' && r.blockers" class="text-[10px] text-red-600 mt-0.5 line-clamp-1">{{ r.blockers }}</p>
              </div>
              <span class="text-muted-foreground shrink-0">{{ r.touchpoint_name }}</span>
              <span class="text-muted-foreground shrink-0">{{ r.project_coordinator }}</span>
              <span v-if="r.project_state" class="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">{{ r.project_state }}</span>
            </div>
          </div>
        </div>

        <!-- Blocked NEM -->
        <div v-if="blockedNem.length > 0" class="rounded-xl border bg-card overflow-hidden">
          <button class="flex items-center justify-between w-full px-4 py-2.5" @click="toggleException('blockedNem')">
            <div class="flex items-center gap-2">
              <span class="size-2 rounded-full bg-orange-500" />
              <span class="text-[11px] font-semibold uppercase tracking-widest text-orange-700">Blocked NEM</span>
            </div>
            <div class="flex items-center gap-2">
              <Badge variant="secondary" class="text-[10px]">{{ blockedNem.length }}</Badge>
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground transition-transform" :class="expandedExceptions.blockedNem ? 'rotate-180' : ''"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
          </button>
          <div v-if="expandedExceptions.blockedNem" class="border-t divide-y">
            <div v-for="r in blockedNem" :key="r.record_id" class="px-4 py-2 flex items-center gap-3 text-[11px]">
              <p class="font-medium flex-1 min-w-0 truncate">{{ r.customer_name }}</p>
              <span class="text-muted-foreground">{{ r.coordinator }}</span>
              <span v-if="r.state" class="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{{ r.state }}</span>
              <span class="text-[10px] text-muted-foreground">NEM {{ fmtDate(r.nem_submitted) }}</span>
              <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-semibold" :class="[getStatusConfig(r.status).bg, getStatusConfig(r.status).text]">{{ r.status }}</span>
            </div>
          </div>
        </div>

        <!-- Post-POS Adders — Sales Rep Notification -->
        <div v-if="adders.length > 0" class="rounded-xl border bg-card overflow-hidden">
          <button class="flex items-center justify-between w-full px-4 py-2.5" @click="toggleException('adders')">
            <div class="flex items-center gap-2">
              <span class="size-2 rounded-full bg-rose-500" />
              <span class="text-[11px] font-semibold uppercase tracking-widest text-rose-700">Adders: Pending Rep Notification</span>
            </div>
            <div class="flex items-center gap-2">
              <Badge variant="secondary" class="text-[10px]">{{ adders.length }}</Badge>
              <button v-if="auth.isAdmin" class="text-[10px] text-muted-foreground hover:text-foreground" :disabled="addersRefreshing" @click.stop="refreshAdders">{{ addersRefreshing ? '…' : 'Sync' }}</button>
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground transition-transform" :class="expandedExceptions.adders ? 'rotate-180' : ''"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
          </button>
          <div v-if="expandedExceptions.adders" class="border-t divide-y">
            <a v-for="r in adders" :key="r.record_id"
              :href="`https://kin.quickbase.com/db/bsaycczmf?a=dr&rid=${r.record_id}`" target="_blank"
              class="px-4 py-2 flex items-center gap-3 text-[11px] hover:bg-muted/40 transition-colors"
            >
              <div class="flex-1 min-w-0">
                <p class="font-medium truncate">{{ r.customer_name || 'Unnamed' }}</p>
                <p class="text-[10px] text-muted-foreground truncate mt-0.5">
                  {{ r.product_name || r.product_category }}
                  <template v-if="r.qty"> · Qty {{ r.qty }}</template>
                  <template v-if="r.project_closer"> · Rep {{ r.project_closer }}</template>
                </p>
              </div>
              <span v-if="r.customer_state" class="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">{{ r.customer_state }}</span>
              <span v-if="r.adder_total" class="text-[10px] font-semibold tabular-nums shrink-0">${{ Math.round(r.adder_total).toLocaleString() }}</span>
              <span v-if="r.sla_timer_days != null" class="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold shrink-0 tabular-nums"
                :class="r.sla_timer_days > 7 ? 'bg-red-100 text-red-700' : r.sla_timer_days > 3 ? 'bg-amber-100 text-amber-700' : 'bg-muted text-muted-foreground'">
                {{ r.sla_timer_days }}d SLA
              </span>
            </a>
          </div>
        </div>
      </div>
    </template>

    <p v-if="cacheInfo && cacheInfo.total > 0" class="text-center text-[10px] text-muted-foreground py-1">{{ cacheInfo.total }} outreach records · synced {{ cacheInfo.last_refresh }}</p>
  </div>
</template>
