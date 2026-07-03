<script setup lang="ts">
// Compose box for QB notes — the write half of the Notes tab. Posts to
// POST /api/notes which creates the record on the QB Notes table
// (bsb6bqt3b) and refreshes the local cache; parent reloads on `posted`.
//
// Deliberately slimmer than the native QB "Add Note" form: note text +
// category (both QB-required), the Internal/Rep-visible toggle, Notify
// PM/Rep, and an optional extra-people notify picker. Date and author
// are stamped server-side from the logged-in portal user.
import { ref, computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useMentions } from '@/lib/mentions'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const props = defineProps<{
  projectRid: number
  /** PC + closer names from the project — shown on the notify pills so
   *  the user sees WHO gets emailed, not just a role label. */
  coordinator?: string | null
  closer?: string | null
}>()
const emit = defineEmits<{ posted: [] }>()

const auth = useAuthStore()
function hdrs() {
  return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }
}

// Mirrors the live QB Category choices (FID 7), minus 'Status Update' —
// that one is reserved for the QB status-change workflow and must not be
// selectable from the portal. Keep in sync with CATEGORIES in
// server/src/routes/notes.ts. Sorted alphabetically for the picker.
const CATEGORIES = [
  'Intake', 'Finance', 'Survey', 'Design', 'MSP Change', 'NEM', 'Permitting',
  'HOA', 'Installation', 'Install Completion', 'Inspection', 'PTO',
  'Commissioning', 'Extra charges', 'Tickets', 'Issues', 'Loose Ends', 'Sales',
  'Cancellation', 'Retention', 'PC Outreach', 'Sales Aid', 'Funding',
  'Licensing & Registration',
].sort((a, b) => a.localeCompare(b))

const expanded = ref(false)
const noteText = ref('')
const category = ref('')
const repVisible = ref(false)
const notifyPm = ref(false)
const notifyRep = ref(false)

// ── @Mentions ─────────────────────────────────────────────
// Shared machinery (lib/mentions): typing "@" opens a picker over portal
// users + departments; selections are validated server-side and only
// sent if their "@Name" survived edits. Mentioned users get an in-app
// notification (departments fan out to members).
const mentions = useMentions(noteText, hdrs)

// ── Slack-style mention highlighting ──────────────────────
// A textarea can't color spans of its own text, so a mirror div sits
// underneath rendering the same text with mention pills (lib/mentions
// supplies the exact-name segments); the textarea's text is transparent
// (caret stays visible). The mirror MUST match the textarea's font
// metrics exactly — same size/weight/padding/line-height — or the caret
// drifts out of alignment, so mention pills change color and background
// only, never weight.
const mirrorEl = ref<HTMLElement | null>(null)
function syncMirrorScroll(e: Event) {
  if (mirrorEl.value) mirrorEl.value.scrollTop = (e.target as HTMLElement).scrollTop
}

// ── Notify pills ──────────────────────────────────────────
// Per the QB-side flow: notifying the rep also makes the note visible to
// them (email + rep-visible + Enerflo pass travel together). So toggling
// "Notify rep" ON pulls visibility to Rep Visible; the user can still
// override back to Internal Only, in which case we surface a warning.
function toggleNotifyRep() {
  notifyRep.value = !notifyRep.value
  if (notifyRep.value) repVisible.value = true
}
const repNotifyConflict = computed(() => notifyRep.value && !repVisible.value)

function firstName(full: string | null | undefined): string | null {
  const name = (full ?? '').trim()
  return name ? (name.split(/\s+/)[0] ?? null) : null
}
const pcLabel = computed(() => firstName(props.coordinator) ? `PC · ${firstName(props.coordinator)}` : 'Project coordinator')
const repLabel = computed(() => firstName(props.closer) ? `Rep · ${firstName(props.closer)}` : 'Sales rep')

// ── Submit ────────────────────────────────────────────────
const saving = ref(false)
const errorMsg = ref<string | null>(null)
const canPost = computed(() => noteText.value.trim().length > 0 && !!category.value && !saving.value)

function reset() {
  noteText.value = ''
  category.value = ''
  repVisible.value = false
  notifyPm.value = false
  notifyRep.value = false
  mentions.reset()
  errorMsg.value = null
}

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
        note: noteText.value.trim(),
        category: category.value,
        visible_to_rep: repVisible.value ? 'Rep Visible' : 'Internal Only',
        notify_pm: notifyPm.value,
        notify_rep: notifyRep.value,
        mentions: mentions.active(),
      }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `Failed to post note (${res.status})`)
    }
    reset()
    expanded.value = false
    emit('posted')
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div
    class="bg-white rounded-2xl mb-3"
    style="box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 1px 0 rgba(15,23,42,0.03)"
  >
    <!-- Collapsed: quiet input-shaped affordance -->
    <button
      v-if="!expanded"
      type="button"
      class="w-full flex items-center gap-2.5 px-4 py-3 text-left cursor-text"
      @click="expanded = true"
    >
      <svg viewBox="0 0 24 24" class="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
      <span class="text-[13.5px] text-slate-400">Add a note…</span>
    </button>

    <!-- Expanded composer -->
    <div v-else class="px-4 pt-3.5 pb-3.5 flex flex-col gap-3">
      <div class="relative bg-slate-50 rounded-xl">
        <!-- Mirror: renders the note text with mention pills behind the
             transparent-text textarea. Metrics must match the textarea 1:1. -->
        <div
          ref="mirrorEl"
          aria-hidden="true"
          class="absolute inset-0 z-0 overflow-hidden whitespace-pre-wrap break-words rounded-xl px-3.5 py-2.5 text-[13.5px] leading-[1.55] text-slate-800 pointer-events-none"
        ><template v-for="(s, i) in mentions.segments.value" :key="i"><span v-if="s.mention" class="text-teal-700 bg-teal-600/10 rounded-[4px]">{{ s.text }}</span><template v-else>{{ s.text }}</template></template>&#8203;</div>
        <textarea
          v-model="noteText"
          rows="4"
          autofocus
          placeholder="Write your note… (@ to mention someone)"
          class="relative z-10 w-full resize-y min-h-[96px] rounded-xl bg-transparent px-3.5 py-2.5 text-[13.5px] leading-[1.55] text-transparent caret-slate-800 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-teal-600/25 transition-shadow"
          @input="mentions.detect()"
          @scroll="syncMirrorScroll"
          @blur="mentions.open.value = false"
          @keydown.escape="mentions.open.value = false"
        />
        <!-- @mention picker — anchored under the textarea -->
        <div
          v-if="mentions.open.value && mentions.matches.value.length"
          class="absolute z-30 top-full -mt-1 left-0 right-0 sm:right-auto sm:min-w-[260px] bg-white rounded-xl py-1 max-h-56 overflow-y-auto"
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

      <!-- Category (full-width) + visibility -->
      <div class="flex flex-col sm:flex-row sm:items-center gap-2">
        <Select v-model="category">
          <SelectTrigger class="h-10 w-full sm:flex-1 text-[13px] cursor-pointer gap-2 rounded-xl bg-slate-50 border-0 shadow-none px-3.5">
            <span class="text-[10px] font-semibold uppercase tracking-wider text-slate-400 shrink-0">Category</span>
            <SelectValue placeholder="Choose a category…" class="text-slate-800" />
          </SelectTrigger>
          <SelectContent class="max-h-72">
            <SelectItem v-for="c in CATEGORIES" :key="c" :value="c" class="text-[13px]">{{ c }}</SelectItem>
          </SelectContent>
        </Select>

        <!-- Internal / Rep visible segmented toggle -->
        <div class="inline-flex self-start sm:self-auto rounded-xl bg-slate-100 p-0.5 text-[12px] font-medium h-10 items-center shrink-0">
          <button
            type="button"
            class="px-3 h-9 rounded-[10px] cursor-pointer transition-colors"
            :class="!repVisible ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500'"
            @click="repVisible = false"
          >Internal only</button>
          <button
            type="button"
            class="px-3 h-9 rounded-[10px] cursor-pointer transition-colors"
            :class="repVisible ? 'bg-white text-teal-700 shadow-sm' : 'text-slate-500'"
            @click="repVisible = true"
          >Visible to rep</button>
        </div>
      </div>

      <!-- Notify pills — named after the project's actual PC / closer -->
      <div class="flex flex-wrap items-center gap-1.5">
        <span class="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mr-1">Email</span>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium cursor-pointer transition-colors"
          :class="notifyPm ? 'bg-teal-700 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200/70'"
          :aria-pressed="notifyPm"
          @click="notifyPm = !notifyPm"
        >
          <svg v-if="notifyPm" viewBox="0 0 24 24" class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          {{ pcLabel }}
        </button>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium cursor-pointer transition-colors"
          :class="notifyRep ? 'bg-teal-700 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200/70'"
          :aria-pressed="notifyRep"
          @click="toggleNotifyRep"
        >
          <svg v-if="notifyRep" viewBox="0 0 24 24" class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          {{ repLabel }}
        </button>
      </div>
      <div v-if="repNotifyConflict" class="text-[11.5px] text-amber-700 -mt-1.5">
        The rep will be emailed about a note they can't see — switch to "Visible to rep" or turn off their notification.
      </div>

      <div v-if="mentions.liveMentions.value.length" class="text-[11.5px] text-slate-400">
        Will notify in-app: {{ mentions.liveMentions.value.map(t => t.name).join(', ') }}
      </div>

      <div v-if="errorMsg" class="text-[12.5px] text-rose-600">{{ errorMsg }}</div>

      <div class="flex items-center justify-end gap-2 pt-0.5">
        <Button variant="ghost" size="sm" class="text-slate-500" :disabled="saving" @click="reset(); expanded = false">
          Cancel
        </Button>
        <Button size="sm" :disabled="!canPost" @click="post">
          {{ saving ? 'Posting…' : 'Post note' }}
        </Button>
      </div>
    </div>
  </div>
</template>
