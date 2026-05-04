<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { BarChart, BoxplotChart, ScatterChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import VChart from 'vue-echarts'

import MilestoneShell from '@/components/milestone/MilestoneShell.vue'
import MilestoneFilterBar, { type FilterDef } from '@/components/milestone/MilestoneFilterBar.vue'
import MilestoneDatePresetBar from '@/components/milestone/MilestoneDatePresetBar.vue'
import MilestoneKpiStrip from '@/components/milestone/MilestoneKpiStrip.vue'
import MilestoneProjectsTable, { type ColumnDef } from '@/components/milestone/MilestoneProjectsTable.vue'
import ProjectDetailDialog from '@/components/milestone/ProjectDetailDialog.vue'
import { fmtDate, fmtDateFull } from '@/lib/dates'

use([CanvasRenderer, BarChart, BoxplotChart, ScatterChart, GridComponent, TooltipComponent, LegendComponent])

const auth = useAuthStore()

const loading = ref(true)
const errorMsg = ref('')
const data = ref<any>({
  kpi: {},
  queues: [],
  charts: { throughput: [], aging: [], slaBoxes: {} },
  pivot: { designers: [], designTypes: [] },
  lists: {},
  filters: { states: [], epcs: [], designers: [], designTypes: [] },
  meta: {},
})

const fState = ref('')
const fEpc = ref('Kin Home')
const fDesigner = ref('')
const fDesignType = ref('')
const datePreset = ref('last_30')
const dateFrom = ref('')
const dateTo = ref('')
const useBizDays = ref(false)
const drillLabel = ref('')
const drillProjects = ref<any[]>([])
const drillLoading = ref(false)
const selectedProject = ref<Record<string, unknown> | null>(null)
const activeSlaMetric = ref<'ssToCad' | 'cadToDesign' | 'ssToDesign'>('ssToDesign')

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
  if (fDesigner.value) p.set('designer', fDesigner.value)
  if (fDesignType.value) p.set('design_type', fDesignType.value)
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
    const res = await fetch(`/api/analytics/design?${apiParams()}`, { headers: hdrs() })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error || 'Failed to load Design analytics')
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
  { key: 'designer', placeholder: 'Designer', allLabel: 'All Designers', options: data.value.filters?.designers || [], value: fDesigner.value },
  { key: 'design_type', placeholder: 'Type', allLabel: 'All Types', options: data.value.filters?.designTypes || [], value: fDesignType.value },
])

const extraActive = computed(() => datePreset.value !== 'last_30' || useBizDays.value)

const slaMetricDefs = [
  { key: 'ssToCad', label: 'SS Sub → Initial CAD Complete', short: 'SS→CAD', target: 1 },
  { key: 'cadToDesign', label: 'Initial CAD Complete → Design Complete', short: 'CAD→Design', target: 1 },
  { key: 'ssToDesign', label: 'SS Sub → Initial Design Complete', short: 'SS→Design', target: 2 },
] as const

function slaDef(key: string) {
  return slaMetricDefs.find(m => m.key === key) || slaMetricDefs[2]
}

function slaTone(summary: any) {
  const pct = Number(summary?.pctMet || 0)
  if (!summary?.count) return 'neutral' as const
  if (pct >= 90) return 'success' as const
  if (pct >= 75) return 'warning' as const
  return 'danger' as const
}

function fmtSlaPct(summary: any): string {
  return summary?.count ? `${summary.pctMet}%` : '—'
}

function fmtSlaSub(summary: any): string {
  if (!summary?.count && !summary?.openMisses) return 'no sample'
  const base = summary?.count ? `${summary.met}/${summary.count} met` : 'no completed'
  return summary?.openMisses ? `${base} · ${summary.openMisses} open over` : base
}

function onFilter(key: string, value: string) {
  if (key === 'epc') fEpc.value = value
  else if (key === 'state') fState.value = value
  else if (key === 'designer') fDesigner.value = value
  else if (key === 'design_type') fDesignType.value = value
  clearDrill()
  loadData()
}

function resetAll() {
  fState.value = ''
  fEpc.value = 'Kin Home'
  fDesigner.value = ''
  fDesignType.value = ''
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

const kpiTiles = computed(() => {
  const k = data.value.kpi || {}
  const tiles = [
    { key: 'open', label: 'Open', value: k.open ?? 0, sub: `${k.avgAge ?? 0}d avg`, tone: 'neutral' as const, drill: true },
    { key: 'stuck', label: 'Stuck', value: k.stale ?? 0, sub: `${k.oldest ?? 0}d oldest`, tone: 'danger' as const, drill: true, bg: k.stale ? 'danger-soft' as const : 'card' as const },
    { key: 'completed', label: 'Complete', value: k.completed ?? 0, sub: 'in window', tone: 'success' as const },
  ]
  for (const key of ['readyCad', 'inCad', 'pendingEng', 'inEng', 'qaAudit']) {
    const q = queueByKey(key)
    if (!q) continue
    tiles.push({
      key,
      label: q.label,
      value: q.count,
      sub: `${q.stale} stale`,
      tone: q.tone,
      drill: true,
      bg: key === 'qaAudit' && q.count ? 'danger-soft' as const : 'card' as const,
    })
  }
  for (const metric of slaMetricDefs) {
    const s = k.sla?.[metric.key] || {}
    tiles.push({
      key: metric.key,
      label: metric.short,
      value: fmtSlaPct(s),
      sub: fmtSlaSub(s),
      tone: slaTone(s),
      drill: !!(s.misses || s.openMisses),
      bg: s.openMisses ? 'danger-soft' as const : 'card' as const,
    })
  }
  return tiles
})

const queueRows = computed(() => data.value.queues || [])
const dayUnit = computed(() => useBizDays.value ? 'biz days' : 'days')

function formatQueueDate(value: unknown): string {
  return fmtDateFull(String(value || ''))
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
  if (key === 'open') setDrill('Open design queue', data.value.lists?.open || [])
  else if (key === 'stuck') setDrill('Stuck design work', data.value.lists?.stuck || [])
  else if (slaMetricDefs.some(m => m.key === key)) {
    const def = slaDef(key)
    setDrill(`${def.label} · SLA misses`, data.value.lists?.[`${key}Miss`] || [])
  }
  else {
    const q = queueByKey(key)
    setDrill(q?.label || key, data.value.lists?.[key] || [])
  }
}

async function drillPeriod(period: string, label: string) {
  drillLabel.value = label
  drillLoading.value = true
  drillProjects.value = []
  try {
    const res = await fetch(`/api/analytics/design/drill?${apiParams({ period })}`, { headers: hdrs() })
    if (!res.ok) return
    const json = await res.json()
    drillProjects.value = json.projects || []
  } finally {
    drillLoading.value = false
  }
  await nextTick()
  document.getElementById('milestone-projects-table')?.scrollIntoView({ behavior: 'smooth' })
}

function onThroughputClick(p: { dataIndex: number; name: string }) {
  const row = data.value.charts?.throughput?.[p.dataIndex]
  if (!row?.period) return
  drillPeriod(row.period, `Completed · ${p.name}`)
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
    legend: { data: ['CAD Complete', 'ENG Complete', 'Design Complete'], top: 0, textStyle: { fontSize: 9 } },
    grid: { top: 28, right: 14, bottom: 5, left: 5, containLabel: true },
    xAxis: { type: 'category' as const, data: rows.map((r: any) => fp(r.period)), axisLabel: { fontSize: 9, rotate: rows.length > 6 ? 45 : 0 } },
    yAxis: { type: 'value' as const, axisLabel: { fontSize: 9 } },
    series: [
      { name: 'CAD Complete', type: 'bar' as const, stack: 'done', data: rows.map((r: any) => r.cadCompleted), itemStyle: { color: '#3b82f6' } },
      { name: 'ENG Complete', type: 'bar' as const, stack: 'done', data: rows.map((r: any) => r.engCompleted), itemStyle: { color: '#8b5cf6' } },
      { name: 'Design Complete', type: 'bar' as const, data: rows.map((r: any) => r.designCompleted), itemStyle: { color: '#10b981', borderRadius: [4, 4, 0, 0] }, label: { show: true, position: 'top' as const, fontSize: 9, color: '#047857', formatter: (x: any) => x.value ? String(x.value) : '' } },
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

const activeSlaDef = computed(() => slaDef(activeSlaMetric.value))
const activeSlaSummary = computed(() => data.value.kpi?.sla?.[activeSlaMetric.value] || {})
const slaBoxSlice = computed(() => (data.value.charts?.slaBoxes?.[activeSlaMetric.value] || []).slice(-13))
const designerSlaRows = computed(() => {
  return (data.value.pivot?.designers || [])
    .filter((r: any) => r.cadSlaTotal || r.designSlaTotal || r.endToEndSlaTotal)
    .sort((a: any, b: any) => (b.endToEndSlaTotal || 0) - (a.endToEndSlaTotal || 0) || (b.completed || 0) - (a.completed || 0))
})

function formatSlaDay(value: unknown): string {
  return value === null || value === undefined || value === '' ? '—' : `${Number(value)}b`
}

function slaRateText(pct: unknown, total: unknown): string {
  return Number(total || 0) ? `${Number(pct || 0)}%` : '—'
}

function slaRateClass(pct: unknown, total: unknown): string {
  if (!Number(total || 0)) return 'text-muted-foreground'
  const n = Number(pct || 0)
  if (n >= 90) return 'text-emerald-600 font-semibold'
  if (n >= 75) return 'text-amber-600 font-semibold'
  return 'text-rose-600 font-semibold'
}

const slaBoxChart = computed(() => {
  const d = slaBoxSlice.value
  const def = activeSlaDef.value
  return {
    tooltip: {
      trigger: 'item' as const,
      formatter: (p: any) => {
        const row = d[p.dataIndex] || {}
        return `<b>${p.name}</b><br/>${row.pctMet ?? 0}% met (${row.met ?? 0}/${row.count ?? 0})<br/>` +
          `Mean: ${row.mean ?? '—'} biz days<br/>Min: ${p.value?.[0] ?? '—'}<br/>P25: ${p.value?.[1] ?? '—'}<br/>P50: ${p.value?.[2] ?? '—'}<br/>P90: ${p.value?.[3] ?? '—'}<br/>Max: ${p.value?.[4] ?? '—'}`
      },
    },
    grid: { top: 12, bottom: 5, left: 5, right: 10, containLabel: true },
    xAxis: { type: 'category' as const, data: d.map((r: any) => fp(r.period)), axisLabel: { fontSize: 9 } },
    yAxis: { type: 'value' as const, name: 'biz days', nameTextStyle: { fontSize: 9 }, axisLabel: { fontSize: 9 } },
    series: [
      {
        type: 'boxplot' as const,
        data: d.map((r: any) => [r.p0, r.p25, r.p50, r.p90, r.p100]),
        itemStyle: { color: '#0f766e', borderColor: '#0f766e' },
        markLine: {
          symbol: 'none',
          label: { formatter: `${def.target}b SLA`, fontSize: 9, color: '#dc2626' },
          lineStyle: { color: '#dc2626', type: 'dashed' as const },
          data: [{ yAxis: def.target }],
        },
      },
      {
        type: 'scatter' as const,
        data: d.map((r: any, i: number) => [i, r.mean ?? 0]),
        symbol: 'diamond',
        symbolSize: 8,
        itemStyle: { color: '#ef4444' },
        tooltip: { show: false },
      },
    ],
  }
})

const drillColumns: ColumnDef[] = [
  { key: 'customer_name', label: 'Customer' },
  { key: 'state', label: 'State', width: '60px' },
  { key: 'project_status', label: 'Status' },
  { key: 'design_type', label: 'Type' },
  { key: 'phase_label', label: 'Phase' },
  { key: 'assigned_designer', label: 'Designer' },
  { key: 'age_days', label: 'Age', align: 'right', format: (v) => `${Number(v || 0)}d`, toneClass: 'font-semibold' },
  { key: 'survey_scheduled', label: 'SS Sched', align: 'right', format: formatQueueDate },
  { key: 'survey_submitted', label: 'SS Sub', align: 'right', format: formatQueueDate },
  { key: 'cad_sla_start', label: 'SLA Start', align: 'right', format: formatQueueDate },
  { key: 'survey_approved', label: 'SS Appr', align: 'right', format: formatQueueDate },
  { key: 'cad_started', label: 'CAD Start', align: 'right', format: formatQueueDate },
  { key: 'cad_completed', label: 'CAD Done', align: 'right', format: formatQueueDate },
  { key: 'engineering_submitted', label: 'ENG Sub', align: 'right', format: formatQueueDate },
  { key: 'sla_ss_to_cad_days', label: 'SS→CAD', align: 'right', format: formatSlaDay },
  { key: 'sla_cad_to_design_days', label: 'CAD→Des', align: 'right', format: formatSlaDay },
  { key: 'sla_ss_to_design_days', label: 'SS→Des', align: 'right', format: formatSlaDay },
]

const PHASE_BORDER: Record<string, string> = {
  ss_pending: 'border-l-amber-500',
  ready_cad: 'border-l-blue-500',
  cad_work: 'border-l-teal-500',
  pending_eng: 'border-l-amber-500',
  engineering: 'border-l-violet-500',
  qa_audit: 'border-l-rose-500',
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
  <MilestoneShell
    title="Design & Engineering"
    :show-freshness="true"
  >
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
              <h3 class="text-xs font-semibold">Design throughput</h3>
              <p class="text-[10px] text-muted-foreground">{{ dateFrom || 'All' }} → {{ dateTo || 'Today' }}</p>
            </div>
            <VChart :option="throughputChart" style="height:220px" autoresize @click="onThroughputClick" />
          </div>
          <div class="rounded-xl bg-card p-3">
            <h3 class="text-xs font-semibold mb-2">Queue shape</h3>
            <VChart :option="phaseChart" style="height:220px" autoresize />
          </div>
        </div>

        <div class="grid grid-cols-1 xl:grid-cols-3 gap-3">
          <div class="xl:col-span-2 rounded-xl bg-card p-3">
            <div class="flex items-start justify-between gap-2 mb-2">
              <div class="min-w-0">
                <h3 class="text-xs font-semibold">Design SLA performance</h3>
                <p class="text-[10px] text-muted-foreground truncate">
                  {{ activeSlaDef.label }} · target {{ activeSlaDef.target }} business {{ activeSlaDef.target === 1 ? 'day' : 'days' }} · {{ activeSlaSummary.count ?? 0 }} completed
                </p>
              </div>
              <div class="flex gap-0.5 p-0.5 bg-muted rounded-lg shrink-0 overflow-x-auto no-scrollbar">
                <button
                  v-for="m in slaMetricDefs"
                  :key="m.key"
                  type="button"
                  class="px-2 py-0.5 text-[10px] font-medium rounded whitespace-nowrap"
                  :class="activeSlaMetric === m.key ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                  @click="activeSlaMetric = m.key"
                >
                  {{ m.short }}
                </button>
              </div>
            </div>
            <VChart :option="slaBoxChart" style="height:220px" autoresize />
            <div v-if="slaBoxSlice.length" class="overflow-x-auto no-scrollbar mt-1">
              <table class="w-full text-[10px]" style="table-layout:fixed">
                <tbody>
                  <tr>
                    <td v-for="r in slaBoxSlice" :key="'mean-' + r.period" class="text-center text-red-600 font-bold py-0.5">{{ r.mean ?? '—' }}</td>
                  </tr>
                  <tr>
                    <td v-for="r in slaBoxSlice" :key="'pct-' + r.period" class="text-center text-muted-foreground py-0.5">{{ r.pctMet }}%</td>
                  </tr>
                </tbody>
              </table>
              <div class="flex gap-4 mt-1 text-[9px] text-muted-foreground">
                <span class="flex items-center gap-1"><span class="inline-block w-2 h-2 bg-red-500 rotate-45" /> Mean business days</span>
                <span>% = completed within SLA for that period</span>
              </div>
            </div>
            <div v-else class="py-8 text-center text-xs text-muted-foreground">No completed SLA samples in this window.</div>
          </div>

          <div class="rounded-xl bg-card overflow-hidden">
            <div class="px-3 py-2 border-b flex items-baseline justify-between gap-2">
              <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Designer SLA</p>
              <p class="text-[10px] text-muted-foreground">business days</p>
            </div>
            <div class="overflow-x-auto">
              <table class="w-full text-[11px] tabular-nums">
                <thead class="bg-muted/30 text-muted-foreground">
                  <tr>
                    <th class="text-left font-medium px-3 py-2">Designer</th>
                    <th class="text-right font-medium px-2 py-2">SS→CAD</th>
                    <th class="text-right font-medium px-2 py-2">CAD→Des</th>
                    <th class="text-right font-medium px-2 py-2">SS→Des</th>
                    <th class="text-right font-medium px-2 py-2">Med</th>
                  </tr>
                </thead>
                <tbody class="divide-y">
                  <tr
                    v-for="r in designerSlaRows"
                    :key="r.name"
                    class="hover:bg-muted/30 cursor-pointer"
                    @click="onFilter('designer', r.name)"
                  >
                    <td class="px-3 py-1.5 font-medium truncate max-w-[140px]" :title="r.name">{{ r.name }}</td>
                    <td class="px-2 py-1.5 text-right" :class="slaRateClass(r.cadSlaPct, r.cadSlaTotal)">{{ slaRateText(r.cadSlaPct, r.cadSlaTotal) }}</td>
                    <td class="px-2 py-1.5 text-right" :class="slaRateClass(r.designSlaPct, r.designSlaTotal)">{{ slaRateText(r.designSlaPct, r.designSlaTotal) }}</td>
                    <td class="px-2 py-1.5 text-right" :class="slaRateClass(r.endToEndSlaPct, r.endToEndSlaTotal)">{{ slaRateText(r.endToEndSlaPct, r.endToEndSlaTotal) }}</td>
                    <td class="px-2 py-1.5 text-right text-muted-foreground">{{ r.endToEndSlaTotal ? formatSlaDay(r.endToEndSlaMedian) : '—' }}</td>
                  </tr>
                  <tr v-if="!designerSlaRows.length">
                    <td colspan="5" class="px-3 py-6 text-center text-muted-foreground">No completed initial-design SLA samples.</td>
                  </tr>
                </tbody>
              </table>
            </div>
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
                  <th class="text-right font-semibold py-1">Ready</th>
                  <th class="text-right font-semibold py-1">CAD</th>
                  <th class="text-right font-semibold py-1">ENG</th>
                  <th class="text-right font-semibold py-1">QA</th>
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
                  <td class="py-1 text-right text-blue-600">{{ b.readyCad }}</td>
                  <td class="py-1 text-right text-teal-600">{{ b.inCad }}</td>
                  <td class="py-1 text-right text-violet-600">{{ b.inEng }}</td>
                  <td class="py-1 text-right text-rose-600">{{ b.qaAudit }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="rounded-xl bg-card overflow-hidden">
            <div class="px-3 py-2 border-b flex items-baseline justify-between gap-2">
              <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Designer load</p>
              <p class="text-[10px] text-muted-foreground">{{ dayUnit }}</p>
            </div>
            <div class="overflow-x-auto">
              <table class="w-full text-[11px] tabular-nums">
                <thead class="bg-muted/30 text-muted-foreground">
                  <tr>
                    <th class="text-left font-medium px-3 py-2">Designer</th>
                    <th class="text-right font-medium px-2 py-2">Open</th>
                    <th class="text-right font-medium px-2 py-2">CAD</th>
                    <th class="text-right font-medium px-2 py-2">ENG</th>
                    <th class="text-right font-medium px-2 py-2">QA</th>
                    <th class="text-right font-medium px-2 py-2">Stale</th>
                    <th class="text-right font-medium px-2 py-2">Done</th>
                    <th class="text-right font-medium px-2 py-2">Avg</th>
                  </tr>
                </thead>
                <tbody class="divide-y">
                  <tr
                    v-for="r in data.pivot.designers"
                    :key="r.name"
                    class="hover:bg-muted/30 cursor-pointer"
                    @click="onFilter('designer', r.name)"
                  >
                    <td class="px-3 py-1.5 font-medium truncate max-w-[160px]" :title="r.name">{{ r.name }}</td>
                    <td class="px-2 py-1.5 text-right font-semibold">{{ r.open }}</td>
                    <td class="px-2 py-1.5 text-right text-teal-600">{{ r.cad }}</td>
                    <td class="px-2 py-1.5 text-right text-violet-600">{{ r.eng }}</td>
                    <td class="px-2 py-1.5 text-right text-rose-600">{{ r.qa }}</td>
                    <td class="px-2 py-1.5 text-right" :class="r.stale ? 'text-rose-600 font-semibold' : 'text-muted-foreground'">{{ r.stale }}</td>
                    <td class="px-2 py-1.5 text-right text-emerald-600">{{ r.completed }}</td>
                    <td class="px-2 py-1.5 text-right text-muted-foreground">{{ r.avgAge }}d</td>
                  </tr>
                  <tr v-if="!data.pivot.designers.length">
                    <td colspan="8" class="px-3 py-6 text-center text-muted-foreground">No designer rows.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="rounded-xl bg-card overflow-hidden">
          <div class="px-3 py-2 border-b flex items-baseline justify-between gap-2">
            <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Design type mix</p>
            <p class="text-[10px] text-muted-foreground">{{ data.meta?.filtered ?? 0 }} matching rows</p>
          </div>
          <div class="sm:hidden divide-y">
            <button
              v-for="r in data.pivot.designTypes"
              :key="r.designType"
              type="button"
              class="w-full text-left px-3 py-2 hover:bg-muted/30"
              @click="onFilter('design_type', r.designType)"
            >
              <p class="font-semibold text-[13px]">{{ r.designType }}</p>
              <div class="grid grid-cols-4 gap-1.5 mt-1 text-[10px] tabular-nums">
                <div class="rounded bg-muted/30 px-2 py-1"><p class="text-muted-foreground">Open</p><p class="font-semibold">{{ r.open }}</p></div>
                <div class="rounded bg-muted/30 px-2 py-1"><p class="text-muted-foreground">Stale</p><p class="font-semibold">{{ r.stale }}</p></div>
                <div class="rounded bg-muted/30 px-2 py-1"><p class="text-muted-foreground">Done</p><p class="font-semibold">{{ r.completed }}</p></div>
                <div class="rounded bg-muted/30 px-2 py-1"><p class="text-muted-foreground">Avg</p><p class="font-semibold">{{ r.avgAge }}d</p></div>
              </div>
            </button>
          </div>
          <div class="hidden sm:block">
            <table class="w-full text-[11px] tabular-nums">
              <thead class="bg-muted/30 text-muted-foreground">
                <tr>
                  <th class="text-left font-medium px-3 py-2">Type</th>
                  <th class="text-right font-medium px-2 py-2">Open</th>
                  <th class="text-right font-medium px-2 py-2">Stale</th>
                  <th class="text-right font-medium px-2 py-2">Completed</th>
                  <th class="text-right font-medium px-2 py-2">Avg Age</th>
                </tr>
              </thead>
              <tbody class="divide-y">
                <tr
                  v-for="r in data.pivot.designTypes"
                  :key="r.designType"
                  class="hover:bg-muted/30 cursor-pointer"
                  @click="onFilter('design_type', r.designType)"
                >
                  <td class="px-3 py-1.5 font-medium">{{ r.designType }}</td>
                  <td class="px-2 py-1.5 text-right font-semibold">{{ r.open }}</td>
                  <td class="px-2 py-1.5 text-right" :class="r.stale ? 'text-rose-600 font-semibold' : 'text-muted-foreground'">{{ r.stale }}</td>
                  <td class="px-2 py-1.5 text-right text-emerald-600">{{ r.completed }}</td>
                  <td class="px-2 py-1.5 text-right text-muted-foreground">{{ r.avgAge }}d</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <p class="text-[10px] text-muted-foreground">
          Source: {{ data.meta?.source }} · {{ data.meta?.total ?? 0 }} rows · fetched {{ data.meta?.fetchedAt ? fmtDate(data.meta.fetchedAt) : '—' }}
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
