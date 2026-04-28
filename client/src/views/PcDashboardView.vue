<script setup lang="ts">
import { ref, computed, inject, nextTick, onMounted, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { getStatusConfig } from '@/lib/status'
import DataFreshness from '@/components/DataFreshness.vue'
import { fmtDate as fmtLocalDate, localTodayIso, localDateKey, shiftLocalDays } from '@/lib/dates'
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
  sms_count_7d?: number
  call_count_7d?: number
  last_comms_at?: string
  last_inbound_sms_at?: string
  last_call_direction?: string
  has_recent_inbound?: number
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
  sms_count_7d?: number
  call_count_7d?: number
  last_comms_at?: string
  has_recent_inbound?: number
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
  sms_count_7d?: number
  call_count_7d?: number
  last_comms_at?: string
  has_recent_inbound?: number
}

interface BlockedPto {
  record_id: number
  project_rid: number
  customer_name: string
  coordinator: string
  state: string
  status: string
  pto_status: string
  pto_submitted: string
  pto_approved: string
  inspection_passed: string
  blockers: string
  blocker_tickets: string
  open_tickets: number
  sms_count_7d?: number
  call_count_7d?: number
  last_comms_at?: string
  has_recent_inbound?: number
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
  ops_review_note: string
  design_callout_note: string
}

interface RecentInbound {
  type: 'sms' | 'call'
  source_id: string
  project_rid: number
  occurred_at: string
  contact_name: string
  preview: string
  direction: string
  call_state?: string
  customer_name: string
  coordinator: string
  state: string
  sms_count_7d: number
  call_count_7d: number
}

interface CommsItem {
  id: string
  type: 'sms' | 'call'
  occurred_at: string
  direction: 'inbound' | 'outbound' | string
  from_number: string
  to_number: string
  body: string | null
  message_status: string | null
  delivery_result: string | null
  contact_name: string | null
  user_name: string | null
  call_state: string | null
  duration_ms: number | null
  recording_url: string | null
  voicemail_url: string | null
  transcription: string | null
  missed_reason: string | null
}

const loading = ref(true)
const refreshing = ref(false)
const kpi = ref<Record<string, number>>({})
const groups = ref<Record<string, OutreachRecord[]>>({})
const unresponsive = ref<UnresponsiveRow[]>([])
const blockedNem = ref<BlockedNem[]>([])
const blockedPto = ref<BlockedPto[]>([])
const recentInbound = ref<RecentInbound[]>([])
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
const expandedExceptions = ref<Record<string, boolean>>({ recentInbound: false, unresponsive: false, blockedNem: false, blockedPto: false, adders: false })
const adders = ref<AdderNotify[]>([])
const addersCache = ref<{ total: number; last_refresh: string } | null>(null)
const addersRefreshing = ref(false)
const commsRefreshing = ref(false)
const commsOpen = ref(false)
const commsLoading = ref(false)
const commsItems = ref<CommsItem[]>([])
const commsProject = ref<{ record_id?: number; customer_name?: string; coordinator?: string; state?: string; status?: string } | null>(null)
const commsSummary = ref<{ sms_count_7d: number; call_count_7d: number; last_comms_at: string } | null>(null)
const commsScroller = ref<HTMLElement | null>(null)

// Customer phone derived from comms items — for inbound use from_number,
// for outbound use to_number. Most-recent item wins. Powers the
// click-to-call icon in the drawer header.
const commsPhone = computed<string>(() => {
  for (let i = commsItems.value.length - 1; i >= 0; i--) {
    const it = commsItems.value[i]
    if (!it) continue
    const num = (it.direction === 'inbound' ? it.from_number : it.to_number) || ''
    if (num && num.trim()) return num.trim()
  }
  return ''
})
function commsInitials(): string {
  const name = (commsProject.value?.customer_name || '').trim()
  if (name) {
    const parts = name.split(/\s+/).slice(0, 2)
    return parts.map(p => p[0] || '').join('').toUpperCase()
  }
  const digits = commsPhone.value.replace(/\D/g, '')
  return digits.slice(-2) || '#'
}
function callCustomer() {
  if (commsPhone.value) window.location.href = `tel:${commsPhone.value}`
}
function fmtPhoneDisplay(p: string): string {
  if (!p) return ''
  const digits = p.replace(/\D/g, '')
  const last10 = digits.length >= 10 ? digits.slice(-10) : digits
  if (last10.length !== 10) return p
  return `(${last10.slice(0, 3)}) ${last10.slice(3, 6)}-${last10.slice(6)}`
}

const useBizDays = ref(false)
const dayUnit = computed(() => useBizDays.value ? 'biz days' : 'days')

// Performance section
const PERF_MILESTONES = ['Initial Outreach', 'Check-In', 'Design Approval', 'Permit Submitted', 'Permit Received', 'Install Complete', 'Inspection Scheduled', 'Inspection Complete', 'PTO Approval']
const activePerfMilestone = ref('Initial Outreach')

interface VolumeBucket { period: string; count: number; avg: number; p90: number }
interface CoordMetric { coordinator: string; count: number; avg: number; median: number; p90: number }
interface DrillRow { record_id: number; project_rid: number; customer_name: string; coordinator: string; outreach_completed_date: string; milestone_date: string; days: number; status: string; state: string; lender: string; contact_method?: string }
interface AnalyticsData { touchpoint: string; binning: string; total: number; byCoordinator: CoordMetric[]; volume: VolumeBucket[]; drillData: DrillRow[] }
const analytics = ref<AnalyticsData | null>(null)
const analyticsLoading = ref(false)
const analyticsError = ref('')
const chartRenderKey = ref(0)
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
  const to = localTodayIso()
  if (key === 'last_30') { perfDateFrom.value = shiftLocalDays(-29, t); perfDateTo.value = to }
  else if (key === 'last_60') { perfDateFrom.value = shiftLocalDays(-59, t); perfDateTo.value = to }
  else if (key === 'last_90') { perfDateFrom.value = shiftLocalDays(-89, t); perfDateTo.value = to }
  else if (key === 'this_month') { perfDateFrom.value = `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-01`; perfDateTo.value = to }
  else if (key === 'this_quarter') { perfDateFrom.value = `${t.getFullYear()}-${String(Math.floor(t.getMonth()/3)*3+1).padStart(2,'0')}-01`; perfDateTo.value = to }
  else if (key === 'this_year') { perfDateFrom.value = `${t.getFullYear()}-01-01`; perfDateTo.value = to }
  loadAnalytics()
}
// Init default date range
;(() => { perfDateFrom.value = shiftLocalDays(-89); perfDateTo.value = localTodayIso() })()

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
  params.set('today', localTodayIso())
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
    blockedPto.value = data.exceptions?.blockedPto || []
    recentInbound.value = data.exceptions?.recentInbound || []
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

async function refreshComms() {
  commsRefreshing.value = true
  try {
    await fetch('/api/pc-dashboard/refresh-comms', { method: 'POST', headers: hdrs() })
    await loadData()
    if (commsProject.value?.record_id) await openComms(Number(commsProject.value.record_id), commsProject.value.customer_name || '')
  } finally { commsRefreshing.value = false }
}

const activeKpi = ref('')
function toggleStage(stage: string) { expandedStages.value = { ...expandedStages.value, [stage]: !expandedStages.value[stage] } }
function selectKpi(stage: string) {
  if (activeKpi.value === stage) { activeKpi.value = ''; expandedStages.value = {} }
  else { activeKpi.value = stage; const fresh: Record<string, boolean> = {}; fresh[stage] = true; expandedStages.value = fresh }
}
function toggleException(key: string) { expandedExceptions.value = { ...expandedExceptions.value, [key]: !expandedExceptions.value[key] } }

function fmtDate(d: string | null) {
  return d ? fmtLocalDate(d) : ''
}

function fmtDateTime(d: string | null | undefined) {
  if (!d) return ''
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return ''
  return dt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function fmtMsgTime(d: string | null | undefined) {
  if (!d) return ''
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return ''
  return dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function msgDay(d: string | null | undefined) {
  if (!d) return ''
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return ''
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(dt, today)) return 'Today'
  if (sameDay(dt, yesterday)) return 'Yesterday'
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function timeAgo(d: string | null | undefined) {
  if (!d) return ''
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return ''
  const mins = Math.floor((Date.now() - dt.getTime()) / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

function fmtDuration(ms: number | null | undefined) {
  if (!ms) return '0s'
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m ${sec % 60}s`
}

function commsCount(row: { sms_count_7d?: number; call_count_7d?: number }) {
  return (row.sms_count_7d || 0) + (row.call_count_7d || 0)
}

function callStatus(item: CommsItem) {
  const state = (item.call_state || '').toLowerCase()
  const direction = item.direction === 'outbound' ? 'Outbound' : 'Inbound'
  if (state.includes('missed')) return `${direction} missed call`
  if (state.includes('voicemail')) return `${direction} voicemail`
  if ((item.duration_ms || 0) > 0 || state.includes('hangup') || state.includes('connected')) return `${direction} answered call`
  return `${direction} call`
}

function callListenUrl(item: CommsItem) {
  return item.recording_url || item.voicemail_url || ''
}

function scrollCommsToBottom() {
  requestAnimationFrame(() => {
    if (commsScroller.value) commsScroller.value.scrollTop = commsScroller.value.scrollHeight
  })
}

async function openComms(projectId: number, fallbackName = '') {
  if (!projectId) return
  commsOpen.value = true
  commsLoading.value = true
  commsItems.value = []
  commsProject.value = { record_id: projectId, customer_name: fallbackName }
  try {
    const res = await fetch(`/api/pc-dashboard/comms?project_id=${projectId}`, { headers: hdrs() })
    if (res.ok) {
      const data = await res.json()
      commsItems.value = data.items || []
      commsProject.value = data.project || commsProject.value
      commsSummary.value = data.summary || null
    }
  } finally {
    commsLoading.value = false
    await nextTick()
    scrollCommsToBottom()
  }
}

function closeComms() {
  commsOpen.value = false
  commsItems.value = []
  commsProject.value = null
  commsSummary.value = null
}

function daysUntil(d: string | null): number | null {
  if (!d) return null
  const dateKey = localDateKey(d)
  if (!dateKey) return null
  const [y, m, day] = dateKey.split('-').map(Number)
  const target = new Date(y, (m || 1) - 1, day || 1, 12, 0, 0, 0)
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
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
  analyticsError.value = ''
  drillLabel.value = ''; drillRows.value = []
  const params = new URLSearchParams()
  params.set('touchpoint', activePerfMilestone.value)
  if (viewMode.value === 'personal' && auth.user?.name) params.set('coordinator', auth.user.name)
  else if (fCoordinator.value) params.set('coordinator', fCoordinator.value)
  if (useBizDays.value) params.set('biz_days', '1')
  if (perfDateFrom.value) params.set('date_from', perfDateFrom.value)
  if (perfDateTo.value) params.set('date_to', perfDateTo.value)
  params.set('today', localTodayIso())
  params.set('tz_offset_min', String(new Date().getTimezoneOffset()))
  try {
    const res = await fetch(`/api/pc-dashboard/analytics?${params}`, { headers: hdrs() })
    if (!res.ok) throw new Error(`Analytics failed (${res.status})`)
    analytics.value = await res.json()
    await nextTick()
    chartRenderKey.value++
  } catch (err) {
    analyticsError.value = err instanceof Error ? err.message : String(err)
  } finally { analyticsLoading.value = false }
}

async function refreshAnalyticsCache() {
  analyticsError.value = ''
  const res = await fetch('/api/pc-dashboard/refresh-analytics', { method: 'POST', headers: hdrs() })
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    analyticsError.value = data?.error || `Refresh failed (${res.status})`
  }
  await loadAnalytics()
}

async function toggleAnalytics() {
  showAnalytics.value = !showAnalytics.value
  if (showAnalytics.value) {
    await loadAnalytics()
  }
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
onMounted(() => {
  loadData().then(() => {
    const projectId = Number(new URLSearchParams(window.location.search).get('commsProject') || 0)
    if (projectId) openComms(projectId)
  })
  loadAdders()
  registerRefresh?.(async () => { await loadData(); await loadAdders() })
})
watch([viewMode, fCoordinator], () => { loadAdders() })
</script>

<template>
  <div class="grid gap-2 sm:gap-3">
    <!-- Header (sticky) -->
    <div class="sticky top-0 z-20 bg-background flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 -mx-3 px-3 sm:-mx-6 sm:px-6 py-2">
      <div class="flex flex-col gap-0.5 min-w-0 w-full sm:w-auto">
        <div class="flex items-baseline gap-2 min-w-0">
          <h1 class="text-2xl font-semibold tracking-tight">PC Dashboard</h1>
          <span class="text-sm font-medium text-muted-foreground tabular-nums shrink-0">{{ totalOutreach }}</span>
        </div>
        <DataFreshness label="Cache" />
      </div>
      <div class="flex items-center gap-1.5 w-full sm:w-auto overflow-x-auto no-scrollbar pb-0.5 sm:pb-0">
        <!-- PC quick filter -->
        <Select :model-value="fCoordinator || '__all__'" @update:model-value="(v: string) => { fCoordinator = v === '__all__' ? '' : v; if (fCoordinator) viewMode = 'team'; loadData() }">
          <SelectTrigger class="h-8 w-[92px] sm:w-auto sm:min-w-[100px] text-xs"><SelectValue placeholder="All PCs" /></SelectTrigger>
          <SelectContent class="max-w-[calc(100vw-1rem)] overflow-x-hidden">
            <SelectItem value="__all__"><span class="block max-w-[calc(100vw-4rem)] truncate">All PCs</span></SelectItem>
            <SelectItem v-for="c in filterOptions.coordinators" :key="c" :value="c"><span class="block max-w-[calc(100vw-4rem)] truncate">{{ c }}</span></SelectItem>
          </SelectContent>
        </Select>
        <!-- Personal / Team toggle -->
        <div class="flex rounded-md border overflow-hidden">
          <button class="px-2.5 h-8 text-xs font-medium transition-colors" :class="viewMode === 'personal' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'" @click="viewMode = 'personal'; fCoordinator = ''; loadData()">Me</button>
          <button class="px-2.5 h-8 text-xs font-medium transition-colors" :class="viewMode === 'team' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'" @click="viewMode = 'team'; loadData()">Team</button>
        </div>
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
      <button class="inline-flex items-center gap-1.5 rounded-md border px-2.5 h-8 text-xs font-medium transition-colors" :class="showAnalytics ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'" @click="toggleAnalytics">
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
    <div v-if="showAnalytics" class="space-y-3 min-w-0">
      <!-- Milestone selector KPI strip -->
      <div class="flex flex-wrap sm:flex-nowrap gap-1.5 sm:overflow-x-auto sm:no-scrollbar -mx-1 px-1 min-w-0">
        <button v-for="ms in PERF_MILESTONES" :key="ms"
          class="rounded-lg px-2.5 py-1.5 text-[9px] font-semibold uppercase tracking-wider transition-all active:scale-[0.97] min-w-0 sm:flex-none"
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
      <div v-else-if="analyticsError" class="rounded-xl border bg-card p-4 text-sm text-red-600">{{ analyticsError }}</div>
      <template v-else-if="analytics">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 min-w-0">
          <!-- Volume chart -->
          <div class="rounded-xl border bg-card p-4 min-w-0 overflow-hidden">
            <p class="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1 break-words">{{ activePerfMilestone }} Volume</p>
            <p class="text-[10px] text-muted-foreground mb-2">{{ analytics.total }} completed · {{ analytics.binning }}</p>
            <VChart v-if="volumeChart" :key="`volume-${chartRenderKey}`" :option="volumeChart" class="w-full min-w-0" style="height: 200px" autoresize />
            <p v-else class="text-[11px] text-muted-foreground py-4 text-center">No data for this period</p>
          </div>

          <!-- Time-to-event by PC -->
          <div class="rounded-xl border bg-card p-4 min-w-0 overflow-hidden">
            <p class="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1 break-words">Time to {{ activePerfMilestone }} by PC</p>
            <p class="text-[10px] text-muted-foreground mb-2">avg + P90 · {{ dayUnit }}</p>
            <VChart v-if="timeToEventChart" :key="`time-${chartRenderKey}`" :option="timeToEventChart" @click="onChartClick"
              class="w-full min-w-0"
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
            <div v-for="r in drillRows" :key="r.record_id" class="px-4 py-2 flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-3 text-[11px] min-w-0">
              <p class="font-medium flex-1 min-w-0 truncate">{{ r.customer_name }}</p>
              <div class="flex flex-wrap items-center gap-1.5 sm:gap-3 min-w-0 text-muted-foreground">
                <span class="min-w-0">{{ fmtDate(r.milestone_date) }} → {{ fmtDate(r.outreach_completed_date) }}</span>
                <span class="font-semibold tabular-nums" :class="r.days > 7 ? 'text-red-600' : r.days > 3 ? 'text-amber-600' : 'text-emerald-600'">{{ r.days }}d</span>
                <span v-if="r.contact_method" class="text-[9px] px-1.5 py-0.5 rounded bg-sky-50 text-sky-700">{{ r.contact_method }}</span>
                <span v-if="r.state" class="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{{ r.state }}</span>
              </div>
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
    <div v-if="showFilters" class="rounded-xl border bg-card p-3 sm:p-4 grid grid-cols-1 min-[420px]:grid-cols-2 sm:grid-cols-3 gap-3">
      <div class="space-y-1.5">
        <Label class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">State</Label>
        <Select :model-value="fState || '__all__'" @update:model-value="(v: string) => { fState = v === '__all__' ? '' : v; loadData() }">
          <SelectTrigger class="h-8 text-xs"><SelectValue placeholder="All states" /></SelectTrigger>
          <SelectContent class="max-w-[calc(100vw-1rem)] overflow-x-hidden">
            <SelectItem value="__all__"><span class="block max-w-[calc(100vw-4rem)] truncate">All states</span></SelectItem>
            <SelectItem v-for="s in filterOptions.states" :key="s" :value="s"><span class="block max-w-[calc(100vw-4rem)] truncate">{{ s }}</span></SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div class="space-y-1.5">
        <Label class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Lender</Label>
        <Select :model-value="fLender || '__all__'" @update:model-value="(v: string) => { fLender = v === '__all__' ? '' : v; loadData() }">
          <SelectTrigger class="h-8 text-xs"><SelectValue placeholder="All lenders" /></SelectTrigger>
          <SelectContent class="max-w-[calc(100vw-1rem)] overflow-x-hidden">
            <SelectItem value="__all__"><span class="block max-w-[calc(100vw-4rem)] truncate">All lenders</span></SelectItem>
            <SelectItem v-for="l in filterOptions.lenders" :key="l" :value="l"><span class="block max-w-[calc(100vw-4rem)] truncate">{{ l }}</span></SelectItem>
          </SelectContent>
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
              <div class="flex items-center flex-wrap gap-1.5 sm:gap-2 shrink-0 sm:justify-end sm:min-w-[160px] min-w-0">
                <button
                  v-if="commsCount(r) > 0"
                  class="relative inline-flex items-center gap-1 rounded-md h-7 px-1.5 sm:px-2 text-[10px] font-semibold bg-muted text-muted-foreground hover:bg-primary hover:text-primary-foreground transition-colors shrink-0"
                  :class="r.has_recent_inbound ? 'ring-1 ring-amber-400 text-amber-700 bg-amber-50' : ''"
                  title="Open comms log"
                  @click.stop="openComms(r.project_rid, r.customer_name)"
                >
                  <span>SMS {{ r.sms_count_7d || 0 }}</span>
                  <span class="opacity-40">/</span>
                  <span>Call {{ r.call_count_7d || 0 }}</span>
                  <span v-if="r.has_recent_inbound" class="absolute -right-1 -top-1 size-2 rounded-full bg-amber-500" />
                </button>
                <div v-if="r.due_date || r.next_due_date">
                  <span v-if="dueBadge(r.due_date || r.next_due_date).label" class="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold" :class="dueBadge(r.due_date || r.next_due_date).cls">
                    {{ dueBadge(r.due_date || r.next_due_date).label }}
                  </span>
                  <span class="text-[10px] text-muted-foreground ml-1">{{ fmtDate(r.due_date || r.next_due_date) }}</span>
                </div>
                <a :href="`https://kin.quickbase.com/db/btvik5kwi?a=er&dfid=10&rid=${r.record_id}`" target="_blank" @click.stop
                  class="inline-flex items-center justify-center rounded-md h-7 px-2 text-[10px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors shrink-0"
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
        <!-- Recent inbound comms -->
        <div v-if="recentInbound.length > 0" class="rounded-xl border bg-card overflow-hidden">
          <button class="flex items-center justify-between w-full px-4 py-2.5" @click="toggleException('recentInbound')">
            <div class="flex items-center gap-2">
              <span class="size-2 rounded-full bg-sky-500" />
              <span class="text-[11px] font-semibold uppercase tracking-widest text-sky-700">Recent Inbound Comms</span>
            </div>
            <div class="flex items-center gap-2">
              <Badge variant="secondary" class="text-[10px]">{{ recentInbound.length }}</Badge>
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground transition-transform" :class="expandedExceptions.recentInbound ? 'rotate-180' : ''"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
          </button>
          <div v-if="expandedExceptions.recentInbound" class="border-t divide-y overflow-hidden">
            <button v-for="r in recentInbound" :key="`${r.type}-${r.source_id}-${r.project_rid}`"
              class="block w-full min-w-0 max-w-full overflow-hidden px-3 sm:px-4 py-2 text-[11px] text-left hover:bg-muted/40 transition-colors"
              @click="openComms(r.project_rid, r.customer_name)"
            >
              <div class="grid min-w-0 max-w-full grid-cols-[minmax(0,1fr)_auto] gap-2">
                <div class="min-w-0 overflow-hidden">
                  <p class="font-medium truncate">{{ r.customer_name || r.contact_name || 'Customer' }}</p>
                  <p class="text-[10px] text-muted-foreground truncate mt-0.5">{{ r.preview }}</p>
                </div>
                <span class="text-[10px] text-muted-foreground shrink-0">{{ timeAgo(r.occurred_at) }}</span>
              </div>
              <div class="mt-1 flex max-w-full flex-wrap items-center gap-1.5 overflow-hidden">
                <span class="inline-flex items-center rounded bg-sky-100 px-1.5 py-0.5 text-[9px] font-semibold text-sky-700">SMS {{ r.sms_count_7d || 0 }}</span>
                <span class="inline-flex items-center rounded bg-emerald-100 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-700">Calls {{ r.call_count_7d || 0 }}</span>
                <span v-if="r.coordinator" class="min-w-0 max-w-[140px] truncate text-muted-foreground sm:max-w-[220px]">{{ r.coordinator }}</span>
                <span v-if="r.state" class="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">{{ r.state }}</span>
                <div class="flex items-center gap-1 text-[10px] font-semibold text-primary shrink-0">
                  <span>Open</span>
                  <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
                </div>
              </div>
            </button>
          </div>
        </div>

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
              <button v-if="r.project_rid && commsCount(r) > 0" class="text-[10px] font-semibold rounded px-2 py-1 bg-muted text-muted-foreground hover:bg-primary hover:text-primary-foreground" @click="openComms(r.project_rid, r.customer_name)">Comms {{ commsCount(r) }}</button>
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
            <div v-for="r in blockedNem" :key="r.record_id" class="px-4 py-2 flex flex-wrap sm:flex-nowrap items-center gap-1.5 sm:gap-3 text-[11px]">
              <p class="font-medium flex-[1_1_160px] min-w-0 truncate">{{ r.customer_name }}</p>
              <span class="text-muted-foreground">{{ r.coordinator }}</span>
              <span v-if="r.state" class="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{{ r.state }}</span>
              <span class="text-[10px] text-muted-foreground">NEM {{ fmtDate(r.nem_submitted) }}</span>
              <button v-if="commsCount(r) > 0" class="text-[10px] font-semibold rounded px-2 py-1 bg-muted text-muted-foreground hover:bg-primary hover:text-primary-foreground" @click="openComms(r.record_id, r.customer_name)">Comms {{ commsCount(r) }}</button>
              <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-semibold" :class="[getStatusConfig(r.status).bg, getStatusConfig(r.status).text]">{{ r.status }}</span>
            </div>
          </div>
        </div>

        <!-- Blocked PTO -->
        <div v-if="blockedPto.length > 0" class="rounded-xl border bg-card overflow-hidden">
          <button class="flex items-center justify-between w-full px-4 py-2.5" @click="toggleException('blockedPto')">
            <div class="flex items-center gap-2">
              <span class="size-2 rounded-full bg-violet-500" />
              <span class="text-[11px] font-semibold uppercase tracking-widest text-violet-700">Blocked PTO</span>
            </div>
            <div class="flex items-center gap-2">
              <Badge variant="secondary" class="text-[10px]">{{ blockedPto.length }}</Badge>
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground transition-transform" :class="expandedExceptions.blockedPto ? 'rotate-180' : ''"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
          </button>
          <div v-if="expandedExceptions.blockedPto" class="border-t divide-y">
            <div v-for="r in blockedPto" :key="r.record_id" class="px-4 py-2 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 text-[11px]">
              <div class="flex-1 min-w-0">
                <p class="font-medium truncate">{{ r.customer_name || 'Unnamed' }}</p>
                <p v-if="r.blockers" class="text-[10px] text-violet-700 mt-0.5 line-clamp-1">{{ r.blockers }}</p>
              </div>
              <span class="text-muted-foreground shrink-0">{{ r.coordinator }}</span>
              <span v-if="r.state" class="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">{{ r.state }}</span>
              <span v-if="r.pto_submitted" class="text-[10px] text-muted-foreground shrink-0">PTO {{ fmtDate(r.pto_submitted) }}</span>
              <span v-else-if="r.inspection_passed" class="text-[10px] text-muted-foreground shrink-0">Insp {{ fmtDate(r.inspection_passed) }}</span>
              <span v-if="r.open_tickets > 0" class="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold bg-rose-100 text-rose-700 shrink-0">{{ r.open_tickets }} open</span>
              <button v-if="commsCount(r) > 0" class="text-[10px] font-semibold rounded px-2 py-1 bg-muted text-muted-foreground hover:bg-primary hover:text-primary-foreground" @click="openComms(r.project_rid, r.customer_name)">Comms {{ commsCount(r) }}</button>
              <span v-if="r.status" class="inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-semibold shrink-0" :class="[getStatusConfig(r.status).bg, getStatusConfig(r.status).text]">{{ r.status }}</span>
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
              class="px-4 py-2 flex flex-wrap sm:flex-nowrap items-center gap-1.5 sm:gap-3 text-[11px] hover:bg-muted/40 transition-colors"
            >
              <div class="flex-[1_1_180px] min-w-0">
                <p class="font-medium truncate">{{ r.customer_name || 'Unnamed' }}</p>
                <p class="text-[10px] text-muted-foreground truncate mt-0.5">
                  {{ r.product_name || r.product_category }}
                  <template v-if="r.qty"> · Qty {{ r.qty }}</template>
                  <template v-if="r.project_closer"> · Rep {{ r.project_closer }}</template>
                </p>
                <p v-if="r.ops_review_note" class="text-[10px] text-rose-700 truncate mt-0.5">{{ r.ops_review_note }}</p>
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

    <!-- Comms slide-over — uses the same Liquid Glass language as
         SmsThreadDialog so the customer-thread visual is consistent
         across the app. Click-to-call wired into the header phone
         icon; calls render inline as compact pills mixed with SMS
         bubbles. -->
    <div v-if="commsOpen" class="fixed inset-0 z-[120]">
      <button class="absolute inset-0 bg-black/40 backdrop-blur-md hidden sm:block" aria-label="Close comms" @click="closeComms" />
      <aside class="absolute right-0 top-0 h-full w-full sm:max-w-[520px] bg-card/95 supports-[backdrop-filter]:bg-card/85 backdrop-blur-2xl shadow-2xl shadow-black/30 ring-1 ring-foreground/5 flex flex-col overflow-hidden">
        <!-- Sticky glass header with avatar + name + phone + call/refresh/close -->
        <header
          class="
            relative flex items-center gap-3 px-3 py-3 sm:px-4
            bg-background/70 supports-[backdrop-filter]:bg-background/55 backdrop-blur-xl
            before:absolute before:inset-x-3 before:bottom-0 before:h-px
            before:bg-gradient-to-r before:from-transparent before:via-foreground/10 before:to-transparent
          "
        >
          <button
            class="size-9 -ml-1 rounded-full hover:bg-foreground/5 active:bg-foreground/10 transition-colors flex items-center justify-center shrink-0"
            aria-label="Close comms"
            @click="closeComms"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>

          <div
            class="
              size-10 rounded-full flex items-center justify-center shrink-0
              bg-gradient-to-br from-sky-400/30 via-sky-500/20 to-violet-500/25
              ring-1 ring-foreground/5
              text-[13px] font-semibold tracking-tight text-foreground/85
              select-none
            "
          >{{ commsInitials() }}</div>

          <div class="flex-1 min-w-0">
            <p class="text-[15px] font-semibold tracking-tight leading-tight truncate">
              {{ commsProject?.customer_name || `Project ${commsProject?.record_id || ''}` }}
            </p>
            <p class="text-[11px] text-muted-foreground tabular-nums truncate leading-tight mt-0.5">
              <template v-if="commsPhone">{{ fmtPhoneDisplay(commsPhone) }}</template>
              <template v-if="commsProject?.coordinator"> · {{ commsProject.coordinator }}</template>
              <template v-if="commsProject?.state"> · {{ commsProject.state }}</template>
            </p>
          </div>

          <button
            v-if="commsPhone"
            class="size-9 rounded-full hover:bg-foreground/5 active:bg-foreground/10 transition-colors flex items-center justify-center shrink-0"
            aria-label="Call customer"
            @click="callCustomer"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
          </button>
          <button
            v-if="auth.isAdmin"
            class="size-9 rounded-full hover:bg-foreground/5 active:bg-foreground/10 transition-colors flex items-center justify-center disabled:opacity-50 shrink-0"
            :disabled="commsRefreshing"
            aria-label="Refresh comms"
            @click="refreshComms"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" :class="commsRefreshing ? 'animate-spin' : ''"><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
          </button>
        </header>

        <!-- Quick stats row (counts last 7d, last contact). -->
        <div class="px-3 sm:px-4 py-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground overflow-x-auto no-scrollbar bg-foreground/[0.025]">
          <span class="rounded-full bg-foreground/[0.06] px-2 py-0.5 font-medium whitespace-nowrap">SMS {{ commsSummary?.sms_count_7d || 0 }} / 7d</span>
          <span class="rounded-full bg-foreground/[0.06] px-2 py-0.5 font-medium whitespace-nowrap">Calls {{ commsSummary?.call_count_7d || 0 }} / 7d</span>
          <span v-if="commsSummary?.last_comms_at" class="rounded-full bg-foreground/[0.06] px-2 py-0.5 font-medium whitespace-nowrap">Last {{ timeAgo(commsSummary.last_comms_at) }} ago</span>
        </div>

        <!-- Conversation -->
        <div ref="commsScroller" role="log" aria-live="polite" class="flex-1 overflow-y-auto overscroll-contain bg-background px-3 py-3 sm:px-4 sm:py-4 space-y-1">
          <p v-if="commsLoading" class="py-12 text-center text-[11px] text-muted-foreground">Loading comms…</p>
          <p v-else-if="commsItems.length === 0" class="py-12 text-center text-[11px] text-muted-foreground">No mapped SMS or calls found for this project.</p>

          <template v-else v-for="(item, i) in commsItems" :key="`${item.type}-${item.id}-${item.occurred_at}`">
            <!-- Day separator -->
            <div v-if="i === 0 || msgDay(item.occurred_at) !== msgDay(commsItems[i - 1]?.occurred_at)" class="text-center pt-3 pb-1">
              <span class="text-[10px] font-semibold tracking-[0.18em] uppercase text-muted-foreground/70">{{ msgDay(item.occurred_at) }}</span>
            </div>

            <!-- Call event — compact centered pill -->
            <div v-if="item.type === 'call'" class="flex flex-col items-center gap-1 my-1">
              <span class="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-full px-2.5 py-1 text-[10px] leading-snug text-muted-foreground bg-foreground/[0.05]">
                <span class="font-semibold uppercase tracking-wider">{{ callStatus(item) }}</span>
                <span class="tabular-nums">{{ fmtMsgTime(item.occurred_at) }}</span>
                <span v-if="item.duration_ms" class="tabular-nums">· {{ fmtDuration(item.duration_ms) }}</span>
                <span v-if="item.missed_reason">· {{ item.missed_reason }}</span>
                <a v-if="callListenUrl(item)" :href="callListenUrl(item)" target="_blank" class="font-semibold text-sky-600 hover:text-sky-500">Listen</a>
              </span>
              <p v-if="item.transcription" class="max-w-[88%] rounded-lg px-2.5 py-1.5 text-[11px] leading-snug text-foreground/80 bg-foreground/[0.04] text-left whitespace-pre-wrap">
                {{ item.transcription }}
              </p>
            </div>

            <!-- SMS bubble -->
            <div v-else class="flex" :class="item.direction === 'outbound' ? 'justify-end' : 'justify-start'">
              <div
                class="max-w-[78%] px-3.5 py-2 text-[15px] leading-[1.35] tracking-[-0.01em] whitespace-pre-wrap break-words"
                :class="item.direction === 'outbound'
                  ? 'text-white bg-gradient-to-br from-sky-500 to-blue-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_2px_rgba(2,132,199,0.25)] rounded-[18px] rounded-br-md'
                  : 'text-foreground bg-foreground/[0.07] dark:bg-foreground/[0.10] rounded-[18px] rounded-bl-md'"
              >
                <template v-if="item.body">{{ item.body }}</template>
                <span v-else class="opacity-60 italic">(empty message)</span>
              </div>
            </div>
          </template>
        </div>
      </aside>
    </div>
  </div>
</template>
