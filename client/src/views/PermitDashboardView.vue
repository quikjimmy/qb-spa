<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { BarChart, BoxplotChart, ScatterChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent, MarkLineComponent } from 'echarts/components'
import VChart from 'vue-echarts'

import MilestoneShell from '@/components/milestone/MilestoneShell.vue'
import MilestoneFilterBar, { type FilterDef } from '@/components/milestone/MilestoneFilterBar.vue'
import MilestoneDatePresetBar from '@/components/milestone/MilestoneDatePresetBar.vue'
import MilestoneKpiStrip from '@/components/milestone/MilestoneKpiStrip.vue'
import MilestoneProjectsTable, { type ColumnDef } from '@/components/milestone/MilestoneProjectsTable.vue'
import ProjectDetailDialog from '@/components/milestone/ProjectDetailDialog.vue'
import { fmtDate, fmtDateFull } from '@/lib/dates'

use([CanvasRenderer, BarChart, BoxplotChart, ScatterChart, GridComponent, TooltipComponent, LegendComponent, MarkLineComponent])

const auth = useAuthStore()

const loading = ref(true)
const errorMsg = ref('')
const data = ref<any>({
  kpi: {},
  queues: [],
  charts: { throughput: [], aging: [], slaBoxes: [], approvalBoxes: [] },
  pivot: { users: [], ahjs: [] },
  lists: {},
  filters: { states: [], epcs: [], permitUsers: [], ahjs: [] },
  meta: {},
})

const fState = ref('')
const fEpc = ref('Kin Home')
const fPermitUser = ref('')
const fAhj = ref('')
const datePreset = ref('last_30')
const dateFrom = ref('')
const dateTo = ref('')
const useBizDays = ref(false)
const drillLabel = ref('')
const drillProjects = ref<any[]>([])
const drillLoading = ref(false)
const selectedProject = ref<Record<string, unknown> | null>(null)

function hdrs() {
  return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }
}

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function setInitialRange() {
  const t = new Date()
  const start = new Date(t)
  start.setDate(start.getDate() - 30)
  dateFrom.value = fmt(start)
  dateTo.value = fmt(t)
}

function apiParams(extra?: Record<string, string>): URLSearchParams {
  const p = new URLSearchParams({ today: todayIso() })
  if (fState.value) p.set('state', fState.value)
  if (fEpc.value) p.set('epc', fEpc.value)
  if (fPermitUser.value) p.set('permit_user', fPermitUser.value)
  if (fAhj.value) p.set('ahj', fAhj.value)
  if (dateFrom.value) p.set('date_from', dateFrom.value)
  if (dateTo.value) p.set('date_to', dateTo.value)
  if (useBizDays.value) p.set('biz_days', '1')
  for (const [k, v] of Object.entries(extra || {})) p.set(k, v)
  return p
}

async function loadData() {
  loading.value = true
  errorMsg.value = ''
  try {
    const res = await fetch(`/api/analytics/permit?${apiParams()}`, { headers: hdrs() })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error || 'Failed to load Permit analytics')
    data.value = json
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

const filterDefs = computed<FilterDef[]>(() => [
  { key: 'epc', placeholder: 'EPC', allLabel: 'All EPCs', options: data.value.filters?.epcs || [], value: fEpc.value, defaultValue: 'Kin Home' },
  { key: 'state', placeholder: 'State', options: data.value.filters?.states || [], value: fState.value },
  { key: 'permit_user', placeholder: 'Permit User', allLabel: 'All Users', options: data.value.filters?.permitUsers || [], value: fPermitUser.value },
  { key: 'ahj', placeholder: 'AHJ', allLabel: 'All AHJs', options: data.value.filters?.ahjs || [], value: fAhj.value },
])

const extraActive = computed(() => datePreset.value !== 'last_30' || useBizDays.value)

function onFilter(key: string, value: string) {
  if (key === 'epc') fEpc.value = value
  else if (key === 'state') fState.value = value
  else if (key === 'permit_user') fPermitUser.value = value
  else if (key === 'ahj') fAhj.value = value
  clearDrill()
  loadData()
}

function resetAll() {
  fState.value = ''
  fEpc.value = 'Kin Home'
  fPermitUser.value = ''
  fAhj.value = ''
  datePreset.value = 'last_30'
  useBizDays.value = false
  setInitialRange()
  clearDrill()
  loadData()
}

function onDateChange(payload: { preset: string; from: string; to: string; bizDays: boolean }) {
  datePreset.value = payload.preset
  dateFrom.value = payload.from
  dateTo.value = payload.to
  useBizDays.value = payload.bizDays
  clearDrill()
  loadData()
}

function queueByKey(key: string) {
  return (data.value.queues || []).find((q: any) => q.key === key)
}

function slaTone(summary: any) {
  const pct = Number(summary?.pctMet || 0)
  if (!summary?.count) return 'neutral' as const
  if (pct >= 90) return 'success' as const
  if (pct >= 75) return 'warning' as const
  return 'danger' as const
}

function formatRate(pct: unknown, total: unknown): string {
  return Number(total || 0) ? `${Number(pct || 0)}%` : '-'
}

function rateClass(pct: unknown, total: unknown): string {
  if (!Number(total || 0)) return 'text-muted-foreground'
  const n = Number(pct || 0)
  if (n >= 90) return 'text-emerald-600 font-semibold'
  if (n >= 75) return 'text-amber-600 font-semibold'
  return 'text-rose-600 font-semibold'
}

const kpiTiles = computed(() => {
  const k = data.value.kpi || {}
  const s = k.sla || {}
  const tiles = [
    { key: 'open', label: 'Open', value: k.open ?? 0, sub: `${k.avgAge ?? 0}d avg`, tone: 'neutral' as const, drill: true },
    { key: 'slaMiss', label: 'Design->Sub SLA', value: s.count ? `${s.pctMet}%` : '-', sub: s.count ? `${s.met}/${s.count} met` : `${s.openMisses ?? 0} open over`, tone: slaTone(s), drill: true, bg: s.openMisses ? 'danger-soft' as const : 'card' as const },
    { key: 'submitted', label: 'Submitted', value: k.submitted ?? 0, sub: 'in window', tone: 'info' as const },
    { key: 'approved', label: 'Approved', value: k.approved ?? 0, sub: 'in window', tone: 'success' as const },
    { key: 'stuck', label: 'Stuck', value: k.stale ?? 0, sub: `${k.oldest ?? 0}d oldest`, tone: 'danger' as const, drill: true, bg: k.stale ? 'danger-soft' as const : 'card' as const },
  ]
  for (const key of ['needSubmit', 'pendingApproval', 'blocked', 'followUp', 'revisions', 'installedNoPermit']) {
    const q = queueByKey(key)
    if (!q) continue
    tiles.push({
      key,
      label: q.label,
      value: q.count,
      sub: `${q.stale} stale`,
      tone: q.tone,
      drill: true,
      bg: (key === 'blocked' || key === 'installedNoPermit') && q.count ? 'danger-soft' as const : 'card' as const,
    })
  }
  return tiles
})

const queueRows = computed(() => data.value.queues || [])
const dayUnit = computed(() => useBizDays.value ? 'biz days' : 'days')
const slaBoxSlice = computed(() => (data.value.charts?.slaBoxes || []).slice(-13))
const approvalBoxSlice = computed(() => (data.value.charts?.approvalBoxes || []).slice(-13))
const userRows = computed(() => data.value.pivot?.users || [])
const ahjRows = computed(() => data.value.pivot?.ahjs || [])

function formatQueueDate(value: unknown): string {
  return fmtDateFull(String(value || ''))
}

function formatDay(value: unknown): string {
  return value === null || value === undefined || value === '' ? '-' : `${Number(value)}d`
}

function formatBizDay(value: unknown): string {
  return value === null || value === undefined || value === '' ? '-' : `${Number(value)}b`
}

function clearDrill() {
  drillLabel.value = ''
  drillProjects.value = []
  drillLoading.value = false
}

function setDrill(label: string, rows: any[]) {
  drillLabel.value = label
  drillProjects.value = rows || []
  drillLoading.value = false
  nextTick().then(() => document.getElementById('milestone-projects-table')?.scrollIntoView({ behavior: 'smooth' }))
}

function onKpiDrill(key: string) {
  if (key === 'open') setDrill('Open permit queue', data.value.lists?.open || [])
  else if (key === 'stuck') setDrill('Stuck permit work', data.value.lists?.stuck || [])
  else if (key === 'slaMiss') setDrill('Design complete -> permit submitted SLA misses', data.value.lists?.slaMiss || [])
  else {
    const q = queueByKey(key)
    setDrill(q?.label || key, data.value.lists?.[key] || [])
  }
}

async function drillPeriod(metric: string, period: string, label: string) {
  drillLabel.value = label
  drillLoading.value = true
  drillProjects.value = []
  try {
    const res = await fetch(`/api/analytics/permit/drill?${apiParams({ metric, period })}`, { headers: hdrs() })
    if (!res.ok) return
    const json = await res.json()
    drillProjects.value = json.projects || []
  } finally {
    drillLoading.value = false
  }
  await nextTick()
  document.getElementById('milestone-projects-table')?.scrollIntoView({ behavior: 'smooth' })
}

function throughputMetric(seriesName: string): string {
  if (seriesName === 'Permit Approved') return 'permitApproved'
  if (seriesName === 'Revision Submitted') return 'revisionSubmitted'
  if (seriesName === 'Revision Approved') return 'revisionApproved'
  return 'permitSubmitted'
}

function onThroughputClick(p: { dataIndex: number; name: string; seriesName?: string }) {
  const row = data.value.charts?.throughput?.[p.dataIndex]
  if (!row?.period) return
  const seriesName = p.seriesName || ''
  drillPeriod(throughputMetric(seriesName), row.period, `${seriesName} · ${p.name}`)
}

function onAgingClick(p: { name: string }) {
  const bucket = String(p.name || '')
  const ranges: Record<string, [number, number]> = {
    '0-1': [0, 1],
    '2-3': [2, 3],
    '4-7': [4, 7],
    '8-14': [8, 14],
    '15+': [15, 99999],
  }
  const range = ranges[bucket]
  if (!range) return
  const rows = (data.value.lists?.open || []).filter((row: any) => Number(row.age_days || 0) >= range[0] && Number(row.age_days || 0) <= range[1])
  setDrill(`Age ${bucket} ${dayUnit.value}`, rows)
}

function fp(period: string) {
  if (!period) return ''
  if (period.length === 10) return new Date(`${period}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  if (period.length === 7) {
    const [yRaw, mRaw] = period.split('-')
    const y = Number(yRaw)
    const m = Number(mRaw)
    return new Date(y, m - 1).toLocaleDateString('en-US', { month: 'short' }) + " '" + String(y).slice(2)
  }
  return period
}

const throughputChart = computed(() => {
  const rows = data.value.charts?.throughput || []
  return {
    tooltip: { trigger: 'axis' as const, axisPointer: { type: 'shadow' as const } },
    legend: { data: ['Permit Submitted', 'Permit Approved', 'Revision Submitted', 'Revision Approved'], top: 0, textStyle: { fontSize: 9 } },
    grid: { top: 28, right: 14, bottom: 5, left: 5, containLabel: true },
    xAxis: { type: 'category' as const, data: rows.map((r: any) => fp(r.period)), axisLabel: { fontSize: 9, rotate: rows.length > 6 ? 45 : 0 } },
    yAxis: { type: 'value' as const, axisLabel: { fontSize: 9 } },
    series: [
      { name: 'Permit Submitted', type: 'bar' as const, stack: 'permit', data: rows.map((r: any) => r.permitSubmitted), itemStyle: { color: '#3b82f6' } },
      { name: 'Permit Approved', type: 'bar' as const, data: rows.map((r: any) => r.permitApproved), itemStyle: { color: '#10b981', borderRadius: [4, 4, 0, 0] }, label: { show: true, position: 'top' as const, fontSize: 9, color: '#047857', formatter: (x: any) => x.value ? String(x.value) : '' } },
      { name: 'Revision Submitted', type: 'bar' as const, stack: 'rev', data: rows.map((r: any) => r.revisionsSubmitted), itemStyle: { color: '#f59e0b' } },
      { name: 'Revision Approved', type: 'bar' as const, stack: 'rev', data: rows.map((r: any) => r.revisionsApproved), itemStyle: { color: '#0f766e', borderRadius: [4, 4, 0, 0] } },
    ],
  }
})

const slaBoxChart = computed(() => {
  const d = slaBoxSlice.value
  return {
    tooltip: {
      trigger: 'item' as const,
      formatter: (p: any) => {
        const row = d[p.dataIndex] || {}
        return `<b>${p.name}</b><br/>${row.pctMet ?? 0}% met (${row.met ?? 0}/${row.count ?? 0})<br/>` +
          `Mean: ${row.mean ?? '-'} biz days<br/>Min: ${p.value?.[0] ?? '-'}<br/>P25: ${p.value?.[1] ?? '-'}<br/>P50: ${p.value?.[2] ?? '-'}<br/>P90: ${p.value?.[3] ?? '-'}<br/>Max: ${p.value?.[4] ?? '-'}`
      },
    },
    grid: { top: 12, right: 14, bottom: 5, left: 5, containLabel: true },
    xAxis: { type: 'category' as const, data: d.map((r: any) => fp(r.period)), axisLabel: { fontSize: 9 } },
    yAxis: { type: 'value' as const, name: 'biz days', nameTextStyle: { fontSize: 9 }, axisLabel: { fontSize: 9 } },
    series: [
      {
        type: 'boxplot' as const,
        data: d.map((r: any) => [r.p0, r.p25, r.p50, r.p90, r.p100]),
        itemStyle: { color: '#0f766e', borderColor: '#0f766e' },
        markLine: {
          symbol: 'none',
          label: { formatter: '1b SLA', fontSize: 9, color: '#dc2626' },
          lineStyle: { color: '#dc2626', type: 'dashed' as const },
          data: [{ yAxis: 1 }],
        },
      },
      { type: 'scatter' as const, data: d.map((r: any, i: number) => [i, r.mean ?? 0]), symbol: 'diamond', symbolSize: 8, itemStyle: { color: '#ef4444' }, tooltip: { show: false } },
    ],
  }
})

const approvalBoxChart = computed(() => {
  const d = approvalBoxSlice.value
  return {
    tooltip: { trigger: 'item' as const, formatter: (p: any) => `<b>${p.name}</b><br/>Mean: ${d[p.dataIndex]?.mean ?? '-'} biz days<br/>Min: ${p.value?.[0] ?? '-'}<br/>P25: ${p.value?.[1] ?? '-'}<br/>P50: ${p.value?.[2] ?? '-'}<br/>P90: ${p.value?.[3] ?? '-'}<br/>Max: ${p.value?.[4] ?? '-'}` },
    grid: { top: 12, right: 14, bottom: 5, left: 5, containLabel: true },
    xAxis: { type: 'category' as const, data: d.map((r: any) => fp(r.period)), axisLabel: { fontSize: 9 } },
    yAxis: { type: 'value' as const, name: 'biz days', nameTextStyle: { fontSize: 9 }, axisLabel: { fontSize: 9 } },
    series: [
      { type: 'boxplot' as const, data: d.map((r: any) => [r.p0, r.p25, r.p50, r.p90, r.p100]), itemStyle: { color: '#3b82f6', borderColor: '#3b82f6' } },
      { type: 'scatter' as const, data: d.map((r: any, i: number) => [i, r.mean ?? 0]), symbol: 'diamond', symbolSize: 8, itemStyle: { color: '#ef4444' }, tooltip: { show: false } },
    ],
  }
})

const agingChart = computed(() => {
  const rows = data.value.charts?.aging || []
  return {
    tooltip: { trigger: 'axis' as const },
    grid: { top: 14, right: 14, bottom: 5, left: 5, containLabel: true },
    xAxis: { type: 'category' as const, data: rows.map((r: any) => r.label), axisLabel: { fontSize: 10 } },
    yAxis: { type: 'value' as const, axisLabel: { fontSize: 9 } },
    series: [{
      type: 'bar' as const,
      data: rows.map((r: any) => r.count),
      itemStyle: { color: '#f59e0b', borderRadius: [4, 4, 0, 0] },
      label: { show: true, position: 'top' as const, fontSize: 9, color: '#b45309', formatter: (x: any) => x.value ? String(x.value) : '' },
    }],
  }
})

const phaseChart = computed(() => {
  const rows = [...queueRows.value].reverse()
  return {
    tooltip: { trigger: 'axis' as const, axisPointer: { type: 'shadow' as const } },
    grid: { top: 8, right: 16, bottom: 5, left: 5, containLabel: true },
    xAxis: { type: 'value' as const, axisLabel: { fontSize: 9 } },
    yAxis: { type: 'category' as const, data: rows.map((r: any) => r.label), axisLabel: { fontSize: 9 } },
    series: [{
      type: 'bar' as const,
      data: rows.map((r: any) => r.count),
      itemStyle: { color: '#475569', borderRadius: [0, 4, 4, 0] },
      label: { show: true, position: 'right' as const, fontSize: 9, color: '#334155', formatter: (x: any) => x.value ? String(x.value) : '' },
    }],
  }
})

const drillColumns: ColumnDef[] = [
  { key: 'customer_name', label: 'Customer' },
  { key: 'state', label: 'State', width: '60px' },
  { key: 'project_status', label: 'Status' },
  { key: 'ahj_name', label: 'AHJ' },
  { key: 'permit_user', label: 'User' },
  { key: 'phase_label', label: 'Phase' },
  { key: 'age_days', label: 'Age', align: 'right', format: (v) => `${Number(v || 0)}d`, toneClass: 'font-semibold' },
  { key: 'permit_sla_start', label: 'SLA Start', align: 'right', format: formatQueueDate },
  { key: 'permit_submitted', label: 'Permit Sub', align: 'right', format: formatQueueDate },
  { key: 'permit_approved', label: 'Permit Appr', align: 'right', format: formatQueueDate },
  { key: 'follow_up_due', label: 'Follow Up', align: 'right', format: formatQueueDate },
  { key: 'permit_submit_sla_days', label: 'SLA', align: 'right', format: formatBizDay },
  { key: 'permit_approval_days', label: 'Appr', align: 'right', format: formatBizDay },
  { key: 'permit_missing_items', label: 'Missing' },
]

const PHASE_BORDER: Record<string, string> = {
  unassigned: 'border-l-amber-500',
  ready: 'border-l-blue-500',
  need_submit: 'border-l-rose-500',
  pending_approval: 'border-l-blue-500',
  blocked: 'border-l-rose-500',
  follow_up: 'border-l-amber-500',
  revision: 'border-l-teal-500',
  installed_no_permit: 'border-l-red-600',
}

function rowAccent(row: Record<string, unknown>) {
  return PHASE_BORDER[String(row['phase'] || '')] || null
}

function selectProject(row: Record<string, unknown>) {
  const projectRid = Number(row['project_rid'] || 0)
  selectedProject.value = {
    ...row,
    record_id: projectRid || Number(row['record_id'] || 0),
    customer_name: String(row['customer_name'] || 'Project'),
  }
}

function queueToneClass(tone: string) {
  if (tone === 'danger') return 'text-rose-600 bg-rose-50'
  if (tone === 'warning') return 'text-amber-600 bg-amber-50'
  if (tone === 'success') return 'text-emerald-600 bg-emerald-50'
  if (tone === 'teal') return 'text-teal-600 bg-teal-50'
  if (tone === 'info') return 'text-blue-600 bg-blue-50'
  return 'text-slate-700 bg-slate-100'
}

onMounted(() => {
  setInitialRange()
  loadData()
})
</script>

<template>
  <MilestoneShell title="Permit" :show-freshness="true">
    <template #filters>
      <MilestoneFilterBar
        :filters="filterDefs"
        :extra-active="extraActive"
        @update="onFilter"
        @reset="resetAll"
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
        <div v-for="i in 4" :key="i" class="rounded-xl bg-card h-40 animate-pulse" />
      </div>

      <div v-else-if="errorMsg" class="rounded-xl bg-card px-4 py-6 text-sm text-rose-600">
        {{ errorMsg }}
      </div>

      <template v-else>
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
          <button
            v-for="q in queueRows"
            :key="q.key"
            type="button"
            class="rounded-xl bg-card p-3 text-left hover:bg-muted/30 active:scale-[0.99] transition cursor-pointer min-w-0"
            @click="onKpiDrill(q.key)"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground truncate">{{ q.label }}</p>
                <p class="mt-1 text-[12px] text-muted-foreground leading-snug">{{ q.description }}</p>
              </div>
              <span class="shrink-0 rounded-md px-2 py-1 text-lg font-extrabold tabular-nums" :class="queueToneClass(q.tone)">
                {{ q.count }}
              </span>
            </div>
            <div class="mt-3 grid grid-cols-3 gap-1.5 text-[10px] tabular-nums">
              <div class="rounded-md bg-muted/40 px-2 py-1 min-w-0">
                <p class="uppercase tracking-wider text-muted-foreground">Avg</p>
                <p class="font-semibold">{{ q.avgAge }}d</p>
              </div>
              <div class="rounded-md bg-muted/40 px-2 py-1 min-w-0">
                <p class="uppercase tracking-wider text-muted-foreground">Oldest</p>
                <p class="font-semibold">{{ q.oldest }}d</p>
              </div>
              <div class="rounded-md bg-muted/40 px-2 py-1 min-w-0">
                <p class="uppercase tracking-wider text-muted-foreground">Stale</p>
                <p class="font-semibold" :class="q.stale ? 'text-rose-600' : ''">{{ q.stale }}</p>
              </div>
            </div>
          </button>
        </div>

        <div class="grid grid-cols-1 xl:grid-cols-3 gap-3">
          <div class="xl:col-span-2 rounded-xl bg-card p-3">
            <div class="flex items-baseline justify-between gap-2 mb-2">
              <h3 class="text-xs font-semibold">Permit throughput</h3>
              <p class="text-[10px] text-muted-foreground">{{ dateFrom || 'All' }} -> {{ dateTo || 'Today' }}</p>
            </div>
            <VChart :option="throughputChart" style="height:220px" autoresize @click="onThroughputClick" />
          </div>
          <div class="rounded-xl bg-card p-3">
            <h3 class="text-xs font-semibold mb-2">Queue shape</h3>
            <VChart :option="phaseChart" style="height:220px" autoresize />
          </div>
        </div>

        <div class="grid grid-cols-1 xl:grid-cols-2 gap-3">
          <div class="rounded-xl bg-card p-3">
            <div class="flex items-start justify-between gap-2 mb-2">
              <div>
                <h3 class="text-xs font-semibold">Initial design complete -> permit submitted</h3>
                <p class="text-[10px] text-muted-foreground">Primary SLA: 1 business day · {{ data.kpi.sla?.count ?? 0 }} completed samples</p>
              </div>
            </div>
            <VChart :option="slaBoxChart" style="height:220px" autoresize />
            <div v-if="slaBoxSlice.length" class="overflow-x-auto no-scrollbar mt-1">
              <table class="w-full text-[10px]" style="table-layout:fixed">
                <tbody>
                  <tr>
                    <td v-for="r in slaBoxSlice" :key="'mean-' + r.period" class="text-center text-red-600 font-bold py-0.5">{{ r.mean ?? '-' }}</td>
                  </tr>
                  <tr>
                    <td v-for="r in slaBoxSlice" :key="'pct-' + r.period" class="text-center text-muted-foreground py-0.5">{{ r.pctMet }}%</td>
                  </tr>
                </tbody>
              </table>
              <div class="flex gap-4 mt-1 text-[9px] text-muted-foreground">
                <span class="flex items-center gap-1"><span class="inline-block w-2 h-2 bg-red-500 rotate-45" /> Mean business days</span>
                <span>% = permit submits within 1 business day</span>
              </div>
            </div>
            <div v-else class="py-8 text-center text-xs text-muted-foreground">No submitted permit SLA samples in this window.</div>
          </div>

          <div class="rounded-xl bg-card p-3">
            <h3 class="text-xs font-semibold mb-2">Permit approval turnaround</h3>
            <VChart :option="approvalBoxChart" style="height:220px" autoresize />
            <div v-if="approvalBoxSlice.length" class="overflow-x-auto no-scrollbar mt-1">
              <table class="w-full text-[10px]" style="table-layout:fixed">
                <tbody>
                  <tr>
                    <td v-for="r in approvalBoxSlice" :key="'approval-mean-' + r.period" class="text-center text-red-600 font-bold py-0.5">{{ r.mean ?? '-' }}</td>
                  </tr>
                  <tr>
                    <td v-for="r in approvalBoxSlice" :key="'approval-count-' + r.period" class="text-center text-muted-foreground py-0.5">n={{ r.count }}</td>
                  </tr>
                </tbody>
              </table>
              <div class="flex gap-4 mt-1 text-[9px] text-muted-foreground">
                <span class="flex items-center gap-1"><span class="inline-block w-2 h-2 bg-red-500 rotate-45" /> Mean business days</span>
                <span>Permit submitted -> permit approved</span>
              </div>
            </div>
            <div v-else class="py-8 text-center text-xs text-muted-foreground">No approved permit samples in this window.</div>
          </div>
        </div>

        <div class="grid grid-cols-1 xl:grid-cols-2 gap-3">
          <div class="rounded-xl bg-card p-3">
            <h3 class="text-xs font-semibold mb-2">Open work aging</h3>
            <VChart :option="agingChart" style="height:170px" autoresize @click="onAgingClick" />
            <table class="w-full mt-2 text-[11px] tabular-nums">
              <thead class="text-muted-foreground">
                <tr>
                  <th class="text-left font-semibold py-1">Age</th>
                  <th class="text-right font-semibold py-1">Open</th>
                  <th class="text-right font-semibold py-1">Need</th>
                  <th class="text-right font-semibold py-1">Pending</th>
                  <th class="text-right font-semibold py-1">Blocked</th>
                  <th class="text-right font-semibold py-1">FU</th>
                  <th class="text-right font-semibold py-1">Rev</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="b in data.charts.aging"
                  :key="b.label"
                  class="border-t border-border/30 hover:bg-muted/30 cursor-pointer"
                  @click="onAgingClick({ name: b.label })"
                >
                  <td class="py-1 font-medium">{{ b.label }}d</td>
                  <td class="py-1 text-right font-semibold">{{ b.count }}</td>
                  <td class="py-1 text-right text-rose-600">{{ b.needSubmit }}</td>
                  <td class="py-1 text-right text-blue-600">{{ b.pending }}</td>
                  <td class="py-1 text-right text-red-600">{{ b.blocked }}</td>
                  <td class="py-1 text-right text-amber-600">{{ b.followUp }}</td>
                  <td class="py-1 text-right text-teal-600">{{ b.revisions }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="rounded-xl bg-card overflow-hidden">
            <div class="px-3 py-2 border-b flex items-baseline justify-between gap-2">
              <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Permit user performance</p>
              <p class="text-[10px] text-muted-foreground">SLA = design -> submitted</p>
            </div>
            <div class="overflow-x-auto">
              <table class="w-full text-[11px] tabular-nums">
                <thead class="bg-muted/30 text-muted-foreground">
                  <tr>
                    <th class="text-left font-medium px-3 py-2">User</th>
                    <th class="text-right font-medium px-2 py-2">Open</th>
                    <th class="text-right font-medium px-2 py-2">Need</th>
                    <th class="text-right font-medium px-2 py-2">Pend</th>
                    <th class="text-right font-medium px-2 py-2">Block</th>
                    <th class="text-right font-medium px-2 py-2">SLA</th>
                    <th class="text-right font-medium px-2 py-2">Med</th>
                    <th class="text-right font-medium px-2 py-2">Appr</th>
                  </tr>
                </thead>
                <tbody class="divide-y">
                  <tr
                    v-for="r in userRows"
                    :key="r.name"
                    class="hover:bg-muted/30 cursor-pointer"
                    @click="onFilter('permit_user', r.name)"
                  >
                    <td class="px-3 py-1.5 font-medium truncate max-w-[150px]" :title="r.name">{{ r.name }}</td>
                    <td class="px-2 py-1.5 text-right font-semibold">{{ r.open }}</td>
                    <td class="px-2 py-1.5 text-right text-rose-600">{{ r.need }}</td>
                    <td class="px-2 py-1.5 text-right text-blue-600">{{ r.pending }}</td>
                    <td class="px-2 py-1.5 text-right text-red-600">{{ r.blocked }}</td>
                    <td class="px-2 py-1.5 text-right" :class="rateClass(r.slaPct, r.slaTotal)">{{ formatRate(r.slaPct, r.slaTotal) }}</td>
                    <td class="px-2 py-1.5 text-right text-muted-foreground">{{ r.slaTotal ? formatBizDay(r.slaMedian) : '-' }}</td>
                    <td class="px-2 py-1.5 text-right text-emerald-600">{{ r.approved }}</td>
                  </tr>
                  <tr v-if="!userRows.length">
                    <td colspan="8" class="px-3 py-6 text-center text-muted-foreground">No permit user rows.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="rounded-xl bg-card overflow-hidden">
          <div class="px-3 py-2 border-b flex items-baseline justify-between gap-2">
            <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">AHJ turntime</p>
            <p class="text-[10px] text-muted-foreground">{{ ahjRows.length }} AHJ buckets</p>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-[11px] tabular-nums">
              <thead class="bg-muted/30 text-muted-foreground">
                <tr>
                  <th class="text-left font-medium px-3 py-2">AHJ</th>
                  <th class="text-left font-medium px-2 py-2">St</th>
                  <th class="text-right font-medium px-2 py-2">Open</th>
                  <th class="text-right font-medium px-2 py-2">Pend</th>
                  <th class="text-right font-medium px-2 py-2">Block</th>
                  <th class="text-right font-medium px-2 py-2">Approved</th>
                  <th class="text-right font-medium px-2 py-2">SLA</th>
                  <th class="text-right font-medium px-2 py-2">P50</th>
                  <th class="text-right font-medium px-2 py-2">P90</th>
                </tr>
              </thead>
              <tbody class="divide-y">
                <tr
                  v-for="r in ahjRows"
                  :key="r.ahj"
                  class="hover:bg-muted/30 cursor-pointer"
                  @click="onFilter('ahj', r.ahj)"
                >
                  <td class="px-3 py-1.5 font-medium truncate max-w-[260px]" :title="r.ahj">{{ r.ahj }}</td>
                  <td class="px-2 py-1.5 text-muted-foreground">{{ r.state || '-' }}</td>
                  <td class="px-2 py-1.5 text-right font-semibold">{{ r.open }}</td>
                  <td class="px-2 py-1.5 text-right text-blue-600">{{ r.pending }}</td>
                  <td class="px-2 py-1.5 text-right text-red-600">{{ r.blocked }}</td>
                  <td class="px-2 py-1.5 text-right text-emerald-600">{{ r.approved }}</td>
                  <td class="px-2 py-1.5 text-right" :class="rateClass(r.slaPct, r.slaTotal)">{{ formatRate(r.slaPct, r.slaTotal) }}</td>
                  <td class="px-2 py-1.5 text-right text-muted-foreground">{{ r.approvalMedian ? formatBizDay(r.approvalMedian) : '-' }}</td>
                  <td class="px-2 py-1.5 text-right text-muted-foreground">{{ r.approvalP90 ? formatBizDay(r.approvalP90) : '-' }}</td>
                </tr>
                <tr v-if="!ahjRows.length">
                  <td colspan="9" class="px-3 py-6 text-center text-muted-foreground">No AHJ rows.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <p class="text-[10px] text-muted-foreground">
          Source: {{ data.meta?.source }} · {{ data.meta?.total ?? 0 }} rows · fetched {{ data.meta?.fetchedAt ? fmtDate(data.meta.fetchedAt) : '-' }}
        </p>
      </template>
    </template>

    <template #drill>
      <MilestoneProjectsTable
        v-if="drillLabel"
        :title="drillLabel"
        :columns="drillColumns"
        :projects="drillProjects as Array<Record<string, unknown> & { record_id: number; customer_name: string }>"
        :loading="drillLoading"
        :row-accent="rowAccent"
        @select="selectProject"
        @close="clearDrill"
      />
    </template>
  </MilestoneShell>

  <ProjectDetailDialog
    :project="selectedProject as any"
    @update:open="(v) => { if (!v) selectedProject = null }"
  />
</template>

<style scoped>
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
.no-scrollbar::-webkit-scrollbar { display: none; }
</style>
