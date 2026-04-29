<script setup lang="ts">
import { computed } from 'vue'
import SectionCard from './SectionCard.vue'
import StatusPill from './StatusPill.vue'

interface TicketRow {
  record_id: number
  title: string
  status: string
  priority?: string | null
  due_date?: string | null
  category?: string | null
  assigned_to?: string | null
}

const props = defineProps<{ items: TicketRow[] }>()

interface Decorated extends TicketRow {
  tone: 'open' | 'pending' | 'resolved'
  pillTone: 'pending' | 'blue' | 'complete'
  dueLabel: string
  subLine: string
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
    const subParts = [t.category, t.assigned_to].filter(Boolean) as string[]
    return { ...t, tone, pillTone, dueLabel, subLine: subParts.join(' · ') }
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
    <div class="px-4 pb-3.5">
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
