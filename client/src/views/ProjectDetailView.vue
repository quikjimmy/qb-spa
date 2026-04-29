<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { computeStripSteps, computeTransits, type StripStep } from '@/lib/milestoneStrip'
import { weekdaysSinceToday } from '@/lib/bizDays'
import CustomerCard from '@/components/project-detail/CustomerCard.vue'
import CancelBanner from '@/components/project-detail/CancelBanner.vue'
import UrgentBanner from '@/components/project-detail/UrgentBanner.vue'
// AttentionCard removed for now — surfaced again once we have dynamic rules.
import ChatPanel from '@/components/chat/ChatPanel.vue'
import ProjectHome from '@/components/chat/ProjectHome.vue'
import ChatHeaderMeta from '@/components/chat/ChatHeaderMeta.vue'
import ContextPreview from '@/components/chat/ContextPreview.vue'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import DealBreakdown from '@/components/project-detail/DealBreakdown.vue'
import EventsView from '@/components/project-detail/EventsView.vue'
import ProjectStatusBadge from '@/components/project-detail/ProjectStatusBadge.vue'
import NextUpBanner from '@/components/project-detail/NextUpBanner.vue'
import Communications from '@/components/project-detail/Communications.vue'
import Tickets from '@/components/project-detail/Tickets.vue'
import DealFeed, { type FeedRow } from '@/components/project-detail/DealFeed.vue'
import MilestoneStrip from '@/components/project-detail/MilestoneStrip.vue'
import MilestoneDetail from '@/components/project-detail/MilestoneDetail.vue'
import SmsThreadDialog from '@/components/SmsThreadDialog.vue'

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
}

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const recordId = computed(() => parseInt(String(route.params['id'] ?? ''), 10))

const project = ref<Project | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const comms = ref<CommItem[]>([])
const tickets = ref<Ticket[]>([])
const rawFeed = ref<FeedRow[]>([])
const starred = ref(false)

const isDesktop = ref(false)
const selectedStepId = ref<string | null>(null)
const activeSection = ref<string>('breakdown')
const smsOpen = ref(false)
const stickyHeader = ref(false)
const headerEl = ref<HTMLElement | null>(null)

// ─── Chat Bot side panel ──────────────
// Mirrors the /chat full-page UX: open the panel → land on the project's
// "home" view (threads list + new chat CTA) → pick or create → chat.
interface ChatThread { id: number; title: string; project_id: number | null; project_name: string | null; space_id: number | null; space_name: string | null; preferred_provider: string | null; preferred_model: string | null; archived: boolean; created_at: string; updated_at: string; last_message_at: string | null }
interface ChatSpace { id: number; project_id: number; name: string; thread_count: number; created_at: string; last_used_at: string | null }
interface RateSnapshot { tokens_remaining: number | null; tokens_limit: number | null; requests_remaining: number | null; requests_limit: number | null; reset_at: string | null; used_own_key: boolean; updated_at: string }
interface ChatQuota { cap_cents: number | null; spent_cents: number; cap_pct_used: number | null; byok_bypasses_cap: boolean; providers: Record<string, RateSnapshot> }

const chatOpen = ref(false)
const chatSpace = ref<ChatSpace | null>(null)
const chatThreads = ref<ChatThread[]>([])
const chatActiveThreadId = ref<number | null>(null)
const chatQuota = ref<ChatQuota | null>(null)
const chatPanelRef = ref<InstanceType<typeof ChatPanel> | null>(null)
const chatContextPreviewOpen = ref(false)

function chatHdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

async function refreshChatQuota() {
  const r = await fetch('/api/chat/quota', { headers: chatHdrs() })
  if (r.ok) chatQuota.value = await r.json()
}

function openChatModelPicker() { chatPanelRef.value?.openModelPicker?.() }

async function openChatBot() {
  if (!project.value) return
  chatOpen.value = true
  // Always land on the project's home (no thread selected) — user picks
  // an existing one to continue or hits "Start a new chat".
  chatActiveThreadId.value = null
  refreshChatQuota()
  try {
    const sRes = await fetch(`/api/chat/spaces/from-project/${project.value.record_id}`, { method: 'POST', headers: chatHdrs() })
    if (sRes.ok) chatSpace.value = await sRes.json()
    if (chatSpace.value) {
      const tRes = await fetch(`/api/chat/threads?space_id=${chatSpace.value.id}`, { headers: chatHdrs() })
      if (tRes.ok) {
        const data = await tRes.json()
        chatThreads.value = data.threads || []
      }
    }
  } catch { /* swallow */ }
}

async function chatNewThread() {
  if (!chatSpace.value) return
  const res = await fetch('/api/chat/threads', {
    method: 'POST', headers: chatHdrs(),
    body: JSON.stringify({ space_id: chatSpace.value.id }),
  })
  if (res.ok) {
    const t = await res.json() as ChatThread
    chatThreads.value = [t, ...chatThreads.value]
    chatActiveThreadId.value = t.id
  }
}

function chatPickThread(t: { id: number }) {
  chatActiveThreadId.value = t.id
}

function chatBackToHome() {
  chatActiveThreadId.value = null
}

function onChatThreadCreated(t: ChatThread) {
  chatThreads.value = [t, ...chatThreads.value.filter(x => x.id !== t.id)]
  chatActiveThreadId.value = t.id
}

function onChatThreadUpdated(t: ChatThread) {
  const idx = chatThreads.value.findIndex(x => x.id === t.id)
  if (idx >= 0) chatThreads.value[idx] = t
  chatThreads.value.sort((a, b) => (b.last_message_at || b.created_at).localeCompare(a.last_message_at || a.created_at))
  refreshChatQuota()
}

const chatActiveThread = computed(() => chatThreads.value.find(t => t.id === chatActiveThreadId.value) || null)

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
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
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
    const res = await fetch(`/api/tickets?project_id=${recordId.value}&open=0&limit=100`, { headers: hdrs() })
    if (!res.ok) return
    const data = await res.json()
    tickets.value = (data.tickets as Ticket[]) ?? []
  } catch { /* ignore */ }
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

async function loadAll() {
  await Promise.all([loadProject(), loadComms(), loadTickets(), loadFeed()])
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
  return merged
})

// ── Scroll spy for mobile section nav ─────────────────────
const sections: Array<{ id: string; label: string }> = [
  { id: 'breakdown', label: 'Breakdown' },
  { id: 'schedule',  label: 'Schedule' },
  { id: 'activity',  label: 'Activity' },
  { id: 'tickets',   label: 'Tickets' },
  { id: 'comms',     label: 'Comms' },
]

let observer: IntersectionObserver | null = null

function observeSections() {
  if (typeof window === 'undefined' || isDesktop.value) return
  if (observer) observer.disconnect()
  observer = new IntersectionObserver(entries => {
    const visible = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
    if (visible.length && visible[0]) activeSection.value = (visible[0].target as HTMLElement).id
  }, { rootMargin: '-160px 0px -60% 0px', threshold: 0 })
  for (const s of sections) {
    const el = document.getElementById(s.id)
    if (el) observer.observe(el)
  }
}

function jumpTo(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  const top = el.getBoundingClientRect().top + window.scrollY - 110
  window.scrollTo({ top, behavior: 'smooth' })
  history.replaceState(null, '', `#${id}`)
}

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
  if (Number.isFinite(recordId.value) && recordId.value > 0) await loadAll()
  await nextTick()
  observeSections()
  onScroll()
  const h = window.location.hash.replace('#', '')
  if (h && sections.some(s => s.id === h)) jumpTo(h)
})

onBeforeUnmount(() => {
  if (mq) mq.removeEventListener('change', syncBp)
  if (observer) observer.disconnect()
  window.removeEventListener('scroll', onScroll)
})

watch(isDesktop, () => observeSections())

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

const stripSteps = computed<StripStep[]>(() => project.value ? computeStripSteps(project.value) : [])
const transits = computed(() => project.value ? computeTransits(project.value) : [])
const selectedStep = computed<StripStep | null>(() => stripSteps.value.find(s => s.id === selectedStepId.value) ?? null)

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

      <!-- Page-level top row -->
      <div class="max-w-[1240px] mx-auto px-4 sm:px-6 pt-4 sm:pt-5 pb-3 flex items-center justify-between">
        <button
          class="text-sm text-slate-500 hover:text-slate-900 transition-colors cursor-pointer"
          @click="router.push({ name: 'projects' })"
        >← Projects</button>
        <div class="flex items-center gap-2">
          <button
            class="inline-flex items-center justify-center size-8 rounded-full bg-slate-900 text-white hover:bg-slate-800 transition-colors cursor-pointer"
            @click="openChatBot"
            title="Open Chat Bot for this project"
            aria-label="Open Chat Bot"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          </button>
          <button
            class="text-sm text-slate-500 hover:text-slate-900 transition-colors cursor-pointer px-2"
            @click="loadAll"
          >Refresh</button>
        </div>
      </div>

      <!-- Banners — Urgent (free-text) sits above Cancel/Pending Cancel.
           Both auto-hide when their source data is empty. -->
      <section class="max-w-[1240px] mx-auto px-4 sm:px-6 pb-3 flex flex-col gap-2">
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
        />
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
            @close="closeDetail"
          />
        </div>
      </section>

      <!-- DESKTOP: 3-col grid — left: breakdown, center: schedule/tickets/comms, RIGHT: feed -->
      <div
        v-if="isDesktop"
        class="max-w-[1240px] mx-auto px-6 pb-6"
      >
        <div class="grid grid-cols-[320px_1fr_380px] gap-[18px] items-start">
          <div class="flex flex-col gap-3.5">
            <DealBreakdown :p="project" />
          </div>
          <div class="flex flex-col gap-3.5">
            <NextUpBanner :project-rid="project.record_id" />
            <div id="schedule"><EventsView :project-rid="project.record_id" /></div>
            <div id="tickets"><Tickets :items="tickets" /></div>
            <div id="comms"><Communications :items="comms" /></div>
          </div>
          <!-- Right rail: chronological project feed, sticky so it persists as the center scrolls -->
          <div id="activity" class="lg:sticky lg:top-20 self-start">
            <DealFeed :items="feedItems" />
          </div>
        </div>
      </div>

      <!-- MOBILE -->
      <template v-else>
        <nav
          class="sticky top-14 z-20"
          aria-label="Section navigation"
          style="background: #f7f3f0;"
        >
          <div class="max-w-[1240px] mx-auto px-4 sm:px-6 py-1.5">
            <ul class="flex items-center gap-1 overflow-x-auto" style="scrollbar-width: none;">
              <li v-for="s in sections" :key="s.id">
                <button
                  type="button"
                  class="text-[12px] px-2.5 py-1.5 rounded-md transition-colors cursor-pointer whitespace-nowrap"
                  :class="activeSection === s.id
                    ? 'text-teal-700 bg-teal-50 font-medium'
                    : 'text-slate-500 hover:text-slate-900'"
                  @click="jumpTo(s.id)"
                >{{ s.label }}</button>
              </li>
            </ul>
          </div>
        </nav>

        <div class="max-w-[1240px] mx-auto px-4 sm:px-6 pb-6 flex flex-col gap-3.5">
          <NextUpBanner :project-rid="project.record_id" />
          <section id="breakdown" class="scroll-mt-[140px]">
            <DealBreakdown :p="project" />
          </section>
          <section id="schedule" class="scroll-mt-[140px]">
            <EventsView :project-rid="project.record_id" list-only />
          </section>
          <section id="activity" class="scroll-mt-[140px]">
            <DealFeed :items="feedItems" />
          </section>
          <section id="tickets" class="scroll-mt-[140px]">
            <Tickets :items="tickets" />
          </section>
          <section id="comms" class="scroll-mt-[140px]">
            <Communications :items="comms" />
          </section>
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
          <span class="ml-auto">
            <a
              :href="qbHref"
              target="_blank"
              rel="noopener"
              class="inline-flex items-center gap-1.5 text-teal-700 hover:underline cursor-pointer"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M14 4H20V10M20 4L10 14M19 14V19C19 19.6 18.6 20 18 20H5C4.4 20 4 19.6 4 19V6C4 5.4 4.4 5 5 5H10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
              Open in Quickbase
            </a>
          </span>
        </div>
      </footer>

      <SmsThreadDialog
        v-if="project.phone"
        :open="smsOpen"
        :external-number="project.phone || ''"
        :contact-name="project.customer_name"
        @close="smsOpen = false"
      />

      <Sheet v-model:open="chatOpen">
        <SheetContent side="right" class="w-full sm:max-w-md md:max-w-lg p-0 flex flex-col gap-0">
          <!-- Slim header — when on a thread, "← Back" returns to project home -->
          <div class="flex items-center gap-2 px-4 py-3 bg-card/40 backdrop-blur-sm shrink-0">
            <button v-if="chatActiveThreadId"
              @click="chatBackToHome"
              class="inline-flex items-center justify-center size-8 rounded-lg hover:bg-foreground/[0.06] text-muted-foreground hover:text-foreground transition-colors shrink-0"
              title="Back to project home"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
            </button>
            <div class="size-8 rounded-full bg-gradient-to-br from-foreground/10 to-foreground/5 flex items-center justify-center shrink-0">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 1 0-16 0"/></svg>
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Chat Bot</div>
              <div class="text-sm font-medium truncate">
                {{ chatActiveThreadId ? (chatActiveThread?.title || 'New chat') : (chatSpace?.name || project.customer_name) }}
              </div>
            </div>
            <ChatHeaderMeta
              v-if="chatActiveThreadId"
              :preferred-provider="chatActiveThread?.preferred_provider ?? null"
              :preferred-model="chatActiveThread?.preferred_model ?? null"
              :quota="chatQuota"
              :compact="true"
              @open-picker="openChatModelPicker"
            />
            <button v-if="chatActiveThreadId && auth.isAdmin"
              @click="chatContextPreviewOpen = true"
              class="inline-flex items-center justify-center size-8 rounded-lg hover:bg-foreground/[0.06] text-muted-foreground hover:text-foreground transition-colors shrink-0"
              title="Show context sent to model (debug)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
            </button>
          </div>

          <!-- Body: ProjectHome when no thread, ChatPanel when in a thread -->
          <div v-if="!chatActiveThreadId && chatSpace" class="flex-1 min-h-0">
            <ProjectHome
              :space="chatSpace"
              :threads="chatThreads"
              @pick-thread="chatPickThread"
              @new-chat="chatNewThread"
            />
          </div>
          <div v-else class="flex-1 min-h-0">
            <ChatPanel
              ref="chatPanelRef"
              :thread-id="chatActiveThreadId"
              :default-space-id="chatSpace?.id ?? null"
              :allow-project-picker="false"
              :compact="true"
              @thread-created="onChatThreadCreated"
              @thread-updated="onChatThreadUpdated"
            />
          </div>
        </SheetContent>
      </Sheet>

      <!-- Admin-only debug: shows the exact system prompt the model received -->
      <ContextPreview
        v-if="auth.isAdmin"
        :open="chatContextPreviewOpen"
        :thread-id="chatActiveThreadId"
        @close="chatContextPreviewOpen = false"
      />
    </template>
  </div>
</template>
