<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import CallActivityFeed from '@/components/CallActivityFeed.vue'
import DialpadLivePanel from '@/components/DialpadLivePanel.vue'
import CommsInbox from '@/components/CommsInbox.vue'
import DtIconInbox from '@dialpad/dialtone-icons/vue3/inbox'
import DtIconBarChart from '@dialpad/dialtone-icons/vue3/bar-chart-2'

const auth = useAuthStore()

// ─── Types ───────────────────────────────────────────────

interface CallTotals {
  total_calls: number
  inbound_total: number
  outbound_total: number
  inbound_answered: number
  inbound_unanswered: number
  inbound_callback_requested: number
  in_missed: number
  in_abandoned: number
  in_voicemail: number
  in_transfer_unanswered: number
  outbound_user_initiated: number
  outbound_callback_attempt: number
  out_connected: number
  out_cancelled: number
  total_talk_time_sec: number
  outbound_talk_time_sec: number
}
interface SmsTotals { sms_total: number; sms_incoming: number; sms_outgoing: number }

interface CoordinatorRow {
  coordinator: string
  portal_user_id: number | null
  portal_email: string
  dialpad_email: string
  matched: boolean
  totals: CallTotals
  sms: SmsTotals
}

interface SyncLog {
  status: string
  rows_ingested: number
  error: string | null
  started_at: string
  finished_at: string | null
}

interface SummaryResponse {
  window: { from: string | null; to: string | null; days: number | null }
  totals: CallTotals
  sms: SmsTotals
  byCoordinator: CoordinatorRow[]
  matching: { total_dialpad_users: number; matched_to_portal: number; unmatched: number }
  lastSync: { calls: SyncLog | null; sms: SyncLog | null }
  filters: { coordinators: string[] }
}

// ─── State ───────────────────────────────────────────────

const loading = ref(true)
const refreshing = ref(false)
const summary = ref<SummaryResponse | null>(null)
const viewMode = ref<'personal' | 'team'>('team')
const fCoordinator = ref('')

// Date window — same preset vocabulary as the PC Dashboard
const datePreset = ref('last_30')
const dateFrom = ref('')
const dateTo = ref('')
const presets = [
  { key: 'last_7', label: '7d' },
  { key: 'last_14', label: '14d' },
  { key: 'last_30', label: '30d' },
  { key: 'last_60', label: '60d' },
  { key: 'last_90', label: '90d' },
  { key: 'this_month', label: 'Mo' },
  { key: 'this_quarter', label: 'Qtr' },
  { key: 'this_year', label: 'YTD' },
]

function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

function fmtLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function applyPreset(key: string) {
  datePreset.value = key
  const t = new Date()
  const to = fmtLocalDate(t)
  const daysBack = (n: number) => { const d = new Date(t); d.setDate(d.getDate() - n); return fmtLocalDate(d) }
  if (key === 'last_7')  { dateFrom.value = daysBack(6);  dateTo.value = to }
  else if (key === 'last_14') { dateFrom.value = daysBack(13); dateTo.value = to }
  else if (key === 'last_30') { dateFrom.value = daysBack(29); dateTo.value = to }
  else if (key === 'last_60') { dateFrom.value = daysBack(59); dateTo.value = to }
  else if (key === 'last_90') { dateFrom.value = daysBack(89); dateTo.value = to }
  else if (key === 'this_month') { dateFrom.value = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-01`; dateTo.value = to }
  else if (key === 'this_quarter') { dateFrom.value = `${t.getFullYear()}-${String(Math.floor(t.getMonth() / 3) * 3 + 1).padStart(2, '0')}-01`; dateTo.value = to }
  else if (key === 'this_year') { dateFrom.value = `${t.getFullYear()}-01-01`; dateTo.value = to }
  loadSummary()
}

// ─── Data loading ────────────────────────────────────────

async function loadSummary() {
  loading.value = true
  const p = new URLSearchParams()
  if (dateFrom.value) p.set('from', dateFrom.value)
  if (dateTo.value) p.set('to', dateTo.value)
  if (viewMode.value === 'personal' && auth.user?.name) p.set('coordinator', auth.user.name)
  else if (fCoordinator.value) p.set('coordinator', fCoordinator.value)
  try {
    const res = await fetch(`/api/dialpad/summary?${p}`, { headers: hdrs() })
    if (res.ok) summary.value = await res.json()
  } finally { loading.value = false }
}

async function refreshAll() {
  refreshing.value = true
  try {
    // Choose how many days to sync based on the current window.
    let days = 30
    if (dateFrom.value && dateTo.value) {
      const diff = Math.ceil((new Date(dateTo.value).getTime() - new Date(dateFrom.value).getTime()) / (1000 * 60 * 60 * 24)) + 1
      days = Math.min(Math.max(diff, 7), 30)
    }
    await fetch('/api/dialpad/refresh-all', { method: 'POST', headers: hdrs(), body: JSON.stringify({ days }) })
    await loadSummary()
  } finally { refreshing.value = false }
}

// ─── Percentage helpers ──────────────────────────────────

function pct(num: number, denom: number): string {
  if (!denom || !isFinite(num / denom)) return '—'
  const n = (num / denom) * 100
  if (n >= 99.95) return '100%'
  if (n < 0.1 && num > 0) return '<0.1%'
  return `${n.toFixed(n >= 10 ? 0 : 1)}%`
}
function fmtNum(n: number): string { return (n || 0).toLocaleString() }
function fmtTalk(sec: number): string {
  if (!sec || sec < 60) return `${sec || 0}s`
  const m = Math.round(sec / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60); const r = m % 60
  return r ? `${h}h ${r}m` : `${h}h`
}
function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z')
  if (isNaN(d.getTime())) return iso
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

// ─── Derived views ───────────────────────────────────────

const totals = computed<CallTotals | null>(() => summary.value?.totals || null)
const smsTotals = computed<SmsTotals | null>(() => summary.value?.sms || null)
const coordinators = computed<CoordinatorRow[]>(() => summary.value?.byCoordinator || [])
const coordinatorOptions = computed<string[]>(() => summary.value?.filters?.coordinators || [])

const inboundAnswerRate = computed(() => totals.value ? pct(totals.value.inbound_answered, totals.value.inbound_total) : '—')
const outboundConnectRate = computed(() => totals.value ? pct(totals.value.out_connected, totals.value.outbound_user_initiated) : '—')

const hasSms = computed(() => !!(summary.value?.sms.sms_total))
const hasCalls = computed(() => !!(summary.value?.totals.total_calls))

// Drill-down node definitions — each row is:
//  { id, label, value, parentValueKey }
// The parentValueKey drives the "% of X" column.
interface DrillRow {
  id: string
  label: string
  depth: number
  value: number
  parent: number | null
  parentLabel: string
}

const drill = computed<DrillRow[]>(() => {
  const t = totals.value
  if (!t) return []
  const rows: DrillRow[] = []
  rows.push({ id: 'total', label: 'Total calls', depth: 0, value: t.total_calls, parent: null, parentLabel: '' })

  // Inbound branch
  rows.push({ id: 'inbound_total', label: 'Inbound', depth: 1, value: t.inbound_total, parent: t.total_calls, parentLabel: 'total' })
  rows.push({ id: 'inbound_answered', label: 'Answered', depth: 2, value: t.inbound_answered, parent: t.inbound_total, parentLabel: 'inbound' })
  rows.push({ id: 'inbound_unanswered', label: 'Unanswered', depth: 2, value: t.inbound_unanswered, parent: t.inbound_total, parentLabel: 'inbound' })
  rows.push({ id: 'in_missed', label: 'Missed', depth: 3, value: t.in_missed, parent: t.inbound_unanswered, parentLabel: 'unanswered' })
  rows.push({ id: 'in_abandoned', label: 'Abandoned', depth: 3, value: t.in_abandoned, parent: t.inbound_unanswered, parentLabel: 'unanswered' })
  rows.push({ id: 'in_transfer_unanswered', label: 'Unanswered transfer', depth: 3, value: t.in_transfer_unanswered, parent: t.inbound_unanswered, parentLabel: 'unanswered' })
  rows.push({ id: 'in_voicemail', label: 'Voicemail', depth: 3, value: t.in_voicemail, parent: t.inbound_unanswered, parentLabel: 'unanswered' })
  rows.push({ id: 'inbound_callback_requested', label: 'Callback requested', depth: 2, value: t.inbound_callback_requested, parent: t.inbound_total, parentLabel: 'inbound' })

  // Outbound branch
  rows.push({ id: 'outbound_total', label: 'Outbound', depth: 1, value: t.outbound_total, parent: t.total_calls, parentLabel: 'total' })
  rows.push({ id: 'outbound_user_initiated', label: 'User initiated', depth: 2, value: t.outbound_user_initiated, parent: t.outbound_total, parentLabel: 'outbound' })
  rows.push({ id: 'out_connected', label: 'Connected', depth: 3, value: t.out_connected, parent: t.outbound_user_initiated, parentLabel: 'user initiated' })
  rows.push({ id: 'out_cancelled', label: 'Cancelled', depth: 3, value: t.out_cancelled, parent: t.outbound_user_initiated, parentLabel: 'user initiated' })
  rows.push({ id: 'outbound_callback_attempt', label: 'Callback attempt', depth: 2, value: t.outbound_callback_attempt, parent: t.outbound_total, parentLabel: 'outbound' })
  return rows
})

const expandedNodes = ref<Record<string, boolean>>({ total: true, inbound_total: true, outbound_total: true, inbound_unanswered: true, outbound_user_initiated: true })
function toggleDrill(id: string) { expandedNodes.value = { ...expandedNodes.value, [id]: !expandedNodes.value[id] } }

// Parent visibility: a row is shown if all its ancestors are expanded.
function isDrillVisible(row: DrillRow): boolean {
  if (row.depth === 0) return true
  if (row.depth === 1) return !!expandedNodes.value['total']
  if (row.depth === 2) {
    if (row.id.startsWith('inbound')) return !!expandedNodes.value['total'] && !!expandedNodes.value['inbound_total']
    return !!expandedNodes.value['total'] && !!expandedNodes.value['outbound_total']
  }
  if (row.depth === 3) {
    if (row.id.startsWith('in_')) return !!expandedNodes.value['total'] && !!expandedNodes.value['inbound_total'] && !!expandedNodes.value['inbound_unanswered']
    return !!expandedNodes.value['total'] && !!expandedNodes.value['outbound_total'] && !!expandedNodes.value['outbound_user_initiated']
  }
  return true
}
function canToggle(row: DrillRow): boolean {
  return ['total', 'inbound_total', 'outbound_total', 'inbound_unanswered', 'outbound_user_initiated'].includes(row.id)
}

// ─── Lifecycle ───────────────────────────────────────────

onMounted(() => {
  // Set the default date window for Reporting but only load the summary if
  // Reporting is the active tab — otherwise we wait until the user switches.
  const t = new Date()
  const from = new Date(t); from.setDate(t.getDate() - 29)
  dateFrom.value = fmtLocalDate(from)
  dateTo.value = fmtLocalDate(t)
  datePreset.value = 'last_30'
  if (mainTab.value === 'reporting') loadSummary()
})

watch([viewMode, fCoordinator], () => { loadSummary() })

// Activity feed — click a user row (or the "Show my activity" strip) to
// expand a CallActivityFeed below the table scoped to that coordinator.
const activityCoordinator = ref<string>('')
function toggleActivity(coord: string) {
  activityCoordinator.value = activityCoordinator.value === coord ? '' : coord
}

// Top-level tab: Inbox (actionable per-user view) or Reporting (KPIs +
// drill-down). Default to Inbox — that's the "what do I need to do" view
// most PCs will land on daily. localStorage persists the last choice.
type CommsTab = 'inbox' | 'reporting'
const mainTab = ref<CommsTab>((localStorage.getItem('comms.mainTab') as CommsTab) || 'inbox')
function setMainTab(t: CommsTab) {
  mainTab.value = t
  localStorage.setItem('comms.mainTab', t)
  // Load summary lazily when Reporting is opened
  if (t === 'reporting' && !summary.value) loadSummary()
}
</script>

<template>
  <div class="grid gap-4 min-w-0">
    <!-- Header — controls wrap below title on <sm screens so 390px iPhones don't overflow -->
    <div class="sticky top-0 z-20 bg-background flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 -mx-3 px-3 sm:-mx-6 sm:px-6 py-2">
      <div class="flex items-baseline gap-2 min-w-0">
        <h1 class="text-2xl font-semibold tracking-tight truncate">Comms Hub</h1>
        <span v-if="totals" class="text-sm font-medium text-muted-foreground tabular-nums shrink-0">
          {{ fmtNum(totals.total_calls) }} calls
          <span v-if="hasSms">· {{ fmtNum(smsTotals?.sms_total || 0) }} texts</span>
        </span>
      </div>
      <div class="flex items-center gap-1.5 flex-wrap">
        <Select :model-value="fCoordinator || '__all__'" @update:model-value="(v: string) => { fCoordinator = v === '__all__' ? '' : v; if (fCoordinator) viewMode = 'team' }">
          <SelectTrigger class="h-8 w-auto min-w-[110px] max-w-[160px] text-xs"><SelectValue placeholder="All users" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All users</SelectItem>
            <SelectItem v-for="c in coordinatorOptions" :key="c" :value="c">{{ c }}</SelectItem>
          </SelectContent>
        </Select>
        <div class="flex rounded-md border overflow-hidden shrink-0">
          <button class="px-2.5 h-8 text-xs font-medium transition-colors" :class="viewMode === 'personal' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'" @click="viewMode = 'personal'; fCoordinator = ''">Me</button>
          <button class="px-2.5 h-8 text-xs font-medium transition-colors" :class="viewMode === 'team' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'" @click="viewMode = 'team'">Team</button>
        </div>
        <Button v-if="auth.isAdmin" variant="outline" class="h-8 text-xs px-2.5 shrink-0" :disabled="refreshing" @click="refreshAll">
          {{ refreshing ? 'Syncing…' : 'Sync' }}
        </Button>
      </div>
    </div>

    <!-- Live events panel (SSE) — always visible, above the tabs -->
    <DialpadLivePanel />

    <!-- Top-level tabs: Inbox vs Reporting -->
    <div class="flex rounded-lg border overflow-hidden bg-muted/20 w-full sm:w-auto sm:self-start">
      <button
        class="flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium transition-colors"
        :class="mainTab === 'inbox' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
        @click="setMainTab('inbox')"
      >
        <component :is="DtIconInbox" class="w-3.5 h-3.5" />
        Inbox
      </button>
      <button
        class="flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium transition-colors"
        :class="mainTab === 'reporting' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
        @click="setMainTab('reporting')"
      >
        <component :is="DtIconBarChart" class="w-3.5 h-3.5" />
        Reporting
      </button>
    </div>

    <!-- Inbox tab -->
    <CommsInbox v-if="mainTab === 'inbox'" />

    <!-- Reporting tab content below — everything date-window-scoped -->
    <template v-if="mainTab === 'reporting'">
    <!-- Date presets + sync status -->
    <div class="flex flex-wrap items-center gap-1.5">
      <button v-for="p in presets" :key="p.key"
        class="px-2 py-0.5 rounded border text-[10px] font-medium transition-colors"
        :class="datePreset === p.key ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'"
        @click="applyPreset(p.key)"
      >{{ p.label }}</button>
      <span v-if="dateFrom && dateTo" class="text-[10px] text-muted-foreground ml-2">{{ dateFrom }} → {{ dateTo }}</span>
      <!-- Historical batch sync status (NOT the live webhook feed, which is
           shown separately in the Live Activity panel below). -->
      <span class="text-[10px] text-muted-foreground ml-auto" title="Historical records pulled from Dialpad's Stats API on demand. Separate from the live webhook feed.">
        Historical sync · Calls: <span :class="summary?.lastSync?.calls?.status === 'failed' ? 'text-red-600' : 'text-emerald-600'">{{ summary?.lastSync?.calls?.status || 'never' }}</span>
        · {{ timeAgo(summary?.lastSync?.calls?.finished_at) }}
      </span>
      <span v-if="summary?.lastSync?.sms" class="text-[10px] text-muted-foreground" title="Historical SMS pull (stat_type=texts). Live SMS arrives separately via webhooks.">
        · SMS: <span :class="summary.lastSync.sms.status === 'failed' ? 'text-red-600' : 'text-emerald-600'">{{ summary.lastSync.sms.status }}</span>
      </span>
    </div>

    <!-- Loading / empty -->
    <div v-if="loading && !summary" class="rounded-xl border bg-card p-12 text-center text-sm text-muted-foreground">Loading Comms Hub…</div>
    <div v-else-if="summary && !hasCalls" class="rounded-xl border bg-card p-12 text-center">
      <p class="text-muted-foreground">No call data for this window.</p>
      <p class="text-xs text-muted-foreground mt-1">
        <template v-if="summary.lastSync?.calls?.status === 'failed'">Last sync failed: {{ summary.lastSync.calls.error }}</template>
        <template v-else-if="!summary.lastSync?.calls">No Dialpad sync has run yet.</template>
        <template v-else>Try syncing or picking a wider date range.</template>
      </p>
      <Button v-if="auth.isAdmin" variant="outline" size="sm" class="mt-4" :disabled="refreshing" @click="refreshAll">
        {{ refreshing ? 'Syncing…' : 'Sync from Dialpad' }}
      </Button>
    </div>

    <template v-else-if="totals">
      <!-- KPI tiles -->
      <div class="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <div class="rounded-xl border bg-card p-3">
          <p class="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">Total calls</p>
          <p class="text-xl font-extrabold tabular-nums mt-1">{{ fmtNum(totals.total_calls) }}</p>
          <p class="text-[10px] text-muted-foreground mt-0.5">{{ fmtTalk(totals.total_talk_time_sec) }} talk time</p>
        </div>
        <div class="rounded-xl border bg-card p-3">
          <p class="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">Inbound</p>
          <p class="text-xl font-extrabold tabular-nums mt-1 text-sky-600">{{ fmtNum(totals.inbound_total) }}</p>
          <p class="text-[10px] text-muted-foreground mt-0.5">{{ pct(totals.inbound_total, totals.total_calls) }} of total</p>
        </div>
        <div class="rounded-xl border bg-card p-3">
          <p class="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">Outbound</p>
          <p class="text-xl font-extrabold tabular-nums mt-1 text-emerald-600">{{ fmtNum(totals.outbound_total) }}</p>
          <p class="text-[10px] text-muted-foreground mt-0.5">{{ pct(totals.outbound_total, totals.total_calls) }} of total</p>
        </div>
        <div class="rounded-xl border bg-card p-3">
          <p class="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">Inbound answer rate</p>
          <p class="text-xl font-extrabold tabular-nums mt-1" :class="totals.inbound_total && (totals.inbound_answered / totals.inbound_total) < 0.75 ? 'text-amber-600' : 'text-emerald-600'">{{ inboundAnswerRate }}</p>
          <p class="text-[10px] text-muted-foreground mt-0.5">{{ fmtNum(totals.inbound_answered) }} / {{ fmtNum(totals.inbound_total) }}</p>
        </div>
        <div class="rounded-xl border bg-card p-3">
          <p class="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">Outbound connect rate</p>
          <p class="text-xl font-extrabold tabular-nums mt-1" :class="totals.outbound_user_initiated && (totals.out_connected / totals.outbound_user_initiated) < 0.5 ? 'text-amber-600' : 'text-emerald-600'">{{ outboundConnectRate }}</p>
          <p class="text-[10px] text-muted-foreground mt-0.5">{{ fmtNum(totals.out_connected) }} / {{ fmtNum(totals.outbound_user_initiated) }}</p>
        </div>
      </div>

      <!-- SMS tiles (only if there's data) -->
      <div v-if="hasSms" class="grid grid-cols-3 gap-2">
        <div class="rounded-xl border bg-card p-3">
          <p class="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">Total texts</p>
          <p class="text-lg font-extrabold tabular-nums mt-1">{{ fmtNum(smsTotals?.sms_total || 0) }}</p>
        </div>
        <div class="rounded-xl border bg-card p-3">
          <p class="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">Incoming</p>
          <p class="text-lg font-extrabold tabular-nums mt-1 text-sky-600">{{ fmtNum(smsTotals?.sms_incoming || 0) }}</p>
          <p class="text-[10px] text-muted-foreground mt-0.5">{{ pct(smsTotals?.sms_incoming || 0, smsTotals?.sms_total || 0) }} of total</p>
        </div>
        <div class="rounded-xl border bg-card p-3">
          <p class="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">Outgoing</p>
          <p class="text-lg font-extrabold tabular-nums mt-1 text-emerald-600">{{ fmtNum(smsTotals?.sms_outgoing || 0) }}</p>
          <p class="text-[10px] text-muted-foreground mt-0.5">{{ pct(smsTotals?.sms_outgoing || 0, smsTotals?.sms_total || 0) }} of total</p>
        </div>
      </div>

      <!-- Drill-down tree -->
      <div class="rounded-xl border bg-card overflow-hidden">
        <div class="px-4 py-2.5 border-b flex items-center justify-between">
          <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Call breakdown</p>
          <p class="text-[10px] text-muted-foreground">Each row shows % of its parent leg</p>
        </div>
        <div class="divide-y">
          <div v-for="row in drill.filter(isDrillVisible)" :key="row.id"
            class="flex items-center gap-1.5 sm:gap-2 pr-3 sm:pr-4 py-1.5 text-[11px] transition-colors"
            :class="[canToggle(row) ? 'hover:bg-muted/40 cursor-pointer' : '', row.depth === 0 ? 'bg-muted/30 font-semibold' : '']"
            :style="{ paddingLeft: `${8 + row.depth * 14}px` }"
            @click="canToggle(row) && toggleDrill(row.id)"
          >
            <svg v-if="canToggle(row)" xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground shrink-0 transition-transform" :class="expandedNodes[row.id] ? 'rotate-90' : ''"><polyline points="9 18 15 12 9 6"/></svg>
            <span v-else class="w-[10px] shrink-0" />
            <span class="flex-1 min-w-0 truncate" :class="row.depth === 0 ? 'text-foreground' : 'text-muted-foreground'">{{ row.label }}</span>
            <span class="tabular-nums text-right shrink-0 font-semibold text-foreground w-10 sm:w-16">{{ fmtNum(row.value) }}</span>
            <span class="tabular-nums text-right shrink-0 text-muted-foreground w-12 sm:w-auto sm:min-w-[4rem]">
              <template v-if="row.parent === null">100%</template>
              <template v-else-if="row.parent > 0">{{ pct(row.value, row.parent) }}<span class="hidden sm:inline text-[9px]"> of {{ row.parentLabel }}</span></template>
              <template v-else>—</template>
            </span>
          </div>
        </div>
      </div>

      <!-- Per-user table -->
      <div class="rounded-xl border bg-card overflow-hidden">
        <div class="px-3 sm:px-4 py-2.5 border-b flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 sm:gap-2">
          <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">By user</p>
          <p class="text-[10px] text-muted-foreground">
            {{ summary?.matching.matched_to_portal || 0 }} of {{ summary?.matching.total_dialpad_users || 0 }} matched
            <span v-if="summary && summary.matching.unmatched > 0" class="text-amber-600">· {{ summary.matching.unmatched }} unmatched</span>
          </p>
        </div>
        <!-- Desktop: table — full metric set side-by-side -->
        <div class="hidden sm:block">
          <table class="w-full text-[11px] tabular-nums">
            <thead class="bg-muted/30 text-muted-foreground">
              <tr>
                <th class="text-left font-medium px-3 py-2">User</th>
                <th class="text-right font-medium px-2 py-2">Total</th>
                <th class="text-right font-medium px-2 py-2">In</th>
                <th class="text-right font-medium px-2 py-2">Out</th>
                <th class="text-right font-medium px-2 py-2">In ans%</th>
                <th class="text-right font-medium px-2 py-2">Out conn%</th>
                <th class="text-right font-medium px-2 py-2">Out talk</th>
                <th v-if="hasSms" class="text-right font-medium px-2 py-2">SMS in</th>
                <th v-if="hasSms" class="text-right font-medium px-2 py-2">SMS out</th>
              </tr>
            </thead>
            <tbody class="divide-y">
              <tr v-for="r in coordinators" :key="r.coordinator" class="hover:bg-muted/30 cursor-pointer" :class="activityCoordinator === r.coordinator ? 'bg-muted/30' : ''" @click="toggleActivity(r.coordinator)">
                <td class="px-3 py-1.5">
                  <div class="flex items-center gap-1.5 min-w-0">
                    <span class="font-medium truncate">{{ r.coordinator }}</span>
                    <span v-if="!r.matched" class="text-[9px] font-medium px-1 py-0.5 rounded bg-amber-100 text-amber-700 shrink-0" title="Not matched to a portal user — add as a portal user with matching email to link.">unmatched</span>
                  </div>
                  <p v-if="!r.matched && r.dialpad_email" class="text-[9px] text-muted-foreground truncate">{{ r.dialpad_email }}</p>
                </td>
                <td class="text-right px-2">{{ fmtNum(r.totals.total_calls) }}</td>
                <td class="text-right px-2 text-sky-700">{{ fmtNum(r.totals.inbound_total) }}</td>
                <td class="text-right px-2 text-emerald-700">{{ fmtNum(r.totals.outbound_total) }}</td>
                <td class="text-right px-2">{{ pct(r.totals.inbound_answered, r.totals.inbound_total) }}</td>
                <td class="text-right px-2">{{ pct(r.totals.out_connected, r.totals.outbound_user_initiated) }}</td>
                <td class="text-right px-2 text-muted-foreground">{{ fmtTalk(r.totals.outbound_talk_time_sec) }}</td>
                <td v-if="hasSms" class="text-right px-2 text-sky-700">{{ fmtNum(r.sms?.sms_incoming || 0) }}</td>
                <td v-if="hasSms" class="text-right px-2 text-emerald-700">{{ fmtNum(r.sms?.sms_outgoing || 0) }}</td>
              </tr>
              <tr v-if="coordinators.length === 0">
                <td :colspan="hasSms ? 9 : 7" class="text-center py-6 text-muted-foreground">No users with activity in this window.</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Mobile: card rows — no h-scroll, each metric labeled -->
        <div class="sm:hidden divide-y">
          <div v-for="r in coordinators" :key="r.coordinator" class="px-3 py-2 space-y-1.5 cursor-pointer" :class="activityCoordinator === r.coordinator ? 'bg-muted/30' : ''" @click="toggleActivity(r.coordinator)">
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="font-medium text-[12px] truncate flex-1 min-w-0">{{ r.coordinator }}</span>
              <span v-if="!r.matched" class="text-[9px] font-medium px-1 py-0.5 rounded bg-amber-100 text-amber-700 shrink-0">unmatched</span>
            </div>
            <p v-if="!r.matched && r.dialpad_email" class="text-[9px] text-muted-foreground truncate -mt-1">{{ r.dialpad_email }}</p>

            <div class="grid grid-cols-3 gap-1.5 text-[11px] tabular-nums">
              <div class="rounded bg-muted/30 px-2 py-1">
                <p class="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Total</p>
                <p class="font-semibold">{{ fmtNum(r.totals.total_calls) }}</p>
              </div>
              <div class="rounded bg-muted/30 px-2 py-1">
                <p class="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">In</p>
                <p class="font-semibold text-sky-700">{{ fmtNum(r.totals.inbound_total) }}</p>
              </div>
              <div class="rounded bg-muted/30 px-2 py-1">
                <p class="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Out</p>
                <p class="font-semibold text-emerald-700">{{ fmtNum(r.totals.outbound_total) }}</p>
              </div>
              <div class="rounded bg-muted/30 px-2 py-1">
                <p class="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">In ans%</p>
                <p class="font-semibold">{{ pct(r.totals.inbound_answered, r.totals.inbound_total) }}</p>
              </div>
              <div class="rounded bg-muted/30 px-2 py-1">
                <p class="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Out conn%</p>
                <p class="font-semibold">{{ pct(r.totals.out_connected, r.totals.outbound_user_initiated) }}</p>
              </div>
              <div class="rounded bg-muted/30 px-2 py-1">
                <p class="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Out talk</p>
                <p class="font-semibold text-muted-foreground">{{ fmtTalk(r.totals.outbound_talk_time_sec) }}</p>
              </div>
            </div>

            <div v-if="hasSms" class="grid grid-cols-2 gap-1.5 text-[11px] tabular-nums">
              <div class="rounded bg-muted/30 px-2 py-1">
                <p class="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">SMS in</p>
                <p class="font-semibold text-sky-700">{{ fmtNum(r.sms?.sms_incoming || 0) }}</p>
              </div>
              <div class="rounded bg-muted/30 px-2 py-1">
                <p class="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">SMS out</p>
                <p class="font-semibold text-emerald-700">{{ fmtNum(r.sms?.sms_outgoing || 0) }}</p>
              </div>
            </div>
          </div>
          <div v-if="coordinators.length === 0" class="px-3 py-6 text-center text-muted-foreground text-[11px]">
            No users with activity in this window.
          </div>
        </div>
      </div>

      <!-- Per-user activity feed — opens inline when a user row is clicked -->
      <CallActivityFeed
        v-if="activityCoordinator"
        :coordinator="activityCoordinator"
        :from="dateFrom || undefined"
        :to="dateTo || undefined"
      />
    </template>
    </template>
  </div>
</template>
