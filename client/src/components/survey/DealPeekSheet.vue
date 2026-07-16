<script setup lang="ts">
// Bump-out for survey tasks that are NOT in the QB Projects table.
// Mirrors ProjectDetailDialog's chrome section-for-section (header chips,
// address+meta strip, quick actions, Milestones card, Key dates) so it
// reads like the normal project bump-out — with one loud difference: an
// amber stuck-banner up top saying exactly where this deal is blocked,
// plus a live Enerflo deal-flow tracker (GraphQL) showing where the
// customer is inside the deal.
import { computed, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { fmtDate } from '@/lib/dates'
import MilestoneStrip from '@/components/project-detail/MilestoneStrip.vue'
import { computeStripSteps, type StripStep } from '@/lib/milestoneStrip'
import type { ArrivyStatusKey } from '@/lib/arrivyStatus'
import { type SurveyCard } from '@/lib/surveyTasks'

const props = defineProps<{
  /** When non-null, sheet is open and rendering this card. */
  card: SurveyCard | null
}>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()

const auth = useAuthStore()
const isOpen = ref(false)
watch(() => props.card, c => { isOpen.value = c != null }, { immediate: true })
function onOpenChange(v: boolean) {
  isOpen.value = v
  emit('update:open', v)
}

const deal = computed(() => props.card?.deal ?? null)
const surveyDone = computed(() => props.card?.status === 'submitted' || props.card?.status === 'notsubmitted')

// The stuck banner — the one thing this drawer must land.
const headline = computed(() => {
  if (!props.card) return ''
  if (!deal.value) return 'No Enerflo deal matched this task — needs manual linking.'
  return surveyDone.value
    ? 'Survey is done, but the deal isn’t submitted to QuickBase'
    : 'Survey is booked, but the deal isn’t submitted to QuickBase'
})

// Quick-action hrefs (customer contact — same row as the normal drawer).
const phoneHref = computed(() => deal.value?.cust_phone ? `tel:${deal.value.cust_phone}` : '')
const smsHref = computed(() => deal.value?.cust_phone ? `sms:${deal.value.cust_phone}` : '')
const emailHref = computed(() => deal.value?.cust_email ? `mailto:${deal.value.cust_email}` : '')
const mapHref = computed(() => deal.value?.cust_address ? `https://maps.google.com/?q=${encodeURIComponent(deal.value.cust_address)}` : '')

// The normal milestone strip, synthesized from what the deal + Arrivy
// task tell us: Sale carries the signed date and renders purple (the
// stuck stage), Survey shows scheduled/submitted exactly like a QB
// project's strip. Everything else (Intake included) stays grey — the
// deal hasn't even been submitted to process yet.
const stripSteps = computed<StripStep[]>(() => {
  if (!props.card) return []
  const t = props.card.floating_task
  const statusMap: Record<string, ArrivyStatusKey> = {
    cancelled: 'cancelled', submitted: 'submitted', enroute: 'enroute', onsite: 'onsite', scheduled: 'scheduled',
  }
  const steps = computeStripSteps({
    sales_date: deal.value?.signed_at || null,
    survey_scheduled: t?.scheduled_at || props.card.scheduled_at || null,
    survey_submitted: t?.submitted_at || null,
    arrivy_survey_status: t ? statusMap[t.status] ?? null : null,
  })
  return steps.map(s => {
    if (s.id === 'sale') return { ...s, state: 'rejected' as const }
    if (s.id === 'survey') return s
    return { ...s, state: 'not' as const }
  })
})

// ── Enerflo deal-flow progress (GraphQL, via server proxy) ──
interface DealStep { id: string; name: string; status: 'complete' | 'active' | 'invalid' | 'pending' }
interface DealProgress {
  configured: boolean; ok: boolean; error?: string
  dealStatus?: string; progress?: number; currentStage?: string
  steps: DealStep[]
  submission?: { attempted: boolean; at?: string }
}
const progress = ref<DealProgress | null>(null)
const progressLoading = ref(false)

watch(() => props.card, async c => {
  progress.value = null
  const dealId = c?.deal?.enerflo_deal_id
  if (!c || !dealId) return
  progressLoading.value = true
  try {
    const res = await fetch(`/api/survey-tasks/deal-progress?deal_id=${encodeURIComponent(dealId)}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    if (res.ok) progress.value = await res.json()
  } catch { /* section self-hides */ } finally {
    progressLoading.value = false
  }
}, { immediate: true })

const stepDot: Record<DealStep['status'], string> = {
  complete: 'bg-emerald-500',
  active: 'bg-blue-500 ring-2 ring-blue-200',
  invalid: 'bg-rose-500 ring-2 ring-rose-200',
  pending: 'bg-slate-200',
}

function fmtDateTime(ds: string): string {
  if (!ds) return 'Not scheduled'
  const d = new Date(ds)
  if (isNaN(d.getTime())) return ds
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}
</script>

<template>
  <Sheet :open="isOpen" @update:open="onOpenChange">
    <SheetContent
      side="right"
      class="w-full sm:max-w-[680px] p-0 flex flex-col gap-0 overflow-hidden"
    >
      <SheetHeader class="px-4 py-3 border-b shrink-0">
        <SheetTitle class="text-[15px] font-semibold">
          {{ card?.customer_name || 'Unknown customer' }}
        </SheetTitle>
        <div v-if="card" class="flex items-center gap-2 mt-0.5 flex-wrap">
          <span class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">Not in QB</span>
          <span v-if="deal?.state" class="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{{ deal.state }}</span>
          <span class="text-[10px] font-medium px-1.5 py-0.5 rounded" :class="card.pillCls">{{ card.status_label }}</span>
          <span v-if="deal?.system_size_kw" class="text-[10px] text-muted-foreground tabular-nums">{{ Number(deal.system_size_kw).toFixed(2) }} kW</span>
          <a
            v-if="deal?.deal_url"
            :href="deal.deal_url"
            target="_blank"
            rel="noopener"
            class="ml-auto text-[11px] text-teal-700 hover:text-teal-800 hover:underline cursor-pointer inline-flex items-center gap-1"
          >
            Open in Enerflo
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-3">
              <path d="M7 17L17 7"/><path d="M8 7h9v9"/>
            </svg>
          </a>
        </div>
      </SheetHeader>

      <div v-if="card" class="flex-1 overflow-y-auto">
        <!-- STUCK BANNER — the loud element this drawer exists for -->
        <div class="px-4 pt-3 pb-1">
          <div class="rounded-lg px-3 py-2.5" :class="surveyDone && deal ? 'bg-amber-50' : 'bg-slate-50'">
            <p class="text-[13px] font-semibold leading-snug" :class="surveyDone && deal ? 'text-amber-800' : 'text-slate-700'">
              ⚠️ {{ headline }}
            </p>
            <p v-if="deal && card.signed_note" class="text-[11px] mt-0.5" :class="surveyDone ? 'text-amber-700/80' : 'text-slate-500'">
              {{ card.signed_note }} · press <span class="font-semibold">{{ deal.closer_name || 'the closer' }}</span><template v-if="deal.sales_office"> ({{ deal.sales_office }})</template> to submit the deal.
            </p>
          </div>
        </div>

        <!-- Address + meta strip (same shape as the project drawer) -->
        <div class="px-4 pt-2 pb-2 text-[12.5px] text-slate-700 leading-relaxed">
          <p v-if="deal?.cust_address" class="truncate">{{ deal.cust_address }}</p>
          <div class="flex flex-wrap gap-x-4 gap-y-0.5 mt-1 text-[11px] text-muted-foreground">
            <span v-if="deal?.closer_name">Closer: <span class="text-foreground">{{ deal.closer_name }}</span></span>
            <span v-if="deal?.sales_office">Office: <span class="text-foreground">{{ deal.sales_office }}</span></span>
            <span v-if="deal?.lender_name">Lender: <span class="text-foreground">{{ deal.lender_name }}</span></span>
            <span v-if="deal?.signed_at">Signed: <span class="text-foreground">{{ fmtDate(deal.signed_at) }}</span></span>
          </div>
        </div>

        <!-- Quick actions — customer contact + closer contact -->
        <div class="px-4 pb-3 flex flex-wrap gap-1.5">
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
          <a v-if="deal?.closer_phone" :href="`tel:${deal.closer_phone}`" class="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-md bg-amber-100 text-amber-800 hover:bg-amber-200 cursor-pointer">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-3"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
            Call closer
          </a>
          <a v-if="deal?.closer_email" :href="`mailto:${deal.closer_email}`" class="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-md bg-amber-100 text-amber-800 hover:bg-amber-200 cursor-pointer">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-3"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
            Email closer
          </a>
          <a v-if="card.task_url" :href="card.task_url" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-md bg-muted hover:bg-muted/70 cursor-pointer">
            <img src="/integrations/arrivy.png" alt="" class="size-3 object-contain" />
            Arrivy
          </a>
        </div>

        <!-- Milestone strip — same card as the project drawer -->
        <div class="px-4 pb-3">
          <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Milestones</p>
          <div class="rounded-2xl bg-card px-3 py-3" style="box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 1px 0 rgba(15,23,42,0.03);">
            <MilestoneStrip :steps="stripSteps" />
          </div>
        </div>

        <!-- Enerflo deal flow — where the customer is inside the deal -->
        <div v-if="deal && (progressLoading || progress)" class="px-4 pb-3">
          <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
            Enerflo deal progress<span v-if="progress?.dealStatus" class="normal-case tracking-normal"> · {{ progress.dealStatus }}<template v-if="progress.progress != null"> · {{ progress.progress }}%</template></span>
          </p>
          <div class="rounded-2xl bg-card px-3 py-3" style="box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 1px 0 rgba(15,23,42,0.03);">
            <div v-if="progressLoading" class="h-16 animate-pulse rounded-lg bg-slate-50" />
            <template v-else-if="progress?.ok && progress.steps.length">
              <div class="grid gap-1">
                <div v-for="s in progress.steps" :key="s.name" class="flex items-center gap-2 min-w-0">
                  <span class="size-2.5 rounded-full shrink-0" :class="stepDot[s.status]" aria-hidden="true" />
                  <span
                    class="text-[12px] min-w-0 truncate"
                    :class="s.status === 'pending' ? 'text-slate-400' : s.status === 'active' ? 'text-blue-700 font-semibold' : s.status === 'invalid' ? 'text-rose-700 font-semibold' : 'text-slate-700'"
                  >{{ s.name }}</span>
                  <span
                    v-if="s.id === 'project-submission' && progress.submission"
                    class="ml-auto text-[10px] font-semibold shrink-0"
                    :class="progress.submission.attempted ? 'text-rose-600' : 'text-slate-400'"
                    :title="progress.submission.attempted ? 'Enerflo says this deal WAS submitted but it never landed in QB — check the intake failed runs' : undefined"
                  >{{ progress.submission.attempted
                    ? `⚠ submitted${progress.submission.at ? ' ' + fmtDate(progress.submission.at) : ''} — not in QB`
                    : 'never attempted' }}</span>
                  <span v-else-if="s.status === 'active'" class="ml-auto text-[10px] text-blue-600 font-semibold shrink-0">← here</span>
                </div>
              </div>
            </template>
            <p v-else-if="progress && !progress.configured" class="text-[11px] text-muted-foreground">
              Connect the Enerflo API (ENERFLO_API_KEY) to see live deal-flow progress here.
            </p>
            <p v-else class="text-[11px] text-muted-foreground">
              Couldn’t load deal progress from Enerflo{{ progress?.error ? ` — ${progress.error}` : '' }}.
            </p>
          </div>
        </div>

        <!-- Key dates -->
        <div class="px-4 pb-4">
          <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Key dates</p>
          <div class="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
            <div v-if="deal?.signed_at" class="flex justify-between"><span class="text-muted-foreground">Signed</span><span class="tabular-nums">{{ fmtDate(deal.signed_at) }}</span></div>
            <div v-if="card.scheduled_at" class="flex justify-between"><span class="text-muted-foreground">Survey sched</span><span class="tabular-nums">{{ fmtDateTime(card.scheduled_at) }}</span></div>
            <div v-if="card.floating_task?.submitted_at" class="flex justify-between"><span class="text-muted-foreground">Survey sub</span><span class="tabular-nums">{{ fmtDate(card.floating_task.submitted_at) }}</span></div>
          </div>
        </div>
      </div>
    </SheetContent>
  </Sheet>
</template>
