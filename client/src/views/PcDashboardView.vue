<script setup lang="ts">
import { ref, computed, inject, nextTick, onMounted, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
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
import { parseMessageBody, bodyHasImage } from '@/lib/smsBody'
import { fmtDate as fmtLocalDate, localTodayIso, localDateKey, shiftLocalDays, userTz, localDayBoundsToUtc } from '@/lib/dates'
import ProjectDetailDialog from '@/components/milestone/ProjectDetailDialog.vue'
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

// ─── Field Activity tab state ────────────────────────────
// Upcoming Arrivy tasks for projects currently on the PC dashboard. Tab
// + window are persisted in the URL so refresh / direct-link works.
type DashboardTab = 'outreach' | 'field-activity'
type WindowKey = 'today' | 'tomorrow' | 'thisweek' | 'nextweek' | 'thismonth' | 'next7'

interface UpcomingTask {
  arrivy_id: string
  project_rid: string
  customer_name: string
  project_coordinator: string
  task_title: string
  task_type_key: string
  task_type_label: string
  scheduled_at: string
  crew_names: string
  status: 'submitted' | 'notsubmitted' | 'overdue' | 'cancelled' | 'onsite' | 'enroute' | 'scheduled'
  status_label: string
  task_url: string
  progress: {
    enroute: boolean
    onsite: boolean
    submitted: boolean
    install_complete: boolean
    rtr_ready: boolean
    rtr_status: string
  }
}

// Full project_cache row used by ProjectDetailDialog (the shared
// "project snapshot" panel — pipeline strip + key dates + contact
// shortcuts). The dialog reads any project_cache columns it needs;
// we just pass the row through.
type PeekProjectRow = Record<string, unknown> & { record_id: number; customer_name: string }

const activeTab = ref<DashboardTab>('outreach')
const windowKey = ref<WindowKey>('next7')
const upcomingTasks = ref<UpcomingTask[]>([])
const upcomingLoading = ref(false)
const upcomingError = ref<string>('')
type GroupMode = 'time' | 'type'
const groupBy = ref<GroupMode>('time')

// Independent filters: type (Solar Install / Survey / …) and status
// (Scheduled / En Route / On Site / Submitted / Late). Click a KPI tile
// to toggle. Both can be active simultaneously.
type StatusFilter = 'scheduled' | 'enroute' | 'onsite' | 'notsubmitted' | 'late'
const filterType = ref<string | null>(null)
const filterStatus = ref<StatusFilter | null>(null)

const WINDOW_CHIPS: Array<{ k: WindowKey; l: string }> = [
  { k: 'today', l: 'Today' },
  { k: 'tomorrow', l: 'Tomorrow' },
  { k: 'thisweek', l: 'This Week' },
  { k: 'nextweek', l: 'Next Week' },
  { k: 'thismonth', l: 'This Month' },
  { k: 'next7', l: 'Next 7 Days' },
]

// Resolve a chip key to UTC ISO bounds in the user's local tz. All windows
// are forward-looking ("upcoming") — past portions of "this week" etc. are
// excluded so a row that already passed doesn't pad the count.
function windowBounds(key: WindowKey): { fromIso: string; toIso: string } {
  const tz = userTz()
  const today = localTodayIso()
  const [y, m, d] = today.split('-').map(n => parseInt(n, 10))
  const todayUtc = new Date(Date.UTC(y!, m! - 1, d!, 12))
  function shift(n: number): string {
    const o = new Date(todayUtc); o.setUTCDate(todayUtc.getUTCDate() + n)
    return `${o.getUTCFullYear()}-${String(o.getUTCMonth() + 1).padStart(2, '0')}-${String(o.getUTCDate()).padStart(2, '0')}`
  }
  switch (key) {
    case 'today': {
      const b = localDayBoundsToUtc(today, tz)
      return { fromIso: b.from, toIso: b.to }
    }
    case 'tomorrow': {
      const b = localDayBoundsToUtc(shift(1), tz)
      return { fromIso: b.from, toIso: b.to }
    }
    case 'thisweek': {
      // ISO week: Mon→Sun. We want today→Sun (forward-looking).
      const dow = todayUtc.getUTCDay() // 0=Sun,1=Mon,...,6=Sat
      const daysToSun = dow === 0 ? 0 : 7 - dow
      return { fromIso: localDayBoundsToUtc(today, tz).from, toIso: localDayBoundsToUtc(shift(daysToSun), tz).to }
    }
    case 'nextweek': {
      const dow = todayUtc.getUTCDay()
      const daysToNextMon = dow === 0 ? 1 : 8 - dow
      const mon = shift(daysToNextMon)
      const sun = shift(daysToNextMon + 6)
      return { fromIso: localDayBoundsToUtc(mon, tz).from, toIso: localDayBoundsToUtc(sun, tz).to }
    }
    case 'thismonth': {
      const lastDay = new Date(Date.UTC(y!, m!, 0)).getUTCDate()
      const lastIso = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
      return { fromIso: localDayBoundsToUtc(today, tz).from, toIso: localDayBoundsToUtc(lastIso, tz).to }
    }
    case 'next7':
    default: {
      return { fromIso: localDayBoundsToUtc(today, tz).from, toIso: localDayBoundsToUtc(shift(6), tz).to }
    }
  }
}

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

async function loadUpcomingTasks() {
  upcomingLoading.value = true
  upcomingError.value = ''
  const { fromIso, toIso } = windowBounds(windowKey.value)
  const params = new URLSearchParams({ fromIso, toIso })
  // Mirror the outreach coordinator scope onto the field-activity tab so
  // both views read as the same person/team.
  if (viewMode.value === 'personal' && auth.user?.name) params.set('coordinator', auth.user.name)
  else if (fCoordinator.value) params.set('coordinator', fCoordinator.value)
  try {
    const res = await fetch(`/api/pc-dashboard/upcoming-tasks?${params}`, { headers: hdrs() })
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string }
      upcomingError.value = data.error || `Failed to load (${res.status})`
      upcomingTasks.value = []
      return
    }
    const data = await res.json() as { tasks: UpcomingTask[] }
    upcomingTasks.value = data.tasks || []
  } catch (e) {
    upcomingError.value = e instanceof Error ? e.message : 'Network error'
    upcomingTasks.value = []
  } finally { upcomingLoading.value = false }
}

// ─── Tab + window URL state ─────────────────────────────
const router = useRouter()
const route = useRoute()

function parseTab(q: unknown): DashboardTab {
  return q === 'field-activity' ? 'field-activity' : 'outreach'
}
function parseWindow(q: unknown): WindowKey {
  const valid: WindowKey[] = ['today', 'tomorrow', 'thisweek', 'nextweek', 'thismonth', 'next7']
  return valid.includes(q as WindowKey) ? (q as WindowKey) : 'next7'
}
function syncUrlFromState() {
  const query: Record<string, string> = { ...route.query as Record<string, string> }
  if (activeTab.value === 'outreach') {
    delete query['tab']; delete query['window']
  } else {
    query['tab'] = 'field-activity'
    query['window'] = windowKey.value
  }
  void router.replace({ query })
}

function fmtScheduled(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
}

// Status pill — calmer pastels, no anxiety colors. Editorial weight.
// Warm tones (rose/red) reserved for genuinely actionable states.
function statusPillCls(s: UpcomingTask['status']): string {
  switch (s) {
    case 'cancelled': return 'bg-rose-100/80 text-rose-800 ring-1 ring-rose-200/60'
    case 'notsubmitted': return 'bg-amber-100/70 text-amber-800 ring-1 ring-amber-200/60'
    case 'submitted': return 'bg-emerald-100/70 text-emerald-800 ring-1 ring-emerald-200/60'
    case 'overdue': return 'bg-rose-100/70 text-rose-800 ring-1 ring-rose-200/60'
    case 'onsite': return 'bg-sky-100/70 text-sky-800 ring-1 ring-sky-200/60'
    case 'enroute': return 'bg-sky-100/70 text-sky-800 ring-1 ring-sky-200/60'
    default: return 'bg-foreground/[0.06] text-foreground/70'
  }
}

// Status dot — replaces the previous hard left border. A small filled
// circle reads as a tonal accent without imposing a rule on the card.
function statusDotCls(s: UpcomingTask['status']): string {
  switch (s) {
    case 'cancelled': return 'bg-rose-500'
    case 'notsubmitted': return 'bg-red-500'
    case 'submitted': return 'bg-emerald-500'
    case 'overdue': return 'bg-red-500'
    case 'onsite': return 'bg-sky-500'
    case 'enroute': return 'bg-sky-500'
    default: return 'bg-foreground/30'
  }
}

// Inline SVG paths for status icons. Heroicons-style 24x24 stroke icons.
// Emojis as icons were a checklist violation — these read consistent at
// any size and inherit currentColor for the active status tint.
const STATUS_ICON_PATHS: Record<UpcomingTask['status'], string> = {
  scheduled: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  enroute: '<path d="M5 12h13M13 6l6 6-6 6"/>',
  onsite: '<path d="M12 21s-7-7.5-7-12a7 7 0 0 1 14 0c0 4.5-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>',
  submitted: '<path d="M5 12l4 4L19 7"/>',
  notsubmitted: '<path d="M12 9v4M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>',
  overdue: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/><path d="M18 6l4-4M22 6l-4-4" stroke-width="1.5"/>',
  cancelled: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
}

// Task-type chip — editorial pastel with a subtle ring, not a loud
// solid. Each type still reads distinct at a glance but the row stays
// calm under the customer name.
function taskTypeChipCls(key: string): string {
  switch (key) {
    case 'install': return 'bg-violet-50 text-violet-800 ring-1 ring-violet-200/70'
    case 'survey': return 'bg-sky-50 text-sky-800 ring-1 ring-sky-200/70'
    case 'final-inspection': return 'bg-amber-50 text-amber-900 ring-1 ring-amber-200/70'
    case 'inspection': return 'bg-amber-50 text-amber-900 ring-1 ring-amber-200/70'
    case 'service': return 'bg-teal-50 text-teal-800 ring-1 ring-teal-200/70'
    case 'rework': return 'bg-orange-50 text-orange-800 ring-1 ring-orange-200/70'
    case 'battery': return 'bg-fuchsia-50 text-fuchsia-800 ring-1 ring-fuchsia-200/70'
    default: return 'bg-foreground/[0.04] text-foreground/70 ring-1 ring-foreground/10'
  }
}
function taskTypeAccentTextCls(key: string): string {
  switch (key) {
    case 'install': return 'text-violet-700'
    case 'survey': return 'text-sky-700'
    case 'final-inspection': return 'text-amber-700'
    case 'inspection': return 'text-amber-700'
    case 'service': return 'text-teal-700'
    case 'rework': return 'text-orange-700'
    case 'battery': return 'text-fuchsia-700'
    default: return 'text-muted-foreground'
  }
}

// Progress chips — direct port of the field app's chipsFor(t) logic so a
// PC can see at a glance whether the crew is en route, on site, has
// submitted, and whether RTR is ready. "filled" → action complete.
function progressChips(t: UpcomingTask): Array<{ label: string; cls: string }> {
  const filled = 'bg-emerald-100 text-emerald-700'
  const empty = 'bg-slate-100 text-slate-400'
  const chips = [
    { label: 'ER', cls: t.progress.enroute ? filled : empty },
    { label: 'OS', cls: t.progress.onsite ? filled : empty },
    { label: 'SUB', cls: t.progress.submitted ? filled : empty },
  ]
  if (t.task_type_key === 'install') {
    chips.push({ label: 'COMP', cls: t.progress.install_complete ? filled : empty })
    chips.push({ label: 'RTR', cls: t.progress.rtr_ready ? filled : empty })
  }
  return chips
}

// ─── Project snapshot — shared ProjectDetailDialog ─────
// Clicking a Field Activity row hands its project_cache row to the
// shared "project snapshot" dialog (pipeline strip + key dates +
// contact shortcuts + Open full view). The dialog auto-opens when
// the prop is non-null and closes back to null.
const selectedPeekProject = ref<PeekProjectRow | null>(null)

async function openProjectPeek(rid: number): Promise<void> {
  if (!Number.isFinite(rid) || rid <= 0) return
  try {
    const res = await fetch(`/api/projects/${rid}?live=0`, { headers: hdrs() })
    if (!res.ok) return
    const data = await res.json() as { project: PeekProjectRow }
    if (data.project) selectedPeekProject.value = data.project
  } catch {
    // Silent — row stays clickable for retry.
  }
}

// "Late" = scheduled time has passed, no progress logged (still in 'scheduled'
// or marked 'overdue' by Arrivy). PCs need to act on these now — surfaced
// per-card and counted at the top of the view.
function isTaskLate(t: UpcomingTask): boolean {
  if (t.status === 'submitted' || t.status === 'cancelled') return false
  if (t.progress.onsite || t.progress.enroute) return false
  const sched = new Date(t.scheduled_at)
  if (isNaN(sched.getTime())) return false
  return sched.getTime() < Date.now()
}

const TASK_TYPE_ORDER: Array<{ key: string; label: string }> = [
  { key: 'install', label: 'Solar Install' },
  { key: 'battery', label: 'Battery' },
  { key: 'survey', label: 'Survey' },
  { key: 'final-inspection', label: 'Final Inspection' },
  { key: 'inspection', label: 'Inspection' },
  { key: 'service', label: 'Service' },
  { key: 'rework', label: 'Rework' },
  { key: 'other', label: 'Other' },
]

interface TaskGroup { key: string; label: string; tasks: UpcomingTask[] }

function statusMatches(t: UpcomingTask, f: StatusFilter): boolean {
  if (f === 'late') return isTaskLate(t)
  return t.status === f
}

// Apply type + status filters (independent) before grouping. Both null
// means "show everything"; either set narrows the list.
const filteredTasks = computed<UpcomingTask[]>(() => {
  return upcomingTasks.value.filter(t => {
    if (filterType.value && t.task_type_key !== filterType.value) return false
    if (filterStatus.value && !statusMatches(t, filterStatus.value)) return false
    return true
  })
})

// Hour-of-day bucket key for a task. Includes date prefix so multi-day
// windows separate same-hour tasks across different days.
function hourBucketKey(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return 'unknown'
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}`
}
function hourBucketLabel(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return 'No time'
  const dateLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  const hourLabel = d.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true })
  return `${dateLabel} · ${hourLabel}`
}

const groupedTasks = computed<TaskGroup[]>(() => {
  if (groupBy.value === 'time') {
    // Cluster by (date + hour) so the table reads as time blocks.
    // Each hour with one or more tasks becomes its own group.
    const byHour = new Map<string, UpcomingTask[]>()
    for (const t of filteredTasks.value) {
      const k = hourBucketKey(t.scheduled_at)
      const arr = byHour.get(k) || []
      arr.push(t)
      byHour.set(k, arr)
    }
    const keys = [...byHour.keys()].sort()
    return keys.map(k => {
      const tasks = byHour.get(k)!
      return { key: k, label: hourBucketLabel(tasks[0]!.scheduled_at), tasks }
    })
  }
  const byKey = new Map<string, UpcomingTask[]>()
  for (const t of filteredTasks.value) {
    const arr = byKey.get(t.task_type_key) || []
    arr.push(t)
    byKey.set(t.task_type_key, arr)
  }
  const groups: TaskGroup[] = []
  for (const { key, label } of TASK_TYPE_ORDER) {
    const tasks = byKey.get(key)
    if (tasks && tasks.length) groups.push({ key, label, tasks })
  }
  return groups
})


function toggleTypeFilter(key: string): void {
  filterType.value = filterType.value === key ? null : key
}
function toggleStatusFilter(key: StatusFilter): void {
  filterStatus.value = filterStatus.value === key ? null : key
}
function clearFilters(): void {
  filterType.value = null
  filterStatus.value = null
}

interface StatusTile { key: StatusFilter; label: string; count: number; iconKey: UpcomingTask['status']; tone: 'neutral' | 'progress' | 'done' | 'alert' }
// Submitted is intentionally absent — the server filters submitted
// tasks out of "upcoming". "Not Submitted" (crew complete, no RTR) is
// the actionable state the PC needs to chase, so it takes that slot.
const STATUS_TILE_ORDER: Array<{ key: StatusFilter; label: string; iconKey: UpcomingTask['status']; tone: StatusTile['tone'] }> = [
  { key: 'scheduled', label: 'Scheduled', iconKey: 'scheduled', tone: 'neutral' },
  { key: 'enroute', label: 'En Route', iconKey: 'enroute', tone: 'progress' },
  { key: 'onsite', label: 'On Site', iconKey: 'onsite', tone: 'progress' },
  { key: 'notsubmitted', label: 'No RTR', iconKey: 'notsubmitted', tone: 'alert' },
  { key: 'late', label: 'Running Late', iconKey: 'overdue', tone: 'alert' },
]
function statusTileAccent(tone: StatusTile['tone']): string {
  switch (tone) {
    case 'progress': return 'text-sky-700'
    case 'done': return 'text-emerald-700'
    case 'alert': return 'text-rose-700'
    default: return 'text-muted-foreground'
  }
}

// Per `docs/ui-component-specs.md`: standard KPI tile uses a 3px top
// accent strip + accent-600 number. Enumerated map so Tailwind can
// statically extract classes (no dynamic interpolation). Active state
// uses the matching ring color so the outline reads as "more of the
// same accent" instead of a stark black border.
const TILE_ACCENT: Record<string, { strip: string; text: string; ring: string }> = {
  violet: { strip: 'bg-violet-500', text: 'text-violet-600', ring: 'ring-violet-500' },
  sky: { strip: 'bg-sky-500', text: 'text-sky-600', ring: 'ring-sky-500' },
  amber: { strip: 'bg-amber-500', text: 'text-amber-600', ring: 'ring-amber-500' },
  teal: { strip: 'bg-teal-500', text: 'text-teal-600', ring: 'ring-teal-500' },
  orange: { strip: 'bg-orange-500', text: 'text-orange-600', ring: 'ring-orange-500' },
  fuchsia: { strip: 'bg-fuchsia-500', text: 'text-fuchsia-600', ring: 'ring-fuchsia-500' },
  rose: { strip: 'bg-rose-500', text: 'text-rose-600', ring: 'ring-rose-500' },
  emerald: { strip: 'bg-emerald-500', text: 'text-emerald-600', ring: 'ring-emerald-500' },
  slate: { strip: 'bg-slate-400', text: 'text-slate-600', ring: 'ring-slate-400' },
}
function tileAccent(color: string): { strip: string; text: string; ring: string } {
  return TILE_ACCENT[color] || TILE_ACCENT['slate']!
}
function typeAccentColor(key: string): string {
  switch (key) {
    case 'install': return 'violet'
    case 'battery': return 'fuchsia'
    case 'survey': return 'sky'
    case 'final-inspection': return 'amber'
    case 'inspection': return 'amber'
    case 'service': return 'teal'
    case 'rework': return 'orange'
    default: return 'slate'
  }
}
function statusAccentColor(key: StatusFilter): string {
  switch (key) {
    case 'enroute': return 'sky'
    case 'onsite': return 'sky'
    case 'notsubmitted': return 'amber'
    case 'late': return 'rose'
    default: return 'slate'
  }
}

const lateCount = computed(() => upcomingTasks.value.filter(isTaskLate).length)

// Top-of-view summary: type KPI tiles (Solar Install / Survey / …) and
// parallel status KPI tiles (Scheduled / En Route / On Site / Submitted /
// Late). Both are clickable filters; both row sets use the same tile
// visual so they read as siblings.
interface ActivitySummary {
  total: number
  byType: Array<{ key: string; label: string; count: number }>
  statuses: StatusTile[]
}

// Cross-axis filter: TYPE tile counts respect the active status filter,
// and STATUS tile counts respect the active type filter. So clicking
// "Survey" makes the status row tally only Survey tasks — the counts
// sum to the Survey total. Both filters cleared = full counts.
const tasksForTypeCounts = computed<UpcomingTask[]>(() => {
  return filterStatus.value
    ? upcomingTasks.value.filter(t => statusMatches(t, filterStatus.value!))
    : upcomingTasks.value
})
const tasksForStatusCounts = computed<UpcomingTask[]>(() => {
  return filterType.value
    ? upcomingTasks.value.filter(t => t.task_type_key === filterType.value)
    : upcomingTasks.value
})

const activitySummary = computed<ActivitySummary>(() => {
  // TYPE counts — population narrows when a status filter is active.
  const typeMap = new Map<string, { label: string; count: number }>()
  for (const t of tasksForTypeCounts.value) {
    const ex = typeMap.get(t.task_type_key)
    if (ex) ex.count += 1
    else typeMap.set(t.task_type_key, { label: t.task_type_label, count: 1 })
  }
  const byType: Array<{ key: string; label: string; count: number }> = []
  for (const { key } of TASK_TYPE_ORDER) {
    const entry = typeMap.get(key)
    if (entry) byType.push({ key, label: entry.label, count: entry.count })
  }

  // STATUS counts — population narrows when a type filter is active.
  const byStatusCount = { scheduled: 0, enroute: 0, onsite: 0, submitted: 0, cancelled: 0, overdue: 0, notsubmitted: 0 }
  let late = 0
  for (const t of tasksForStatusCounts.value) {
    byStatusCount[t.status] += 1
    if (isTaskLate(t)) late += 1
  }
  const statuses: StatusTile[] = STATUS_TILE_ORDER.map(s => ({
    ...s,
    // 'late' is a derived signal; the rest map straight off the
    // server-classified status field on each task.
    count: s.key === 'late' ? late : (byStatusCount[s.key as keyof typeof byStatusCount] ?? 0),
  }))

  return {
    total: upcomingTasks.value.length,
    byType, statuses,
  }
})

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
  const [y = 1970, m = 1, day = 1] = dateKey.split('-').map(Number)
  const target = new Date(y, m - 1, day, 12, 0, 0, 0)
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
      if (!bucket) return ''
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
        const bucket = v[p.dataIndex]; return bucket ? `${bucket.avg}d` : ''
      }},
      labelLayout: { hideOverlap: true },
    }, {
      type: 'bar' as const, data: v.map(b => b.count),
      barGap: '-100%' as const, silent: true, barMaxWidth: 28,
      itemStyle: { color: 'transparent' },
      label: {
        show: true, position: 'insideBottom' as const, fontSize: 9, fontWeight: 600,
        color: '#fff', formatter: (p: any) => `${v[p.dataIndex]?.count ?? ''}`,
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
    const coord = coordData[params.dataIndex]?.coordinator
    if (!coord) return
    const rows = analytics.value.drillData.filter(r => r.coordinator === coord)
    drillInto(`${coord} — ${activePerfMilestone.value}`, rows)
  }
}

watch([viewMode, fCoordinator, useBizDays, activePerfMilestone], () => { if (showAnalytics.value) loadAnalytics() })

const registerRefresh = inject<(fn: () => Promise<void>) => void>('registerRefresh')
onMounted(() => {
  // Hydrate tab + window from URL so a direct link / refresh lands you where you were.
  activeTab.value = parseTab(route.query['tab'])
  windowKey.value = parseWindow(route.query['window'])

  loadData().then(() => {
    const projectId = Number(new URLSearchParams(window.location.search).get('commsProject') || 0)
    if (projectId) openComms(projectId)
  })
  loadAdders()
  if (activeTab.value === 'field-activity') loadUpcomingTasks()
  registerRefresh?.(async () => {
    await loadData(); await loadAdders()
    if (activeTab.value === 'field-activity') await loadUpcomingTasks()
  })
})
watch([viewMode, fCoordinator], () => { loadAdders() })

// Field-activity tab: fetch on tab entry, on chip change, and on coordinator
// changes while the tab is active. URL stays in sync with both.
watch(activeTab, (next) => {
  syncUrlFromState()
  if (next === 'field-activity') loadUpcomingTasks()
})
watch(windowKey, () => {
  syncUrlFromState()
  if (activeTab.value === 'field-activity') loadUpcomingTasks()
})
watch([viewMode, fCoordinator], () => {
  if (activeTab.value === 'field-activity') loadUpcomingTasks()
})
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

    <!-- Top-level tabs -->
    <div class="flex border-b border-border">
      <button v-for="t in [{ k: 'outreach' as DashboardTab, l: 'Outreach' }, { k: 'field-activity' as DashboardTab, l: 'Field Activity' }]" :key="t.k"
        class="flex-1 py-2.5 px-4 text-sm font-medium border-b-2 transition-colors"
        :class="activeTab === t.k ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground'"
        @click="activeTab = t.k"
      >{{ t.l }}</button>
    </div>

    <template v-if="activeTab === 'outreach'">
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
                  title="Open PC Outreach form in QuickBase"
                >Log in QB</a>
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
    </template>

    <!-- ── Field Activity tab ── -->
    <template v-else-if="activeTab === 'field-activity'">
      <!-- Editorial chip strip: tonal background, no borders, active is
           solid foreground. Group toggle uses sliding-pill pattern. -->
      <div class="flex items-center gap-2 flex-wrap">
        <div class="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1 flex-1 min-w-0">
          <button v-for="c in WINDOW_CHIPS" :key="c.k"
            class="shrink-0 px-3 py-1.5 rounded-full text-[11.5px] font-medium tracking-tight transition-all duration-200 cursor-pointer"
            :class="windowKey === c.k ? 'bg-foreground text-background shadow-sm' : 'bg-foreground/[0.04] text-foreground/70 hover:bg-foreground/[0.08] hover:text-foreground'"
            @click="windowKey = c.k"
          >{{ c.l }}</button>
        </div>
        <div class="flex rounded-full overflow-hidden shrink-0 bg-foreground/[0.04] p-0.5">
          <button class="px-3 py-1 rounded-full text-[11px] font-medium tracking-tight transition-all duration-200 cursor-pointer" :class="groupBy === 'time' ? 'bg-card shadow-sm text-foreground' : 'text-foreground/60 hover:text-foreground'" @click="groupBy = 'time'" title="Sort chronologically">Time</button>
          <button class="px-3 py-1 rounded-full text-[11px] font-medium tracking-tight transition-all duration-200 cursor-pointer" :class="groupBy === 'type' ? 'bg-card shadow-sm text-foreground' : 'text-foreground/60 hover:text-foreground'" @click="groupBy = 'type'" title="Group by task type">By Type</button>
        </div>
      </div>

      <!-- Summary — type tiles and status tiles as parallel KPI rows,
           each tile is an independent click-to-filter. Active tile is
           elevated. Clear button surfaces when any filter is on. -->
      <section v-if="!upcomingLoading && upcomingTasks.length"
        class="rounded-2xl bg-card/60 supports-[backdrop-filter]:bg-card/40 backdrop-blur-xl shadow-sm p-3 grid gap-3"
      >
        <!-- TYPE row -->
        <div class="grid gap-1.5">
          <div class="flex items-center justify-between gap-2">
            <p class="text-[9.5px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Type</p>
            <button v-if="filterType" class="text-[10px] text-muted-foreground hover:text-foreground transition-colors" @click="filterType = null">Clear type</button>
          </div>
          <!-- Fixed-width tiles in a horizontal scroll strip — same
               pattern as the Outreach tab's KPI row so widths match
               app-wide. 3px accent strip + accent-600 number per
               ui-component-specs.md. overflow-hidden keeps the strip
               clipped to the rounded corners; the active-state ring
               is a box-shadow and renders outside that clip. -->
          <div class="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 py-1">
            <button v-for="bt in activitySummary.byType" :key="bt.key"
              type="button"
              class="flex-none w-[105px] sm:w-[115px] text-left rounded-xl border bg-card p-3 min-w-0 relative overflow-hidden transition-all duration-200 cursor-pointer hover:shadow-md focus-visible:ring-2 focus-visible:ring-foreground/30 outline-none"
              :class="filterType === bt.key ? 'ring-2 shadow-lg -translate-y-px bg-foreground/[0.025] ' + tileAccent(typeAccentColor(bt.key)).ring : 'shadow-sm'"
              @click="toggleTypeFilter(bt.key)"
              :title="`Filter by ${bt.label}`"
            >
              <div class="absolute top-0 left-0 right-0" :class="[tileAccent(typeAccentColor(bt.key)).strip, filterType === bt.key ? 'h-[6px]' : 'h-[3px]']" />
              <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">{{ bt.label }}</p>
              <p class="mt-1 text-2xl font-extrabold tabular-nums leading-none" :class="tileAccent(typeAccentColor(bt.key)).text">{{ bt.count }}</p>
            </button>
          </div>
        </div>

        <!-- Subtle hairline divider -->
        <div class="h-px bg-gradient-to-r from-transparent via-foreground/[0.08] to-transparent" />

        <!-- STATUS row -->
        <div class="grid gap-1.5">
          <div class="flex items-center justify-between gap-2">
            <p class="text-[9.5px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Status</p>
            <button v-if="filterStatus" class="text-[10px] text-muted-foreground hover:text-foreground transition-colors" @click="filterStatus = null">Clear status</button>
          </div>
          <div class="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 py-1">
            <button v-for="st in activitySummary.statuses" :key="st.key"
              type="button"
              class="flex-none w-[105px] sm:w-[115px] text-left rounded-xl border bg-card p-3 min-w-0 relative overflow-hidden transition-all duration-200 cursor-pointer hover:shadow-md focus-visible:ring-2 focus-visible:ring-foreground/30 outline-none"
              :class="filterStatus === st.key ? 'ring-2 shadow-lg -translate-y-px bg-foreground/[0.025] ' + tileAccent(statusAccentColor(st.key)).ring : 'shadow-sm'"
              @click="toggleStatusFilter(st.key)"
              :title="`Filter by ${st.label}`"
            >
              <div class="absolute top-0 left-0 right-0" :class="[tileAccent(statusAccentColor(st.key)).strip, filterStatus === st.key ? 'h-[6px]' : 'h-[3px]']" />
              <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">{{ st.label }}</p>
              <p class="mt-1 text-2xl font-extrabold tabular-nums leading-none" :class="tileAccent(statusAccentColor(st.key)).text">{{ st.count }}</p>
            </button>
          </div>
        </div>

        <!-- Active filter summary line -->
        <div v-if="filterType || filterStatus" class="flex items-center justify-between gap-2 pt-1">
          <p class="text-[11px] text-muted-foreground">
            Showing <span class="font-semibold text-foreground tabular-nums">{{ filteredTasks.length }}</span>
            of {{ upcomingTasks.length }} tasks
            <template v-if="filterType"> · type <span class="text-foreground">{{ activitySummary.byType.find(b => b.key === filterType)?.label }}</span></template>
            <template v-if="filterStatus"> · status <span class="text-foreground">{{ STATUS_TILE_ORDER.find(s => s.key === filterStatus)?.label }}</span></template>
          </p>
          <button class="text-[11px] text-muted-foreground hover:text-foreground transition-colors" @click="clearFilters">Clear all</button>
        </div>
      </section>

      <!-- Loading / error / empty — calm tonal surfaces, no hard borders. -->
      <div v-if="upcomingLoading" class="rounded-2xl bg-card/60 supports-[backdrop-filter]:bg-card/40 backdrop-blur-xl shadow-sm p-10 text-center text-sm text-muted-foreground">Loading field activity…</div>
      <div v-else-if="upcomingError" class="rounded-2xl bg-rose-50/70 ring-1 ring-rose-200/60 p-4 text-sm text-rose-900">{{ upcomingError }}</div>
      <div v-else-if="upcomingTasks.length === 0" class="rounded-2xl bg-card/60 supports-[backdrop-filter]:bg-card/40 backdrop-blur-xl shadow-sm p-10 text-center text-sm text-muted-foreground">
        <template v-if="viewMode === 'personal' && auth.user?.name">No field activity for {{ auth.user.name }} in this window.</template>
        <template v-else-if="fCoordinator">No field activity for {{ fCoordinator }} in this window.</template>
        <template v-else>No field activity scheduled in this window.</template>
      </div>

      <template v-else v-for="g in groupedTasks" :key="g.key">
        <!-- Group header — renders for both By Type (e.g. "SOLAR
             INSTALL · 3") and Time (e.g. "Wed Jun 3 · 9 AM · 2"). In
             Time mode the header explicitly blocks the list by hour
             so a PC can scan "what's happening at 10 AM" at a glance. -->
        <header v-if="g.label" class="flex items-baseline gap-2 mt-3 mb-1">
          <p class="text-[10.5px] font-semibold uppercase tracking-[0.18em]" :class="groupBy === 'type' ? taskTypeAccentTextCls(g.key) : 'text-foreground/70'">{{ g.label }}</p>
          <span class="text-[10px] text-muted-foreground/80 tabular-nums">· {{ g.tasks.length }}</span>
          <span class="flex-1 h-px bg-gradient-to-r from-foreground/10 via-foreground/[0.04] to-transparent" />
        </header>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-2 min-w-0">
          <button v-for="t in g.tasks" :key="t.arrivy_id" type="button"
            class="text-left rounded-xl bg-card/60 supports-[backdrop-filter]:bg-card/40 backdrop-blur-xl shadow-sm hover:shadow-md focus-visible:shadow-md focus-visible:ring-2 focus-visible:ring-foreground/20 outline-none transition-all duration-200 cursor-pointer min-w-0 overflow-hidden px-3 py-2"
            :class="[
              t.status === 'cancelled' ? 'bg-rose-50/40 hover:bg-rose-50/60' : '',
              isTaskLate(t) ? 'ring-1 ring-rose-200/70 hover:ring-rose-300/70' : '',
            ]"
            @click="openProjectPeek(Number(t.project_rid))"
          >
            <!-- Primary row: status dot · type chip · customer · LATE · status pill -->
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="size-1.5 shrink-0 rounded-full" :class="statusDotCls(t.status)" aria-hidden="true" />
              <span class="shrink-0 px-1.5 py-0.5 rounded-md text-[9.5px] font-semibold tracking-tight" :class="taskTypeChipCls(t.task_type_key)">{{ t.task_type_label }}</span>
              <p class="font-semibold text-[13px] flex-1 min-w-0 truncate text-foreground/90">
                {{ t.customer_name || 'Unknown' }}
              </p>
              <span v-if="isTaskLate(t)" class="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9.5px] font-bold tracking-wide bg-rose-100/80 text-rose-800 ring-1 ring-rose-200/60">
                <span class="size-1 rounded-full bg-rose-500" />LATE
              </span>
              <span
                class="inline-flex items-center gap-1 rounded-full font-medium shrink-0 whitespace-nowrap px-2 py-0.5 text-[10px] tracking-tight"
                :class="statusPillCls(t.status)"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-2.5" aria-hidden="true" v-html="STATUS_ICON_PATHS[t.status]" />
                {{ t.status_label }}
              </span>
            </div>
            <!-- Secondary row: 👷 contractor · time · coordinator +
                 progress chips + Arrivy link. Hard-hat emoji marks
                 the line as "who's doing the work". -->
            <div class="flex items-center justify-between gap-2 mt-1 min-w-0">
              <p class="text-[10.5px] truncate min-w-0 flex-1 text-muted-foreground" :class="t.status === 'cancelled' ? 'text-rose-800/70' : ''">
                <span class="mr-0.5" aria-hidden="true">👷</span>{{ t.crew_names || 'Unassigned' }}<span class="text-foreground/30"> · </span><span class="tabular-nums">{{ fmtScheduled(t.scheduled_at) }}</span><template v-if="t.project_coordinator && viewMode === 'team'"><span class="text-foreground/30"> · </span>{{ t.project_coordinator }}</template>
              </p>
              <div class="flex items-center gap-1 shrink-0">
                <span v-for="(c, i) in progressChips(t)" :key="i" class="text-[9px] font-semibold px-1 py-px rounded whitespace-nowrap tracking-wider" :class="c.cls">{{ c.label }}</span>
                <a v-if="t.task_url" :href="t.task_url" target="_blank" rel="noopener" class="text-[10px] font-semibold ml-0.5 text-foreground/40 hover:text-foreground transition-colors" @click.stop title="Open in Arrivy">↗</a>
              </div>
            </div>
          </button>
        </div>
      </template>
      <p v-if="!upcomingLoading && upcomingTasks.length" class="text-center text-[10px] text-muted-foreground/70 py-2 tracking-wide">{{ upcomingTasks.length }} task{{ upcomingTasks.length === 1 ? '' : 's' }}</p>
    </template>

    <!-- Comms slide-over — uses the same Liquid Glass language as
         SmsThreadDialog so the customer-thread visual is consistent
         across the app. Click-to-call wired into the header phone
         icon; calls render inline as compact pills mixed with SMS
         bubbles. -->
    <!-- Project snapshot — shared ProjectDetailDialog used across the
         milestone dashboards (PTO, Design, Permit, Inspx). Auto-opens
         when selectedPeekProject is non-null; closes back to null. -->
    <ProjectDetailDialog
      :project="selectedPeekProject"
      @update:open="(v) => { if (!v) selectedPeekProject = null }"
    />

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

            <!-- SMS bubble. Body is parsed so MMS image URLs render
                 inline (Dialpad's CDN pattern detected) instead of
                 dropping a raw URL into the message. -->
            <div v-else class="flex" :class="item.direction === 'outbound' ? 'justify-end' : 'justify-start'">
              <div
                class="px-3.5 py-2 text-[15px] leading-[1.35] tracking-[-0.01em] break-words"
                :class="[
                  bodyHasImage(item.body) ? 'max-w-[88%]' : 'max-w-[78%]',
                  item.direction === 'outbound'
                    ? 'text-white bg-gradient-to-br from-sky-500 to-blue-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_2px_rgba(2,132,199,0.25)] rounded-[18px] rounded-br-md'
                    : 'text-foreground bg-foreground/[0.07] dark:bg-foreground/[0.10] rounded-[18px] rounded-bl-md',
                ]"
              >
                <template v-if="item.body">
                  <template v-for="(part, pi) in parseMessageBody(item.body)" :key="pi">
                    <span v-if="part.kind === 'text'" class="whitespace-pre-wrap">{{ part.value }}</span>
                    <a
                      v-else-if="part.kind === 'image'"
                      :href="part.url" target="_blank" rel="noopener"
                      class="block my-0.5 first:mt-0 last:mb-0"
                    >
                      <img
                        :src="part.url"
                        loading="lazy"
                        class="block max-w-full max-h-[280px] rounded-lg object-cover ring-1 ring-black/5 cursor-zoom-in"
                        alt="MMS attachment"
                      />
                    </a>
                    <a
                      v-else
                      :href="part.url" target="_blank" rel="noopener"
                      class="underline underline-offset-2 break-all hover:opacity-80"
                      :class="item.direction === 'outbound' ? 'text-white' : 'text-sky-600 dark:text-sky-400'"
                    >{{ part.url }}</a>
                  </template>
                </template>
                <span v-else class="opacity-60 italic">(empty message)</span>
              </div>
            </div>
          </template>
        </div>
      </aside>
    </div>
  </div>
</template>
