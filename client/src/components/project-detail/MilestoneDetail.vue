<script setup lang="ts">
import { computed } from 'vue'
import type { StripStep } from '@/lib/milestoneStrip'
import { fmtFull } from '@/lib/milestoneStrip'
import { STATUS_INFO, type ArrivyStatusKey } from '@/lib/arrivyStatus'
import IntakeChecklist from './IntakeChecklist.vue'

interface FeedRow {
  id: string | number
  occurred_at: string
  event_type: string
  title: string
  body?: string | null
  actor_name?: string | null
}

const props = defineProps<{
  step: StripStep | null
  feed: FeedRow[]
  coordinator?: string | null
  // referenceDate (sales_date or last activity) used as fallback when step has no date
  referenceDate?: string | null
  /** Live Arrivy task status for this step (when there is one). Hidden
   *  when its label matches the milestone state to avoid the "Cancelled
   *  Cancelled" duplication. */
  arrivyStatus?: ArrivyStatusKey | null
  arrivyTaskUrl?: string | null
  /** Cancellation context — phase the task was in when cancelled
   *  (onsite / enroute / scheduled), plus actor + timestamp. */
  cancelPhase?: 'onsite' | 'enroute' | 'scheduled' | null
  cancelledAt?: string | null
  cancelledBy?: string | null
  /** Project record ID — used to fetch related child-table data (intake
   *  events, etc.) only for the steps that need it. */
  projectRid?: number | null
}>()

const emit = defineEmits<{ close: [] }>()

const arrivyInfo = computed(() => props.arrivyStatus ? STATUS_INFO[props.arrivyStatus] : null)

// Hide the live Arrivy pill when its label is identical to the milestone
// state pill (avoids "Cancelled Cancelled"). The phase descriptor below
// carries the unique signal for cancelled cases.
const showArrivyPill = computed(() => {
  if (!arrivyInfo.value) return false
  const stateText = (stateLabel[props.step?.state ?? 'not'] ?? '').toLowerCase()
  return arrivyInfo.value.label.toLowerCase() !== stateText
})

// One-line, human-readable description of how the cancellation went down.
// Used right under the pills so the user instantly knows whether a tech
// made the trip or not.
const cancelPhaseDescriptor = computed<string>(() => {
  if (props.step?.state !== 'cancelled') return ''
  const phase = props.cancelPhase
  const who = props.cancelledBy ? ` by ${props.cancelledBy}` : ''
  const when = props.cancelledAt ? ` · ${fmtCancelTs(props.cancelledAt)}` : ''
  if (phase === 'onsite') return `Cancelled while crew was on-site${who}${when}`
  if (phase === 'enroute') return `Cancelled while crew was en-route${who}${when}`
  if (phase === 'scheduled') return `Cancelled before arrival${who}${when}`
  return `Cancelled${who}${when}`
})

function fmtCancelTs(s: string): string {
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

const stateLabel: Record<string, string> = {
  done: 'Done',
  active: 'In progress',
  scheduled: 'Scheduled',
  rejected: 'Rejected',
  overdue: 'Overdue',
  cancelled: 'Cancelled',
  not: 'Not started',
}

const stateClass: Record<string, string> = {
  done: 'bg-emerald-50 text-emerald-700',
  active: 'bg-amber-50 text-amber-700',
  scheduled: 'bg-blue-50 text-blue-700',
  rejected: 'bg-violet-50 text-violet-700',
  overdue: 'bg-stone-100 text-stone-700',
  cancelled: 'bg-rose-600 text-white',
  not: 'bg-slate-100 text-slate-500',
}

const subDot: Record<string, string> = {
  done: 'bg-emerald-500',
  rejected: 'bg-violet-500',
  pending: 'bg-slate-200',
}

const relatedFeed = computed(() => {
  if (!props.step) return []
  const kws = props.step.feedKeywords.map(k => k.toLowerCase())
  return props.feed
    .filter(it => {
      const hay = `${it.title ?? ''} ${it.body ?? ''} ${it.event_type ?? ''}`.toLowerCase()
      return kws.some(k => hay.includes(k))
    })
    .slice(0, 8)
})

function fmtTime(s: string): string {
  const d = new Date(s)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
</script>

<template>
  <div
    v-if="step"
    class="rounded-2xl bg-white/90 backdrop-blur-sm overflow-hidden"
    style="box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 1px 0 rgba(15,23,42,0.03);"
    role="region"
    :aria-label="`${step.label} detail`"
  >
    <div class="flex items-center gap-2 px-4 pt-3.5 pb-2 flex-wrap">
      <h3 class="text-[15px] font-semibold text-slate-900">{{ step.label }}</h3>
      <span
        class="inline-flex items-center px-2 py-[2px] rounded-full text-[11px] font-medium"
        :class="stateClass[step.state] ?? stateClass['not']"
      >{{ stateLabel[step.state] ?? '—' }}</span>
      <!-- Live status pill from the latest Arrivy task on this milestone
           (survey/install/inspection). Hidden when redundant with the
           milestone-state pill (e.g. both say "Cancelled"). Bare status
           text — no prefix or icon — so it reads as just the state. -->
      <span
        v-if="showArrivyPill && arrivyInfo"
        class="inline-flex items-center px-2 py-[2px] rounded-full text-[11px] font-medium uppercase tracking-wide"
        :class="arrivyInfo.pillCls"
      >{{ arrivyInfo.label }}</span>
      <a
        v-if="arrivyTaskUrl"
        :href="arrivyTaskUrl"
        target="_blank"
        rel="noopener"
        class="text-[11px] text-teal-700 hover:text-teal-800 hover:underline cursor-pointer"
      >Open task</a>
      <div class="flex-1" />
      <button
        class="text-slate-400 hover:text-slate-700 transition-colors text-sm cursor-pointer"
        aria-label="Close milestone detail"
        @click="emit('close')"
      >×</button>
    </div>

    <!-- Cancellation context line: "Cancelled while crew was on-site by
         John Smith · Apr 29, 2:03 PM". Carries the unique 'how' signal
         the pills can't fit. -->
    <div
      v-if="cancelPhaseDescriptor"
      class="px-4 -mt-1 mb-1 text-[12.5px] text-rose-800 flex items-start gap-1.5"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" class="size-3.5 mt-[2px] text-rose-600 shrink-0" aria-hidden="true">
        <path d="M6 6l12 12" /><path d="M18 6L6 18" />
      </svg>
      <span>{{ cancelPhaseDescriptor }}</span>
    </div>

    <!-- Missing items — full-width banner above the sub-step / events grid
         so it's the first thing the user sees when there's a blocker. Items
         arrive as a `;`-joined multi-select from QB. -->
    <div
      v-if="step.infoFlag.missingItems && step.infoFlag.missingItems.length"
      class="mx-4 mb-3 rounded-lg bg-rose-50 ring-1 ring-rose-100 px-3 py-2"
    >
      <div class="flex items-center gap-1.5 mb-1.5">
        <span class="size-2 rounded-full bg-rose-500" aria-hidden="true" />
        <span class="text-[10.5px] font-semibold text-rose-700 uppercase tracking-wider">
          {{ step.infoFlag.reason || 'Needs attention' }}
        </span>
      </div>
      <ul class="space-y-1">
        <li
          v-for="(item, i) in step.infoFlag.missingItems"
          :key="i"
          class="flex items-start gap-2 text-[12.5px] text-slate-700 leading-snug"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" class="size-3 mt-1 text-rose-500 shrink-0" aria-hidden="true">
            <path d="M6 6l12 12" /><path d="M18 6L6 18" />
          </svg>
          <span>{{ item }}</span>
        </li>
      </ul>
    </div>

    <!-- Intake checklist grid — only renders when the Intake step is
         selected. Pulls multi-attempt KCA results from /api/intake. -->
    <div v-if="step.id === 'intake' && projectRid" class="px-4 pb-4">
      <IntakeChecklist :project-rid="projectRid" />
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4 px-4 pb-4">
      <!-- Sub-checklist -->
      <div>
        <div class="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-2">Sub-steps</div>
        <ul class="space-y-2">
          <li
            v-for="(sub, i) in step.subSteps"
            :key="i"
            class="flex items-center gap-2.5"
          >
            <span class="size-2 rounded-full shrink-0" :class="subDot[sub.state]" />
            <span class="text-[13px] text-slate-700 flex-1">{{ sub.label }}</span>
            <span class="text-[12px] tabular-nums text-slate-500">{{ sub.date ? fmtFull(sub.date) : '—' }}</span>
          </li>
        </ul>
        <div v-if="coordinator" class="mt-3 text-[11px] text-slate-500">
          Coordinator: <span class="text-slate-700">{{ coordinator }}</span>
        </div>
      </div>

      <!-- Related events -->
      <div>
        <div class="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-2">
          Related events
          <span v-if="relatedFeed.length" class="ml-1 text-slate-400 normal-case tracking-normal">({{ relatedFeed.length }})</span>
        </div>
        <ul v-if="relatedFeed.length" class="space-y-2.5">
          <li v-for="ev in relatedFeed" :key="ev.id" class="text-[12.5px] text-slate-700 leading-snug">
            <div class="flex items-baseline gap-2">
              <span class="text-[10.5px] uppercase tracking-wide text-slate-400 shrink-0">{{ ev.event_type }}</span>
              <span class="text-[10.5px] text-slate-400 ml-auto shrink-0">{{ fmtTime(ev.occurred_at) }}</span>
            </div>
            <div class="text-slate-800 mt-0.5">{{ ev.title }}</div>
            <div v-if="ev.actor_name" class="text-[11px] text-slate-500 mt-0.5">{{ ev.actor_name }}</div>
          </li>
        </ul>
        <div v-else class="text-[12px] text-slate-400">No matching events yet.</div>
      </div>
    </div>
  </div>
</template>
