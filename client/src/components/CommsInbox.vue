<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { bucketMeta, formatPhone, fmtTalkSec, splitStartedAt } from '@/lib/callBuckets'
import DtIconInbox from '@dialpad/dialtone-icons/vue3/inbox'
import DtIconPhoneMissed from '@dialpad/dialtone-icons/vue3/phone-missed'
import DtIconVoicemail from '@dialpad/dialtone-icons/vue3/voicemail'
import DtIconMic from '@dialpad/dialtone-icons/vue3/mic'
import DtIconBellRing from '@dialpad/dialtone-icons/vue3/bell-ring'
import DtIconMessage from '@dialpad/dialtone-icons/vue3/message'
import SmsThreadDialog from '@/components/SmsThreadDialog.vue'
import CallTimelineDialog from '@/components/CallTimelineDialog.vue'

interface InboxRow {
  item_kind: 'call' | 'sms'
  item_id: string
  call_id: string | null
  user_email: string
  user_name: string | null
  direction: string
  bucket: string
  external_number: string | null
  started_at: string
  connected_at?: string | null
  ended_at?: string | null
  talk_time_sec: number
  ring_time_sec: number
  was_voicemail: number
  was_recorded: number
  was_transfer: number
  entry_point_target_kind?: string | null
  message_body?: string | null
  coordinator: string
  is_read: number
  read_at: string | null
}

interface InboxResponse {
  tab: string
  rows: InboxRow[]
  counts: { unread: number; all: number; missed: number; vms: number; recordings: number; texts: number }
  days: number
  scope: 'me' | 'all'
  coming_soon?: boolean
  note?: string
}

const auth = useAuthStore()
const tab = ref<'unread' | 'all' | 'missed' | 'vms' | 'recordings' | 'texts'>('unread')
const scope = ref<'me' | 'all'>('me')
const resp = ref<InboxResponse | null>(null)
const loading = ref(false)
// Matched projects per call_id so the inbox row can link to a QB project
// without each row firing its own fetch. We prime the cache for every
// visible row on load.
interface MatchedProject { record_id: number; customer_name: string; status: string; state: string; coordinator: string; probable?: boolean }
const projectMatches = ref<Record<string, MatchedProject[]>>({})

function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

async function load() {
  loading.value = true
  const p = new URLSearchParams()
  p.set('tab', tab.value)
  if (scope.value === 'all' && auth.isAdmin) p.set('scope', 'all')
  try {
    const res = await fetch(`/api/dialpad/inbox?${p}`, { headers: hdrs() })
    if (res.ok) resp.value = await res.json() as InboxResponse
    // Prime phone → project cache for each unique external number
    const numbers = new Set((resp.value?.rows || []).map(r => r.external_number || '').filter(Boolean))
    for (const n of numbers) primeMatch(n)
  } finally { loading.value = false }
}

async function primeMatch(number: string) {
  if (projectMatches.value[number] !== undefined) return
  projectMatches.value = { ...projectMatches.value, [number]: [] }  // reserve
  try {
    const res = await fetch(`/api/projects/by-phone?number=${encodeURIComponent(number)}&limit=3`, { headers: hdrs() })
    if (res.ok) {
      const data = await res.json() as { rows: MatchedProject[]; match_quality: string }
      // The `probable` flag is set server-side on each row when the match
      // came from the 7-digit fallback; UI renders these with a tentative
      // chip style so the user knows to verify.
      projectMatches.value = { ...projectMatches.value, [number]: data.rows || [] }
    }
  } catch { /* ignore */ }
}

async function markRead(r: InboxRow) {
  const qs = r.item_kind === 'sms' ? '?kind=sms' : ''
  await fetch(`/api/dialpad/inbox/${encodeURIComponent(r.item_id)}/read${qs}`, { method: 'POST', headers: hdrs() })
  if (resp.value) {
    const row = resp.value.rows.find(x => x.item_id === r.item_id && x.item_kind === r.item_kind)
    if (row) row.is_read = 1
    if (resp.value.counts.unread > 0) resp.value.counts.unread -= 1
  }
  if (tab.value === 'unread' && resp.value) {
    resp.value.rows = resp.value.rows.filter(x => !(x.item_id === r.item_id && x.item_kind === r.item_kind))
  }
}

async function markUnread(r: InboxRow) {
  const qs = r.item_kind === 'sms' ? '?kind=sms' : ''
  await fetch(`/api/dialpad/inbox/${encodeURIComponent(r.item_id)}/read${qs}`, { method: 'DELETE', headers: hdrs() })
  await load()
}

async function markAllRead() {
  if (!confirm('Mark all call records in the last 14 days as read?')) return
  await fetch('/api/dialpad/inbox/read-all', { method: 'POST', headers: hdrs() })
  await load()
}

function openProject(rid: number) {
  window.open(`https://kin.quickbase.com/nav/app/br9kwm8bk/table/br9kwm8na/action/dr?rid=${rid}`, '_blank')
}

// "Call back" via tel: link — works from mobile and from most desktop OSes
// (Dialpad's click-to-call handler intercepts these when the app is installed).
function callBack(number: string | null) {
  if (!number) return
  window.location.href = `tel:${number}`
}

// Thread/timeline dialogs — clicking an inbox row opens the appropriate
// modal. Only one is open at a time, parameterized by the row clicked.
const smsThread = ref<{ open: boolean; number: string; name: string }>({ open: false, number: '', name: '' })
const callTimeline = ref<{ open: boolean; callId: string; number: string }>({ open: false, callId: '', number: '' })
function openItem(r: InboxRow) {
  if (r.item_kind === 'sms' && r.external_number) {
    const matched = projectMatches.value[r.external_number]?.[0]?.customer_name || ''
    smsThread.value = { open: true, number: r.external_number, name: matched }
  } else if (r.item_kind === 'call' && r.call_id) {
    callTimeline.value = { open: true, callId: r.call_id, number: r.external_number || '' }
  }
}

// Audio expansion state — lazily show the <audio> element only after the
// user clicks "Listen" so we don't trigger a Dialpad fetch for every row.
const audioOpen = ref<Record<string, boolean>>({})
function toggleAudio(callId: string) {
  audioOpen.value = { ...audioOpen.value, [callId]: !audioOpen.value[callId] }
}
function audioSrc(callId: string): string {
  // token query param works because our authenticate middleware reads
  // ?token= when the Authorization header is absent (audio elements can't
  // set headers).
  return `/api/dialpad/call/${encodeURIComponent(callId)}/audio?token=${encodeURIComponent(auth.token || '')}`
}

// Time-ago in compact form — 2m / 3h / 4d
function ago(iso: string): string {
  const d = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z')).getTime()
  if (!Number.isFinite(d)) return ''
  const mins = Math.max(0, Math.floor((Date.now() - d) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

interface TabDef { id: typeof tab.value; label: string; icon: unknown; countKey: keyof InboxResponse['counts'] }
const tabs: TabDef[] = [
  { id: 'unread',     label: 'Unread',     icon: DtIconBellRing,   countKey: 'unread' },
  { id: 'all',        label: 'All',        icon: DtIconInbox,      countKey: 'all' },
  { id: 'missed',     label: 'Missed',     icon: DtIconPhoneMissed, countKey: 'missed' },
  { id: 'vms',        label: 'VMs',        icon: DtIconVoicemail,  countKey: 'vms' },
  { id: 'texts',      label: 'Texts',      icon: DtIconMessage,    countKey: 'texts' },
  { id: 'recordings', label: 'Recordings', icon: DtIconMic,        countKey: 'recordings' },
]

// SMS bucket metadata — matches calls' bucketMeta shape so the row template
// stays uniform. (bucketMeta's catch-all falls to 'other' which renders a
// generic phone icon — not ideal for texts.)
const SMS_META = {
  sms_incoming: { label: 'Text received', short: 'Text in',  icon: DtIconMessage, colorClass: 'text-sky-600',     bgClass: 'bg-sky-100' },
  sms_outgoing: { label: 'Text sent',     short: 'Text out', icon: DtIconMessage, colorClass: 'text-emerald-600', bgClass: 'bg-emerald-100' },
} as const

function metaFor(r: InboxRow) {
  if (r.item_kind === 'sms') {
    return r.bucket === 'sms_outgoing' ? SMS_META.sms_outgoing : SMS_META.sms_incoming
  }
  return bucketMeta(r.bucket)
}

const visibleRows = computed(() => resp.value?.rows || [])

onMounted(load)
watch([tab, scope], load)
</script>

<template>
  <div class="grid gap-3 min-w-0">
    <!-- Sub-tabs row — scrolls horizontally only for its own strip (allowed
         per the no-h-scroll rule: this is the approved tab/filter strip). -->
    <div class="flex gap-1 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1">
      <button v-for="t in tabs" :key="t.id"
        class="flex-none inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all active:scale-[0.97] whitespace-nowrap"
        :class="tab === t.id ? 'bg-primary text-primary-foreground shadow-sm' : 'bg-muted/40 hover:bg-muted text-muted-foreground'"
        @click="tab = t.id"
      >
        <component :is="t.icon" class="w-3.5 h-3.5" />
        <span>{{ t.label }}</span>
        <span v-if="resp && (resp.counts[t.countKey] || 0) > 0" class="tabular-nums text-[10px] rounded-full px-1.5" :class="tab === t.id ? 'bg-primary-foreground/20' : 'bg-card'">
          {{ resp.counts[t.countKey] }}
        </span>
      </button>
    </div>

    <!-- Top actions -->
    <div class="flex items-center gap-2 flex-wrap">
      <button v-if="auth.isAdmin" class="text-[10px] rounded border px-2 py-0.5 transition-colors" :class="scope === 'me' ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'" @click="scope = 'me'">Me</button>
      <button v-if="auth.isAdmin" class="text-[10px] rounded border px-2 py-0.5 transition-colors" :class="scope === 'all' ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'" @click="scope = 'all'">All</button>
      <span v-if="resp?.days" class="text-[10px] text-muted-foreground">Last {{ resp.days }} days</span>
      <button v-if="tab === 'unread' && (resp?.counts.unread || 0) > 0" class="ml-auto text-[11px] text-primary hover:underline" @click="markAllRead">
        Mark all read
      </button>
    </div>

    <!-- Recordings placeholder -->
    <div v-if="tab === 'recordings' && resp?.coming_soon" class="rounded-xl border bg-card p-10 text-center">
      <div class="inline-flex items-center justify-center size-12 rounded-full bg-muted/60 mb-3">
        <component :is="DtIconMic" class="w-6 h-6 text-muted-foreground" />
      </div>
      <p class="font-medium text-sm">Recordings coming soon</p>
      <p class="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">{{ resp.note }}</p>
    </div>

    <!-- Loading -->
    <div v-else-if="loading && !resp" class="rounded-xl border bg-card p-10 text-center text-sm text-muted-foreground">Loading inbox…</div>

    <!-- Empty -->
    <div v-else-if="visibleRows.length === 0" class="rounded-xl border bg-card p-10 text-center">
      <div class="inline-flex items-center justify-center size-12 rounded-full bg-muted/60 mb-3">
        <component :is="tabs.find(t => t.id === tab)?.icon" class="w-6 h-6 text-muted-foreground" />
      </div>
      <p class="text-sm font-medium">
        <template v-if="tab === 'unread'">Inbox zero</template>
        <template v-else-if="tab === 'missed'">No missed calls</template>
        <template v-else-if="tab === 'vms'">No voicemails</template>
        <template v-else-if="tab === 'texts'">No texts received</template>
        <template v-else-if="tab === 'recordings'">No recorded calls</template>
        <template v-else>No activity</template>
      </p>
      <p class="text-xs text-muted-foreground mt-1">Showing the last {{ resp?.days || 14 }} days · {{ scope === 'all' ? 'team' : 'you' }}</p>
    </div>

    <!-- Inbox list -->
    <div v-else class="rounded-xl border bg-card overflow-hidden divide-y">
      <div v-for="r in visibleRows" :key="`${r.item_kind}-${r.item_id}`"
        class="px-3 py-3 flex items-start gap-3 transition-colors"
        :class="r.is_read ? 'bg-card' : 'bg-sky-50/30 dark:bg-sky-950/10'"
      >
        <!-- Icon chip — SMS rows use the message icon + sky/emerald palette -->
        <div class="shrink-0 size-9 rounded-full flex items-center justify-center" :class="metaFor(r).bgClass">
          <component :is="metaFor(r).icon" class="w-4 h-4" :class="metaFor(r).colorClass" />
        </div>

        <!-- Main content -->
        <div class="flex-1 min-w-0 space-y-1">
          <div class="flex items-center gap-2 flex-wrap">
            <!-- Unread dot -->
            <span v-if="!r.is_read" class="size-1.5 rounded-full bg-sky-500 shrink-0" title="Unread" />
            <!-- Caller — matched customer name or phone -->
            <p class="font-semibold text-[13px] truncate">
              <template v-if="r.external_number && projectMatches[r.external_number]?.[0]?.customer_name">
                {{ projectMatches[r.external_number]![0]!.customer_name }}
              </template>
              <template v-else>{{ formatPhone(r.external_number) || 'Unknown' }}</template>
            </p>
            <span class="text-[10px] text-muted-foreground tabular-nums shrink-0 ml-auto">{{ ago(r.started_at) }}</span>
          </div>
          <p class="text-[11px] text-muted-foreground truncate">
            <span>{{ metaFor(r).short }}</span>
            <template v-if="r.external_number && projectMatches[r.external_number]?.[0]?.customer_name"> · {{ formatPhone(r.external_number) }}</template>
            <template v-if="r.coordinator && scope === 'all'"> · {{ r.coordinator }}</template>
            <template v-if="r.talk_time_sec > 0"> · {{ fmtTalkSec(r.talk_time_sec) }}</template>
          </p>

          <!-- SMS body — up to ~2 lines before truncation. Preserves newlines
               so multi-line texts stay readable. -->
          <p v-if="r.item_kind === 'sms' && r.message_body" class="text-[12px] leading-snug line-clamp-2 whitespace-pre-wrap pt-0.5">
            {{ r.message_body }}
          </p>

          <!-- Matched projects row. Probable matches (last-7-digit fallback)
               render with a yellow tint + "?" so the user treats them as
               tentative and doesn't blindly click into the wrong project. -->
          <div v-if="r.external_number && projectMatches[r.external_number]?.length" class="flex flex-wrap gap-1 pt-0.5">
            <button v-for="p in projectMatches[r.external_number]" :key="p.record_id"
              class="inline-flex items-center gap-1 rounded-md text-[10px] px-1.5 py-0.5 transition-colors"
              :class="p.probable ? 'bg-amber-100 hover:bg-amber-200 text-amber-900' : 'bg-muted/60 hover:bg-muted'"
              :title="p.probable ? 'Probable match — caller\'s last 7 digits match, but country/area code differs' : 'Strict phone match'"
              @click="openProject(p.record_id)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17l10-10"/><path d="M7 7h10v10"/></svg>
              <span v-if="p.probable" class="font-bold">?</span>
              <span class="truncate max-w-[120px]">{{ p.customer_name }}</span>
              <span v-if="p.status" class="text-[9px] opacity-70">· {{ p.status }}</span>
            </button>
          </div>

          <!-- Action buttons -->
          <div class="flex items-center gap-1.5 pt-0.5 flex-wrap">
            <!-- Primary CTA per kind: SMS → open thread; call → open
                 timeline. Sits first so it's visually most prominent. -->
            <button v-if="r.item_kind === 'sms' && r.external_number"
              class="inline-flex items-center gap-1 rounded-md bg-primary text-primary-foreground px-2 py-0.5 text-[10px] font-medium hover:bg-primary/90 transition-colors"
              @click="openItem(r)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              Thread
            </button>
            <button v-else-if="r.item_kind === 'call' && r.call_id"
              class="inline-flex items-center gap-1 rounded-md bg-primary text-primary-foreground px-2 py-0.5 text-[10px] font-medium hover:bg-primary/90 transition-colors"
              @click="openItem(r)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>
              Timeline
            </button>
            <button v-if="r.external_number"
              class="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium hover:bg-muted transition-colors"
              @click="callBack(r.external_number)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
              Call back
            </button>
            <!-- Listen: shown for voicemails and recorded calls. Clicking
                 mounts an <audio> element inline below which lazily fetches
                 audio from /api/dialpad/call/:id/audio via our proxy. -->
            <button v-if="r.was_voicemail || r.was_recorded"
              class="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium transition-colors"
              :class="audioOpen[r.call_id] ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'"
              @click="toggleAudio(r.call_id)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
              {{ audioOpen[r.call_id] ? 'Hide' : (r.was_voicemail ? 'Listen VM' : 'Recording') }}
            </button>
            <button v-if="!r.is_read"
              class="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium hover:bg-muted transition-colors"
              @click="markRead(r)"
            >
              Mark read
            </button>
            <button v-else
              class="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              @click="markUnread(r)"
            >
              Mark unread
            </button>
          </div>

          <!-- Inline audio player. Rendered only after the user opens it
               (preload="none" is belt-and-suspenders since we only even
               set src after the click). -->
          <div v-if="r.call_id && audioOpen[r.call_id]" class="pt-1.5">
            <audio
              :src="audioSrc(r.call_id)"
              controls
              preload="none"
              class="w-full h-8"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- Modals — one of each, parameterized by the row clicked -->
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
