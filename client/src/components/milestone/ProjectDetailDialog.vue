<script setup lang="ts">
// Lite "window in window" project view — slides in from the right as a
// Sheet, mounts the project's CustomerCard + MilestoneStrip + a small
// quick-actions row, and offers an "Open full view" link to the full
// /projects/<rid> route. Keeps the milestone page (table, chart
// selection, scroll position, filters) intact behind it so the user
// can browse a list of projects without losing context.
//
// Data: receives the *project row* the parent already has from its
// projects list / pivot — no extra fetch needed for the lite view.

import { computed, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { RouterLink } from 'vue-router'
import { fmtDate } from '@/lib/dates'
import MilestoneStrip from '@/components/project-detail/MilestoneStrip.vue'
import EventsView from '@/components/project-detail/EventsView.vue'
import Tickets from '@/components/project-detail/Tickets.vue'
import TicketGlance from '@/components/project-detail/TicketGlance.vue'
import FundingChips, { type FundingProject } from '@/components/project-detail/FundingChips.vue'
import ProjectChatSheet from '@/components/chat/ProjectChatSheet.vue'
import { computeStripSteps, computeTransits, type StripStep } from '@/lib/milestoneStrip'

interface ProjectRow {
  record_id: number
  customer_name: string
  customer_address?: string | null
  email?: string | null
  phone?: string | null
  status?: string | null
  state?: string | null
  coordinator?: string | null
  closer?: string | null
  lender?: string | null
  system_size_kw?: number | null
  sales_date?: string | null
  intake_completed?: string | null
  survey_scheduled?: string | null
  survey_submitted?: string | null
  survey_approved?: string | null
  cad_submitted?: string | null
  design_completed?: string | null
  permit_submitted?: string | null
  permit_approved?: string | null
  permit_rejected?: string | null
  nem_submitted?: string | null
  nem_approved?: string | null
  nem_rejected?: string | null
  install_scheduled?: string | null
  install_completed?: string | null
  inspection_scheduled?: string | null
  inspection_passed?: string | null
  pto_submitted?: string | null
  pto_approved?: string | null
  ntp_submitted?: string | null
  ntp_approved?: string | null
  m1_status?: string | null
  [k: string]: unknown
}

const props = defineProps<{
  /** When non-null, dialog is open and rendering this project. */
  project: ProjectRow | null
}>()

const emit = defineEmits<{ 'update:open': [open: boolean] }>()

const auth = useAuthStore()

const isOpen = ref(false)
watch(() => props.project, (p) => {
  isOpen.value = p != null
}, { immediate: true })

// ── Chat about this project ──
const chatOpen = ref(false)

// ── Open tickets + at-a-glance overdue/today/future counts ──
// /api/tickets returns the project's open tickets plus a `kpi` block already
// bucketed against the Denver office calendar — no client-side date math needed.
interface TicketRow {
  record_id: number
  title: string
  status: string
  priority?: string | null
  due_date?: string | null
  category?: string | null
  assigned_to?: string | null
}
interface TicketKpi { allOpen: number; overdue: number; dueToday: number; futureDue: number }
const openTickets = ref<TicketRow[]>([])
const ticketKpi = ref<TicketKpi | null>(null)

async function loadTickets(rid: number) {
  openTickets.value = []
  ticketKpi.value = null
  try {
    const res = await fetch(`/api/tickets?project_id=${rid}&open=1&limit=50`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    if (res.ok) {
      const data = await res.json()
      openTickets.value = (data.tickets as TicketRow[]) ?? []
      ticketKpi.value = (data.kpi as TicketKpi) ?? null
    }
  } catch { /* non-fatal — drawer still renders without tickets */ }
}
watch(() => props.project?.record_id, (rid) => { if (rid) loadTickets(rid) }, { immediate: true })

function onOpenChange(v: boolean) {
  isOpen.value = v
  emit('update:open', v)
}

// Build the milestone strip from the project row directly — avoids a
// fetch since the parent table already has every column the strip
// needs from project_cache.
const stripSteps = computed<StripStep[]>(() => {
  if (!props.project) return []
  return computeStripSteps(props.project)
})
const transits = computed(() => props.project ? computeTransits(props.project) : [])

const phoneHref = computed(() => {
  const p = props.project?.phone
  return p ? `tel:${String(p).replace(/[^0-9+]/g, '')}` : null
})
const smsHref = computed(() => {
  const p = props.project?.phone
  return p ? `sms:${String(p).replace(/[^0-9+]/g, '')}` : null
})
const emailHref = computed(() => {
  const e = props.project?.email
  return e ? `mailto:${e}` : null
})
const mapHref = computed(() => {
  const a = props.project?.customer_address
  return a ? `https://maps.google.com/?q=${encodeURIComponent(String(a))}` : null
})

// Funding pills — reuse the project view's FundingChips (NTP/M1/M2/M3/DCA).
// The drawer receives the full project_cache row, so all the fields it reads
// are already present. Gate the labeled section on FundingChips' own
// visibility rule (m1 status / install scheduled / NTP) so early-stage
// projects show no empty "Funding" header.
function has(v: unknown): boolean {
  return !!(v && String(v).trim() !== '' && v !== '0')
}
const hasFunding = computed(() => {
  const p = props.project
  if (!p) return false
  return !!(p.m1_status || has(p.install_scheduled) || has(p.ntp_submitted) || has(p.ntp_approved))
})
</script>

<template>
  <Sheet :open="isOpen" @update:open="onOpenChange">
    <SheetContent
      side="right"
      class="w-full sm:max-w-[680px] p-0 flex flex-col gap-0 overflow-hidden"
    >
      <SheetHeader class="px-4 py-3 border-b shrink-0">
        <SheetTitle class="text-[15px] font-semibold">
          {{ project?.customer_name ?? 'Project' }}
        </SheetTitle>
        <div v-if="project" class="flex items-center gap-2 mt-0.5 flex-wrap">
          <span v-if="project.state" class="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{{ project.state }}</span>
          <span v-if="project.status" class="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{{ project.status }}</span>
          <span v-if="project.system_size_kw" class="text-[10px] text-muted-foreground tabular-nums">{{ Number(project.system_size_kw).toFixed(2) }} kW</span>

          <!-- Open-ticket glance: ticket icon + overdue (red) / today (amber) /
               future (green) counts. Read it in under a second. -->
          <TicketGlance
            v-if="ticketKpi"
            :overdue="ticketKpi.overdue"
            :today="ticketKpi.dueToday"
            :future="ticketKpi.futureDue"
            show-icon
            empty-text="No open tickets"
          />

          <RouterLink
            :to="{ name: 'project-detail', params: { id: project.record_id } }"
            class="ml-auto text-[11px] text-teal-700 hover:text-teal-800 hover:underline cursor-pointer inline-flex items-center gap-1"
            @click="onOpenChange(false)"
          >
            Open full view
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-3">
              <path d="M7 17L17 7"/><path d="M8 7h9v9"/>
            </svg>
          </RouterLink>
        </div>
      </SheetHeader>

      <div v-if="project" class="flex-1 overflow-y-auto">
        <!-- Address + meta strip -->
        <div class="px-4 pt-3 pb-2 text-[12.5px] text-slate-700 leading-relaxed">
          <p v-if="project.customer_address" class="truncate">{{ project.customer_address }}</p>
          <div class="flex flex-wrap gap-x-4 gap-y-0.5 mt-1 text-[11px] text-muted-foreground">
            <span v-if="project.coordinator">PC: <span class="text-foreground">{{ project.coordinator }}</span></span>
            <span v-if="project.closer">Closer: <span class="text-foreground">{{ project.closer }}</span></span>
            <span v-if="project.lender">Lender: <span class="text-foreground">{{ project.lender }}</span></span>
            <span v-if="project.sales_date">Sale: <span class="text-foreground">{{ fmtDate(project.sales_date) }}</span></span>
          </div>
        </div>

        <!-- Quick actions -->
        <div class="px-4 pb-3 flex flex-wrap gap-1.5">
          <button
            v-if="!auth.isReferralAgent"
            type="button"
            class="inline-flex items-center gap-1.5 text-[11px] font-medium pl-1.5 pr-2.5 py-1 rounded-md bg-slate-900 text-white hover:bg-slate-800 active:scale-95 transition-all cursor-pointer"
            title="Chat about this project"
            @click="chatOpen = true"
          >
            <img src="/img/ai-chat-icon.png" alt="" class="w-4 h-4" aria-hidden="true" />
            Ask AI
          </button>
          <a v-if="phoneHref" :href="phoneHref" class="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-md bg-muted hover:bg-muted/70 cursor-pointer">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-3"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
            Call
          </a>
          <a v-if="smsHref" :href="smsHref" class="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-md bg-muted hover:bg-muted/70 cursor-pointer">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-3"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            Text
          </a>
          <a v-if="emailHref" :href="emailHref" class="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-md bg-muted hover:bg-muted/70 cursor-pointer">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-3"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
            Email
          </a>
          <a v-if="mapHref" :href="mapHref" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-md bg-muted hover:bg-muted/70 cursor-pointer">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-3"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg>
            Map
          </a>
        </div>

        <!-- Funding pills (NTP / M1 / M2 / M3 / DCA) — same component as the full project view -->
        <div v-if="hasFunding" class="px-4 pb-3">
          <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Funding</p>
          <FundingChips :p="project as unknown as FundingProject" />
        </div>

        <!-- Milestone strip -->
        <div class="px-4 pb-3">
          <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Milestones</p>
          <div class="rounded-2xl bg-card px-3 py-3" style="box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 1px 0 rgba(15,23,42,0.03);">
            <MilestoneStrip :steps="stripSteps" :transits="transits" />
          </div>
        </div>

        <!-- Key dates summary -->
        <div class="px-4 pb-4">
          <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Key dates</p>
          <div class="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
            <div v-if="project.intake_completed" class="flex justify-between"><span class="text-muted-foreground">Intake</span><span class="tabular-nums">{{ fmtDate(project.intake_completed) }}</span></div>
            <div v-if="project.survey_scheduled" class="flex justify-between"><span class="text-muted-foreground">Survey sched</span><span class="tabular-nums">{{ fmtDate(project.survey_scheduled) }}</span></div>
            <div v-if="project.survey_approved" class="flex justify-between"><span class="text-muted-foreground">Survey appr</span><span class="tabular-nums">{{ fmtDate(project.survey_approved) }}</span></div>
            <div v-if="project.permit_submitted" class="flex justify-between"><span class="text-muted-foreground">Permit sub</span><span class="tabular-nums">{{ fmtDate(project.permit_submitted) }}</span></div>
            <div v-if="project.permit_approved" class="flex justify-between"><span class="text-muted-foreground">Permit appr</span><span class="tabular-nums">{{ fmtDate(project.permit_approved) }}</span></div>
            <div v-if="project.nem_approved" class="flex justify-between"><span class="text-muted-foreground">NEM appr</span><span class="tabular-nums">{{ fmtDate(project.nem_approved) }}</span></div>
            <div v-if="project.install_scheduled" class="flex justify-between"><span class="text-muted-foreground">Install sched</span><span class="tabular-nums">{{ fmtDate(project.install_scheduled) }}</span></div>
            <div v-if="project.install_completed" class="flex justify-between"><span class="text-muted-foreground">Install done</span><span class="tabular-nums">{{ fmtDate(project.install_completed) }}</span></div>
            <div v-if="project.inspection_scheduled" class="flex justify-between"><span class="text-muted-foreground">Inspx sched</span><span class="tabular-nums">{{ fmtDate(project.inspection_scheduled) }}</span></div>
            <div v-if="project.inspection_passed" class="flex justify-between"><span class="text-muted-foreground">Inspx passed</span><span class="tabular-nums">{{ fmtDate(project.inspection_passed) }}</span></div>
            <div v-if="project.pto_submitted" class="flex justify-between"><span class="text-muted-foreground">PTO sub</span><span class="tabular-nums">{{ fmtDate(project.pto_submitted) }}</span></div>
            <div v-if="project.pto_approved" class="flex justify-between"><span class="text-muted-foreground">PTO appr</span><span class="tabular-nums">{{ fmtDate(project.pto_approved) }}</span></div>
          </div>
        </div>

        <!-- Open tickets — scrollable so a long list never dominates the
             drawer. Only rendered when there are open tickets; the empty case
             is already conveyed by the header glance. Tickets.vue renders its
             own "Tickets" header + count. -->
        <div v-if="openTickets.length" class="px-4 pb-4">
          <div class="max-h-72 overflow-y-auto">
            <Tickets :items="openTickets" flat />
          </div>
        </div>

        <!-- Arrivy events — full event tiles in a single newest-first list so
             upcoming and recently-completed events read off the top. Same
             component as the full project view, in flat (descending) mode.
             EventsView renders its own "Events" header + count chip. -->
        <div class="px-4 pb-4">
          <EventsView :project-rid="project.record_id" flat />
        </div>
      </div>
    </SheetContent>
  </Sheet>

  <!-- Chat about this project — self-contained sheet; opens above the bump-out. -->
  <ProjectChatSheet
    v-if="project"
    v-model:open="chatOpen"
    :project-id="project.record_id"
    :project-name="project.customer_name"
  />
</template>
