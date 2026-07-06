<script setup lang="ts">
// Ticket detail drawer — view + work a ticket without leaving the portal.
// Actions (status, due date, reassign, complete) are shown to the
// assignee/requester/admin; following and chat are open to everyone.
// Server re-enforces all permissions.
import { ref, computed, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { initials, avatarTone } from '@/lib/avatar'

export interface TicketRow {
  record_id: number
  title: string | null
  description: string | null
  category: string | null
  issue: string | null
  custom_issue: string | null
  priority: string | null
  status: string | null
  due_date: string | null
  adjusted_due: string | null
  assigned_to: string | null
  assigned_email: string | null
  requested_by: string | null
  requested_email: string | null
  followers_json: string | null
  project_rid: number | null
  project_name: string | null
  date_created: string | null
  completed_at: string | null
  completed_by: string | null
  disposition: string | null
  blocker: number
  [k: string]: unknown
}

const props = defineProps<{ open: boolean; ticket: TicketRow | null }>()
const emit = defineEmits<{ 'update:open': [boolean]; changed: [] }>()

const auth = useAuthStore()
function hdrs() {
  return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }
}

const STATUSES = ['On Track', 'Behind Schedule', 'Follow Up Scheduled', 'Ahead of Schedule']

const myEmail = computed(() => (auth.user?.email ?? '').toLowerCase())
const myName = computed(() => (auth.user?.name ?? '').trim().toLowerCase())
const canUpdate = computed(() => {
  const t = props.ticket
  if (!t) return false
  if (auth.isAdmin) return true
  if (myEmail.value && (t.assigned_email === myEmail.value || t.requested_email === myEmail.value)) return true
  return !!myName.value && (
    (t.assigned_to ?? '').trim().toLowerCase() === myName.value ||
    (t.requested_by ?? '').trim().toLowerCase() === myName.value
  )
})
const isOpenTicket = computed(() => !['Complete', 'Completed', 'Closed'].includes(props.ticket?.status ?? ''))
const amFollowing = computed(() => {
  try {
    const f = JSON.parse(props.ticket?.followers_json || '[]') as Array<{ email?: string }>
    return f.some(x => (x.email ?? '').toLowerCase() === myEmail.value)
  } catch { return false }
})

function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  const d = new Date(s.includes('T') ? s : s + 'T12:00:00')
  return isNaN(d.getTime()) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
function fmtStamp(s: string | null | undefined): string {
  if (!s) return ''
  const d = new Date(s)
  if (isNaN(d.getTime())) return s ?? ''
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === new Date().toDateString()) return time
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`
}

// ── Mutations ─────────────────────────────────────────────
const busy = ref(false)
const errorMsg = ref<string | null>(null)
async function patch(body: Record<string, unknown>) {
  if (!props.ticket || busy.value) return
  busy.value = true
  errorMsg.value = null
  try {
    const res = await fetch(`/api/tickets/${props.ticket.record_id}`, {
      method: 'PATCH', headers: hdrs(), body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `Update failed (${res.status})`)
    emit('changed')
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

const editingDue = ref(false)
const newDue = ref('')
async function saveDue() {
  if (!newDue.value) return
  await patch({ due_date: newDue.value })
  editingDue.value = false
}

// Reassign — searchable picker over portal users.
interface PortalUser { id: number; name: string }
const users = ref<PortalUser[]>([])
const reassigning = ref(false)
const reassignSearch = ref('')
async function loadUsers() {
  if (users.value.length) return
  try {
    const res = await fetch('/api/tickets/lookups', { headers: hdrs() })
    if (res.ok) users.value = ((await res.json()).users as PortalUser[]) ?? []
  } catch { /* picker stays empty */ }
}
const reassignMatches = computed(() => {
  const q = reassignSearch.value.trim().toLowerCase()
  return (q ? users.value.filter(u => u.name.toLowerCase().includes(q)) : users.value).slice(0, 8)
})

const confirmingComplete = ref(false)
const disposition = ref('Task Complete')

// ── Chat ──────────────────────────────────────────────────
interface ChatItem { record_id: number; date_created: string; note: string; author: string }
const chat = ref<ChatItem[]>([])
const chatLoading = ref(false)
const chatText = ref('')
const chatSending = ref(false)
async function loadChat() {
  if (!props.ticket) return
  chatLoading.value = true
  try {
    const res = await fetch(`/api/tickets/${props.ticket.record_id}/chat`, { headers: hdrs() })
    if (res.ok) chat.value = ((await res.json()).items as ChatItem[]) ?? []
  } catch { /* chat stays empty */ } finally {
    chatLoading.value = false
  }
}
async function sendChat() {
  const text = chatText.value.trim()
  if (!text || !props.ticket || chatSending.value) return
  chatSending.value = true
  errorMsg.value = null
  try {
    const res = await fetch(`/api/tickets/${props.ticket.record_id}/chat`, {
      method: 'POST', headers: hdrs(), body: JSON.stringify({ note: text }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `Failed to send (${res.status})`)
    chatText.value = ''
    await loadChat()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    chatSending.value = false
  }
}

watch(() => [props.open, props.ticket?.record_id], ([open]) => {
  if (open && props.ticket) {
    chat.value = []
    loadChat()
    editingDue.value = false
    reassigning.value = false
    confirmingComplete.value = false
    errorMsg.value = null
  }
})
</script>

<template>
  <Sheet :open="open" @update:open="(v) => emit('update:open', v)">
    <SheetContent side="right" class="w-full sm:max-w-md overflow-y-auto p-0">
      <template v-if="ticket">
        <SheetHeader class="px-5 pt-5 pb-3">
          <div class="flex items-start gap-2">
            <SheetTitle class="text-[15px] leading-snug flex-1">{{ ticket.title || `Ticket #${ticket.record_id}` }}</SheetTitle>
          </div>
          <div class="flex items-center gap-1.5 flex-wrap">
            <span
              class="text-[10.5px] font-semibold rounded-full px-2 py-0.5"
              :class="ticket.priority === 'Very Urgent' ? 'bg-rose-100 text-rose-700'
                : ticket.priority === 'High' ? 'bg-amber-100 text-amber-700'
                : 'bg-slate-100 text-slate-600'"
            >{{ ticket.priority || 'Medium' }}</span>
            <span class="text-[10.5px] font-medium rounded-full px-2 py-0.5 bg-teal-600/10 text-teal-700">{{ ticket.status || '—' }}</span>
            <span v-if="ticket.blocker" class="text-[10.5px] font-semibold rounded-full px-2 py-0.5 bg-amber-100 text-amber-700">Blocker</span>
          </div>
        </SheetHeader>

        <div class="px-5 pb-5 flex flex-col gap-4">
          <!-- Facts -->
          <div class="grid grid-cols-2 gap-x-4 gap-y-2 text-[12.5px]">
            <div><div class="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Assigned to</div><div class="text-slate-800">{{ ticket.assigned_to || '—' }}</div></div>
            <div><div class="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Requested by</div><div class="text-slate-800">{{ ticket.requested_by || '—' }}</div></div>
            <div><div class="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Category</div><div class="text-slate-800">{{ ticket.category || '—' }}</div></div>
            <div><div class="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Issue</div><div class="text-slate-800">{{ ticket.issue || ticket.custom_issue || '—' }}</div></div>
            <div>
              <div class="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Due</div>
              <div class="text-slate-800 font-medium">{{ fmtDate(ticket.due_date) }}<span v-if="ticket.adjusted_due" class="text-[10.5px] text-slate-400 font-normal"> (adjusted)</span></div>
            </div>
            <div><div class="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Created</div><div class="text-slate-800">{{ fmtDate(ticket.date_created) }}</div></div>
            <div v-if="ticket.project_name" class="col-span-2">
              <div class="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Project</div>
              <router-link v-if="ticket.project_rid" :to="`/projects/${ticket.project_rid}`" class="text-teal-700 hover:underline">{{ ticket.project_name }}</router-link>
              <div v-else class="text-slate-800">{{ ticket.project_name }}</div>
            </div>
            <div v-if="ticket.completed_at" class="col-span-2">
              <div class="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Completed</div>
              <div class="text-slate-800">{{ fmtDate(ticket.completed_at) }} by {{ ticket.completed_by || '—' }} · {{ ticket.disposition || '' }}</div>
            </div>
          </div>

          <!-- Description -->
          <div v-if="ticket.description" class="bg-slate-50 rounded-xl px-3.5 py-2.5 text-[12.5px] text-slate-700 leading-relaxed whitespace-pre-line">{{ ticket.description }}</div>

          <!-- Actions -->
          <div v-if="isOpenTicket" class="flex flex-col gap-2">
            <div class="flex flex-wrap items-center gap-1.5">
              <template v-if="canUpdate">
                <Select :model-value="ticket.status ?? ''" @update:model-value="(v) => patch({ status: String(v) })">
                  <SelectTrigger class="h-8 w-auto text-[12px] cursor-pointer gap-1.5 rounded-full bg-slate-100 border-0 shadow-none px-3" :disabled="busy">
                    <SelectValue placeholder="Status…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="s in STATUSES" :key="s" :value="s" class="text-[12.5px]">{{ s }}</SelectItem>
                  </SelectContent>
                </Select>
                <button
                  type="button"
                  class="h-8 rounded-full px-3 text-[12px] font-medium bg-slate-100 text-slate-600 hover:bg-slate-200/70 cursor-pointer"
                  :disabled="busy"
                  @click="editingDue = !editingDue; newDue = ticket.adjusted_due || ''"
                >Adjust due</button>
                <button
                  type="button"
                  class="h-8 rounded-full px-3 text-[12px] font-medium bg-slate-100 text-slate-600 hover:bg-slate-200/70 cursor-pointer"
                  :disabled="busy"
                  @click="reassigning = !reassigning; loadUsers()"
                >Reassign</button>
                <button
                  type="button"
                  class="h-8 rounded-full px-3 text-[12px] font-semibold bg-teal-700 text-white hover:bg-teal-800 cursor-pointer"
                  :disabled="busy"
                  @click="confirmingComplete = !confirmingComplete"
                >Complete</button>
              </template>
              <button
                type="button"
                class="h-8 rounded-full px-3 text-[12px] font-medium cursor-pointer"
                :class="amFollowing ? 'bg-teal-600/10 text-teal-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200/70'"
                :disabled="busy"
                @click="patch({ follow: !amFollowing })"
              >{{ amFollowing ? 'Following ✓' : 'Follow' }}</button>
            </div>

            <div v-if="editingDue" class="flex items-center gap-2">
              <input v-model="newDue" type="date" class="h-9 rounded-xl bg-slate-50 px-3 text-[12.5px] text-slate-800 outline-none focus:ring-2 focus:ring-teal-600/25 flex-1">
              <Button size="sm" :disabled="!newDue || busy" @click="saveDue">Save</Button>
            </div>

            <div v-if="reassigning" class="relative">
              <input
                v-model="reassignSearch"
                type="text"
                placeholder="Reassign to…"
                class="w-full h-9 rounded-xl bg-slate-50 px-3 text-[12.5px] text-slate-800 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-teal-600/25"
              >
              <div
                v-if="reassignMatches.length"
                class="absolute z-30 top-10 left-0 right-0 bg-white rounded-xl py-1 max-h-48 overflow-y-auto"
                style="box-shadow: 0 4px 16px rgba(15,23,42,0.10), 0 1px 3px rgba(15,23,42,0.06)"
              >
                <button
                  v-for="u in reassignMatches"
                  :key="u.id"
                  type="button"
                  class="w-full text-left px-3 py-1.5 hover:bg-slate-50 cursor-pointer text-[12.5px] text-slate-700"
                  @mousedown.prevent="patch({ assigned_user_id: u.id }); reassigning = false; reassignSearch = ''"
                >{{ u.name }}</button>
              </div>
            </div>

            <div v-if="confirmingComplete" class="flex flex-wrap items-center gap-2 bg-slate-50 rounded-xl px-3 py-2">
              <Select v-model="disposition">
                <SelectTrigger class="h-8 w-auto text-[12px] cursor-pointer gap-1.5 rounded-lg bg-white border-0 shadow-sm px-3">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Task Complete" class="text-[12.5px]">Task Complete</SelectItem>
                  <SelectItem value="Task Rejected" class="text-[12.5px]">Task Rejected</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" :disabled="busy" @click="patch({ complete: true, disposition }); confirmingComplete = false">
                {{ busy ? 'Saving…' : 'Confirm complete' }}
              </Button>
              <button type="button" class="text-[12px] text-slate-400 hover:text-slate-600 cursor-pointer" @click="confirmingComplete = false">Cancel</button>
            </div>
          </div>

          <div v-if="errorMsg" class="text-[12.5px] text-rose-600">{{ errorMsg }}</div>

          <!-- Chat -->
          <div>
            <div class="text-[11px] font-medium text-slate-500 tracking-[0.08em] uppercase mb-2">Conversation</div>
            <div v-if="chatLoading" class="text-[12px] text-slate-400 py-2">Loading…</div>
            <div v-else-if="!chat.length" class="text-[12px] text-slate-400 py-2">No messages yet.</div>
            <div v-else class="flex flex-col gap-2.5 mb-3">
              <div v-for="m in chat" :key="m.record_id" class="flex gap-2">
                <span
                  class="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0 mt-0.5"
                  :style="{ background: avatarTone(m.author).bg, color: avatarTone(m.author).fg }"
                >{{ initials(m.author) }}</span>
                <div class="flex-1 min-w-0">
                  <div class="flex items-baseline gap-2">
                    <span class="text-[11.5px] font-semibold text-slate-600">{{ m.author || 'Unknown' }}</span>
                    <span class="text-[11px] font-medium text-slate-500 tabular-nums">{{ fmtStamp(m.date_created) }}</span>
                  </div>
                  <div class="text-[12.5px] text-slate-600 leading-relaxed whitespace-pre-line">{{ m.note }}</div>
                </div>
              </div>
            </div>
            <div class="flex items-end gap-1.5 bg-slate-50 rounded-xl px-3 py-2">
              <textarea
                v-model="chatText"
                rows="2"
                placeholder="Write a message…"
                class="flex-1 resize-none bg-transparent text-[12.5px] text-slate-800 placeholder:text-slate-400 outline-none leading-relaxed"
                @keydown.meta.enter="sendChat"
                @keydown.ctrl.enter="sendChat"
              />
              <button
                type="button"
                class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 transition-colors cursor-pointer"
                :class="chatText.trim() && !chatSending ? 'bg-teal-700 text-white' : 'bg-teal-600/10 text-teal-700/50'"
                :disabled="!chatText.trim() || chatSending"
                @click="sendChat"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
              </button>
            </div>
          </div>
        </div>
      </template>
    </SheetContent>
  </Sheet>
</template>
