<script setup lang="ts">
import { computed, ref } from 'vue'
import SectionCard from './SectionCard.vue'
import StatusPill from './StatusPill.vue'

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

const props = defineProps<{ items: CommItem[] }>()

const tab = ref<'all' | 'calls' | 'texts'>('all')

const counts = computed(() => ({
  all: props.items.length,
  calls: props.items.filter(c => c.type === 'call').length,
  texts: props.items.filter(c => c.type === 'sms').length,
}))

const filtered = computed(() =>
  props.items.filter(c => {
    if (tab.value === 'all') return true
    if (tab.value === 'calls') return c.type === 'call'
    return c.type === 'sms'
  })
)

function fmtTime(s: string): string {
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function fmtDuration(ms?: number | null): string {
  if (!ms) return ''
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  return m ? `${m}m ${s % 60}s` : `${s}s`
}
</script>

<template>
  <SectionCard title="Communications" no-padding>
    <div class="px-3 pb-2 flex gap-1.5">
      <button
        v-for="t in ['all', 'calls', 'texts'] as const"
        :key="t"
        class="flex-1 h-9 rounded-lg font-medium text-[13px] flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
        :class="tab === t ? 'bg-teal-700 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'"
        @click="tab = t"
      >
        {{ t === 'all' ? 'All' : t === 'calls' ? 'Calls' : 'Texts' }}
        <span
          class="text-[11px] font-bold px-1.5 h-[17px] leading-[17px] rounded-full"
          :class="tab === t ? 'bg-white/20 text-white' : 'bg-slate-200 text-slate-500'"
        >{{ counts[t] }}</span>
      </button>
    </div>
    <div class="px-4 pb-3">
      <div
        v-for="(c, i) in filtered"
        :key="c.id"
        class="flex items-start gap-2.5 py-3"
        :class="i < filtered.length - 1 ? 'border-b' : ''"
        style="border-color: #e6dfd6;"
      >
        <div
          class="size-8 rounded-full flex items-center justify-center shrink-0"
          :style="c.type === 'call' ? { background: '#dbeafe', color: '#1d4ed8' } : { background: '#e0e7ff', color: '#4338ca' }"
        >
          <svg v-if="c.type === 'call'" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 4H9L11 9L8.5 10.5C9.6 12.7 11.3 14.4 13.5 15.5L15 13L20 15V19C20 19.6 19.6 20 19 20C12.4 20 4 11.6 4 5C4 4.4 4.4 4 5 4Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 4H19C20.1 4 21 4.9 21 6V15C21 16.1 20.1 17 19 17H8L4 21V6C4 4.9 4.9 4 5 4Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="text-[13px] font-medium text-slate-900 truncate">
              {{ c.contact_name || c.from_number || c.to_number || '—' }}
            </span>
            <span class="text-[11px] text-slate-500">
              {{ c.type === 'call'
                ? (c.direction === 'inbound' || c.direction === 'in' ? 'Incoming' : 'Outgoing')
                : (c.direction === 'inbound' || c.direction === 'in' ? 'Received' : 'Sent') }}
            </span>
            <StatusPill v-if="c.duration_ms" tone="soft">{{ fmtDuration(c.duration_ms) }}</StatusPill>
            <StatusPill v-if="c.recording_url" tone="info">REC</StatusPill>
            <span class="ml-auto text-[11px] text-slate-500 shrink-0">{{ fmtTime(c.occurred_at) }}</span>
          </div>
          <div
            v-if="c.body || c.voicemail_url"
            class="text-[13px] text-slate-700 mt-1 leading-snug line-clamp-2"
          >{{ c.body || (c.voicemail_url ? '🎙 Voicemail' : '') }}</div>
        </div>
      </div>
      <div v-if="!filtered.length" class="py-6 text-center text-xs text-slate-500">
        No {{ tab === 'all' ? 'communications' : tab }} yet.
      </div>
    </div>
  </SectionCard>
</template>
