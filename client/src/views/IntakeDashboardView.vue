<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { openProjectWithEvent } from '@/lib/openProject'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { BarChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import VChart from 'vue-echarts'
import { ChevronDown, ExternalLink, RefreshCw, RotateCcw, Search, X } from 'lucide-vue-next'

import MilestoneShell from '@/components/milestone/MilestoneShell.vue'
import MilestoneDatePresetBar from '@/components/milestone/MilestoneDatePresetBar.vue'
import MilestoneFilterBar, { type FilterDef } from '@/components/milestone/MilestoneFilterBar.vue'
import MilestoneKpiStrip from '@/components/milestone/MilestoneKpiStrip.vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useAuthStore } from '@/stores/auth'

use([CanvasRenderer, BarChart, GridComponent, LegendComponent, TooltipComponent])

interface FailedRun {
  record_id: number
  customer_name: string
  enerflo_record_id: string
  enerflo_install_id: string
  error_summary: string
  zapier_run_id: string
  org_id_created: string
  contact_id_created: string
  project_id_created: string
  junction_id_created: string
  notes: string
  payload_json: string
  payload_preview: Record<string, string>
  retry_status: string
  retry_triggered: boolean
  date_created: string
  date_modified: string
  age_days: number
  created_count: number
  missing_records: string[]
  partial_create: boolean
  qb_url: string
  org_url: string
  contact_url: string
  project_url: string
  junction_url: string
  enerflo_url: string
  phase: string
  phase_label: string
  retryable: boolean
}

interface IntakeProject {
  record_id: number
  customer_name: string
  state: string
  sales_office: string
  lender: string
  closer: string
  system_size_kw: number
  project_status: string
  intake_status: string
  sales_date: string
  intake_progress: number | null
  missing_items: string
  missing_items_list: string[]
  first_pass_user: string
  first_pass_missing_items: string
  first_pass_missing_items_list: string[]
  first_pass_disposition: string
  first_pass_complete: string
  first_pass_processing_time: string
  first_pass_started: string
  intake_start_hours: number | null
  intake_complete_hours: number | null
  first_pass_success: boolean
  first_pass_rejected: boolean
  max_intake_finished: string
  hours_since_last_event: number | null
  surrender_reference_date: string
  age_days: number
  project_url: string
  phase: string
  phase_label: string
}

interface ProcessingEvent {
  record_id: number
  project_rid: number | null
  customer_name: string
  project_status: string
  started_processing: string
  date_created: string
  age_hours: number | null
  completion_pct: number
  project_url: string
  intake_event_url: string
}

type IntakeDimension = 'closer' | 'salesOffice' | 'lender' | 'state'

const auth = useAuthStore()

const loading = ref(true)
const refreshing = ref(false)
const errorMsg = ref('')
const actionError = ref('')
const retryBusyId = ref<number | null>(null)
const data = ref<any>({
  kpi: {},
  queues: [],
  charts: { throughput: [], status: [], createdRecords: [] },
  intakeManager: { kpi: {}, performanceKpi: {}, queues: [], lists: {}, charts: { intakeThroughput: [] }, pivots: {}, rejectionReasons: [] },
  lists: { rows: [] },
  filters: { retryStatuses: [] },
  meta: {},
})

const retryStatus = ref('')
const searchText = ref('')
const appliedSearch = ref('')
const datePreset = ref('last_30')
const dateFrom = ref('')
const dateTo = ref('')
const drillLabel = ref('')
const drillRows = ref<FailedRun[]>([])
const managerLabel = ref('')
const managerKey = ref('inProcess')
const managerRows = ref<IntakeProject[]>([])
const processingRows = ref<ProcessingEvent[]>([])
const managerMode = ref<'projects' | 'processing'>('projects')
const selectedRun = ref<FailedRun | null>(null)
const dimension = ref<IntakeDimension>('closer')
const recoveryOpen = ref(false)

const dimensionOptions: Array<{ key: IntakeDimension; label: string }> = [
  { key: 'closer', label: 'Closer' },
  { key: 'salesOffice', label: 'Sales Office' },
  { key: 'lender', label: 'Lender' },
  { key: 'state', label: 'State' },
]
const chartResize = { throttle: 200 }

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

function fmtRunDate(value: string): string {
  if (!value || value === '0' || value === '-') return '—'
  const parsed = value.length === 10 && !value.includes('T') ? new Date(`${value}T12:00:00`) : new Date(value)
  if (Number.isNaN(parsed.getTime())) return '—'
  return parsed.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function fmtHours(value: number | null | undefined, preferDays = false): string {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (preferDays || n >= 24) return `${Math.round((n / 24) * 10) / 10}d`
  return `${Math.round(n * 10) / 10}h`
}

function fmtKw(value: number | null | undefined): string {
  const n = Number(value || 0)
  return n ? n.toFixed(1) : '0.0'
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
  if (dateFrom.value) p.set('date_from', dateFrom.value)
  if (dateTo.value) p.set('date_to', dateTo.value)
  if (retryStatus.value) p.set('retry_status', retryStatus.value)
  if (appliedSearch.value) p.set('search', appliedSearch.value)
  for (const [k, v] of Object.entries(extra || {})) p.set(k, v)
  return p
}

async function loadData(force = false) {
  if (force) refreshing.value = true
  else loading.value = true
  errorMsg.value = ''
  actionError.value = ''
  try {
    const params = apiParams(force ? { fresh: '1' } : undefined)
    const res = await fetch(`/api/intake/failed-runs?${params}`, { headers: hdrs() })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error || 'Failed to load Intake failed runs')
    data.value = json
    if (!drillLabel.value) drillRows.value = json.lists?.rows || []
    syncManagerRows(json)
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

const filterDefs = computed<FilterDef[]>(() => [
  { key: 'retry_status', placeholder: 'Retry', allLabel: 'All Statuses', options: data.value.filters?.retryStatuses || [], value: retryStatus.value },
])

const recoveryActive = computed(() => retryStatus.value !== '' || appliedSearch.value !== '')

function onFilter(key: string, value: string) {
  if (key === 'retry_status') retryStatus.value = value
  clearDrill()
  loadData()
}

function resetRecoveryFilters() {
  retryStatus.value = ''
  searchText.value = ''
  appliedSearch.value = ''
  clearDrill()
  loadData()
}

function onDateChange(payload: { preset: string; from: string; to: string }) {
  datePreset.value = payload.preset
  dateFrom.value = payload.from
  dateTo.value = payload.to
  clearDrill()
  loadData()
}

function applySearch() {
  appliedSearch.value = searchText.value.trim()
  clearDrill()
  loadData()
}

function clearSearch() {
  searchText.value = ''
  appliedSearch.value = ''
  clearDrill()
  loadData()
}

function setDrill(label: string, rows: FailedRun[]) {
  drillLabel.value = label
  drillRows.value = rows || []
  nextTick().then(() => document.getElementById('intake-failed-runs-table')?.scrollIntoView({ behavior: 'smooth' }))
}

function clearDrill() {
  drillLabel.value = ''
  drillRows.value = data.value.lists?.rows || []
}

function setManagerProjects(label: string, rows: IntakeProject[]) {
  managerLabel.value = label
  managerMode.value = 'projects'
  managerRows.value = rows || []
  processingRows.value = []
  nextTick().then(() => document.getElementById('intake-manager-table')?.scrollIntoView({ behavior: 'smooth' }))
}

function setManagerProcessing(label: string, rows: ProcessingEvent[]) {
  managerLabel.value = label
  managerMode.value = 'processing'
  processingRows.value = rows || []
  managerRows.value = []
  nextTick().then(() => document.getElementById('intake-manager-table')?.scrollIntoView({ behavior: 'smooth' }))
}

function onManagerQueue(key: string) {
  managerKey.value = key
  const lists = data.value.intakeManager?.lists || {}
  const q = (data.value.intakeManager?.queues || []).find((row: any) => row.key === key)
  const label = q?.label || key
  if (key === 'processingEvents') setManagerProcessing(label, lists.processingEvents || [])
  else setManagerProjects(label, lists[key] || [])
}

function syncManagerRows(source: any) {
  const key = managerKey.value || 'inProcess'
  const lists = source.intakeManager?.lists || {}
  const q = (source.intakeManager?.queues || []).find((row: any) => row.key === key)
  managerLabel.value = q?.label || (key === 'inProcess' ? 'All In-Process' : key)
  if (key === 'processingEvents') {
    managerMode.value = 'processing'
    processingRows.value = lists.processingEvents || []
    managerRows.value = []
  } else {
    managerMode.value = 'projects'
    managerRows.value = lists[key] || lists.inProcess || []
    processingRows.value = []
  }
}

function onKpiDrill(key: string) {
  const map: Record<string, { label: string; rows: FailedRun[] }> = {
    active: { label: 'Active failed runs', rows: data.value.lists?.active || [] },
    ready: { label: 'Pending retry', rows: data.value.lists?.pending || [] },
    triggered: { label: 'Retry triggered', rows: data.value.lists?.triggered || [] },
    failedAgain: { label: 'Failed again', rows: data.value.lists?.failedAgain || [] },
    partial: { label: 'Partial creates', rows: data.value.lists?.partial || [] },
    resolved: { label: 'Resolved', rows: data.value.lists?.resolved || [] },
  }
  const target = map[key]
  if (target) setDrill(target.label, target.rows)
}

const performanceKpiTiles = computed(() => {
  const k = data.value.intakeManager?.performanceKpi || {}
  return [
    { key: 'timeToStart', label: 'Time To Start', value: fmtHours(k.avgTimeToStartHours, true), sub: 'sold → intake start', tone: 'info' as const },
    { key: 'startToComplete', label: 'Start To Complete', value: fmtHours(k.avgStartToCompleteHours), sub: 'complete timestamp', tone: 'teal' as const },
    { key: 'uniqueProjects', label: 'Unique Projects', value: k.uniqueProjects ?? 0, sub: `${fmtKw(k.soldKw)} kW sold`, tone: 'neutral' as const },
    { key: 'intakeCompleted', label: '% Complete', value: `${k.intakeCompletedPct ?? 0}%`, sub: `${k.intakeCompleted ?? 0} completed`, tone: (k.intakeCompletedPct ?? 0) >= 85 ? 'success' as const : 'warning' as const },
    { key: 'rejectedStatus', label: 'Rejected', value: k.rejectedStatus ?? 0, sub: 'rejected status', tone: (k.rejectedStatus ?? 0) ? 'danger' as const : 'success' as const, bg: (k.rejectedStatus ?? 0) ? 'danger-soft' as const : 'card' as const },
  ]
})

const failedRunKpiTiles = computed(() => {
  const k = data.value.kpi || {}
  return [
    { key: 'active', label: 'Active', value: k.active ?? 0, sub: `${k.oldestActive ?? 0}d oldest`, tone: 'warning' as const, drill: true, bg: k.active ? 'danger-soft' as const : 'card' as const },
    { key: 'ready', label: 'Ready', value: k.ready ?? 0, sub: 'operator review', tone: 'info' as const, drill: true },
    { key: 'triggered', label: 'Triggered', value: k.triggered ?? 0, sub: 'Zap pickup', tone: 'teal' as const, drill: true },
    { key: 'failedAgain', label: 'Failed Again', value: k.failedAgain ?? 0, sub: 'needs attention', tone: 'danger' as const, drill: true, bg: k.failedAgain ? 'danger-soft' as const : 'card' as const },
    { key: 'partial', label: 'Partial', value: k.partial ?? 0, sub: 'skip created', tone: 'warning' as const, drill: true },
    { key: 'resolved', label: 'Resolved', value: k.resolvedWindow ?? 0, sub: `${k.retrySuccessPct ?? 0}% retry win`, tone: 'success' as const, drill: true },
  ]
})

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

const intakeThroughputChart = computed(() => {
  const rows = data.value.intakeManager?.charts?.intakeThroughput || []
  return {
    tooltip: { trigger: 'axis' as const, axisPointer: { type: 'shadow' as const } },
    legend: { data: ['Requested', 'Processed'], top: 0, textStyle: { fontSize: 10 } },
    grid: { top: 30, right: 14, bottom: 5, left: 5, containLabel: true },
    xAxis: { type: 'category' as const, data: rows.map((r: any) => fp(r.period)), axisLabel: { fontSize: 9, rotate: rows.length > 8 ? 45 : 0 } },
    yAxis: { type: 'value' as const, axisLabel: { fontSize: 9 } },
    series: [
      { name: 'Requested', type: 'bar' as const, data: rows.map((r: any) => r.requested), itemStyle: { color: '#2563eb', borderRadius: [4, 4, 0, 0] } },
      { name: 'Processed', type: 'bar' as const, data: rows.map((r: any) => r.processed), itemStyle: { color: '#10b981', borderRadius: [4, 4, 0, 0] } },
    ],
  }
})

const rejectionReasonChart = computed(() => {
  const rows = data.value.intakeManager?.rejectionReasons || []
  return {
    tooltip: { trigger: 'axis' as const, axisPointer: { type: 'shadow' as const } },
    grid: { top: 8, right: 24, bottom: 5, left: 5, containLabel: true },
    xAxis: { type: 'value' as const, axisLabel: { fontSize: 9 } },
    yAxis: {
      type: 'category' as const,
      data: rows.map((r: any) => r.reason).reverse(),
      axisLabel: { fontSize: 9, width: 130, overflow: 'truncate' as const },
    },
    series: [{
      type: 'bar' as const,
      data: rows.map((r: any) => r.count).reverse(),
      itemStyle: { color: '#f97316', borderRadius: [0, 4, 4, 0] },
      label: { show: true, position: 'right' as const, fontSize: 9, color: '#9a3412', formatter: (x: any) => x.value ? String(x.value) : '' },
    }],
  }
})

const failedRunThroughputChart = computed(() => {
  const rows = data.value.charts?.throughput || []
  return {
    tooltip: { trigger: 'axis' as const, axisPointer: { type: 'shadow' as const } },
    legend: { data: ['Failures', 'Triggered', 'Resolved', 'Failed Again'], top: 0, textStyle: { fontSize: 9 } },
    grid: { top: 28, right: 14, bottom: 5, left: 5, containLabel: true },
    xAxis: { type: 'category' as const, data: rows.map((r: any) => fp(r.period)), axisLabel: { fontSize: 9, rotate: rows.length > 6 ? 45 : 0 } },
    yAxis: { type: 'value' as const, axisLabel: { fontSize: 9 } },
    series: [
      { name: 'Failures', type: 'bar' as const, data: rows.map((r: any) => r.failed), itemStyle: { color: '#ef4444', borderRadius: [4, 4, 0, 0] } },
      { name: 'Triggered', type: 'bar' as const, data: rows.map((r: any) => r.triggered), itemStyle: { color: '#0ea5e9', borderRadius: [4, 4, 0, 0] } },
      { name: 'Resolved', type: 'bar' as const, data: rows.map((r: any) => r.resolved), itemStyle: { color: '#10b981', borderRadius: [4, 4, 0, 0] } },
      { name: 'Failed Again', type: 'bar' as const, data: rows.map((r: any) => r.failedAgain), itemStyle: { color: '#be123c', borderRadius: [4, 4, 0, 0] } },
    ],
  }
})

const statusChart = computed(() => {
  const rows = data.value.charts?.status || []
  return {
    tooltip: { trigger: 'axis' as const, axisPointer: { type: 'shadow' as const } },
    grid: { top: 8, right: 16, bottom: 5, left: 5, containLabel: true },
    xAxis: { type: 'value' as const, axisLabel: { fontSize: 9 } },
    yAxis: { type: 'category' as const, data: rows.map((r: any) => r.status).reverse(), axisLabel: { fontSize: 9 } },
    series: [{
      type: 'bar' as const,
      data: rows.map((r: any) => r.count).reverse(),
      itemStyle: { color: '#475569', borderRadius: [0, 4, 4, 0] },
      label: { show: true, position: 'right' as const, fontSize: 9, color: '#334155', formatter: (x: any) => x.value ? String(x.value) : '' },
    }],
  }
})

const createdChart = computed(() => {
  const rows = data.value.charts?.createdRecords || []
  return {
    tooltip: { trigger: 'axis' as const },
    grid: { top: 12, right: 12, bottom: 5, left: 5, containLabel: true },
    xAxis: { type: 'category' as const, data: rows.map((r: any) => r.label), axisLabel: { fontSize: 10 } },
    yAxis: { type: 'value' as const, axisLabel: { fontSize: 9 } },
    series: [{
      type: 'bar' as const,
      data: rows.map((r: any) => r.count),
      itemStyle: { color: '#14b8a6', borderRadius: [4, 4, 0, 0] },
      label: { show: true, position: 'top' as const, fontSize: 9, color: '#0f766e', formatter: (x: any) => x.value ? String(x.value) : '' },
    }],
  }
})

function queueToneClass(tone: string) {
  if (tone === 'danger') return 'text-rose-600 bg-rose-50'
  if (tone === 'warning') return 'text-amber-600 bg-amber-50'
  if (tone === 'success') return 'text-emerald-600 bg-emerald-50'
  if (tone === 'teal') return 'text-teal-600 bg-teal-50'
  if (tone === 'info') return 'text-blue-600 bg-blue-50'
  return 'text-slate-700 bg-slate-100'
}

function statusClass(row: FailedRun) {
  if (row.phase === 'resolved') return 'bg-emerald-50 text-emerald-700'
  if (row.phase === 'failed_again') return 'bg-rose-50 text-rose-700'
  if (row.phase === 'triggered') return 'bg-blue-50 text-blue-700'
  if (row.phase === 'partial') return 'bg-teal-50 text-teal-700'
  if (row.phase === 'ignored') return 'bg-slate-100 text-slate-600'
  return 'bg-amber-50 text-amber-700'
}

function rowAccent(row: FailedRun) {
  if (row.phase === 'resolved') return 'border-l-emerald-500'
  if (row.phase === 'failed_again') return 'border-l-rose-500'
  if (row.phase === 'triggered') return 'border-l-blue-500'
  if (row.phase === 'partial') return 'border-l-teal-500'
  if (row.phase === 'ignored') return 'border-l-slate-300'
  return 'border-l-amber-500'
}

function idText(value: string) {
  return value && value !== '0' ? value : '—'
}

function idClass(value: string) {
  return value && value !== '0' ? 'text-emerald-700 bg-emerald-50' : 'text-rose-700 bg-rose-50'
}

function progressClass(value: number | null) {
  const n = Number(value ?? 0)
  if (n >= 90) return 'bg-emerald-500'
  if (n >= 60) return 'bg-teal-500'
  if (n >= 30) return 'bg-amber-500'
  return 'bg-rose-500'
}

const router = useRouter()

function openUrl(url: string) {
  if (!url) return
  window.open(url, '_blank', 'noopener,noreferrer')
}

// Click row → in-app project detail. Modifier-aware: ⌘/Ctrl/Shift/middle
// click opens in a new tab. The QB URL stays accessible via the
// explicit "Open in QB" icon button.
function openProject(rid: number, e?: MouseEvent) {
  if (!rid) return
  openProjectWithEvent(router, rid, e)
}

function errorLines(row: FailedRun | null): string[] {
  if (!row?.error_summary) return []
  return row.error_summary
    .split(/\n|•|;|\|/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 8)
}

function payloadPretty(row: FailedRun | null): string {
  if (!row?.payload_json) return ''
  try {
    return JSON.stringify(JSON.parse(row.payload_json), null, 2)
  } catch {
    return row.payload_json
  }
}

function openQb(row: FailedRun) {
  window.open(row.qb_url, '_blank', 'noopener,noreferrer')
}

async function triggerRetry(row: FailedRun) {
  if (!row.retryable || retryBusyId.value) return
  retryBusyId.value = row.record_id
  actionError.value = ''
  try {
    const res = await fetch(`/api/intake/failed-runs/${row.record_id}/retry`, {
      method: 'POST',
      headers: hdrs(),
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error || 'Failed to trigger retry')
    await loadData(true)
    const fresh = [
      ...(data.value.lists?.triggered || []),
      ...(data.value.lists?.pending || []),
      ...(data.value.lists?.partial || []),
      ...(data.value.lists?.failedAgain || []),
    ].find((r: FailedRun) => r.record_id === row.record_id)
    selectedRun.value = fresh || { ...row, retry_triggered: true, retry_status: 'Pending', phase: 'triggered', phase_label: 'Retry Triggered', retryable: false }
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err)
  } finally {
    retryBusyId.value = null
  }
}

const dimensionRows = computed(() => data.value.intakeManager?.pivots?.[dimension.value] || [])

// Total row — sums across all visible dimension rows. Percentages are
// weighted by the underlying counts (not averages of per-row %), so the
// total reads as the true overall rate, not the mean of rates.
interface DimRow { dimension_value: string; sold_count: number; sold_kw: number; kca_count: number; kca_kw: number; first_pass_count: number; kca_pct: number; first_pass_pct: number }
const dimensionTotal = computed(() => {
  const rows = dimensionRows.value as DimRow[]
  if (!rows.length) return null
  const sold = rows.reduce((a, r) => a + (r.sold_count || 0), 0)
  const soldKw = rows.reduce((a, r) => a + (r.sold_kw || 0), 0)
  const kca = rows.reduce((a, r) => a + (r.kca_count || 0), 0)
  const kcaKw = rows.reduce((a, r) => a + (r.kca_kw || 0), 0)
  const firstPass = rows.reduce((a, r) => a + (r.first_pass_count || 0), 0)
  return {
    sold_count: sold,
    sold_kw: Math.round(soldKw * 10) / 10,
    kca_count: kca,
    kca_kw: Math.round(kcaKw * 10) / 10,
    kca_pct: sold > 0 ? Math.round((kca / sold) * 100) : 0,
    first_pass_pct: kca > 0 ? Math.round((firstPass / kca) * 100) : 0,
  }
})
const tableRows = computed<FailedRun[]>(() => drillRows.value.length || drillLabel.value ? drillRows.value : (data.value.lists?.rows || []))
const tableTitle = computed(() => drillLabel.value || 'Failed runs')
const managerTableCount = computed(() => managerMode.value === 'processing' ? processingRows.value.length : managerRows.value.length)
const freshnessText = computed(() => data.value.meta?.fetchedAt ? `QuickBase data as of ${fmtRunDate(data.value.meta.fetchedAt)}` : 'QuickBase data')
const recoveryCount = computed(() => data.value.kpi?.active ?? 0)
const zapSteps = [
  { n: 1, label: 'Watch', value: 'Triggered + Pending' },
  { n: 2, label: 'Parse', value: 'Payload + existing IDs' },
  { n: 3, label: 'Gate', value: 'should_proceed' },
  { n: 4, label: 'Retry', value: 'Skip created records' },
  { n: 5, label: 'Close', value: 'Resolved / Failed Again' },
]

onMounted(() => {
  setInitialRange()
  loadData()
})
</script>

<template>
  <MilestoneShell
    title="Intake"
    :description="freshnessText"
    :show-freshness="false"
  >
    <template #header-actions>
      <Button variant="outline" size="sm" :disabled="refreshing" @click="loadData(true)">
        <RefreshCw class="size-3.5" :class="refreshing ? 'animate-spin' : ''" />
        Refresh
      </Button>
    </template>

    <template #dates>
      <MilestoneDatePresetBar
        :preset="datePreset"
        :biz-days="false"
        :show-biz-toggle="false"
        @update:preset="(k: string) => (datePreset = k)"
        @change="onDateChange"
      />
    </template>

    <template #kpis>
      <MilestoneKpiStrip :tiles="performanceKpiTiles" />
    </template>

    <template #charts>
      <div v-if="loading" class="space-y-3">
        <div v-for="i in 4" :key="i" class="rounded-xl bg-card h-40 animate-pulse" />
      </div>

      <div v-else-if="errorMsg" class="rounded-xl bg-card px-4 py-6 text-sm text-rose-600">
        {{ errorMsg }}
      </div>

      <template v-else>
        <div class="grid grid-cols-2 md:grid-cols-2 xl:grid-cols-5 gap-2">
          <button
            v-for="q in data.intakeManager?.queues || []"
            :key="q.key"
            type="button"
            class="rounded-xl bg-card p-2.5 sm:p-3 text-left hover:bg-muted/30 active:scale-[0.99] transition cursor-pointer min-w-0"
            @click="onManagerQueue(q.key)"
          >
            <div class="flex items-start justify-between gap-2 sm:gap-3">
              <div class="min-w-0">
                <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground truncate">{{ q.label }}</p>
                <p class="mt-1 hidden sm:block text-[12px] text-muted-foreground leading-snug">{{ q.description }}</p>
              </div>
              <span class="shrink-0 rounded-md px-1.5 py-0.5 sm:px-2 sm:py-1 text-base sm:text-lg font-extrabold tabular-nums" :class="queueToneClass(q.tone)">
                {{ q.count }}
              </span>
            </div>
          </button>
        </div>

        <div class="grid grid-cols-1 xl:grid-cols-3 gap-3">
          <div class="xl:col-span-2 rounded-xl bg-card p-3">
            <div class="flex items-baseline justify-between gap-2 mb-2">
              <h3 class="text-xs font-semibold">Intake requested vs processed</h3>
              <p class="text-[10px] text-muted-foreground">{{ dateFrom || 'All' }} → {{ dateTo || 'Today' }}</p>
            </div>
            <div class="chart-frame chart-frame-main">
              <VChart :option="intakeThroughputChart" class="size-full min-w-0" :autoresize="chartResize" />
            </div>
          </div>
          <div class="rounded-xl bg-card p-3">
            <div class="flex items-baseline justify-between gap-2 mb-2">
              <h3 class="text-xs font-semibold">First rejection reasons</h3>
              <p class="text-[10px] text-muted-foreground">{{ data.intakeManager?.rejectionReasons?.length || 0 }} reasons</p>
            </div>
            <div class="chart-frame chart-frame-main">
              <VChart :option="rejectionReasonChart" class="size-full min-w-0" :autoresize="chartResize" />
            </div>
          </div>
        </div>

        <div class="rounded-xl bg-card overflow-hidden">
          <div class="px-3 py-2 border-b flex items-center justify-between gap-2 flex-wrap">
            <div class="min-w-0">
              <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Intake cohort performance</p>
              <p class="text-[11px] text-muted-foreground">Sold cohort grouped by {{ dimensionOptions.find(d => d.key === dimension)?.label }}</p>
            </div>
            <div class="grid w-full grid-cols-2 gap-1 rounded-md border bg-background p-0.5 sm:inline-flex sm:w-auto sm:gap-0">
              <button
                v-for="opt in dimensionOptions"
                :key="opt.key"
                type="button"
                class="rounded px-2.5 py-1 text-[11px] font-medium transition whitespace-nowrap"
                :class="dimension === opt.key ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'"
                @click="dimension = opt.key"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>
          <!-- Compact pivot — selected dimension on Y, four metric columns
               on X. Count + kW collapse into single "#/kW" cells (count
               primary, kW secondary) so the whole table fits at 390px
               without horizontal scroll for 4-letter state codes. State
               dimension shows 2-letter codes; longer dims (closer/office)
               truncate with a tooltip. -->
          <div class="overflow-x-auto">
            <table class="w-full text-[11px] tabular-nums" style="table-layout:fixed">
              <colgroup>
                <col style="width:34%" />
                <col style="width:18%" />
                <col style="width:18%" />
                <col style="width:15%" />
                <col style="width:15%" />
              </colgroup>
              <thead class="bg-muted/30 text-muted-foreground text-[10px] uppercase tracking-wider">
                <tr>
                  <th class="text-left font-semibold px-2 py-1.5">{{ dimensionOptions.find(d => d.key === dimension)?.label || 'Dimension' }}</th>
                  <th class="text-right font-semibold px-2 py-1.5">#/kW Sold</th>
                  <th class="text-right font-semibold px-2 py-1.5">#/kW KCA</th>
                  <th class="text-right font-semibold px-2 py-1.5">KCA%</th>
                  <th class="text-right font-semibold px-2 py-1.5">1st Pass%</th>
                </tr>
              </thead>
              <tbody class="divide-y">
                <tr v-for="row in dimensionRows" :key="`${dimension}-${row.dimension_value}`" class="hover:bg-muted/30">
                  <td class="px-2 py-1.5 font-medium truncate" :title="row.dimension_value">{{ row.dimension_value }}</td>
                  <td class="px-2 py-1.5 text-right whitespace-nowrap">
                    <span class="font-semibold">{{ row.sold_count }}</span>
                    <span class="text-muted-foreground"> / {{ fmtKw(row.sold_kw) }}</span>
                  </td>
                  <td class="px-2 py-1.5 text-right whitespace-nowrap">
                    <span class="font-semibold">{{ row.kca_count }}</span>
                    <span class="text-muted-foreground"> / {{ fmtKw(row.kca_kw) }}</span>
                  </td>
                  <td class="px-2 py-1.5 text-right font-semibold" :class="row.kca_pct >= 85 ? 'text-emerald-600' : 'text-amber-600'">{{ row.kca_pct }}%</td>
                  <td class="px-2 py-1.5 text-right font-semibold" :class="row.first_pass_pct >= 85 ? 'text-emerald-600' : 'text-amber-600'">{{ row.first_pass_pct }}%</td>
                </tr>
                <tr v-if="!dimensionRows.length">
                  <td colspan="5" class="px-2 py-6 text-center text-muted-foreground">No sold projects in this date range.</td>
                </tr>
              </tbody>
              <tfoot v-if="dimensionTotal">
                <tr class="border-t-2 border-border bg-muted/40 font-bold">
                  <td class="px-2 py-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">Total</td>
                  <td class="px-2 py-1.5 text-right whitespace-nowrap">
                    <span>{{ dimensionTotal.sold_count }}</span>
                    <span class="text-muted-foreground font-normal"> / {{ fmtKw(dimensionTotal.sold_kw) }}</span>
                  </td>
                  <td class="px-2 py-1.5 text-right whitespace-nowrap">
                    <span>{{ dimensionTotal.kca_count }}</span>
                    <span class="text-muted-foreground font-normal"> / {{ fmtKw(dimensionTotal.kca_kw) }}</span>
                  </td>
                  <td class="px-2 py-1.5 text-right" :class="dimensionTotal.kca_pct >= 85 ? 'text-emerald-600' : 'text-amber-600'">{{ dimensionTotal.kca_pct }}%</td>
                  <td class="px-2 py-1.5 text-right" :class="dimensionTotal.first_pass_pct >= 85 ? 'text-emerald-600' : 'text-amber-600'">{{ dimensionTotal.first_pass_pct }}%</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        <div id="intake-manager-table" class="rounded-xl bg-card overflow-hidden">
          <div class="px-3 py-2 border-b flex items-center justify-between gap-2 flex-wrap">
            <div class="min-w-0">
              <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                Intake manager queue <span class="ml-1 text-foreground">{{ managerTableCount }}</span>
              </p>
              <p class="text-[11px] text-muted-foreground">{{ managerLabel || 'All In-Process' }}</p>
            </div>
            <div class="text-[10px] text-muted-foreground">
              Avg progress {{ data.intakeManager?.kpi?.avgProgress ?? 0 }}%
            </div>
          </div>

          <div v-if="managerMode === 'projects'">
            <!-- Single table for all viewports — narrow screens get
                 horizontal scroll. Avoids the duplicate card-vs-table
                 mode that hid columns on mobile. -->
            <div class="overflow-x-auto">
              <table class="w-full text-[12px] tabular-nums min-w-[760px]">
                <thead class="bg-muted/30 text-muted-foreground">
                  <tr>
                    <th class="text-left font-medium px-3 py-1.5">Customer</th>
                    <th class="text-left font-medium px-3 py-1.5">Intake</th>
                    <th class="text-left font-medium px-3 py-1.5">Project</th>
                    <th class="text-right font-medium px-3 py-1.5">Sold</th>
                    <th class="text-left font-medium px-3 py-1.5">State</th>
                    <th class="text-left font-medium px-3 py-1.5">Progress</th>
                    <th class="text-left font-medium px-3 py-1.5">Missing Items</th>
                    <th class="text-right font-medium px-3 py-1.5">Idle</th>
                    <th class="text-right font-medium px-3 py-1.5">QB</th>
                  </tr>
                </thead>
                <tbody class="divide-y">
                  <tr
                    v-for="row in managerRows"
                    :key="row.record_id"
                    class="hover:bg-muted/30 cursor-pointer"
                    @click="openProject(row.record_id, $event)" @auxclick.prevent="openProject(row.record_id, $event)"
                  >
                    <td class="px-3 py-1.5 font-medium max-w-[220px]">
                      <span class="block truncate hover:underline" :title="row.customer_name">{{ row.customer_name }}</span>
                      <p class="text-[10px] text-muted-foreground">RID {{ row.record_id }}</p>
                    </td>
                    <td class="px-3 py-1.5">
                      <span class="inline-flex rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-700 whitespace-nowrap">
                        {{ row.intake_status || '—' }}
                      </span>
                    </td>
                    <td class="px-3 py-1.5">{{ row.project_status || '—' }}</td>
                    <td class="px-3 py-1.5 text-right whitespace-nowrap">{{ fmtRunDate(row.sales_date) }}</td>
                    <td class="px-3 py-1.5">{{ row.state || '—' }}</td>
                    <td class="px-3 py-1.5 min-w-[120px]">
                      <div class="flex items-center gap-2">
                        <div class="h-2 w-20 rounded-full bg-muted overflow-hidden">
                          <div class="h-full rounded-full" :class="progressClass(row.intake_progress)" :style="{ width: `${row.intake_progress ?? 0}%` }" />
                        </div>
                        <span class="text-[11px] font-semibold">{{ row.intake_progress ?? 0 }}%</span>
                      </div>
                    </td>
                    <td class="px-3 py-1.5 max-w-[320px]">
                      <span class="truncate block" :title="row.first_pass_missing_items || row.missing_items">
                        {{ row.first_pass_missing_items_list?.join(', ') || row.missing_items_list?.join(', ') || '—' }}
                      </span>
                    </td>
                    <td class="px-3 py-1.5 text-right">{{ row.hours_since_last_event ?? '—' }}h</td>
                    <td class="px-3 py-1.5 text-right">
                      <Button size="icon-sm" variant="ghost" title="Open in QuickBase" :disabled="!row.project_url" @click.stop="openUrl(row.project_url)">
                        <ExternalLink class="size-3.5" />
                      </Button>
                    </td>
                  </tr>
                  <tr v-if="!managerRows.length">
                    <td colspan="9" class="px-3 py-6 text-center text-muted-foreground">No projects in this queue.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div v-else>
            <!-- Same table-everywhere pattern as the projects mode. -->
            <div class="overflow-x-auto">
              <table class="w-full text-[12px] tabular-nums min-w-[640px]">
                <thead class="bg-muted/30 text-muted-foreground">
                  <tr>
                    <th class="text-left font-medium px-3 py-1.5">Customer</th>
                    <th class="text-left font-medium px-3 py-1.5">Project Status</th>
                    <th class="text-right font-medium px-3 py-1.5">Started</th>
                    <th class="text-left font-medium px-3 py-1.5">Progress</th>
                    <th class="text-right font-medium px-3 py-1.5">Links</th>
                  </tr>
                </thead>
                <tbody class="divide-y">
                  <tr
                    v-for="row in processingRows"
                    :key="row.record_id"
                    class="hover:bg-muted/30 cursor-pointer"
                    @click="openProject(row.record_id, $event)" @auxclick.prevent="openProject(row.record_id, $event)"
                  >
                    <td class="px-3 py-1.5 font-medium max-w-[240px] truncate" :title="row.customer_name">{{ row.customer_name }}</td>
                    <td class="px-3 py-1.5">{{ row.project_status || '—' }}</td>
                    <td class="px-3 py-1.5 text-right whitespace-nowrap">{{ fmtRunDate(row.started_processing) }}</td>
                    <td class="px-3 py-1.5 min-w-[120px]">
                      <div class="flex items-center gap-2">
                        <div class="h-2 w-20 rounded-full bg-muted overflow-hidden">
                          <div class="h-full rounded-full" :class="progressClass(row.completion_pct)" :style="{ width: `${row.completion_pct}%` }" />
                        </div>
                        <span class="text-[11px] font-semibold">{{ row.completion_pct }}%</span>
                      </div>
                    </td>
                    <td class="px-3 py-1.5 text-right">
                      <div class="flex justify-end gap-1">
                        <Button size="icon-sm" variant="ghost" title="Open Intake Event in QB" @click.stop="openUrl(row.intake_event_url)">
                          <ExternalLink class="size-3.5" />
                        </Button>
                        <Button size="icon-sm" variant="ghost" title="Open Project in QB" :disabled="!row.project_url" @click.stop="openUrl(row.project_url)">
                          <ExternalLink class="size-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                  <tr v-if="!processingRows.length">
                    <td colspan="5" class="px-3 py-6 text-center text-muted-foreground">No processing events in this queue.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="border-t pt-3 space-y-3">
          <button
            type="button"
            class="flex w-full items-center justify-between gap-3 rounded-xl bg-card px-3 py-2 text-left hover:bg-muted/30"
            @click="recoveryOpen = !recoveryOpen"
          >
            <div class="min-w-0">
              <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Errors & retries</p>
              <p class="text-[11px] text-muted-foreground truncate">{{ recoveryCount }} active failed runs</p>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <span class="rounded-md px-2 py-0.5 text-[11px] font-bold tabular-nums" :class="recoveryCount ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'">
                {{ recoveryCount }}
              </span>
              <ChevronDown class="size-4 text-muted-foreground transition-transform" :class="recoveryOpen ? 'rotate-180' : ''" />
            </div>
          </button>

          <div v-if="recoveryOpen" class="space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="min-w-0">
              <p class="text-[11px] text-muted-foreground">Failed runs, partial creates, and Retry Zap handoff</p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <MilestoneFilterBar
                :filters="filterDefs"
                :extra-active="recoveryActive"
                @update="onFilter"
                @reset="resetRecoveryFilters"
              />
              <form class="flex items-center gap-1 h-7" @submit.prevent="applySearch">
                <div class="relative">
                  <Search class="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground" />
                  <input
                    v-model="searchText"
                    type="search"
                    class="h-7 w-[210px] rounded-md border bg-card pl-7 pr-7 text-[11px] outline-none focus:ring-2 focus:ring-ring/30"
                    placeholder="Search failed runs"
                  />
                  <button
                    v-if="appliedSearch"
                    type="button"
                    class="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label="Clear search"
                    @click="clearSearch"
                  >
                    <X class="size-3" />
                  </button>
                </div>
                <Button size="sm" variant="outline" class="h-7 px-2 text-[11px]" type="submit">Search</Button>
              </form>
            </div>
          </div>

          <MilestoneKpiStrip :tiles="failedRunKpiTiles" @drill="onKpiDrill" />

          <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
          <button
            v-for="q in data.queues"
            :key="q.key"
            type="button"
            class="rounded-xl bg-card p-3 text-left hover:bg-muted/30 active:scale-[0.99] transition cursor-pointer min-w-0"
            @click="setDrill(q.label, data.lists?.[q.key] || [])"
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
                <p class="uppercase tracking-wider text-muted-foreground">Partial</p>
                <p class="font-semibold" :class="q.partial ? 'text-teal-600' : ''">{{ q.partial }}</p>
              </div>
            </div>
          </button>
        </div>

        <div class="grid grid-cols-1 xl:grid-cols-3 gap-3">
          <div class="xl:col-span-2 rounded-xl bg-card p-3">
            <div class="flex items-baseline justify-between gap-2 mb-2">
              <h3 class="text-xs font-semibold">Failure and retry flow</h3>
              <p class="text-[10px] text-muted-foreground">{{ dateFrom || 'All' }} → {{ dateTo || 'Today' }}</p>
            </div>
            <div class="chart-frame chart-frame-retry">
              <VChart :option="failedRunThroughputChart" class="size-full min-w-0" :autoresize="chartResize" />
            </div>
          </div>
          <div class="rounded-xl bg-card p-3">
            <h3 class="text-xs font-semibold mb-2">Retry status mix</h3>
            <div class="chart-frame chart-frame-retry">
              <VChart :option="statusChart" class="size-full min-w-0" :autoresize="chartResize" />
            </div>
          </div>
        </div>

        <div class="grid grid-cols-1 xl:grid-cols-3 gap-3">
          <div class="rounded-xl bg-card p-3">
            <h3 class="text-xs font-semibold mb-2">Records created before failure</h3>
            <div class="chart-frame chart-frame-created">
              <VChart :option="createdChart" class="size-full min-w-0" :autoresize="chartResize" />
            </div>
          </div>

          <div class="hidden md:block xl:col-span-2 rounded-xl bg-card overflow-hidden">
            <div class="px-3 py-2 border-b flex items-baseline justify-between gap-2">
              <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Retry Zap scope</p>
              <p class="text-[10px] text-muted-foreground">{{ data.meta?.source }}</p>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-5 divide-y sm:divide-y-0 sm:divide-x">
              <div v-for="step in zapSteps" :key="step.n" class="p-3 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="inline-flex size-5 items-center justify-center rounded-full bg-slate-100 text-[10px] font-bold text-slate-600">{{ step.n }}</span>
                  <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground truncate">{{ step.label }}</p>
                </div>
                <p class="mt-2 text-[12px] font-medium leading-snug">{{ step.value }}</p>
              </div>
            </div>
          </div>
        </div>

        <div id="intake-failed-runs-table" class="rounded-xl bg-card overflow-hidden">
          <div class="px-3 py-2 border-b flex items-center justify-between gap-2 flex-wrap">
            <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              {{ tableTitle }} <span class="ml-1 text-foreground">{{ tableRows.length }}</span>
            </p>
            <button
              v-if="drillLabel"
              type="button"
              class="text-[11px] text-muted-foreground hover:text-foreground cursor-pointer"
              @click="clearDrill"
            >Close</button>
          </div>

          <div v-if="actionError" class="border-b bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
            {{ actionError }}
          </div>

          <div v-if="!tableRows.length" class="text-center py-8 text-xs text-muted-foreground">
            No failed runs in this slice.
          </div>

          <template v-else>
            <div class="hidden lg:block overflow-x-auto">
              <table class="w-full text-[12px] tabular-nums">
                <thead class="bg-muted/30 text-muted-foreground sticky top-0">
                  <tr>
                    <th class="text-left font-medium px-3 py-1.5 sticky left-0 bg-muted/30 z-[1]">Customer</th>
                    <th class="text-left font-medium px-3 py-1.5">Status</th>
                    <th class="text-right font-medium px-3 py-1.5">Install</th>
                    <th class="text-right font-medium px-3 py-1.5">Created</th>
                    <th class="text-right font-medium px-3 py-1.5">Modified</th>
                    <th class="text-right font-medium px-2 py-1.5">Org</th>
                    <th class="text-right font-medium px-2 py-1.5">Contact</th>
                    <th class="text-right font-medium px-2 py-1.5">Project</th>
                    <th class="text-right font-medium px-2 py-1.5">Junction</th>
                    <th class="text-left font-medium px-3 py-1.5">Error</th>
                    <th class="text-right font-medium px-3 py-1.5">Actions</th>
                  </tr>
                </thead>
                <tbody class="divide-y">
                  <tr
                    v-for="row in tableRows"
                    :key="row.record_id"
                    class="hover:bg-muted/30 border-l-[3px] transition-colors"
                    :class="rowAccent(row)"
                  >
                    <td class="px-3 py-1.5 sticky left-0 bg-card z-[1] max-w-[220px]">
                      <button class="font-medium truncate text-left hover:underline" type="button" :title="row.customer_name" @click="selectedRun = row">
                        {{ row.customer_name }}
                      </button>
                      <p class="text-[10px] text-muted-foreground">RID {{ row.record_id }}</p>
                    </td>
                    <td class="px-3 py-1.5">
                      <span class="inline-flex rounded-md px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap" :class="statusClass(row)">
                        {{ row.phase_label }}
                      </span>
                    </td>
                    <td class="px-3 py-1.5 text-right">
                      <a
                        v-if="row.enerflo_url"
                        :href="row.enerflo_url"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="font-semibold text-blue-700 hover:underline"
                        @click.stop
                      >{{ row.enerflo_install_id }}</a>
                      <span v-else>—</span>
                    </td>
                    <td class="px-3 py-1.5 text-right whitespace-nowrap">{{ fmtRunDate(row.date_created) }}</td>
                    <td class="px-3 py-1.5 text-right whitespace-nowrap">{{ fmtRunDate(row.date_modified) }}</td>
                    <td class="px-2 py-1.5 text-right">
                      <a v-if="row.org_url" :href="row.org_url" target="_blank" rel="noopener noreferrer" class="rounded px-1.5 py-0.5 hover:underline" :class="idClass(row.org_id_created)" @click.stop>{{ idText(row.org_id_created) }}</a>
                      <span v-else class="rounded px-1.5 py-0.5" :class="idClass(row.org_id_created)">{{ idText(row.org_id_created) }}</span>
                    </td>
                    <td class="px-2 py-1.5 text-right">
                      <a v-if="row.contact_url" :href="row.contact_url" target="_blank" rel="noopener noreferrer" class="rounded px-1.5 py-0.5 hover:underline" :class="idClass(row.contact_id_created)" @click.stop>{{ idText(row.contact_id_created) }}</a>
                      <span v-else class="rounded px-1.5 py-0.5" :class="idClass(row.contact_id_created)">{{ idText(row.contact_id_created) }}</span>
                    </td>
                    <td class="px-2 py-1.5 text-right">
                      <a v-if="row.project_url" :href="row.project_url" target="_blank" rel="noopener noreferrer" class="rounded px-1.5 py-0.5 hover:underline" :class="idClass(row.project_id_created)" @click.stop>{{ idText(row.project_id_created) }}</a>
                      <span v-else class="rounded px-1.5 py-0.5" :class="idClass(row.project_id_created)">{{ idText(row.project_id_created) }}</span>
                    </td>
                    <td class="px-2 py-1.5 text-right">
                      <a v-if="row.junction_url" :href="row.junction_url" target="_blank" rel="noopener noreferrer" class="rounded px-1.5 py-0.5 hover:underline" :class="idClass(row.junction_id_created)" @click.stop>{{ idText(row.junction_id_created) }}</a>
                      <span v-else class="rounded px-1.5 py-0.5" :class="idClass(row.junction_id_created)" title="Junction table id not confirmed">{{ idText(row.junction_id_created) }}</span>
                    </td>
                    <td class="px-3 py-1.5 max-w-[280px] truncate" :title="row.error_summary">{{ row.error_summary || '—' }}</td>
                    <td class="px-3 py-1.5">
                      <div class="flex justify-end gap-1">
                        <Button size="icon-sm" variant="ghost" title="Open QuickBase record" @click.stop="openQb(row)">
                          <ExternalLink class="size-3.5" />
                        </Button>
                        <Button size="icon-sm" variant="ghost" :disabled="!row.enerflo_url" title="Open Enerflo install" @click.stop="openUrl(row.enerflo_url)">
                          <ExternalLink class="size-3.5" />
                        </Button>
                        <Button size="icon-sm" variant="outline" :disabled="!row.retryable || retryBusyId === row.record_id" title="Trigger retry" @click.stop="triggerRetry(row)">
                          <RotateCcw class="size-3.5" :class="retryBusyId === row.record_id ? 'animate-spin' : ''" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div class="lg:hidden divide-y">
              <button
                v-for="row in tableRows"
                :key="row.record_id"
                type="button"
                class="w-full text-left px-3 py-2 hover:bg-muted/30 border-l-[3px]"
                :class="rowAccent(row)"
                @click="selectedRun = row"
              >
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0">
                    <p class="font-semibold text-[13px] truncate">{{ row.customer_name }}</p>
                    <p class="text-[11px] text-muted-foreground">{{ row.enerflo_install_id || 'No install ID' }} · {{ fmtRunDate(row.date_created) }}</p>
                  </div>
                  <span class="shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold" :class="statusClass(row)">
                    {{ row.phase_label }}
                  </span>
                </div>
                <div class="mt-2 grid grid-cols-4 gap-1 text-[10px] tabular-nums">
                  <span class="rounded px-1.5 py-1 text-center" :class="idClass(row.org_id_created)">Org {{ idText(row.org_id_created) }}</span>
                  <span class="rounded px-1.5 py-1 text-center" :class="idClass(row.contact_id_created)">Contact {{ idText(row.contact_id_created) }}</span>
                  <span class="rounded px-1.5 py-1 text-center" :class="idClass(row.project_id_created)">Project {{ idText(row.project_id_created) }}</span>
                  <span class="rounded px-1.5 py-1 text-center" :class="idClass(row.junction_id_created)">Junction {{ idText(row.junction_id_created) }}</span>
                </div>
              </button>
            </div>
          </template>
        </div>
        </div>
        </div>

        <p class="text-[10px] text-muted-foreground">
          Source: {{ data.meta?.source }} · {{ data.meta?.total ?? 0 }} rows · fetched {{ data.meta?.fetchedAt ? fmtRunDate(data.meta.fetchedAt) : '—' }}
        </p>
      </template>
    </template>
  </MilestoneShell>

  <Dialog :open="!!selectedRun" @update:open="(v) => { if (!v) selectedRun = null }">
    <DialogContent class="max-w-4xl">
      <DialogHeader>
        <DialogTitle>{{ selectedRun?.customer_name || 'Failed run' }}</DialogTitle>
        <DialogDescription>
          Failed Run #{{ selectedRun?.record_id }} · {{ selectedRun?.phase_label }} · {{ selectedRun ? fmtRunDate(selectedRun.date_created) : '' }}
        </DialogDescription>
      </DialogHeader>

      <div v-if="selectedRun" class="grid gap-3">
        <div class="flex flex-wrap items-center gap-2">
          <span class="inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold" :class="statusClass(selectedRun)">
            {{ selectedRun.phase_label }}
          </span>
          <a
            v-if="selectedRun.enerflo_url"
            :href="selectedRun.enerflo_url"
            target="_blank"
            rel="noopener noreferrer"
            class="text-[11px] font-semibold text-blue-700 hover:underline"
          >Enerflo Install: {{ selectedRun.enerflo_install_id }}</a>
          <span v-else class="text-[11px] text-muted-foreground">Enerflo Install: —</span>
          <span class="text-[11px] text-muted-foreground">Zapier: {{ selectedRun.zapier_run_id || '—' }}</span>
        </div>

        <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px] tabular-nums">
          <div class="rounded-lg border p-2">
            <p class="text-muted-foreground uppercase tracking-wider">Org</p>
            <a
              v-if="selectedRun.org_url"
              :href="selectedRun.org_url"
              target="_blank"
              rel="noopener noreferrer"
              class="font-semibold hover:underline"
              :class="selectedRun.org_id_created && selectedRun.org_id_created !== '0' ? 'text-emerald-700' : 'text-rose-700'"
            >{{ idText(selectedRun.org_id_created) }}</a>
            <p v-else class="font-semibold" :class="selectedRun.org_id_created && selectedRun.org_id_created !== '0' ? 'text-emerald-700' : 'text-rose-700'">{{ idText(selectedRun.org_id_created) }}</p>
          </div>
          <div class="rounded-lg border p-2">
            <p class="text-muted-foreground uppercase tracking-wider">Contact</p>
            <a
              v-if="selectedRun.contact_url"
              :href="selectedRun.contact_url"
              target="_blank"
              rel="noopener noreferrer"
              class="font-semibold hover:underline"
              :class="selectedRun.contact_id_created && selectedRun.contact_id_created !== '0' ? 'text-emerald-700' : 'text-rose-700'"
            >{{ idText(selectedRun.contact_id_created) }}</a>
            <p v-else class="font-semibold" :class="selectedRun.contact_id_created && selectedRun.contact_id_created !== '0' ? 'text-emerald-700' : 'text-rose-700'">{{ idText(selectedRun.contact_id_created) }}</p>
          </div>
          <div class="rounded-lg border p-2">
            <p class="text-muted-foreground uppercase tracking-wider">Project</p>
            <a
              v-if="selectedRun.project_url"
              :href="selectedRun.project_url"
              target="_blank"
              rel="noopener noreferrer"
              class="font-semibold hover:underline"
              :class="selectedRun.project_id_created && selectedRun.project_id_created !== '0' ? 'text-emerald-700' : 'text-rose-700'"
            >{{ idText(selectedRun.project_id_created) }}</a>
            <p v-else class="font-semibold" :class="selectedRun.project_id_created && selectedRun.project_id_created !== '0' ? 'text-emerald-700' : 'text-rose-700'">{{ idText(selectedRun.project_id_created) }}</p>
          </div>
          <div class="rounded-lg border p-2">
            <p class="text-muted-foreground uppercase tracking-wider">Junction</p>
            <p class="font-semibold" :class="selectedRun.junction_id_created && selectedRun.junction_id_created !== '0' ? 'text-emerald-700' : 'text-rose-700'">{{ idText(selectedRun.junction_id_created) }}</p>
            <p v-if="selectedRun.junction_id_created && selectedRun.junction_id_created !== '0' && !selectedRun.junction_url" class="mt-0.5 text-[10px] text-muted-foreground">table TBD</p>
          </div>
        </div>

        <div class="grid grid-cols-1 xl:grid-cols-2 gap-3">
          <div class="rounded-lg border p-3 min-w-0">
            <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Errors</p>
            <ul v-if="errorLines(selectedRun).length" class="mt-2 space-y-1 text-[12px]">
              <li v-for="line in errorLines(selectedRun)" :key="line" class="leading-snug">{{ line }}</li>
            </ul>
            <p v-else class="mt-2 text-[12px] text-muted-foreground">No error summary.</p>
          </div>

          <div class="rounded-lg border p-3 min-w-0">
            <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Payload preview</p>
            <div v-if="Object.keys(selectedRun.payload_preview || {}).length" class="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1 text-[11px]">
              <div v-for="(v, k) in selectedRun.payload_preview" :key="k" class="rounded bg-muted/40 px-2 py-1 min-w-0">
                <span class="text-muted-foreground">{{ k }}:</span>
                <span class="ml-1 font-medium break-all">{{ v }}</span>
              </div>
            </div>
            <p v-else class="mt-2 text-[12px] text-muted-foreground">No parsed preview.</p>
          </div>
        </div>

        <details class="rounded-lg border p-3">
          <summary class="cursor-pointer text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Payload JSON</summary>
          <pre class="mt-2 max-h-[280px] overflow-auto rounded-md bg-slate-950 p-3 text-[11px] text-slate-100">{{ payloadPretty(selectedRun) || '—' }}</pre>
        </details>

        <div class="flex flex-wrap justify-end gap-2">
          <Button variant="outline" :disabled="!selectedRun.enerflo_url" @click="openUrl(selectedRun.enerflo_url)">
            <ExternalLink class="size-4" />
            Enerflo
          </Button>
          <Button variant="outline" @click="openQb(selectedRun)">
            <ExternalLink class="size-4" />
            Failed Run
          </Button>
          <Button :disabled="!selectedRun.retryable || retryBusyId === selectedRun.record_id" @click="triggerRetry(selectedRun)">
            <RotateCcw class="size-4" :class="retryBusyId === selectedRun.record_id ? 'animate-spin' : ''" />
            Trigger Retry
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.chart-frame {
  width: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  position: relative;
}

.chart-frame-main {
  height: 230px;
}

.chart-frame-retry {
  height: 220px;
}

.chart-frame-created {
  height: 190px;
}

.chart-frame :deep(.echarts) {
  width: 100% !important;
  height: 100% !important;
  min-width: 0 !important;
  min-height: 0 !important;
}

@media (max-width: 640px) {
  .chart-frame-main,
  .chart-frame-retry {
    height: 190px;
  }

  .chart-frame-created {
    height: 170px;
  }
}
</style>
