<script setup lang="ts">
import { computed, ref } from 'vue'

export interface FeedRow {
  id: string | number
  occurred_at: string
  /** Raw qb-spa feed_items.event_type — note_added | milestone | status_change |
   *  task_event | ticket_created — OR a comms-derived type prefixed `comms.*`. */
  event_type: string
  title: string
  body?: string | null
  actor_name?: string | null
  actor_role?: string | null
  category?: string | null
  pinned?: boolean
}

const props = defineProps<{ items: FeedRow[] }>()

const filter = ref<string>('all')

// Filters drive the chip strip. Each one takes a fn that knows how to match
// the real event_type values stored in feed_items + the synthetic
// `comms.sms.*` / `comms.call.*` types we mix in for SMS + calls.
const filters: Array<{ id: string; label: string; match: (k: string) => boolean }> = [
  { id: 'all',        label: 'All',        match: () => true },
  { id: 'notes',      label: 'Notes',      match: k => k === 'note_added' || k === 'note' || k === 'user_post' },
  { id: 'comms',      label: 'Comms',      match: k => k.startsWith('comms.') },
  { id: 'milestones', label: 'Milestones', match: k => k === 'milestone' || k.includes('milestone') },
  { id: 'changes',    label: 'Changes',    match: k => k === 'status_change' || k.includes('change') || k === 'audit' },
  { id: 'tickets',    label: 'Tickets',    match: k => k === 'ticket_created' || k.startsWith('ticket') },
  { id: 'tasks',      label: 'Tasks',      match: k => k === 'task_event' || k.startsWith('task') },
]

const visible = computed(() => {
  const f = filters.find(x => x.id === filter.value) ?? filters[0]!
  return [...props.items]
    .filter(it => f.match(it.event_type || ''))
    .sort((a, b) => String(b.occurred_at || '').localeCompare(String(a.occurred_at || '')))
})

interface Group { key: string; items: FeedRow[] }

function dayKey(s: string): string {
  const d = new Date(s)
  if (isNaN(d.getTime())) return 'Earlier'
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return 'Today'
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const groups = computed<Group[]>(() => {
  const out: Group[] = []
  for (const it of visible.value) {
    const key = dayKey(it.occurred_at)
    let g = out.find(x => x.key === key)
    if (!g) { g = { key, items: [] }; out.push(g) }
    g.items.push(it)
  }
  return out
})

function timeOf(s: string): string {
  const d = new Date(s)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

interface Decoration { bg: string; fg: string; label: string; emoji: string }

function decorate(it: FeedRow): Decoration {
  const k = (it.event_type || '').toLowerCase()
  // Comms (synthetic types from merged comms endpoint)
  if (k === 'comms.sms.in')   return { bg: '#e0e7ff', fg: '#4338ca', label: 'Text · received', emoji: '💬' }
  if (k === 'comms.sms.out')  return { bg: '#e0e7ff', fg: '#4338ca', label: 'Text · sent',     emoji: '💬' }
  if (k === 'comms.call.in')  return { bg: '#dbeafe', fg: '#1d4ed8', label: 'Call · incoming', emoji: '📞' }
  if (k === 'comms.call.out') return { bg: '#dbeafe', fg: '#1d4ed8', label: 'Call · outgoing', emoji: '📞' }
  // feed_items.event_type values that actually ship today
  if (k === 'note_added' || k === 'note')      return { bg: '#fef3c7', fg: '#92400e', label: 'Note',           emoji: '📝' }
  if (k === 'user_post')                       return { bg: '#fef3c7', fg: '#92400e', label: 'Post',           emoji: '📝' }
  if (k === 'milestone' || k.includes('milestone')) return { bg: '#dcfce7', fg: '#166534', label: 'Milestone',  emoji: '✓' }
  if (k === 'status_change' || k === 'audit' || k.includes('change')) return { bg: '#f1f5f9', fg: '#334155', label: 'Status changed', emoji: '↻' }
  if (k === 'task_event' || k.startsWith('task'))  return { bg: '#ede9fe', fg: '#6d28d9', label: 'Task',       emoji: '⚙' }
  if (k === 'ticket_created' || k.startsWith('ticket')) return { bg: '#fee2e2', fg: '#b91c1c', label: 'Ticket',     emoji: '🎟' }
  if (k === 'agent_run')                       return { bg: '#ede9fe', fg: '#6d28d9', label: 'Agent',          emoji: '🤖' }
  if (k === 'system')                          return { bg: '#ede9fe', fg: '#6d28d9', label: 'System',         emoji: '⚙' }
  if (k === 'doc')                             return { bg: '#fce7f3', fg: '#be185d', label: 'Documents',      emoji: '📄' }
  return { bg: '#f1f5f9', fg: '#334155', label: it.event_type || 'Event', emoji: '•' }
}
</script>

<template>
  <div class="flex flex-col gap-2.5">
    <!-- Filter chip row -->
    <div
      class="flex gap-1.5 overflow-x-auto pb-1 -mb-1"
      style="scrollbar-width: none;"
    >
      <button
        v-for="f in filters"
        :key="f.id"
        type="button"
        class="rounded-full px-3 py-1 font-medium text-[11.5px] whitespace-nowrap shrink-0 transition-colors cursor-pointer"
        :class="filter === f.id ? 'bg-teal-700 text-white' : 'bg-white text-slate-600 hover:bg-slate-50 border border-slate-200'"
        @click="filter = f.id"
      >{{ f.label }}</button>
    </div>

    <div
      v-for="g in groups"
      :key="g.key"
      class="bg-white rounded-2xl"
      style="box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 1px 0 rgba(15,23,42,0.03);"
    >
      <div
        class="px-4 pt-3 pb-2 text-[10.5px] font-medium text-slate-500 tracking-[0.08em] uppercase"
        style="border-bottom: 1px solid #e6dfd6;"
      >{{ g.key }}</div>
      <div class="px-4">
        <div
          v-for="(it, i) in g.items"
          :key="it.id"
          class="flex items-start gap-3 py-3"
          :class="i < g.items.length - 1 ? 'border-b' : ''"
          style="border-color: #e6dfd6;"
        >
          <div
            class="size-7 rounded-lg shrink-0 flex items-center justify-center text-[14px]"
            :style="{ background: decorate(it).bg, color: decorate(it).fg }"
          >{{ decorate(it).emoji }}</div>
          <div class="flex-1 min-w-0">
            <div class="flex items-baseline gap-1.5 flex-wrap">
              <span
                class="text-[10.5px] font-medium uppercase tracking-[0.05em]"
                :style="{ color: decorate(it).fg }"
              >{{ decorate(it).label }}</span>
              <span v-if="it.category" class="text-[10px] text-slate-500 font-medium">· {{ it.category }}</span>
              <span v-if="it.pinned" class="text-[10px] font-medium text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded-full">📌 Pinned</span>
              <span class="ml-auto text-[10.5px] text-slate-400 tabular-nums">{{ timeOf(it.occurred_at) }}</span>
            </div>
            <div class="text-[13px] text-slate-900 mt-1 leading-snug">{{ it.title }}</div>
            <div v-if="it.body" class="text-[12.5px] text-slate-600 mt-1 leading-relaxed whitespace-pre-line line-clamp-3">{{ it.body }}</div>
            <div v-if="it.actor_name" class="text-[10.5px] text-slate-400 mt-1.5">
              {{ it.actor_name }}<span v-if="it.actor_role"> · {{ it.actor_role }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div
      v-if="!visible.length"
      class="bg-white rounded-2xl py-7 text-center text-[12.5px] text-slate-400"
      style="box-shadow: 0 1px 2px rgba(15,23,42,0.04);"
    >No items match this filter.</div>
  </div>
</template>
