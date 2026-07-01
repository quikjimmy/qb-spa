<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick, inject, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { computeStripSteps, computeTransits, type StripStep } from '@/lib/milestoneStrip'
import { weekdaysSinceToday } from '@/lib/bizDays'
import { classifyArrivyTask, type ArrivyStatusKey } from '@/lib/arrivyStatus'
import CustomerCard from '@/components/project-detail/CustomerCard.vue'
import CancelBanner from '@/components/project-detail/CancelBanner.vue'
import UrgentBanner from '@/components/project-detail/UrgentBanner.vue'
// AttentionCard removed for now — surfaced again once we have dynamic rules.
import ProjectChatSheet from '@/components/chat/ProjectChatSheet.vue'
import DealBreakdown from '@/components/project-detail/DealBreakdown.vue'
import Documents from '@/components/project-detail/Documents.vue'
import EventsView from '@/components/project-detail/EventsView.vue'
import ProjectStatusBadge from '@/components/project-detail/ProjectStatusBadge.vue'
import NextUpBanner from '@/components/project-detail/NextUpBanner.vue'
import Communications from '@/components/project-detail/Communications.vue'
import Tickets from '@/components/project-detail/Tickets.vue'
import TicketGlance from '@/components/project-detail/TicketGlance.vue'
import DealFeed, { type FeedRow } from '@/components/project-detail/DealFeed.vue'
import MilestoneStrip from '@/components/project-detail/MilestoneStrip.vue'
import MilestoneDetail from '@/components/project-detail/MilestoneDetail.vue'
import SmsThreadDialog from '@/components/SmsThreadDialog.vue'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

interface Project extends Record<string, unknown> {
  record_id: number
  customer_name: string
  customer_address: string
  email: string | null
  phone: string | null
  status: string
  sales_office: string | null
  lender: string | null
  closer: string | null
  setter: string | null
  area_director: string | null
  coordinator: string | null
  ahj_name: string | null
  utility_company: string | null
  state: string | null
  system_size_kw: number | null
  battery_only?: number
  sales_date: string | null
  intake_completed: string | null
  survey_scheduled: string | null
  survey_submitted: string | null
  survey_approved: string | null
  cad_submitted: string | null
  design_completed: string | null
  permit_submitted: string | null
  permit_approved: string | null
  permit_rejected: string | null
  nem_submitted: string | null
  nem_approved: string | null
  nem_rejected: string | null
  install_scheduled: string | null
  install_completed: string | null
  inspection_scheduled: string | null
  inspection_passed: string | null
  pto_submitted: string | null
  pto_approved: string | null
  qb_modified_at: string | null
  cached_at?: string | null
  epc?: string | null
  // Funding (NTP / M1 / M2 / M3 / DCA)
  lender_loan_id?: string | null
  is_funded?: number | null
  ntp_submitted?: string | null
  ntp_approved?: string | null
  m1_status?: string | null
  m1_ready?: number | null
  m1_expected_amount?: number | null
  m1_requested_date?: string | null
  m1_rejected_date?: string | null
  m1_approved_date?: string | null
  m1_deposit_date?: string | null
  m1_net_received?: number | null
  m2_status?: string | null
  m2_ready?: number | null
  m2_expected_amount?: number | null
  m2_requested_date?: string | null
  m2_rejected_date?: string | null
  m2_approved_date?: string | null
  m2_deposit_date?: string | null
  m2_net_received?: number | null
  m3_status?: string | null
  m3_ready?: number | null
  m3_expected_amount?: number | null
  m3_requested_date?: string | null
  m3_rejected_date?: string | null
  m3_approved_date?: string | null
  m3_deposit_date?: string | null
  m3_net_received?: number | null
  // DCA (ancillary funding event)
  dca_status?: string | null
  dca_timer_start?: string | null
  dca_expected_amount?: number | null
  dca_calc_type?: string | null
  dca_expected_deposit?: string | null
  dca_actual_deposit?: string | null
  dca_total_received?: number | null
  // Custom urgent banner text (shown above the customer card when set)
  urgent_banner_text?: string | null
  // Finance terms
  finance_term?: string | null
  finance_rate?: string | null
  credit_expiration_date?: string | null
  // Equipment
  estimated_production?: number | null
  module_brand?: string | null
  module?: string | null
  panel_count?: number | null
  inverter_brand?: string | null
  inverter?: string | null
  inverter_count?: number | null
  existing_system?: string | null
  // Costs
  system_price?: number | null
  gross_ppw?: number | null
  dealer_fees_pct?: number | null
  dealer_fee_ppw?: number | null
  net_cost?: number | null
  net_ppw?: number | null
  // Integrations
  google_drive_link?: string | null
  project_number?: number | null
  max_arrivy_task_id?: number | null
  // Multi-select missing-items lists per milestone (`;`-joined text)
  permit_missing_items?: string | null
  nem_missing_items?: string | null
  pto_missing_items?: string | null
  // Project-level intake decision (drives the IntakeChecklist pill)
  intake_status?: string | null
}

interface CommItem {
  type: 'sms' | 'call'
  id: string
  occurred_at: string
  direction: string
  from_number?: string | null
  to_number?: string | null
  body?: string | null
  duration_ms?: number | null
  recording_url?: string | null
  contact_name?: string | null
  user_name?: string | null
  message_status?: string | null
  voicemail_url?: string | null
}

interface Ticket {
  record_id: number
  title: string
  status: string
  priority?: string | null
  due_date?: string | null
  category?: string | null
  assigned_to?: string | null
  description?: string | null
}

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

// Hand the customer name up to AppLayout's breadcrumb. Replaces "Projects › 10621"
// with "Projects › {customer name}". AppLayout resets the override on route change.
const lastCrumbLabel = inject<Ref<string | null> | null>('lastCrumbLabel', null)

// AppLayout's pull-to-refresh hook — registering loadAll lets users pull to
// refresh the page on mobile, replacing the "Refresh" button we used to show.
const registerRefresh = inject<((fn: () => Promise<void>) => void) | null>('registerRefresh', null)

const recordId = computed(() => parseInt(String(route.params['id'] ?? ''), 10))

const project = ref<Project | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const comms = ref<CommItem[]>([])
const tickets = ref<Ticket[]>([])
// Open-ticket counts (overdue / today / future) for the at-a-glance bubbles,
// straight from the tickets API kpi block (Denver-anchored server-side).
const ticketKpi = ref<{ overdue: number; dueToday: number; futureDue: number } | null>(null)
const rawFeed = ref<FeedRow[]>([])
interface NoteRow {
  record_id: number
  date_created: string | null
  date_modified: string | null
  record_owner: string | null
  last_modified_by: string | null
  note: string | null
  category: string | null
  notify_pm: number
  notify_rep: number
}
const notes = ref<NoteRow[]>([])
// Most recent retention row (used by the milestone strip — the full list
// lives in RetentionCard fetched separately when the user opens the step).
interface RetentionSummary {
  record_id: number
  cancel_request_at: string | null
  resolved_at: string | null
  resolution_type: string | null
  request_status: string | null
  is_ror: number
}
const retentionSummary = ref<RetentionSummary | null>(null)
const starred = ref(false)

const isDesktop = ref(false)

// Tabbed workspace — replaces the previous endless vertical stack of
// Schedule / Tickets / Comms / Documents in the center column. URL
// hash mirrors the active tab so deep links + browser back/forward
// land on the same view. On desktop the deal sidebar + activity feed
// stay visible alongside; on mobile they become tabs themselves.
type WorkTab = 'all' | 'notes' | 'schedule' | 'tickets' | 'docs' | 'comms' | 'breakdown'
const VALID_TABS: WorkTab[] = ['all', 'notes', 'schedule', 'tickets', 'docs', 'comms', 'breakdown']
function readTabFromHash(): WorkTab {
  if (typeof window === 'undefined') return 'all'
  const h = (window.location.hash || '').replace('#', '') as WorkTab
  return VALID_TABS.includes(h) ? h : 'all'
}
const activeTab = ref<WorkTab>(readTabFromHash())
function setTab(t: string) {
  if (!VALID_TABS.includes(t as WorkTab)) return
  activeTab.value = t as WorkTab
  // Sync to URL hash without triggering a router navigation, so deep
  // links work but the browser doesn't push a history entry per click.
  if (typeof window !== 'undefined') {
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${t}`)
  }
}
const selectedStepId = ref<string | null>(null)
const smsOpen = ref(false)
const stickyHeader = ref(false)
const headerEl = ref<HTMLElement | null>(null)

// ─── Chat Bot side panel ──────────────
// The chat sheet itself lives in the reusable ProjectChatSheet component
// (space/thread/quota wiring, ProjectHome + ChatPanel). This view just owns
// the floating launcher FAB and the open/minimize state.
const chatOpen = ref(false)

// Floating-FAB minimize toggle, mirrors FeedbackLauncher's pattern. When
// minimized the FAB tucks to a small left-edge tab the user can re-open.
const CHAT_MIN_KEY = 'projectChat.minimized'
const chatMinimized = ref<boolean>(typeof localStorage !== 'undefined' && localStorage.getItem(CHAT_MIN_KEY) === '1')
watch(chatMinimized, (v) => {
  try { localStorage.setItem(CHAT_MIN_KEY, v ? '1' : '0') } catch { /* ignore */ }
})
function minimizeChatFab() { chatMinimized.value = true }
function restoreChatFab() { chatMinimized.value = false }

function syncBp() {
  isDesktop.value = typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches
}
let mq: MediaQueryList | null = null

function hdrs() {
  return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }
}

async function loadProject() {
  loading.value = true
  error.value = null
  try {
    const res = await fetch(`/api/projects/${recordId.value}?live=1`, { headers: hdrs() })
    if (!res.ok) throw new Error(`Failed to load project (${res.status})`)
    const data = await res.json()
    project.value = data.project as Project
    if (lastCrumbLabel) lastCrumbLabel.value = project.value?.customer_name ?? null
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

const testProjectSaving = ref(false)
const isTestProject = computed(() => Boolean(Number(project.value?.test_project ?? 0)))

// Admin-only: flip the QB "Test Project" flag (FID 622) and write it straight
// back to QuickBase via the upsert proxy. Optimistic — revert on failure.
// Flagging a project hides it from every list; it stays viewable here because
// the single-record fetch deliberately skips the test-project exclusion.
async function toggleTestProject(value: boolean) {
  if (!project.value || testProjectSaving.value) return
  const rid = project.value.record_id
  const prev = project.value.test_project
  testProjectSaving.value = true
  project.value = { ...project.value, test_project: value ? 1 : 0 }
  try {
    const res = await fetch('/api/qb/upsert', {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify({ to: 'br9kwm8na', data: [{ '3': { value: rid }, '622': { value } }] }),
    })
    if (!res.ok) throw new Error(`Failed to update Test Project flag (${res.status})`)
  } catch (e) {
    project.value = { ...project.value, test_project: prev }
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    testProjectSaving.value = false
  }
}

async function loadComms() {
  try {
    const res = await fetch(`/api/pc-dashboard/comms?project_id=${recordId.value}&limit=200`, { headers: hdrs() })
    if (!res.ok) return
    const data = await res.json()
    comms.value = (data.items as CommItem[]) ?? []
  } catch { /* ignore */ }
}

async function loadTickets() {
  try {
    const res = await fetch(`/api/tickets?project_id=${recordId.value}&open=1&limit=100`, { headers: hdrs() })
    if (!res.ok) return
    const data = await res.json()
    tickets.value = (data.tickets as Ticket[]) ?? []
    ticketKpi.value = data.kpi ?? null
  } catch { /* ignore */ }
}

async function loadNotes() {
  try {
    const res = await fetch(`/api/notes?project_id=${recordId.value}`, { headers: hdrs() })
    if (!res.ok) return
    const data = await res.json()
    notes.value = (data.items as NoteRow[]) ?? []
  } catch { /* ignore */ }
}

// Retention summary — first row in /api/retention is the most recent
// (server orders by cancel_request_at DESC). When non-null, the milestone
// strip appends a disconnected "Retention" step at the end.
async function loadRetention() {
  try {
    const res = await fetch(`/api/retention?project_id=${recordId.value}`, { headers: hdrs() })
    if (!res.ok) return
    const data = await res.json()
    const items = (data.items as RetentionSummary[]) ?? []
    retentionSummary.value = items[0] ?? null
  } catch { /* ignore — retention is optional context */ }
}

async function loadFeed() {
  try {
    const res = await fetch(`/api/feed?project_id=${recordId.value}&limit=200`, { headers: hdrs() })
    if (!res.ok) return
    const data = await res.json()
    rawFeed.value = ((data.items as Array<Record<string, unknown>>) ?? []).map(r => ({
      id: r['id'] as number,
      occurred_at: String(r['occurred_at'] ?? ''),
      event_type: String(r['event_type'] ?? ''),
      title: String(r['title'] ?? ''),
      body: (r['body'] as string) ?? null,
      actor_name: (r['actor_name'] as string) ?? null,
      actor_role: null,
      category: null,
    }))
  } catch { /* ignore */ }
}

// ── Arrivy task overlay for milestone strip ──
//
// We pull the project's Arrivy tasks once and derive the *latest* status
// per template kind (survey/install/inspection). The milestone strip
// reads these to surface a 'cancelled' state when a site visit was
// cancelled, even if QB's milestone date columns still hold a stale
// scheduled date.

interface ArrivyTaskInfo {
  status: ArrivyStatusKey
  taskUrl: string
  scheduledIso: string  // for picking the most recent
  // Cancellation context — populated when status === 'cancelled' and the
  // server's Arrivy log lookup returned phase data.
  cancelPhase?: 'onsite' | 'enroute' | 'scheduled' | null
  cancelledAt?: string | null
  cancelledBy?: string | null
}
interface QbValue { value: unknown }
type QbRecord = Record<string, QbValue>

const arrivySurveyTask = ref<ArrivyTaskInfo | null>(null)
const arrivyInstallTask = ref<ArrivyTaskInfo | null>(null)
const arrivyInspectionTask = ref<ArrivyTaskInfo | null>(null)

function qbVal(rec: QbRecord, fid: number): unknown { return rec[String(fid)]?.value ?? null }
function qbStrField(rec: QbRecord, fid: number): string {
  const v = qbVal(rec, fid)
  if (v == null) return ''
  if (Array.isArray(v)) {
    return (v as Array<unknown>).map(item => {
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>
        return (o['name'] as string) || (o['email'] as string) || ''
      }
      return String(item ?? '')
    }).filter(Boolean).join(', ')
  }
  return String(v)
}

async function loadArrivy() {
  arrivySurveyTask.value = null
  arrivyInstallTask.value = null
  arrivyInspectionTask.value = null
  try {
    const res = await fetch(`/api/field/project-tasks?project_rid=${recordId.value}`, { headers: hdrs() })
    if (!res.ok) return
    interface CancelInfo { phase: 'onsite' | 'enroute' | 'scheduled'; cancelledAt: string; cancelledBy: string }
    const data = await res.json() as {
      records: QbRecord[]
      fields: Record<string, number>
      cancelledTaskRids?: string[]
      cancelledTaskInfo?: Record<string, CancelInfo>
    }
    const F = data.fields
    if (!F) return
    // Server-derived cancellation set (from QB Arrivy task log). The task
    // row's task_status often doesn't reflect cancellation — the log does.
    const cancelled = new Set<string>(data.cancelledTaskRids || [])
    const cancelInfoMap: Record<string, CancelInfo> = data.cancelledTaskInfo || {}
    // Group records by kind, sort by scheduled-datetime desc, classify the latest.
    const byKind: Record<'survey' | 'install' | 'inspection', QbRecord[]> = { survey: [], install: [], inspection: [] }
    for (const rec of data.records || []) {
      const tpl = qbStrField(rec, F['templateName']!).toLowerCase()
      if (!tpl) continue
      if (tpl.includes('survey') || tpl.includes('site visit')) byKind.survey.push(rec)
      else if (tpl.includes('install')) byKind.install.push(rec)
      else if (tpl.includes('inspect')) byKind.inspection.push(rec)
    }
    function statusRank(status: ArrivyStatusKey): number {
      switch (status) {
        case 'onsite': return 80
        case 'enroute': return 70
        case 'submitted':
        case 'approved': return 60
        case 'cancelled':
        case 'rejected': return 50
        case 'scheduled': return 10
      }
    }
    function taskStatus(rec: QbRecord): { status: ArrivyStatusKey; cancelInfo: CancelInfo | null } {
      const taskRid = String(qbVal(rec, 3) ?? '')
      const logCancelled = !!taskRid && cancelled.has(taskRid)
      const status = logCancelled ? 'cancelled' : classifyArrivyTask({
        rawStatus: qbStrField(rec, F['taskStatus']!),
        arrived: qbStrField(rec, F['startedStatus']!) || null,
        enroute: qbStrField(rec, F['enrouteStatus']!) || null,
        submitted: qbStrField(rec, F['submittedDateTime']!) || null,
      })
      return { status, cancelInfo: logCancelled ? cancelInfoMap[taskRid] ?? null : null }
    }
    function latest(kind: 'survey' | 'install' | 'inspection'): ArrivyTaskInfo | null {
      const recs = byKind[kind]
      if (!recs.length) return null
      // Pick the most meaningful task first. A completed/on-site/en-route
      // task should not be hidden behind a future scheduled follow-up just
      // because that follow-up has a later scheduled date.
      recs.sort((a, b) => {
        const as = taskStatus(a).status
        const bs = taskStatus(b).status
        const rankDelta = statusRank(bs) - statusRank(as)
        if (rankDelta !== 0) return rankDelta
        const av = String(qbVal(a, F['scheduledDateTime']!) ?? '')
        const bv = String(qbVal(b, F['scheduledDateTime']!) ?? '')
        return bv.localeCompare(av)
      })
      const rec = recs[0]!
      const { status, cancelInfo: cinfo } = taskStatus(rec)
      return {
        status,
        taskUrl: qbStrField(rec, F['taskUrl']!),
        scheduledIso: String(qbVal(rec, F['scheduledDateTime']!) ?? ''),
        cancelPhase: cinfo?.phase ?? null,
        cancelledAt: cinfo?.cancelledAt ?? null,
        cancelledBy: cinfo?.cancelledBy ?? null,
      }
    }
    arrivySurveyTask.value = latest('survey')
    arrivyInstallTask.value = latest('install')
    arrivyInspectionTask.value = latest('inspection')
  } catch { /* arrivy is optional context — failing here shouldn't break the page */ }
}

async function loadAll() {
  await Promise.all([loadProject(), loadComms(), loadTickets(), loadFeed(), loadNotes(), loadArrivy(), loadRetention()])
}

async function toggleStar() {
  starred.value = !starred.value
  try {
    await fetch(`/api/projects/favorites/${recordId.value}`, { method: 'POST', headers: hdrs() })
  } catch { starred.value = !starred.value }
}

watch(recordId, () => loadAll(), { immediate: false })

// ── Merge comms (sms + calls) into the feed as synthetic types so the
//    Deal Feed filter chips ("Comms") have data to show.
const feedItems = computed<FeedRow[]>(() => {
  const merged: FeedRow[] = [...rawFeed.value]
  for (const c of comms.value) {
    const dirNorm = (c.direction === 'inbound' || c.direction === 'in') ? 'in' : 'out'
    const evType = c.type === 'sms' ? `comms.sms.${dirNorm}` : `comms.call.${dirNorm}`
    const title = c.type === 'sms'
      ? (c.body?.slice(0, 100) || 'Text message')
      : (dirNorm === 'in' ? 'Incoming call' : 'Outgoing call')
    const body = c.type === 'sms' ? null : (c.duration_ms ? `${Math.round(c.duration_ms / 1000)}s` : null)
    merged.push({
      id: `c:${c.id}`,
      occurred_at: c.occurred_at,
      event_type: evType,
      title,
      body: body ?? (c.type === 'sms' ? c.body ?? null : null),
      actor_name: c.user_name ?? c.contact_name ?? null,
    })
  }
  // QB notes — merged with event_type 'note_added' (matches the existing
  // feed_items convention) so the "Notes" filter chip surfaces them too.
  // Title is the first line of the note (or the category as fallback);
  // body is the full text. Category goes into the chip slot we already
  // render above the title.
  for (const n of notes.value) {
    if (!n.date_created) continue
    const noteText = (n.note ?? '').trim()
    const firstLine = noteText.split('\n')[0]?.slice(0, 140) || (n.category ?? 'Note')
    merged.push({
      id: `n:${n.record_id}`,
      occurred_at: n.date_created,
      event_type: 'note_added',
      title: firstLine,
      body: noteText && noteText !== firstLine ? noteText : null,
      actor_name: n.last_modified_by ?? n.record_owner ?? null,
      category: n.category ?? null,
    })
  }
  return merged
})

// ── Scroll spy for mobile section nav ─────────────────────

// (Old IntersectionObserver-based section nav removed when the body
// switched to a tabbed workspace — the active tab now drives focus,
// and URL hash sync is handled by readTabFromHash / setTab.)

// ── Sticky compact header on scroll past the main customer card ──
function onScroll() {
  if (!headerEl.value) { stickyHeader.value = false; return }
  const rect = headerEl.value.getBoundingClientRect()
  // Show the sticky bar once the H1 leaves the top of the viewport (with topbar offset)
  stickyHeader.value = rect.bottom < 60
}

onMounted(async () => {
  syncBp()
  if (typeof window !== 'undefined') {
    mq = window.matchMedia('(min-width: 1024px)')
    mq.addEventListener('change', syncBp)
    window.addEventListener('scroll', onScroll, { passive: true })
  }
  if (registerRefresh) registerRefresh(loadAll)
  if (Number.isFinite(recordId.value) && recordId.value > 0) await loadAll()
  await nextTick()
  onScroll()
})

onBeforeUnmount(() => {
  if (mq) mq.removeEventListener('change', syncBp)
  window.removeEventListener('scroll', onScroll)
})

// ── Derived data ─────────────────────────────────────────

const customerForCard = computed(() => {
  if (!project.value) return null
  const p = project.value
  return {
    record_id: p.record_id,
    customer_name: p.customer_name,
    customer_address: p.customer_address || '',
    phone: p.phone,
    email: p.email,
    status: p.status,
    system_size_kw: p.system_size_kw,
    battery_only: p.battery_only,
    utility_company: p.utility_company,
    ahj_name: p.ahj_name,
    coordinator: p.coordinator,
    lender: p.lender,
    daysInStatus: weekdaysSinceToday(p.qb_modified_at ?? null),
    // Funding pass-through (FundingChips reads these)
    lender_loan_id: p.lender_loan_id,
    ntp_submitted: p.ntp_submitted,
    ntp_approved: p.ntp_approved,
    m1_status: p.m1_status,
    m1_requested_date: p.m1_requested_date,
    m1_rejected_date: p.m1_rejected_date,
    m1_approved_date: p.m1_approved_date,
    m1_deposit_date: p.m1_deposit_date,
    m1_net_received: p.m1_net_received,
    m2_status: p.m2_status,
    m2_requested_date: p.m2_requested_date,
    m2_rejected_date: p.m2_rejected_date,
    m2_approved_date: p.m2_approved_date,
    m2_deposit_date: p.m2_deposit_date,
    m2_net_received: p.m2_net_received,
    m3_status: p.m3_status,
    m3_requested_date: p.m3_requested_date,
    m3_rejected_date: p.m3_rejected_date,
    m3_approved_date: p.m3_approved_date,
    m3_deposit_date: p.m3_deposit_date,
    m3_net_received: p.m3_net_received,
    install_scheduled: p.install_scheduled,
    dca_status: p.dca_status,
    dca_timer_start: p.dca_timer_start,
    dca_calc_type: p.dca_calc_type,
    dca_expected_deposit: p.dca_expected_deposit,
    dca_actual_deposit: p.dca_actual_deposit,
    dca_total_received: p.dca_total_received,
    google_drive_link: p.google_drive_link,
    project_number: p.project_number,
    max_arrivy_task_id: p.max_arrivy_task_id,
  }
})

const stripSteps = computed<StripStep[]>(() => {
  if (!project.value) return []
  const r = retentionSummary.value
  return computeStripSteps({
    ...project.value,
    arrivy_survey_status: arrivySurveyTask.value?.status ?? null,
    arrivy_install_status: arrivyInstallTask.value?.status ?? null,
    arrivy_inspection_status: arrivyInspectionTask.value?.status ?? null,
    arrivy_survey_cancelled_at:     arrivySurveyTask.value?.cancelledAt     ?? null,
    arrivy_install_cancelled_at:    arrivyInstallTask.value?.cancelledAt    ?? null,
    arrivy_inspection_cancelled_at: arrivyInspectionTask.value?.cancelledAt ?? null,
    retention_request_at:      r?.cancel_request_at ?? null,
    retention_resolved_at:     r?.resolved_at ?? null,
    retention_resolution_type: r?.resolution_type ?? null,
    retention_request_status:  r?.request_status ?? null,
    retention_is_ror:          !!r?.is_ror,
  })
})
const transits = computed(() => project.value ? computeTransits(project.value) : [])
const selectedStep = computed<StripStep | null>(() => stripSteps.value.find(s => s.id === selectedStepId.value) ?? null)
// Pick the Arrivy task that maps to the currently-selected milestone step
// — only survey/install/inspection have Arrivy tasks; other steps return
// null and the pill stays hidden.
const selectedStepArrivy = computed<ArrivyTaskInfo | null>(() => {
  const id = selectedStepId.value
  if (id === 'survey') return arrivySurveyTask.value
  if (id === 'install') return arrivyInstallTask.value
  if (id === 'inspection') return arrivyInspectionTask.value
  return null
})

function onStripSelect(id: string) {
  selectedStepId.value = selectedStepId.value === id ? null : id
}
function closeDetail() { selectedStepId.value = null }

// AttentionCard derivation removed — to be reintroduced when we wire dynamic
// cross-app rules (tickets + SLA + comms gap + agent runs).

const lastUpdated = computed(() => {
  const v = project.value?.qb_modified_at
  if (!v) return ''
  const d = new Date(v)
  if (isNaN(d.getTime())) return v
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
})

const lastUpdatedBy = computed<string | null>(() => {
  const sorted = [...rawFeed.value].sort((a, b) => String(b.occurred_at || '').localeCompare(String(a.occurred_at || '')))
  return sorted[0]?.actor_name ?? null
})

const qbHref = computed(() => `https://kin.quickbase.com/db/br9kwm8na?a=dr&rid=${recordId.value}`)
</script>

<template>
  <div class="-mx-3 -my-4 sm:-mx-6 sm:-my-6 min-h-full" style="background: #f7f3f0;">
    <!-- Loading / error -->
    <div v-if="loading" class="p-6 text-center text-sm text-slate-500">Loading project…</div>
    <div v-else-if="error" class="p-6">
      <div class="bg-red-50 text-red-700 rounded-xl p-4 text-sm">
        {{ error }}
        <button class="ml-2 underline cursor-pointer" @click="loadAll">Retry</button>
      </div>
    </div>
    <div v-else-if="!project" class="p-6 text-sm text-slate-500">Project not found.</div>

    <template v-else>
      <!-- Sticky compact header (slides in once user scrolls past the main card) -->
      <div
        v-if="stickyHeader"
        class="sticky top-14 z-30 bg-white/95 backdrop-blur-sm border-b border-slate-200 shadow-sm"
        style="margin: 0;"
      >
        <div class="max-w-[1240px] mx-auto px-4 sm:px-6 py-2 flex items-center gap-3">
          <button
            class="text-[11px] text-slate-400 hover:text-slate-700 transition-colors cursor-pointer shrink-0"
            @click="router.push({ name: 'projects' })"
            aria-label="Back to projects"
          >←</button>
          <span class="text-sm" :class="starred ? 'text-amber-400' : 'text-slate-300'">{{ starred ? '★' : '☆' }}</span>
          <h2 class="text-[14px] sm:text-[15px] font-semibold text-slate-900 truncate flex-1">{{ project.customer_name }}</h2>
          <ProjectStatusBadge :status="project.status" dot />
        </div>
      </div>

      <!-- Back-to-Projects + Refresh removed: the AppLayout breadcrumb
           ("Projects › {customer name}") covers nav, and pull-to-refresh
           covers data refresh. Chat lives as a floating FAB at the bottom
           right. -->

      <!-- Banners — Urgent (free-text) sits above Cancel/Pending Cancel.
           Both auto-hide when their source data is empty. Tight top
           padding because the AppLayout topbar already has its own. -->
      <section class="max-w-[1240px] mx-auto px-4 sm:px-6 pt-2 sm:pt-3 pb-3 flex flex-col gap-2">
        <UrgentBanner :text="project.urgent_banner_text" />
        <CancelBanner :status="project.status" />
      </section>

      <!-- HEADER CARD -->
      <section ref="headerEl" class="max-w-[1240px] mx-auto px-4 sm:px-6 pb-3">
        <CustomerCard
          v-if="customerForCard"
          :p="customerForCard"
          :starred="starred"
          @toggle-star="toggleStar"
          @text="smsOpen = true"
        >
          <!-- Open-ticket glance, anchored right of the address row. Tap to
               jump to the Tickets tab. -->
          <template #meta>
            <button
              v-if="ticketKpi"
              type="button"
              class="inline-flex items-center cursor-pointer"
              title="Open tickets — overdue / due today / upcoming"
              @click="setTab('tickets')"
            >
              <TicketGlance
                :overdue="ticketKpi.overdue"
                :today="ticketKpi.dueToday"
                :future="ticketKpi.futureDue"
                show-icon
                empty-text="No open tickets"
              />
            </button>
          </template>
        </CustomerCard>
      </section>

      <!-- MILESTONE STRIP -->
      <section
        class="max-w-[1240px] mx-auto px-4 sm:px-6 pb-3"
        aria-label="Milestone progress"
      >
        <div
          class="rounded-2xl bg-white px-3 sm:px-5 py-3"
          style="box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 1px 0 rgba(15,23,42,0.03);"
        >
          <MilestoneStrip
            :steps="stripSteps"
            :transits="transits"
            :active-id="selectedStepId"
            @select="onStripSelect"
          />
        </div>
        <div v-if="selectedStep" class="mt-2.5">
          <MilestoneDetail
            :step="selectedStep"
            :feed="feedItems"
            :coordinator="project.coordinator"
            :reference-date="project.sales_date"
            :arrivy-status="selectedStepArrivy?.status ?? null"
            :arrivy-task-url="selectedStepArrivy?.taskUrl ?? null"
            :cancel-phase="selectedStepArrivy?.cancelPhase ?? null"
            :cancelled-at="selectedStepArrivy?.cancelledAt ?? null"
            :cancelled-by="selectedStepArrivy?.cancelledBy ?? null"
            :project-rid="project.record_id"
            :intake-status="project.intake_status ?? null"
            :is-test-project="isTestProject"
            :test-project-saving="testProjectSaving"
            @toggle-test-project="toggleTestProject"
            @close="closeDetail"
          />
        </div>
      </section>

      <!-- AI PROJECT SUMMARY — placeholder card the same width as the
           milestone strip, sitting between the milestones and the body.
           Stub for a future LLM-generated synopsis (Cliff's Notes of the
           project state). -->
      <section class="max-w-[1240px] mx-auto px-4 sm:px-6 pb-3">
        <div
          class="rounded-2xl bg-white px-3 sm:px-5 py-3 border border-dashed border-slate-200"
          style="box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 1px 0 rgba(15,23,42,0.03);"
        >
          <div class="flex items-baseline justify-between gap-2 flex-wrap">
            <p class="text-[10px] font-bold uppercase tracking-widest text-slate-400">AI · Project Summary</p>
            <p class="text-[10px] text-slate-400 italic">Coming soon — auto-generated from notes, milestones, and recent comms</p>
          </div>
          <p class="text-[12px] text-slate-500 mt-1.5">
            Status snapshot, blockers worth knowing, and "what changed since you last looked" will land here once the summary
            agent is wired in.
          </p>
        </div>
      </section>

      <!-- DESKTOP: 2-col workspace -->
      <div
        v-if="isDesktop"
        class="max-w-[1240px] mx-auto px-6 pb-6"
      >
        <!-- Two-pane workspace — left: deal facts + Next Up (stacked),
             right: tabbed work area dominated by the unified "All" feed.
             Sized so the page stays usable when the Live Comms Hub rail
             is open (parent SidebarInset adds right padding for the rail
             and this grid reflows naturally). -->
        <div class="grid grid-cols-[320px_1fr] gap-4 items-start">
          <!-- LEFT — Deal Breakdown + Next Up, sticky -->
          <aside class="lg:sticky lg:top-20 self-start max-h-[calc(100vh-100px)] overflow-y-auto pr-1 flex flex-col gap-3.5">
            <DealBreakdown :p="project" />
            <NextUpBanner :project-rid="project.record_id" />
          </aside>

          <!-- RIGHT — tabs. Default = "All" (chronological feed of notes
               + schedule + milestone + comms + tickets, with multi-select
               filter chips). Tickets is dropped as a top-level tab since
               it's a filter dimension on the All view. -->
          <main>
            <Tabs :model-value="activeTab" @update:model-value="(v) => setTab(String(v))">
              <TabsList class="w-full justify-start bg-card/60 p-1 rounded-xl">
                <TabsTrigger value="all" class="flex-1">All</TabsTrigger>
                <TabsTrigger value="notes" class="flex-1">Notes</TabsTrigger>
                <TabsTrigger value="schedule" class="flex-1">Schedule</TabsTrigger>
                <TabsTrigger value="tickets" class="flex-1">
                  Tickets
                  <TicketGlance v-if="ticketKpi" class="ml-1.5" :overdue="ticketKpi.overdue" :today="ticketKpi.dueToday" :future="ticketKpi.futureDue" />
                </TabsTrigger>
                <TabsTrigger value="docs" class="flex-1">Docs</TabsTrigger>
                <TabsTrigger value="comms" class="flex-1">Comms</TabsTrigger>
              </TabsList>
              <TabsContent value="all" class="mt-3"><DealFeed :items="feedItems" mode="multi" /></TabsContent>
              <TabsContent value="notes" class="mt-3"><DealFeed :items="feedItems" :show-filters="false" locked-filter="notes" /></TabsContent>
              <TabsContent value="schedule" class="mt-3"><EventsView :project-rid="project.record_id" /></TabsContent>
              <TabsContent value="tickets" class="mt-3"><Tickets :items="tickets" flat show-request /></TabsContent>
              <TabsContent value="docs" class="mt-3"><Documents :project-rid="project.record_id" /></TabsContent>
              <TabsContent value="comms" class="mt-3"><Communications :items="comms" /></TabsContent>
            </Tabs>
          </main>
        </div>
      </div>

      <!-- MOBILE — same tab order. Deal sidebar collapses into a "Deal"
           tab since there's no room for the sidebar at narrow widths. -->
      <template v-else>
        <div class="max-w-[1240px] mx-auto px-4 sm:px-6 pb-6">
          <NextUpBanner :project-rid="project.record_id" />
          <Tabs :model-value="activeTab" @update:model-value="(v) => setTab(String(v))" class="mt-3">
            <div class="sticky top-14 z-20 -mx-4 sm:-mx-6 px-4 sm:px-6 py-1.5" style="background: #f7f3f0;">
              <TabsList class="bg-card/60 p-1 rounded-xl overflow-x-auto no-scrollbar w-full justify-start">
                <TabsTrigger value="all" class="shrink-0">All</TabsTrigger>
                <TabsTrigger value="notes" class="shrink-0">Notes</TabsTrigger>
                <TabsTrigger value="schedule" class="shrink-0">Schedule</TabsTrigger>
                <TabsTrigger value="tickets" class="shrink-0">
                  Tickets
                  <TicketGlance v-if="ticketKpi" class="ml-1.5" :overdue="ticketKpi.overdue" :today="ticketKpi.dueToday" :future="ticketKpi.futureDue" />
                </TabsTrigger>
                <TabsTrigger value="docs" class="shrink-0">Docs</TabsTrigger>
                <TabsTrigger value="comms" class="shrink-0">Comms</TabsTrigger>
                <TabsTrigger value="breakdown" class="shrink-0">Deal</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="all" class="mt-3"><DealFeed :items="feedItems" mode="multi" /></TabsContent>
            <TabsContent value="notes" class="mt-3"><DealFeed :items="feedItems" :show-filters="false" locked-filter="notes" /></TabsContent>
            <TabsContent value="schedule" class="mt-3"><EventsView :project-rid="project.record_id" list-only /></TabsContent>
            <TabsContent value="tickets" class="mt-3"><Tickets :items="tickets" flat show-request /></TabsContent>
            <TabsContent value="docs" class="mt-3"><Documents :project-rid="project.record_id" /></TabsContent>
            <TabsContent value="comms" class="mt-3"><Communications :items="comms" /></TabsContent>
            <TabsContent value="breakdown" class="mt-3"><DealBreakdown :p="project" /></TabsContent>
          </Tabs>
        </div>
      </template>

      <!-- FOOTER -->
      <footer class="max-w-[1240px] mx-auto px-4 sm:px-6 pb-10 pt-4 mt-2 border-t border-slate-200/60">
        <div class="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11.5px] text-slate-500">
          <span>
            <span class="text-slate-400">Project ID</span>
            <span class="ml-1 font-mono text-slate-600">#{{ project.record_id }}</span>
          </span>
          <span v-if="lastUpdated">
            <span class="text-slate-400">Last update</span>
            <span class="ml-1 text-slate-600">{{ lastUpdated }}</span>
          </span>
          <span v-if="lastUpdatedBy">
            <span class="text-slate-400">By</span>
            <span class="ml-1 text-slate-600">{{ lastUpdatedBy }}</span>
          </span>
          <span v-if="!auth.isReferralAgent" class="ml-auto">
            <a
              :href="qbHref"
              target="_blank"
              rel="noopener"
              class="inline-flex items-center gap-1.5 text-teal-700 hover:underline cursor-pointer"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M14 4H20V10M20 4L10 14M19 14V19C19 19.6 18.6 20 18 20H5C4.4 20 4 19.6 4 19V6C4 5.4 4.4 5 5 5H10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
              Open in QB
            </a>
          </span>
        </div>
      </footer>

      <!-- Floating Chat FAB — bottom-LEFT to keep clear of the global
           FeedbackLauncher (bottom-right). Mirrors FeedbackLauncher's
           pattern: tap pill to open, ✕ to minimize to a left-edge tab.
           Hidden entirely for Referral Agents (no AI chat). -->
      <template v-if="!auth.isReferralAgent">
      <div
        v-if="!chatMinimized"
        class="fixed bottom-4 right-4 z-50 inline-flex items-stretch rounded-full bg-slate-900 text-white shadow-lg hover:shadow-xl transition-all overflow-hidden"
        :class="chatOpen ? 'ring-2 ring-teal-400' : ''"
      >
        <button
          type="button"
          class="inline-flex items-center justify-center pl-3 pr-2 h-11 active:scale-95 transition-transform cursor-pointer"
          title="Chat about this project"
          aria-label="Open project chat"
          @click="chatOpen = true"
        >
          <img src="/img/ai-chat-icon.png" alt="" class="w-7 h-7" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="inline-flex items-center justify-center w-7 border-l border-white/20 hover:bg-white/10 active:bg-white/20 transition-colors cursor-pointer"
          title="Minimize chat"
          aria-label="Minimize project chat"
          @click="minimizeChatFab"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <!-- Minimized: thin vertical pill anchored to the RIGHT edge, lower than
           the FeedbackLauncher (which sits right-edge mid-height) so the two
           don't collide. Tap to restore. -->
      <button
        v-else
        type="button"
        class="fixed right-0 bottom-24 z-50 bg-slate-900 text-white shadow-lg hover:shadow-xl active:scale-95 transition-all rounded-l-md py-2.5 px-1.5 cursor-pointer"
        title="Show project chat"
        aria-label="Show project chat"
        @click="restoreChatFab"
      >
        <span class="text-[10px] font-semibold uppercase tracking-widest [writing-mode:vertical-rl] [text-orientation:mixed]">AI Chat</span>
      </button>
      </template>

      <SmsThreadDialog
        v-if="project.phone"
        :open="smsOpen"
        :external-number="project.phone || ''"
        :contact-name="project.customer_name"
        @close="smsOpen = false"
      />

      <ProjectChatSheet
        v-model:open="chatOpen"
        :project-id="project.record_id"
        :project-name="project.customer_name"
      />
    </template>
  </div>
</template>
