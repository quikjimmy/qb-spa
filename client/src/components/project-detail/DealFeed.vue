<script setup lang="ts">
import { computed, ref } from 'vue'
import NoteThread, { type ReplyRow } from './NoteThread.vue'
import { mentionSegs } from '@/lib/mentions'
import { initials, avatarTone } from '@/lib/avatar'

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
  /** QB note record id (note rows only) — keys the reply thread. */
  noteRecordId?: number
  /** Whether the note is Rep Visible (replies inherit this). */
  repVisible?: boolean
}

const props = withDefaults(defineProps<{
  items: FeedRow[]
  /** 'single' (existing chip-radio) or 'multi' (checkbox-style toggles).
   *  Multi mode is the default for the project-detail "All" tab so the
   *  user can layer dimensions instead of swapping between them. */
  mode?: 'single' | 'multi'
  /** When false, hide the chip strip entirely. Useful when the parent
   *  has already locked the feed to a single category (e.g. the Notes
   *  tab passes only note items). */
  showFilters?: boolean
  /** When showFilters is false, an optional id that pre-filters to one
   *  category. Equivalent to passing pre-filtered `items` but cleaner
   *  for parents that already share the same feedItems prop. */
  lockedFilter?: string
  /** Enables reply threads on note rows (needed to post replies). */
  projectRid?: number
  /** Replies grouped by root note record id. */
  repliesByRoot?: Record<number, ReplyRow[]>
}>(), { mode: 'single', showFilters: true })

const emit = defineEmits<{ 'reply-posted': [] }>()

// Rows whose reply box was opened via the byline "Reply" button (rows
// with existing replies always render their thread).
const openReplies = ref<Set<number>>(new Set())
function openReply(rootId: number) {
  openReplies.value = new Set(openReplies.value).add(rootId)
}
function repliesFor(it: FeedRow): ReplyRow[] {
  return (it.noteRecordId && props.repliesByRoot?.[it.noteRecordId]) || []
}
function threadVisible(it: FeedRow): boolean {
  if (!props.projectRid || !it.noteRecordId) return false
  return repliesFor(it).length > 0 || openReplies.value.has(it.noteRecordId)
}
function canReply(it: FeedRow): boolean {
  return !!props.projectRid && !!it.noteRecordId && it.category !== 'Status Update'
}

// Filter dimensions. Drops the old "Changes" and "Tasks" buckets;
// "Schedule" replaces "Tasks" since it reads more clearly to ops.
// `all` is single-mode-only — multi mode treats all-selected as the
// no-op "show everything" state.
const filters: Array<{ id: string; label: string; match: (k: string) => boolean }> = [
  { id: 'all',       label: 'All',       match: () => true },
  { id: 'notes',     label: 'Notes',     match: k => k === 'note_added' || k === 'note' || k === 'user_post' },
  { id: 'schedule',  label: 'Schedule',  match: k => k === 'task_event' || k.startsWith('task') },
  { id: 'milestone', label: 'Milestone', match: k => k === 'milestone' || k.includes('milestone') },
  { id: 'comms',     label: 'Comms',     match: k => k.startsWith('comms.') },
  { id: 'tickets',   label: 'Tickets',   match: k => k === 'ticket_created' || k.startsWith('ticket') },
]
// Filters available in multi mode (drops the "all" toggle since it's
// implicit when nothing is unselected).
const multiFilters = filters.filter(f => f.id !== 'all')

// Single-mode state (existing behavior).
const filter = ref<string>('all')

// Multi-mode state. Defaults to "all dimensions on" so the feed reads
// as everything until the user starts deselecting.
const activeMulti = ref<Set<string>>(new Set(multiFilters.map(f => f.id)))
function toggleMulti(id: string) {
  const next = new Set(activeMulti.value)
  if (next.has(id)) next.delete(id); else next.add(id)
  activeMulti.value = next
}
function selectAllMulti() { activeMulti.value = new Set(multiFilters.map(f => f.id)) }
function clearMulti() { activeMulti.value = new Set() }

const visible = computed(() => {
  const sorted = [...props.items].sort((a, b) => String(b.occurred_at || '').localeCompare(String(a.occurred_at || '')))
  if (!props.showFilters && props.lockedFilter) {
    const f = filters.find(x => x.id === props.lockedFilter) ?? filters[0]!
    return sorted.filter(it => f.match(it.event_type || ''))
  }
  if (props.mode === 'multi') {
    if (activeMulti.value.size === 0) return []
    const matchers = multiFilters.filter(f => activeMulti.value.has(f.id))
    return sorted.filter(it => {
      const k = it.event_type || ''
      return matchers.some(m => m.match(k))
    })
  }
  const f = filters.find(x => x.id === filter.value) ?? filters[0]!
  return sorted.filter(it => f.match(it.event_type || ''))
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

// Prominent stamp: time for today's items; date + time once the day
// header alone can't anchor it precisely enough.
function timeOf(s: string): string {
  const d = new Date(s)
  if (isNaN(d.getTime())) return ''
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === new Date().toDateString()) return time
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`
}

// Note rows get @mention highlighting (lib/mentions) and author-initial
// avatars (lib/avatar) instead of the generic amber pencil glyph.
function isNoteType(k: string): boolean {
  return k === 'note_added' || k === 'note' || k === 'user_post'
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
    <!-- Filter chip row — single-mode renders the existing radio behavior;
         multi-mode renders checkbox-style toggles + a "select all / clear"
         affordance. Hidden entirely when showFilters is false. -->
    <div
      v-if="showFilters"
      class="flex items-center gap-1.5 overflow-x-auto pb-1 -mb-1"
      style="scrollbar-width: none;"
    >
      <template v-if="mode === 'multi'">
        <button
          v-for="f in multiFilters"
          :key="f.id"
          type="button"
          class="rounded-full px-3 py-1 font-medium text-[11.5px] whitespace-nowrap shrink-0 transition-colors cursor-pointer border"
          :class="activeMulti.has(f.id)
            ? 'bg-teal-700 text-white border-teal-700'
            : 'bg-white text-slate-500 border-slate-200 hover:text-slate-900 hover:bg-slate-50'"
          :aria-pressed="activeMulti.has(f.id)"
          @click="toggleMulti(f.id)"
        >{{ f.label }}</button>
        <button
          type="button"
          class="ml-1 text-[11px] text-slate-500 hover:text-slate-900 cursor-pointer shrink-0"
          @click="activeMulti.size === multiFilters.length ? clearMulti() : selectAllMulti()"
        >{{ activeMulti.size === multiFilters.length ? 'Clear' : 'All' }}</button>
      </template>
      <template v-else>
        <button
          v-for="f in filters"
          :key="f.id"
          type="button"
          class="rounded-full px-3 py-1 font-medium text-[11.5px] whitespace-nowrap shrink-0 transition-colors cursor-pointer"
          :class="filter === f.id ? 'bg-teal-700 text-white' : 'bg-white text-slate-600 hover:bg-slate-50 border border-slate-200'"
          @click="filter = f.id"
        >{{ f.label }}</button>
      </template>
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
            v-if="isNoteType(it.event_type || '')"
            class="size-7 rounded-full shrink-0 flex items-center justify-center text-[10px] font-bold"
            :style="{ background: avatarTone(it.actor_name).bg, color: avatarTone(it.actor_name).fg }"
          >{{ initials(it.actor_name) }}</div>
          <div
            v-else
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
              <span class="ml-auto text-[11px] font-medium text-slate-500 tabular-nums">{{ timeOf(it.occurred_at) }}</span>
            </div>
            <div class="text-[13px] text-slate-900 mt-1 leading-snug">
              <template v-if="isNoteType(it.event_type || '')"><template v-for="(s, si) in mentionSegs(it.title)" :key="si"><span v-if="s.mention" class="text-teal-700 font-medium bg-teal-600/10 rounded-[4px] px-0.5">{{ s.text }}</span><template v-else>{{ s.text }}</template></template></template>
              <template v-else>{{ it.title }}</template>
            </div>
            <div v-if="it.body" class="text-[12.5px] text-slate-600 mt-1 leading-relaxed whitespace-pre-line line-clamp-3">
              <template v-if="isNoteType(it.event_type || '')"><template v-for="(s, si) in mentionSegs(it.body)" :key="si"><span v-if="s.mention" class="text-teal-700 font-medium bg-teal-600/10 rounded-[4px] px-0.5">{{ s.text }}</span><template v-else>{{ s.text }}</template></template></template>
              <template v-else>{{ it.body }}</template>
            </div>
            <div v-if="it.actor_name || canReply(it)" class="text-[10.5px] text-slate-400 mt-1.5">
              <template v-if="it.actor_name">{{ it.actor_name }}<span v-if="it.actor_role"> · {{ it.actor_role }}</span></template>
              <button
                v-if="canReply(it) && !threadVisible(it)"
                type="button"
                class="text-teal-700 font-medium cursor-pointer hover:underline"
                :class="it.actor_name ? 'ml-2.5' : ''"
                @click="openReply(it.noteRecordId!)"
              >Reply</button>
            </div>
            <NoteThread
              v-if="threadVisible(it)"
              :project-rid="projectRid!"
              :root-id="it.noteRecordId!"
              :category="it.category ?? null"
              :rep-visible="it.repVisible === true"
              :replies="repliesFor(it)"
              :auto-compose="openReplies.has(it.noteRecordId!) && repliesFor(it).length === 0"
              @posted="emit('reply-posted')"
            />
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
