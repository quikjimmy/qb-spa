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
  /** Full project record — source for {variable} resolution. */
  project?: Record<string, unknown> | null
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

// ── / Templates ───────────────────────────────────────────
// A template captures the WHOLE composer state — body, category,
// visibility, notify flags — so applying one configures everything.
// Typing "/" as the first character opens the picker, filtered by what
// follows. Stored portal-side (SQLite); personal unless shared.
interface NoteTemplate {
  id: number
  name: string
  body: string
  category: string | null
  visible_to_rep: string | null
  notify_pm: number
  notify_rep: number
  shared: number
  owner_name: string | null
  mine: boolean
}
const templates = ref<NoteTemplate[]>([])
let templatesLoaded = false
async function loadTemplates(force = false) {
  if (templatesLoaded && !force) return
  templatesLoaded = true
  try {
    const res = await fetch('/api/notes/templates', { headers: hdrs() })
    if (!res.ok) { templatesLoaded = false; return }
    const data = await res.json()
    templates.value = (data.items as NoteTemplate[]) ?? []
  } catch { templatesLoaded = false }
}

// ── { Variables ───────────────────────────────────────────
// Tokens like {customer} pull live project facts (and the next upcoming
// field event) into the text. They stay literal in the composer — shown
// as violet pills — and resolve to real values when a template is
// applied and again at post time, so both flows work:
//   direct use: type "{" → pick → token in text → resolved on post
//   templates:  author with tokens → apply resolves against THIS project
function pstr(key: string): string {
  const v = props.project?.[key]
  return v === null || v === undefined ? '' : String(v)
}
function pdate(key: string): string {
  const raw = pstr(key)
  if (!raw) return ''
  const d = new Date(raw.includes('T') ? raw : raw + 'T12:00:00')
  return isNaN(d.getTime()) ? raw : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// Next upcoming field event (Arrivy) — fetched lazily with templates.
const nextEvent = ref('')
let eventsLoaded = false
async function loadNextEvent() {
  if (eventsLoaded) return
  eventsLoaded = true
  try {
    const res = await fetch(`/api/field/project-tasks?project_rid=${props.projectRid}`, { headers: hdrs() })
    if (!res.ok) { eventsLoaded = false; return }
    const data = await res.json()
    const F = data.fields as Record<string, number> | null
    if (!F) return
    const cancelled = new Set<string>((data.cancelledTaskRids as string[]) ?? [])
    const now = Date.now()
    for (const rec of (data.records as Array<Record<string, { value: unknown }>>) ?? []) {
      const rid = String(rec['3']?.value ?? '')
      if (cancelled.has(rid)) continue
      const whenRaw = String(rec[String(F['scheduledDateTime'])]?.value ?? '')
      if (!whenRaw) continue
      const when = new Date(whenRaw)
      if (isNaN(when.getTime()) || when.getTime() < now) continue
      const what = String(rec[String(F['templateName'])]?.value ?? 'Field event')
      nextEvent.value = `${what} on ${when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
      return  // records are sorted by scheduled time — first future one wins
    }
  } catch { eventsLoaded = false }
}

interface NoteVariable { token: string; label: string; value: string }
const VARIABLES = computed<NoteVariable[]>(() => [
  { token: 'customer', label: 'Customer name', value: pstr('customer_name') },
  { token: 'address', label: 'Address', value: pstr('customer_address') },
  { token: 'status', label: 'Project status', value: pstr('status') },
  { token: 'closer', label: 'Sales rep (closer)', value: pstr('closer') },
  { token: 'setter', label: 'Setter', value: pstr('setter') },
  { token: 'coordinator', label: 'Project coordinator', value: pstr('coordinator') },
  { token: 'lender', label: 'Lender', value: pstr('lender') },
  { token: 'utility', label: 'Utility company', value: pstr('utility_company') },
  { token: 'system_size', label: 'System size', value: pstr('system_size_kw') ? `${Number(pstr('system_size_kw')).toFixed(2)} kW` : '' },
  { token: 'survey_scheduled', label: 'Survey scheduled', value: pdate('survey_scheduled') },
  { token: 'install_scheduled', label: 'Install scheduled', value: pdate('install_scheduled') },
  { token: 'next_event', label: 'Next field event', value: nextEvent.value },
  { token: 'today', label: "Today's date", value: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) },
])

const BRACE_TAIL = /\{([\w]*)?$/
const braceActive = computed(() => BRACE_TAIL.test(noteText.value))
const braceMatches = computed(() => {
  const m = BRACE_TAIL.exec(noteText.value)
  if (!m) return []
  const q = (m[1] || '').toLowerCase()
  return VARIABLES.value
    .filter(v => v.token.includes(q) || v.label.toLowerCase().includes(q))
    .slice(0, 8)
})
function applyVariable(v: NoteVariable) {
  noteText.value = noteText.value.replace(BRACE_TAIL, `{${v.token}} `)
}

const TOKEN_RE = /\{(customer|address|status|closer|setter|coordinator|lender|utility|system_size|survey_scheduled|install_scheduled|next_event|today)\}/g
function resolveVars(text: string): string {
  return text.replace(TOKEN_RE, (whole, token: string) => {
    const v = VARIABLES.value.find(x => x.token === token)?.value ?? ''
    return v || whole  // unresolved tokens stay literal so nothing vanishes silently
  })
}

// Mirror segments: mention pills (teal) from lib/mentions, then variable
// tokens (violet) re-split out of the plain runs.
interface DisplaySeg { text: string; kind: 'plain' | 'mention' | 'variable' }
const displaySegments = computed<DisplaySeg[]>(() => {
  const out: DisplaySeg[] = []
  for (const seg of mentions.segments.value) {
    if (seg.mention) { out.push({ text: seg.text, kind: 'mention' }); continue }
    let last = 0
    let m: RegExpExecArray | null
    TOKEN_RE.lastIndex = 0
    while ((m = TOKEN_RE.exec(seg.text))) {
      if (m.index > last) out.push({ text: seg.text.slice(last, m.index), kind: 'plain' })
      out.push({ text: m[0], kind: 'variable' })
      last = m.index + m[0].length
    }
    if (last < seg.text.length) out.push({ text: seg.text.slice(last), kind: 'plain' })
  }
  return out
})

const slashActive = computed(() => noteText.value.startsWith('/') && !noteText.value.includes('\n'))
const slashMatches = computed(() => {
  if (!slashActive.value) return []
  const q = noteText.value.slice(1).trim().toLowerCase()
  const pool = templates.value
  return (q ? pool.filter(t => t.name.toLowerCase().includes(q)) : pool).slice(0, 8)
})

function applyTemplate(t: NoteTemplate) {
  noteText.value = resolveVars(t.body)
  if (t.category) category.value = t.category
  repVisible.value = t.visible_to_rep === 'Rep Visible'
  notifyPm.value = t.notify_pm === 1
  notifyRep.value = t.notify_rep === 1
}

// Load a template back into the composer RAW (tokens intact) for editing;
// the save form flips to update mode.
const editingTemplateId = ref<number | null>(null)
function editTemplate(t: NoteTemplate) {
  editingTemplateId.value = t.id
  noteText.value = t.body
  if (t.category) category.value = t.category
  repVisible.value = t.visible_to_rep === 'Rep Visible'
  notifyPm.value = t.notify_pm === 1
  notifyRep.value = t.notify_rep === 1
  templateName.value = t.name
  templateShared.value = t.shared === 1
  templateFormOpen.value = true
}

async function deleteTemplate(t: NoteTemplate) {
  try {
    const res = await fetch(`/api/notes/templates/${t.id}`, { method: 'DELETE', headers: hdrs() })
    if (res.ok) templates.value = templates.value.filter(x => x.id !== t.id)
  } catch { /* leave it in the list */ }
}

// Save the current composer state as a template.
const savingTemplate = ref(false)
const templateFormOpen = ref(false)
const templateName = ref('')
const templateShared = ref(false)
async function saveTemplate() {
  const name = templateName.value.trim()
  if (!name || !noteText.value.trim() || savingTemplate.value) return
  savingTemplate.value = true
  try {
    const editing = editingTemplateId.value
    const res = await fetch(editing ? `/api/notes/templates/${editing}` : '/api/notes/templates', {
      method: editing ? 'PATCH' : 'POST',
      headers: hdrs(),
      body: JSON.stringify({
        name,
        body: noteText.value.trim(),
        category: category.value || undefined,
        visible_to_rep: repVisible.value ? 'Rep Visible' : 'Internal Only',
        notify_pm: notifyPm.value,
        notify_rep: notifyRep.value,
        shared: templateShared.value,
      }),
    })
    if (res.ok) {
      templateFormOpen.value = false
      templateName.value = ''
      templateShared.value = false
      editingTemplateId.value = null
      await loadTemplates(true)
    }
  } catch { /* keep the form open */ } finally {
    savingTemplate.value = false
  }
}

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

// ── AI polish ─────────────────────────────────────────────
// Sends the rough draft to /api/notes/assist (whatever LLM provider is
// connected for this user/platform). The result replaces the draft —
// with Undo — and the suggested category fills in only if none is set,
// so an explicit choice is never overridden.
const polishing = ref(false)
const preAiDraft = ref<string | null>(null)
async function polish() {
  const draft = noteText.value.trim()
  if (!draft || polishing.value) return
  polishing.value = true
  errorMsg.value = null
  try {
    const res = await fetch('/api/notes/assist', {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify({ project_id: props.projectRid, draft }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `AI assist unavailable (${res.status})`)
    preAiDraft.value = noteText.value
    noteText.value = String(data.note ?? '')
    if (data.category && !category.value) category.value = String(data.category)
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    polishing.value = false
  }
}
function undoPolish() {
  if (preAiDraft.value === null) return
  noteText.value = preAiDraft.value
  preAiDraft.value = null
}

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
  templateFormOpen.value = false
  templateName.value = ''
  templateShared.value = false
  editingTemplateId.value = null
  preAiDraft.value = null
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
        note: resolveVars(noteText.value.trim()),
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
      @click="expanded = true; loadTemplates(); loadNextEvent()"
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
        ><template v-for="(s, i) in displaySegments" :key="i"><span v-if="s.kind === 'mention'" class="text-teal-700 bg-teal-600/10 rounded-[4px]">{{ s.text }}</span><span v-else-if="s.kind === 'variable'" class="text-violet-700 bg-violet-600/10 rounded-[4px]">{{ s.text }}</span><template v-else>{{ s.text }}</template></template>&#8203;</div>
        <textarea
          v-model="noteText"
          rows="4"
          autofocus
          placeholder="Write your note… (@ mention, / templates, { project facts)"
          class="relative z-10 w-full resize-y min-h-[96px] rounded-xl bg-transparent px-3.5 py-2.5 text-[13.5px] leading-[1.55] text-transparent caret-slate-800 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-teal-600/25 transition-shadow"
          @input="mentions.detect()"
          @scroll="syncMirrorScroll"
          @blur="mentions.open.value = false"
          @keydown.escape="mentions.open.value = false"
        />
        <!-- / template picker — anchored under the textarea -->
        <div
          v-if="slashActive && slashMatches.length"
          class="absolute z-30 top-full -mt-1 left-0 right-0 bg-white rounded-xl py-1 max-h-64 overflow-y-auto"
          style="box-shadow: 0 4px 16px rgba(15,23,42,0.10), 0 1px 3px rgba(15,23,42,0.06)"
        >
          <div class="px-3 pt-1.5 pb-1 text-[9.5px] font-semibold uppercase tracking-wider text-slate-400">Templates</div>
          <div v-for="t in slashMatches" :key="t.id" class="flex items-center group">
            <button
              type="button"
              class="flex-1 min-w-0 text-left px-3 py-1.5 hover:bg-slate-50 cursor-pointer"
              @mousedown.prevent="applyTemplate(t)"
            >
              <span class="flex items-baseline gap-2">
                <span class="text-[12.5px] font-medium text-slate-700">/{{ t.name }}</span>
                <span v-if="t.category" class="text-[10px] text-slate-400">{{ t.category }}</span>
                <span v-if="t.shared === 1" class="text-[9.5px] font-semibold text-teal-700 bg-teal-600/10 rounded-full px-1.5 py-px">Shared</span>
              </span>
              <span class="block text-[11px] text-slate-400 truncate">{{ t.body }}</span>
            </button>
            <button
              v-if="t.mine"
              type="button"
              class="opacity-0 group-hover:opacity-100 w-6 h-6 rounded-md flex items-center justify-center text-slate-300 hover:text-slate-600 hover:bg-slate-100 cursor-pointer shrink-0"
              title="Edit template"
              @mousedown.prevent="editTemplate(t)"
            >
              <svg viewBox="0 0 24 24" class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            </button>
            <button
              v-if="t.mine"
              type="button"
              class="opacity-0 group-hover:opacity-100 w-6 h-6 mr-2 rounded-md flex items-center justify-center text-slate-300 hover:text-rose-600 hover:bg-rose-50 cursor-pointer shrink-0"
              title="Delete template"
              @mousedown.prevent="deleteTemplate(t)"
            >
              <svg viewBox="0 0 24 24" class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </div>

        <!-- { variable picker — inserts a token that resolves on apply/post -->
        <div
          v-if="!slashActive && braceActive && braceMatches.length"
          class="absolute z-30 top-full -mt-1 left-0 right-0 sm:right-auto sm:min-w-[300px] bg-white rounded-xl py-1 max-h-64 overflow-y-auto"
          style="box-shadow: 0 4px 16px rgba(15,23,42,0.10), 0 1px 3px rgba(15,23,42,0.06)"
        >
          <div class="px-3 pt-1.5 pb-1 text-[9.5px] font-semibold uppercase tracking-wider text-slate-400">Project facts</div>
          <button
            v-for="v in braceMatches"
            :key="v.token"
            type="button"
            class="w-full text-left px-3 py-1.5 hover:bg-slate-50 cursor-pointer flex items-baseline gap-2"
            @mousedown.prevent="applyVariable(v)"
          >
            <span class="text-[12px] font-medium text-violet-700 shrink-0">{{ '{' + v.token + '}' }}</span>
            <span class="text-[11.5px] text-slate-600 truncate">{{ v.value || '—' }}</span>
            <span class="ml-auto text-[10px] text-slate-400 shrink-0">{{ v.label }}</span>
          </button>
        </div>

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

      <!-- Save-as-template inline form -->
      <div v-if="templateFormOpen" class="flex flex-wrap items-center gap-2 bg-slate-50 rounded-xl px-3 py-2">
        <input
          v-model="templateName"
          type="text"
          maxlength="60"
          placeholder="Template name…"
          class="flex-1 min-w-[140px] bg-transparent text-[12.5px] text-slate-800 placeholder:text-slate-400 outline-none"
          @keydown.enter="saveTemplate"
          @keydown.escape="templateFormOpen = false"
        >
        <label class="inline-flex items-center gap-1.5 cursor-pointer select-none text-[11.5px] text-slate-500">
          <input v-model="templateShared" type="checkbox" class="accent-teal-700 cursor-pointer">
          Everyone can use it
        </label>
        <button
          type="button"
          class="text-[11.5px] font-medium cursor-pointer"
          :class="templateName.trim() ? 'text-teal-700 hover:underline' : 'text-teal-700/40'"
          :disabled="!templateName.trim() || savingTemplate"
          @click="saveTemplate"
        >{{ savingTemplate ? 'Saving…' : (editingTemplateId ? 'Update template' : 'Save') }}</button>
        <button
          type="button"
          class="text-[11.5px] text-slate-400 hover:text-slate-600 cursor-pointer"
          @click="templateFormOpen = false; editingTemplateId = null"
        >Cancel</button>
      </div>

      <div class="flex items-center gap-2.5 pt-0.5">
        <button
          v-if="noteText.trim()"
          type="button"
          class="inline-flex items-center gap-1 text-[11.5px] font-medium cursor-pointer transition-colors"
          :class="polishing ? 'text-violet-400' : 'text-violet-700 hover:text-violet-800'"
          :disabled="polishing"
          @click="polish"
        >
          <svg viewBox="0 0 24 24" class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/></svg>
          {{ polishing ? 'Polishing…' : 'Polish' }}
        </button>
        <button
          v-if="preAiDraft !== null && !polishing"
          type="button"
          class="text-[11.5px] text-slate-400 hover:text-slate-600 cursor-pointer"
          @click="undoPolish"
        >Undo</button>
        <button
          v-if="noteText.trim() && !templateFormOpen"
          type="button"
          class="text-[11.5px] text-slate-400 hover:text-slate-600 font-medium cursor-pointer"
          @click="templateFormOpen = true; loadTemplates()"
        >Save as template</button>
        <div class="flex-1" />
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
