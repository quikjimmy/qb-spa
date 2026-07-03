<script setup lang="ts">
// Reply thread under a root note. Each reply is a real QB note record
// whose Thread ID (149) points at the root — the server inherits the
// root's category + visibility, so the reply box is just text + @mentions.
// Threads with 3+ replies collapse to a one-line summary.
import { ref, computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useMentions, mentionSegs } from '@/lib/mentions'
import { initials, avatarTone } from '@/lib/avatar'

export interface ReplyRow {
  record_id: number
  note: string | null
  note_by: string | null
  record_owner: string | null
  date_created: string | null
}

const props = defineProps<{
  projectRid: number
  rootId: number
  category: string | null
  repVisible: boolean
  replies: ReplyRow[]
  /** Mount with the reply box already open (row-level "Reply" tapped). */
  autoCompose?: boolean
}>()
const emit = defineEmits<{ posted: [] }>()

const auth = useAuthStore()
function hdrs() {
  return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }
}

// ── Collapse: 3+ replies fold to a summary line until tapped ──
const expanded = ref(props.autoCompose === true)
const isCollapsed = computed(() => props.replies.length > 2 && !expanded.value)

const chronological = computed(() =>
  [...props.replies].sort((a, b) => String(a.date_created || '').localeCompare(String(b.date_created || '')))
)
const lastReply = computed(() => chronological.value[chronological.value.length - 1] ?? null)
// First two distinct repliers for the collapsed avatar cluster.
const clusterNames = computed(() => {
  const seen: string[] = []
  for (const r of chronological.value) {
    const n = r.note_by || r.record_owner || ''
    if (n && !seen.includes(n)) seen.push(n)
    if (seen.length === 2) break
  }
  return seen
})

function author(r: ReplyRow): string {
  return r.note_by || r.record_owner || 'Unknown'
}

// ── Timestamps — prominent: time always, date when not today ──
function replyStamp(s: string | null): string {
  if (!s) return ''
  const d = new Date(s)
  if (isNaN(d.getTime())) return ''
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === new Date().toDateString()) return time
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`
}
function agoStamp(s: string | null): string {
  if (!s) return ''
  const d = new Date(s)
  if (isNaN(d.getTime())) return ''
  const mins = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000))
  if (mins < 60) return `${mins}m ago`
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ── Reply composer ────────────────────────────────────────
const composing = ref(props.autoCompose === true)
const replyText = ref('')
const mentions = useMentions(replyText, hdrs)
const saving = ref(false)
const errorMsg = ref<string | null>(null)
const canPost = computed(() => replyText.value.trim().length > 0 && !saving.value)

async function post() {
  if (!canPost.value) return
  saving.value = true
  errorMsg.value = null
  try {
    const res = await fetch('/api/notes', {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify({
        project_id: props.projectRid,
        reply_to: props.rootId,
        note: replyText.value.trim(),
        mentions: mentions.active(),
      }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `Failed to post reply (${res.status})`)
    }
    replyText.value = ''
    mentions.reset()
    composing.value = false
    expanded.value = true
    emit('posted')
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-if="replies.length || composing" class="mt-2.5 ml-1.5 pl-4 flex flex-col gap-2.5" style="border-left: 2px solid #e2e8f0;">
    <!-- Collapsed summary -->
    <button
      v-if="isCollapsed"
      type="button"
      class="flex items-center gap-2 text-left cursor-pointer group"
      @click="expanded = true"
    >
      <span class="flex">
        <span
          v-for="(n, i) in clusterNames"
          :key="n"
          class="w-[18px] h-[18px] rounded-full flex items-center justify-center text-[8px] font-bold border-[1.5px] border-white"
          :class="i > 0 ? '-ml-1.5' : ''"
          :style="{ background: avatarTone(n).bg, color: avatarTone(n).fg }"
        >{{ initials(n) }}</span>
      </span>
      <span class="text-[11.5px] font-semibold text-teal-700 group-hover:underline">{{ replies.length }} replies</span>
      <span class="text-[11px] text-slate-400">· last from {{ (lastReply ? author(lastReply) : '').split(' ')[0] }} · {{ agoStamp(lastReply?.date_created ?? null) }}</span>
    </button>

    <!-- Expanded replies -->
    <template v-else>
      <button
        v-if="replies.length > 2"
        type="button"
        class="self-start text-[11px] font-medium text-slate-400 hover:text-slate-600 cursor-pointer"
        @click="expanded = false; composing = false"
      >Hide replies</button>
      <div v-for="r in chronological" :key="r.record_id" class="flex gap-2">
        <span
          class="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0 mt-0.5"
          :style="{ background: avatarTone(author(r)).bg, color: avatarTone(author(r)).fg }"
        >{{ initials(author(r)) }}</span>
        <div class="flex-1 min-w-0">
          <div class="flex items-baseline gap-2 flex-wrap">
            <span class="text-[11.5px] font-semibold text-slate-600">{{ author(r) }}</span>
            <span class="text-[11px] font-medium text-slate-500 tabular-nums">{{ replyStamp(r.date_created) }}</span>
          </div>
          <div class="text-[12.5px] text-slate-600 leading-relaxed whitespace-pre-line"><template v-for="(s, si) in mentionSegs(r.note ?? '')" :key="si"><span v-if="s.mention" class="text-teal-700 font-medium bg-teal-600/10 rounded-[4px] px-0.5">{{ s.text }}</span><template v-else>{{ s.text }}</template></template></div>
        </div>
      </div>
    </template>

    <!-- Reply composer -->
    <div v-if="!isCollapsed">
      <div v-if="!composing" class="flex">
        <button
          type="button"
          class="text-[12px] text-slate-400 bg-slate-50 rounded-xl px-3 py-1.5 cursor-text hover:bg-slate-100/80 transition-colors w-full text-left"
          @click="composing = true"
        >Reply… (@ to mention)</button>
      </div>
      <div v-else class="relative">
        <div class="flex items-end gap-1.5 bg-slate-50 rounded-xl px-3 py-2">
          <textarea
            v-model="replyText"
            rows="2"
            autofocus
            placeholder="Reply… (@ to mention)"
            class="flex-1 resize-none bg-transparent text-[12.5px] text-slate-800 placeholder:text-slate-400 outline-none leading-relaxed"
            @input="mentions.detect()"
            @blur="mentions.open.value = false"
            @keydown.escape="mentions.open.value = false"
            @keydown.meta.enter="post"
            @keydown.ctrl.enter="post"
          />
          <button
            type="button"
            class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 transition-colors cursor-pointer"
            :class="canPost ? 'bg-teal-700 text-white' : 'bg-teal-600/10 text-teal-700/50'"
            :disabled="!canPost"
            @click="post"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </button>
        </div>
        <!-- @mention picker -->
        <div
          v-if="mentions.open.value && mentions.matches.value.length"
          class="absolute z-30 top-full -mt-1 left-0 right-0 sm:right-auto sm:min-w-[240px] bg-white rounded-xl py-1 max-h-56 overflow-y-auto"
          style="box-shadow: 0 4px 16px rgba(15,23,42,0.10), 0 1px 3px rgba(15,23,42,0.06)"
        >
          <button
            v-for="t in mentions.matches.value"
            :key="`${t.type}:${t.id}`"
            type="button"
            class="w-full text-left px-3 py-1.5 hover:bg-slate-50 cursor-pointer flex items-center gap-2"
            @mousedown.prevent="mentions.apply(t)"
          >
            <span
              class="w-5 h-5 rounded-full inline-flex items-center justify-center text-[10px] font-semibold shrink-0"
              :class="t.type === 'department' ? 'bg-violet-100 text-violet-700' : 'bg-teal-100 text-teal-800'"
            >{{ t.type === 'department' ? '#' : t.name.charAt(0).toUpperCase() }}</span>
            <span class="text-[12.5px] font-medium text-slate-700 truncate">{{ t.name }}</span>
            <span v-if="t.type === 'department'" class="ml-auto text-[11px] text-slate-400 shrink-0">{{ t.member_count }} people</span>
          </button>
        </div>
        <div class="text-[10px] text-slate-400 mt-1 pl-0.5">
          Replies inherit <span class="font-semibold text-slate-500">{{ category || 'Uncategorized' }}</span> · <span class="font-semibold text-slate-500">{{ repVisible ? 'Rep visible' : 'Internal only' }}</span>
        </div>
        <div v-if="errorMsg" class="text-[11.5px] text-rose-600 mt-1">{{ errorMsg }}</div>
      </div>
    </div>
  </div>
</template>
