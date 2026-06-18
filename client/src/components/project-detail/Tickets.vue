<script setup lang="ts">
import { computed } from 'vue'
import SectionCard from './SectionCard.vue'
import StatusPill from './StatusPill.vue'
import { fmtDate, isPast, isToday } from '@/lib/dates'

interface TicketRow {
  record_id: number
  title: string
  status: string
  priority?: string | null
  due_date?: string | null
  category?: string | null
  assigned_to?: string | null
}

const props = defineProps<{
  items: TicketRow[]
  /** Render rows as outlined white tiles (rounded, ring, colored left border,
   *  status pill) to match EventsView's flat list. Used in the project
   *  bump-out so Tickets and Events read as the same UI. */
  flat?: boolean
}>()

type DueBucket = 'overdue' | 'today' | 'future' | 'none'

interface Decorated extends TicketRow {
  // Default-mode chrome — status-driven (full project view shows open + closed).
  tone: 'open' | 'pending' | 'resolved'
  pillTone: 'pending' | 'blue' | 'complete'
  dueLabel: string
  // Flat/tile-mode chrome — due-date-driven so the tile colour matches the
  // header's overdue/today/future bubbles (all tickets here are open). Anchored
  // to the Denver office calendar via dates.ts, never UTC.
  due: DueBucket
  borderCls: string
  pillCls: string
  pillLabel: string
  dueText: string
  dueTextCls: string
  subLine: string
}

// Due bucket against the office calendar (Denver). Empty/sentinel dates → none.
function dueBucketOf(d?: string | null): DueBucket {
  if (!d || d === '0' || d === '-') return 'none'
  if (isToday(d)) return 'today'
  if (isPast(d)) return 'overdue'
  return 'future'
}

// Labels + colours mirror TicketsView's dueStatus() so ticket due-state reads
// identically everywhere it appears.
const DUE_BORDER: Record<DueBucket, string> = {
  overdue: 'border-l-red-500',
  today: 'border-l-amber-500',
  future: 'border-l-emerald-500',
  none: 'border-l-slate-300',
}
const DUE_PILL: Record<DueBucket, string> = {
  overdue: 'bg-red-100 text-red-700',
  today: 'bg-amber-100 text-amber-700',
  future: 'bg-emerald-100 text-emerald-700',
  none: 'bg-slate-100 text-slate-600',
}
const DUE_TEXT_CLS: Record<DueBucket, string> = {
  overdue: 'text-red-600 font-medium',
  today: 'text-amber-700 font-medium',
  future: 'text-slate-500',
  none: 'text-slate-500',
}

const decorated = computed<Decorated[]>(() =>
  props.items.map(t => {
    const status = (t.status || '').toLowerCase()
    let tone: Decorated['tone'] = 'open'
    let pillTone: Decorated['pillTone'] = 'pending'
    if (status.includes('complete') || status.includes('resolved') || status.includes('closed')) { tone = 'resolved'; pillTone = 'complete' }
    else if (status.includes('pending') || status.includes('progress')) { tone = 'pending'; pillTone = 'blue' }

    let dueLabel = ''
    if (t.due_date) {
      const d = new Date(t.due_date.length === 10 ? `${t.due_date}T00:00:00` : t.due_date)
      if (!isNaN(d.getTime())) dueLabel = `Due ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
    }

    const due = dueBucketOf(t.due_date)
    // The QB status field never auto-flips to "Overdue" when the due date
    // passes, so derive the pill text from the due bucket: an actionable due
    // state (Overdue / Due today) overrides the stale status word; otherwise
    // show the real status.
    const pillLabel =
      due === 'overdue' ? 'Past Due' :
      due === 'today' ? 'Due Today' :
      due === 'future' ? 'On Track' :
      t.status
    // Date detail line. Today is already conveyed by the pill, so it gets none.
    const dueText =
      due === 'overdue' ? `Due ${fmtDate(t.due_date!)}` :
      due === 'future' ? `Due ${fmtDate(t.due_date!)}` :
      ''

    const subParts = [t.category, t.assigned_to].filter(Boolean) as string[]
    return {
      ...t, tone, pillTone, dueLabel, subLine: subParts.join(' · '),
      due, borderCls: DUE_BORDER[due], pillCls: DUE_PILL[due], pillLabel, dueText, dueTextCls: DUE_TEXT_CLS[due],
    }
  })
)

const accent: Record<Decorated['tone'], string> = {
  open: '#d97706',
  pending: '#1d4ed8',
  resolved: '#16a34a',
}
</script>

<template>
  <SectionCard title="Tickets" :count="items.length" no-padding>
    <!-- FLAT — outlined white tiles, matching EventsView's flat list -->
    <div v-if="flat" class="px-4 pb-3.5">
      <ul class="space-y-1.5">
        <li
          v-for="t in decorated"
          :key="t.record_id"
          class="rounded-md border-l-[4px] bg-white ring-1 ring-slate-200/90 shadow-sm"
          :class="t.borderCls"
        >
          <div class="flex items-stretch gap-3 py-2 pl-2.5 pr-2">
            <div class="flex-1 min-w-0 flex flex-col justify-center">
              <div class="flex items-center gap-1.5 flex-wrap">
                <span class="text-[12.5px] font-medium text-slate-800 truncate" :title="t.title">{{ t.title }}</span>
                <span
                  class="inline-flex items-center rounded-full px-1.5 py-[1px] text-[10px] font-medium whitespace-nowrap"
                  :class="t.pillCls"
                >{{ t.pillLabel }}</span>
              </div>
              <div v-if="t.subLine" class="text-[11px] text-slate-500 truncate">{{ t.subLine }}</div>
              <div v-if="t.dueText" class="text-[11px] truncate" :class="t.dueTextCls">{{ t.dueText }}</div>
            </div>
          </div>
        </li>
      </ul>
      <div v-if="!decorated.length" class="py-5 text-center text-xs text-slate-500">
        No open tickets.
      </div>
    </div>

    <!-- DEFAULT — divided list (full project view) -->
    <div v-else class="px-4 pb-3.5">
      <div
        v-for="(t, i) in decorated"
        :key="t.record_id"
        class="py-2.5"
        :class="i < decorated.length - 1 ? 'border-b' : ''"
        :style="{ borderLeft: `3px solid ${accent[t.tone]}`, paddingLeft: '12px', marginLeft: '-16px', borderColor: i < decorated.length - 1 ? '#e6dfd6' : 'transparent' }"
      >
        <div class="flex items-start gap-2">
          <div class="flex-1 min-w-0">
            <div class="text-[13px] font-medium text-slate-900 leading-tight">{{ t.title }}</div>
            <div v-if="t.subLine || t.dueLabel" class="text-[11px] text-slate-500 mt-1">
              {{ [t.subLine, t.dueLabel].filter(Boolean).join(' · ') }}
            </div>
          </div>
          <StatusPill :tone="t.pillTone">{{ t.status }}</StatusPill>
        </div>
      </div>
      <div v-if="!decorated.length" class="py-5 text-center text-xs text-slate-500">
        No open tickets.
      </div>
    </div>
  </SectionCard>
</template>
