<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { formatPhone, fmtTalkSec } from '@/lib/callBuckets'
import SmsThreadDialog from '@/components/SmsThreadDialog.vue'
import CallTimelineDialog from '@/components/CallTimelineDialog.vue'
import ContactCard, { type ContactCardData } from '@/components/ContactCard.vue'
import ComposeDialog from '@/components/ComposeDialog.vue'
import DtIconSearch from '@dialpad/dialtone-icons/vue3/search'
import DtIconClose from '@dialpad/dialtone-icons/vue3/close'
import DtIconMessage from '@dialpad/dialtone-icons/vue3/message'
import DtIconPhoneIncoming from '@dialpad/dialtone-icons/vue3/phone-incoming'
import DtIconPhoneOutgoing from '@dialpad/dialtone-icons/vue3/phone-outgoing'
import DtIconVoicemail from '@dialpad/dialtone-icons/vue3/voicemail'

interface SmsLatest {
  id: number
  at: string
  direction: string
  user_name: string | null
  body: string | null
}
interface CallLatest {
  call_id: string
  at: string
  direction: string
  user_name: string | null
  bucket: string
  talk_time_sec: number
  was_voicemail: boolean
  was_recorded: boolean
}
interface SearchRow {
  phone: string
  digits: string
  last_at: string
  last_kind: 'sms' | 'call'
  customer_name: string | null
  project_id: number | null
  project_status: string | null
  project_coordinator: string | null
  sms: SmsLatest | null
  call: CallLatest | null
}
interface SearchResponse {
  rows: SearchRow[]
  q: string
  mode: 'phone' | 'text' | 'idle'
  total_candidates?: number
}

const auth = useAuthStore()
function hdrs() { return { Authorization: `Bearer ${auth.token}` } }

const q = ref('')
const rows = ref<SearchRow[]>([])
const loading = ref(false)
const mode = ref<'phone' | 'text' | 'idle'>('idle')
const lastReqId = ref(0)

// Compose dialog — new SMS or new call. Always-available alongside search;
// also reachable from ContactCard so the user can pick a sender even on
// existing threads.
const compose = ref<{ open: boolean; prefillNumber: string; prefillName: string }>({ open: false, prefillNumber: '', prefillName: '' })

// Contact card — first thing shown after a row click. Hosts the Message /
// Call action buttons; we then escalate into the SMS thread or call timeline
// based on what the user picks.
const contactCard = ref<{ open: boolean; data: ContactCardData | null }>({ open: false, data: null })
// SMS thread dialog
const smsThread = ref<{ open: boolean; number: string; name: string }>({ open: false, number: '', name: '' })
// Call timeline dialog
const callTimeline = ref<{ open: boolean; callId: string; number: string }>({ open: false, callId: '', number: '' })

let debounceTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSearch() {
  if (debounceTimer) clearTimeout(debounceTimer)
  // Empty / too short → clear and bail
  if (q.value.trim().length < 2) {
    rows.value = []
    mode.value = 'idle'
    loading.value = false
    return
  }
  debounceTimer = setTimeout(runSearch, 220)
}

async function runSearch() {
  const reqId = ++lastReqId.value
  loading.value = true
  try {
    const url = `/api/dialpad/search?q=${encodeURIComponent(q.value.trim())}&limit=25`
    const res = await fetch(url, { headers: hdrs() })
    if (!res.ok) {
      // Stale / aborted requests are dropped silently — the latest one wins.
      if (reqId === lastReqId.value) { rows.value = []; mode.value = 'idle' }
      return
    }
    const data = await res.json() as SearchResponse
    if (reqId !== lastReqId.value) return
    rows.value = data.rows
    mode.value = data.mode
  } finally {
    if (reqId === lastReqId.value) loading.value = false
  }
}

watch(q, scheduleSearch)

onBeforeUnmount(() => { if (debounceTimer) clearTimeout(debounceTimer) })

function clearSearch() {
  q.value = ''
  rows.value = []
  mode.value = 'idle'
}

function onRowClick(r: SearchRow) {
  // Open the contact card first so the user can pick Message / Call. The
  // card escalates into SmsThreadDialog or CallTimelineDialog via emits.
  contactCard.value = {
    open: true,
    data: {
      phone: r.phone,
      customer_name: r.customer_name,
      project_id: r.project_id,
      project_status: r.project_status,
      project_coordinator: r.project_coordinator,
      sms: r.sms,
      call: r.call,
    },
  }
}

function onContactMessage() {
  // Open the SMS thread directly — iMessage feel. The thread now owns its
  // own sender picker (defaulting to the most-recent agent on the thread or
  // the current user) and auto-focuses the composer on open. The dedicated
  // ComposeDialog stays reserved for the "+ New" button where the recipient
  // hasn't been picked yet.
  const c = contactCard.value.data
  if (!c) return
  const name = c.customer_name || formatPhone(c.phone)
  contactCard.value.open = false
  smsThread.value = { open: true, number: c.phone, name }
}

function onContactViewCall() {
  const c = contactCard.value.data
  if (!c?.call) return
  contactCard.value.open = false
  callTimeline.value = { open: true, callId: c.call.call_id, number: c.phone }
}

function openCompose() {
  compose.value = { open: true, prefillNumber: '', prefillName: '' }
}

function onComposeSent(kind: 'sms' | 'call') {
  // After a text send, drop into the thread so the user sees their bubble
  // land. After a call initiation, no follow-up — Dialpad rings their device.
  const prefill = compose.value.prefillNumber
  const name = compose.value.prefillName
  if (kind === 'sms' && prefill) {
    smsThread.value = { open: true, number: prefill, name: name || formatPhone(prefill) }
  }
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z')
  if (isNaN(d.getTime())) return ''
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  if (days < 30) return `${days}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function shortBody(body: string | null): string {
  if (!body) return ''
  const trimmed = body.trim()
  return trimmed.length > 110 ? trimmed.slice(0, 110) + '…' : trimmed
}

// Highlight the matched substring inside customer name / SMS body for text mode.
function highlight(text: string): string {
  if (!text || mode.value !== 'text' || q.value.trim().length < 2) return escapeHtml(text)
  const needle = q.value.trim()
  // Build a case-insensitive regex from the needle, escape regex specials.
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return escapeHtml(text).replace(new RegExp(escaped, 'gi'), m => `<mark class="bg-amber-100 text-amber-900 rounded-sm px-0.5">${m}</mark>`)
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}
</script>

<template>
  <div class="comms-search relative">
    <!-- Search input + compose button — flex row so the compose CTA sits
         alongside the search box without stealing vertical space. -->
    <div class="flex items-center gap-2">
      <div class="relative flex-1 min-w-0">
        <span class="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none">
          <component :is="DtIconSearch" class="w-4 h-4" />
        </span>
        <input
          v-model="q"
          type="search"
          placeholder="Search by name, phone, or message…"
          class="w-full h-9 pl-9 pr-9 rounded-lg border bg-card text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          autocomplete="off"
          spellcheck="false"
          @keydown.escape="clearSearch"
        />
        <button
          v-if="q.length > 0"
          type="button"
          class="absolute right-2 top-1/2 -translate-y-1/2 size-6 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted cursor-pointer"
          aria-label="Clear search"
          @click="clearSearch"
        >
          <component :is="DtIconClose" class="w-3.5 h-3.5" />
        </button>
      </div>
      <button
        type="button"
        class="
          shrink-0 inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg cursor-pointer text-[12.5px] font-medium
          bg-gradient-to-br from-sky-500 to-blue-600 text-white
          shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_3px_rgba(2,132,199,0.25)]
          hover:from-sky-400 hover:to-blue-500 active:scale-[0.98] transition-all
        "
        aria-label="Start a new message or call"
        @click="openCompose"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        <span class="hidden sm:inline">New</span>
      </button>
    </div>

    <!-- Results panel -->
    <div v-if="q.trim().length >= 2" class="mt-1.5 rounded-lg border bg-card overflow-hidden">
      <div v-if="loading && rows.length === 0" class="px-3 py-6 text-center text-xs text-muted-foreground">
        Searching…
      </div>
      <div v-else-if="rows.length === 0" class="px-3 py-6 text-center text-xs text-muted-foreground">
        No matches in the last 90 days.
      </div>
      <div v-else class="max-h-[60vh] overflow-y-auto divide-y">
        <button
          v-for="r in rows"
          :key="r.phone"
          type="button"
          class="w-full text-left px-3 py-2.5 hover:bg-muted/40 transition-colors cursor-pointer min-w-0"
          @click="onRowClick(r)"
        >
          <div class="flex items-start gap-2 min-w-0">
            <!-- Last-activity icon: kind + direction -->
            <span class="shrink-0 mt-0.5 size-7 inline-flex items-center justify-center rounded-full bg-muted/60">
              <component
                :is="r.last_kind === 'sms'
                  ? DtIconMessage
                  : (r.call?.was_voicemail ? DtIconVoicemail : (r.call?.direction === 'outgoing' ? DtIconPhoneOutgoing : DtIconPhoneIncoming))"
                class="w-3.5 h-3.5"
                :class="r.last_kind === 'sms'
                  ? 'text-violet-600'
                  : (r.call?.was_voicemail ? 'text-violet-600' : (r.call?.direction === 'outgoing' ? 'text-emerald-600' : 'text-sky-600'))"
              />
            </span>

            <div class="flex-1 min-w-0">
              <!-- Top row: name + time -->
              <div class="flex items-baseline gap-2 min-w-0">
                <p class="text-[13px] font-semibold truncate min-w-0" v-html="highlight(r.customer_name || formatPhone(r.phone))" />
                <span class="text-[10px] text-muted-foreground shrink-0 tabular-nums">{{ timeAgo(r.last_at) }}</span>
              </div>
              <!-- Sub row: phone + project status -->
              <div class="flex items-center gap-1.5 text-[11px] text-muted-foreground min-w-0">
                <span class="tabular-nums">{{ formatPhone(r.phone) }}</span>
                <span v-if="r.project_status" class="truncate">· {{ r.project_status }}</span>
                <span v-if="r.project_coordinator" class="truncate">· PC: {{ r.project_coordinator }}</span>
              </div>
              <!-- Snippet row: SMS body or call info -->
              <p
                v-if="r.last_kind === 'sms' && r.sms?.body"
                class="mt-1 text-[11.5px] leading-snug text-muted-foreground line-clamp-2"
                v-html="(r.sms.direction === 'outgoing' ? '<span class=&quot;text-emerald-700 font-medium&quot;>You: </span>' : '') + highlight(shortBody(r.sms.body))"
              />
              <p v-else-if="r.last_kind === 'call' && r.call" class="mt-1 text-[11.5px] leading-snug text-muted-foreground">
                {{ r.call.direction === 'outgoing' ? 'Outbound' : 'Inbound' }}
                <template v-if="r.call.was_voicemail">voicemail</template>
                <template v-else-if="r.call.talk_time_sec > 0"> · {{ fmtTalkSec(r.call.talk_time_sec) }} talk</template>
                <template v-else> · no answer</template>
                <span v-if="r.call.user_name"> · {{ r.call.user_name }}</span>
              </p>
            </div>
          </div>
        </button>
      </div>
    </div>

    <ContactCard
      :open="contactCard.open"
      :contact="contactCard.data"
      @close="contactCard.open = false"
      @message="onContactMessage"
      @view-call="onContactViewCall"
    />
    <ComposeDialog
      :open="compose.open"
      :prefill-number="compose.prefillNumber"
      :prefill-name="compose.prefillName"
      @close="compose.open = false"
      @sent="onComposeSent"
    />
    <SmsThreadDialog
      :open="smsThread.open"
      :external-number="smsThread.number"
      :contact-name="smsThread.name"
      @close="smsThread.open = false"
    />
    <CallTimelineDialog
      :open="callTimeline.open"
      :call-id="callTimeline.callId"
      :external-number="callTimeline.number"
      @close="callTimeline.open = false"
    />
  </div>
</template>
