<script setup lang="ts">
// Inline note-text editor — swapped in place of a note's body (root rows
// in DealFeed, replies in NoteThread). Text is the only editable field;
// category/visibility are fixed at post time. Server enforces the
// author-or-admin rule; the parent only decides whether to show "Edit".
//
// @mentions work exactly like the composer: "@" opens the picker, picked
// names render as teal pills via the mirror overlay, and only mentions
// picked DURING this edit are sent — people already @'d in the original
// text aren't re-pinged.
import { ref, computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useMentions } from '@/lib/mentions'

const props = defineProps<{
  noteId: number
  initialText: string
  /** Compact styling for replies. */
  small?: boolean
}>()
const emit = defineEmits<{ saved: []; cancel: [] }>()

const auth = useAuthStore()
function hdrs() {
  return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }
}

const text = ref(props.initialText)
const mentions = useMentions(text, hdrs)
const saving = ref(false)
const errorMsg = ref<string | null>(null)
const canSave = computed(() =>
  text.value.trim().length > 0 && text.value.trim() !== props.initialText.trim() && !saving.value
)

// Mirror overlay for pill highlighting — metrics must match the textarea
// exactly (see NoteComposer for the technique).
const mirrorEl = ref<HTMLElement | null>(null)
function syncMirrorScroll(e: Event) {
  if (mirrorEl.value) mirrorEl.value.scrollTop = (e.target as HTMLElement).scrollTop
}

async function save() {
  if (!canSave.value) return
  saving.value = true
  errorMsg.value = null
  try {
    const res = await fetch(`/api/notes/${props.noteId}`, {
      method: 'PATCH',
      headers: hdrs(),
      body: JSON.stringify({ note: text.value.trim(), mentions: mentions.active() }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `Failed to save (${res.status})`)
    }
    emit('saved')
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="mt-1">
    <div class="relative bg-slate-50 rounded-xl">
      <div
        ref="mirrorEl"
        aria-hidden="true"
        class="absolute inset-0 z-0 overflow-hidden whitespace-pre-wrap break-words rounded-xl px-3 py-2 leading-relaxed text-slate-800 pointer-events-none"
        :class="small ? 'text-[12.5px]' : 'text-[13px]'"
      ><template v-for="(s, i) in mentions.segments.value" :key="i"><span v-if="s.mention" class="text-teal-700 bg-teal-600/10 rounded-[4px]">{{ s.text }}</span><template v-else>{{ s.text }}</template></template>&#8203;</div>
      <textarea
        v-model="text"
        :rows="small ? 2 : 3"
        autofocus
        class="relative z-10 w-full resize-y rounded-xl bg-transparent px-3 py-2 text-transparent caret-slate-800 outline-none focus:ring-2 focus:ring-teal-600/25 leading-relaxed"
        :class="small ? 'text-[12.5px]' : 'text-[13px]'"
        @input="mentions.detect()"
        @scroll="syncMirrorScroll"
        @blur="mentions.open.value = false"
        @keydown.meta.enter="save"
        @keydown.ctrl.enter="save"
        @keydown.escape="mentions.open.value ? mentions.open.value = false : emit('cancel')"
      />
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
    </div>
    <div v-if="mentions.liveMentions.value.length" class="text-[10.5px] text-slate-400 mt-1">
      Will notify in-app: {{ mentions.liveMentions.value.map(t => t.name).join(', ') }}
    </div>
    <div v-if="errorMsg" class="text-[11.5px] text-rose-600 mt-1">{{ errorMsg }}</div>
    <div class="flex items-center gap-3 mt-1">
      <button
        type="button"
        class="text-[11.5px] font-medium cursor-pointer"
        :class="canSave ? 'text-teal-700 hover:underline' : 'text-teal-700/40'"
        :disabled="!canSave"
        @click="save"
      >{{ saving ? 'Saving…' : 'Save' }}</button>
      <button
        type="button"
        class="text-[11.5px] text-slate-400 hover:text-slate-600 cursor-pointer"
        :disabled="saving"
        @click="emit('cancel')"
      >Cancel</button>
    </div>
  </div>
</template>
