<script setup lang="ts">
// Create-ticket drawer — bottom sheet on mobile, right drawer on desktop.
// Description-first flow: write what's needed, then "Suggest details"
// (AI triage via the user's connected LLM) fills category / issue /
// priority and recommends assignees from who actually handles that kind
// of ticket. All suggestions stay editable; the cleaned-up description
// is only ever a preview the user explicitly accepts.
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const props = defineProps<{
  open: boolean
  /** Pre-links the ticket to a project (from the project detail tab). */
  projectRid?: number | null
  projectName?: string | null
}>()
const emit = defineEmits<{ 'update:open': [boolean]; created: [] }>()

const auth = useAuthStore()
function hdrs() {
  return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }
}

// Bottom sheet on mobile, right drawer on desktop.
const isDesktop = ref(false)
let mq: MediaQueryList | null = null
function syncBp() { isDesktop.value = typeof window !== 'undefined' && window.matchMedia('(min-width: 640px)').matches }
onMounted(() => {
  syncBp()
  mq = window.matchMedia('(min-width: 640px)')
  mq.addEventListener('change', syncBp)
})
onUnmounted(() => mq?.removeEventListener('change', syncBp))

// ── Lookups ───────────────────────────────────────────────
interface Category { id: number; label: string; status: string; blocker: boolean }
interface Issue { id: number; label: string; status: string; category_id: number | null; blocker: boolean }
interface PortalUser { id: number; name: string }
const categories = ref<Category[]>([])
const issues = ref<Issue[]>([])
const users = ref<PortalUser[]>([])
let lookupsLoaded = false
async function loadLookups() {
  if (lookupsLoaded) return
  try {
    const res = await fetch('/api/tickets/lookups', { headers: hdrs() })
    if (!res.ok) return
    const data = await res.json()
    categories.value = ((data.categories as Category[]) ?? []).filter(c => c.status === 'Active')
    issues.value = ((data.issues as Issue[]) ?? []).filter(i => i.status === 'Active')
    users.value = (data.users as PortalUser[]) ?? []
    lookupsLoaded = true
  } catch { /* pickers stay empty; save will fail loudly */ }
}
watch(() => props.open, (o) => { if (o) loadLookups() })

// ── Form state ────────────────────────────────────────────
const description = ref('')
const categoryId = ref<number | null>(null)
const issueId = ref<number | null>(null)
const customIssue = ref('')
const priority = ref('Medium')
const dueDate = ref('')
const assignedUserId = ref<number | null>(null)
const followerIds = ref<number[]>([])

const PRIORITIES = ['Low', 'Medium', 'High', 'Very Urgent']

const categoryIssues = computed(() => issues.value.filter(i => i.category_id === categoryId.value))
function onCategoryChange(v: string) {
  const id = parseInt(v) || null
  if (id !== categoryId.value) { categoryId.value = id; issueId.value = null }
}

// Searchable issue picker (232 issues across categories).
const issueSearch = ref('')
const issuePickerOpen = ref(false)
const issueMatches = computed(() => {
  const q = issueSearch.value.trim().toLowerCase()
  const pool = categoryIssues.value
  return (q ? pool.filter(i => i.label.toLowerCase().includes(q)) : pool).slice(0, 10)
})
const selectedIssueLabel = computed(() =>
  issueId.value ? (issues.value.find(i => i.id === issueId.value)?.label ?? '') : ''
)

// Assignee picker.
const assigneeSearch = ref('')
const assigneePickerOpen = ref(false)
const assigneeMatches = computed(() => {
  const q = assigneeSearch.value.trim().toLowerCase()
  const pool = users.value.filter(u => u.id !== assignedUserId.value)
  return (q ? pool.filter(u => u.name.toLowerCase().includes(q)) : pool).slice(0, 8)
})
const assigneeName = computed(() =>
  assignedUserId.value ? (users.value.find(u => u.id === assignedUserId.value)?.name ?? '') : ''
)

// Followers.
const followerSearch = ref('')
const followerPickerOpen = ref(false)
const followerMatches = computed(() => {
  const q = followerSearch.value.trim().toLowerCase()
  const pool = users.value.filter(u => !followerIds.value.includes(u.id) && u.id !== assignedUserId.value)
  return (q ? pool.filter(u => u.name.toLowerCase().includes(q)) : pool).slice(0, 8)
})
function followerName(id: number): string {
  return users.value.find(u => u.id === id)?.name ?? String(id)
}

// ── AI triage ─────────────────────────────────────────────
// Fills the pickers (still editable) and proposes cleaned wording that
// the user must explicitly accept — their text is never overwritten.
const triaging = ref(false)
const triageError = ref<string | null>(null)
const cleanedProposal = ref<string | null>(null)
const suggestedAssignees = ref<Array<{ user_id: number; name: string; count: number }>>([])
const triageApplied = ref(false)
const suggestedDue = ref<string | null>(null)
const onsiteNote = ref<string | null>(null)
const nextVisit = ref<{ when: string; what: string } | null>(null)
const fieldDoable = ref(false)

async function suggestDetails() {
  const text = description.value.trim()
  if (!text || triaging.value) return
  triaging.value = true
  triageError.value = null
  try {
    const res = await fetch('/api/tickets/triage', {
      method: 'POST', headers: hdrs(),
      body: JSON.stringify({ description: text, project_id: props.projectRid ?? undefined }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `Triage unavailable (${res.status})`)
    if (data.category_id) categoryId.value = data.category_id
    if (data.issue_id) issueId.value = data.issue_id
    else if (data.custom_issue) customIssue.value = data.custom_issue
    if (data.priority) priority.value = data.priority
    cleanedProposal.value = (data.cleaned_description && data.cleaned_description !== text) ? data.cleaned_description : null
    suggestedAssignees.value = (data.suggested_assignees as typeof suggestedAssignees.value) ?? []
    suggestedDue.value = (data.suggested_due_date as string | null) ?? null
    fieldDoable.value = data.field_doable === true
    onsiteNote.value = (data.onsite_note as string | null) ?? null
    nextVisit.value = (data.next_visit as typeof nextVisit.value) ?? null
    triageApplied.value = true
  } catch (e) {
    triageError.value = e instanceof Error ? e.message : String(e)
  } finally {
    triaging.value = false
  }
}
function acceptCleaned() {
  if (cleanedProposal.value) description.value = cleanedProposal.value
  cleanedProposal.value = null
}

// ── Submit ────────────────────────────────────────────────
const saving = ref(false)
const errorMsg = ref<string | null>(null)
const canSave = computed(() =>
  !!categoryId.value && (!!issueId.value || customIssue.value.trim().length > 0) &&
  !!dueDate.value && !!assignedUserId.value && description.value.trim().length > 0 && !saving.value
)

const todayLabel = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

function reset() {
  description.value = ''
  categoryId.value = null
  issueId.value = null
  customIssue.value = ''
  priority.value = 'Medium'
  dueDate.value = ''
  assignedUserId.value = null
  followerIds.value = []
  cleanedProposal.value = null
  suggestedAssignees.value = []
  suggestedDue.value = null
  onsiteNote.value = null
  nextVisit.value = null
  fieldDoable.value = false
  triageApplied.value = false
  triageError.value = null
  errorMsg.value = null
}

function fmtVisit(v: { when: string; what: string }): string {
  const d = new Date(v.when)
  const day = isNaN(d.getTime()) ? v.when.slice(0, 10) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${v.what} · ${day}`
}

async function save() {
  if (!canSave.value) return
  saving.value = true
  errorMsg.value = null
  try {
    const res = await fetch('/api/tickets', {
      method: 'POST', headers: hdrs(),
      body: JSON.stringify({
        project_id: props.projectRid ?? undefined,
        category_id: categoryId.value,
        issue_id: issueId.value ?? undefined,
        custom_issue: customIssue.value.trim() || undefined,
        priority: priority.value,
        due_date: dueDate.value,
        assigned_user_id: assignedUserId.value,
        description: description.value.trim(),
        follower_user_ids: followerIds.value,
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `Failed to create ticket (${res.status})`)
    reset()
    emit('update:open', false)
    emit('created')
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Sheet :open="open" @update:open="(v) => emit('update:open', v)">
    <SheetContent
      :side="isDesktop ? 'right' : 'bottom'"
      :class="isDesktop
        ? 'w-full sm:max-w-md overflow-y-auto p-0'
        : 'max-h-[92vh] overflow-y-auto rounded-t-2xl p-0'"
    >
      <SheetHeader class="px-5 pt-5 pb-1">
        <SheetTitle class="text-[15px]">
          New ticket<span v-if="projectName" class="font-normal text-slate-500"> · {{ projectName }}</span>
        </SheetTitle>
      </SheetHeader>

      <div class="px-5 pb-6 flex flex-col gap-4">
        <!-- Description first — everything else can follow from it -->
        <div>
          <label class="block text-[10.5px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
            What's needed <span class="text-rose-500">*</span>
          </label>
          <textarea
            v-model="description"
            rows="4"
            placeholder="Describe the issue — what's wrong, what's needed, any context…"
            class="w-full resize-y min-h-[96px] rounded-xl bg-white ring-1 ring-slate-200 px-3.5 py-2.5 text-[13px] text-slate-800 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-teal-600/40 leading-relaxed"
          />
          <div class="flex items-center gap-2 mt-1.5">
            <button
              type="button"
              class="inline-flex items-center gap-1 text-[11.5px] font-medium cursor-pointer transition-colors"
              :class="!description.trim() || triaging ? 'text-violet-300' : 'text-violet-700 hover:text-violet-800'"
              :disabled="!description.trim() || triaging"
              @click="suggestDetails"
            >
              <svg viewBox="0 0 24 24" class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/></svg>
              {{ triaging ? 'Suggesting…' : 'Suggest details' }}
            </button>
            <span v-if="triageApplied && !triaging" class="text-[10.5px] text-slate-400">Category, issue &amp; priority filled — adjust anything below.</span>
          </div>
          <div v-if="triageError" class="text-[11.5px] text-rose-600 mt-1">{{ triageError }}</div>

          <!-- Ride-along: on-site work + an upcoming visit = bundle it -->
          <div v-if="fieldDoable && nextVisit" class="mt-2 rounded-xl bg-amber-50/80 px-3.5 py-2.5">
            <div class="text-[10px] font-semibold uppercase tracking-wider text-amber-600 mb-1">Crew already scheduled — bundle this?</div>
            <div class="text-[12.5px] text-slate-700 leading-relaxed">
              {{ fmtVisit(nextVisit) }} is on the calendar for this project.
              <template v-if="onsiteNote"> Suggested crew instruction: <span class="font-medium">“{{ onsiteNote }}”</span></template>
            </div>
          </div>

          <!-- Cleaned-wording proposal — never auto-applied -->
          <div v-if="cleanedProposal" class="mt-2 rounded-xl bg-violet-50/70 px-3.5 py-2.5">
            <div class="text-[10px] font-semibold uppercase tracking-wider text-violet-500 mb-1">Suggested wording</div>
            <div class="text-[12.5px] text-slate-700 leading-relaxed whitespace-pre-line">{{ cleanedProposal }}</div>
            <div class="flex items-center gap-3 mt-1.5">
              <button type="button" class="text-[11.5px] font-medium text-violet-700 hover:underline cursor-pointer" @click="acceptCleaned">Use this wording</button>
              <button type="button" class="text-[11.5px] text-slate-400 hover:text-slate-600 cursor-pointer" @click="cleanedProposal = null">Keep mine</button>
            </div>
          </div>
        </div>

        <!-- Category + issue -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label class="block text-[10.5px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
              Category <span class="text-rose-500">*</span>
            </label>
            <Select :model-value="categoryId ? String(categoryId) : ''" @update:model-value="(v) => onCategoryChange(String(v))">
              <SelectTrigger class="h-10 w-full text-[13px] cursor-pointer rounded-xl bg-white ring-1 ring-slate-200 border-0 shadow-none px-3.5 data-[placeholder]:text-slate-400">
                <SelectValue placeholder="Choose…" />
              </SelectTrigger>
              <SelectContent class="max-h-72">
                <SelectItem v-for="c in categories" :key="c.id" :value="String(c.id)" class="text-[13px]">{{ c.label }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label class="block text-[10.5px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
              Issue <span class="text-rose-500">*</span>
            </label>
            <div class="relative">
              <div v-if="selectedIssueLabel" class="flex items-center gap-2 h-10 rounded-xl bg-white ring-1 ring-slate-200 px-3.5">
                <span class="text-[13px] text-slate-800 truncate flex-1">{{ selectedIssueLabel }}</span>
                <button type="button" class="text-slate-400 hover:text-slate-600 cursor-pointer" @click="issueId = null">
                  <svg viewBox="0 0 24 24" class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
                </button>
              </div>
              <div v-else-if="customIssue" class="flex items-center gap-2 h-10 rounded-xl bg-white ring-1 ring-slate-200 px-3.5">
                <span class="text-[13px] text-slate-800 truncate flex-1">{{ customIssue }} <span class="text-[10px] text-slate-400">(custom)</span></span>
                <button type="button" class="text-slate-400 hover:text-slate-600 cursor-pointer" @click="customIssue = ''">
                  <svg viewBox="0 0 24 24" class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
                </button>
              </div>
              <template v-else>
                <input
                  v-model="issueSearch"
                  type="text"
                  :placeholder="categoryId ? 'Search issues…' : 'Pick a category first'"
                  :disabled="!categoryId"
                  class="w-full h-10 rounded-xl bg-white ring-1 ring-slate-200 px-3.5 text-[13px] text-slate-800 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-teal-600/40 disabled:opacity-50"
                  @focus="issuePickerOpen = true"
                  @blur="issuePickerOpen = false"
                >
                <div
                  v-if="issuePickerOpen && categoryId"
                  class="absolute z-30 top-11 left-0 right-0 bg-white rounded-xl py-1 max-h-56 overflow-y-auto"
                  style="box-shadow: 0 4px 16px rgba(15,23,42,0.10), 0 1px 3px rgba(15,23,42,0.06)"
                >
                  <button
                    v-for="i in issueMatches"
                    :key="i.id"
                    type="button"
                    class="w-full text-left px-3 py-1.5 hover:bg-slate-50 cursor-pointer text-[13px] text-slate-700 flex items-center gap-2"
                    @mousedown.prevent="issueId = i.id; customIssue = ''; issueSearch = ''; issuePickerOpen = false"
                  >
                    <span class="truncate">{{ i.label }}</span>
                    <span v-if="i.blocker" class="ml-auto text-[9.5px] font-semibold text-amber-700 bg-amber-100 rounded-full px-1.5 py-px shrink-0">Blocker</span>
                  </button>
                  <button
                    v-if="issueSearch.trim()"
                    type="button"
                    class="w-full text-left px-3 py-1.5 hover:bg-slate-50 cursor-pointer text-[12.5px] text-teal-700 font-medium"
                    @mousedown.prevent="customIssue = issueSearch.trim(); issueSearch = ''; issuePickerOpen = false"
                  >Use “{{ issueSearch.trim() }}” as a custom issue</button>
                </div>
              </template>
            </div>
          </div>
        </div>

        <!-- Priority + due -->
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-[10.5px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
              Priority <span class="text-rose-500">*</span>
            </label>
            <Select v-model="priority">
              <SelectTrigger class="h-10 w-full text-[13px] cursor-pointer rounded-xl bg-white ring-1 ring-slate-200 border-0 shadow-none px-3.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="p in PRIORITIES" :key="p" :value="p" class="text-[13px]">{{ p }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label class="block text-[10.5px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
              Due date <span class="text-rose-500">*</span>
            </label>
            <input
              v-model="dueDate"
              type="date"
              class="w-full h-10 rounded-xl bg-white ring-1 ring-slate-200 px-3.5 text-[13px] text-slate-800 outline-none focus:ring-2 focus:ring-teal-600/40 cursor-pointer"
            >
            <button
              v-if="suggestedDue && dueDate !== suggestedDue"
              type="button"
              class="mt-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium bg-violet-600/10 text-violet-700 hover:bg-violet-600/20 cursor-pointer"
              :title="nextVisit ? `Anchored to ${fmtVisit(nextVisit)}` : 'Suggested from priority'"
              @click="dueDate = suggestedDue!"
            >Suggest: {{ suggestedDue }}</button>
          </div>
        </div>

        <!-- Assignee -->
        <div>
          <label class="block text-[10.5px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
            Assign to <span class="text-rose-500">*</span>
          </label>
          <div class="relative">
            <div v-if="assigneeName" class="flex items-center gap-2 h-10 rounded-xl bg-white ring-1 ring-slate-200 px-3.5">
              <span class="text-[13px] text-slate-800 truncate flex-1">{{ assigneeName }}</span>
              <button type="button" class="text-slate-400 hover:text-slate-600 cursor-pointer" @click="assignedUserId = null">
                <svg viewBox="0 0 24 24" class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>
            <template v-else>
              <input
                v-model="assigneeSearch"
                type="text"
                placeholder="Search people…"
                class="w-full h-10 rounded-xl bg-white ring-1 ring-slate-200 px-3.5 text-[13px] text-slate-800 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-teal-600/40"
                @focus="assigneePickerOpen = true"
                @blur="assigneePickerOpen = false"
              >
              <div
                v-if="assigneePickerOpen && assigneeMatches.length"
                class="absolute z-30 top-11 left-0 right-0 bg-white rounded-xl py-1 max-h-48 overflow-y-auto"
                style="box-shadow: 0 4px 16px rgba(15,23,42,0.10), 0 1px 3px rgba(15,23,42,0.06)"
              >
                <button
                  v-for="u in assigneeMatches"
                  :key="u.id"
                  type="button"
                  class="w-full text-left px-3 py-1.5 hover:bg-slate-50 cursor-pointer text-[13px] text-slate-700"
                  @mousedown.prevent="assignedUserId = u.id; assigneeSearch = ''; assigneePickerOpen = false"
                >{{ u.name }}</button>
              </div>
            </template>
          </div>
          <!-- Rules-based assignee suggestions from triage -->
          <div v-if="suggestedAssignees.length && !assigneeName" class="flex flex-wrap items-center gap-1.5 mt-1.5">
            <span class="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Suggested</span>
            <button
              v-for="s in suggestedAssignees"
              :key="s.user_id"
              type="button"
              class="rounded-full px-2.5 py-1 text-[11.5px] font-medium bg-violet-600/10 text-violet-700 hover:bg-violet-600/20 cursor-pointer"
              :title="`Handled ${s.count} similar tickets recently`"
              @click="assignedUserId = s.user_id"
            >{{ s.name }} · {{ s.count }}</button>
          </div>
        </div>

        <!-- Followers -->
        <div>
          <label class="block text-[10.5px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">Followers</label>
          <div v-if="followerIds.length" class="flex flex-wrap gap-1.5 mb-1.5">
            <span
              v-for="id in followerIds"
              :key="id"
              class="inline-flex items-center gap-1 bg-slate-100 text-slate-700 text-[12px] font-medium pl-2 pr-1 py-0.5 rounded-full"
            >
              {{ followerName(id) }}
              <button
                type="button"
                class="w-4 h-4 rounded-full inline-flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-200 cursor-pointer"
                @click="followerIds = followerIds.filter(x => x !== id)"
              >
                <svg viewBox="0 0 24 24" class="w-2.5 h-2.5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </span>
          </div>
          <div class="relative">
            <input
              v-model="followerSearch"
              type="text"
              placeholder="Add people who should get updates…"
              class="w-full h-9 rounded-xl bg-white ring-1 ring-slate-200 px-3.5 text-[12.5px] text-slate-700 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-teal-600/40"
              @focus="followerPickerOpen = true"
              @blur="followerPickerOpen = false"
            >
            <div
              v-if="followerPickerOpen && followerMatches.length"
              class="absolute z-30 top-10 left-0 right-0 bg-white rounded-xl py-1 max-h-48 overflow-y-auto"
              style="box-shadow: 0 4px 16px rgba(15,23,42,0.10), 0 1px 3px rgba(15,23,42,0.06)"
            >
              <button
                v-for="u in followerMatches"
                :key="u.id"
                type="button"
                class="w-full text-left px-3 py-1.5 hover:bg-slate-50 cursor-pointer text-[12.5px] text-slate-700"
                @mousedown.prevent="followerIds = [...followerIds, u.id]; followerSearch = ''"
              >{{ u.name }}</button>
            </div>
          </div>
        </div>

        <div v-if="errorMsg" class="text-[12.5px] text-rose-600">{{ errorMsg }}</div>

        <!-- Auto fields, like the QB form shows them -->
        <div class="flex items-center justify-between gap-3 pt-1">
          <span class="text-[11px] text-slate-400">Requested by {{ auth.user?.name || 'you' }} · {{ todayLabel }}</span>
          <div class="flex items-center gap-2">
            <Button variant="ghost" size="sm" class="text-slate-500" :disabled="saving" @click="emit('update:open', false)">Cancel</Button>
            <Button size="sm" :disabled="!canSave" @click="save">{{ saving ? 'Creating…' : 'Create ticket' }}</Button>
          </div>
        </div>
      </div>
    </SheetContent>
  </Sheet>
</template>
