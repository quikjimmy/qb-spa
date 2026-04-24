<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { bucketMeta, formatPhone, fmtTalkSec, splitStartedAt } from '@/lib/callBuckets'
import DtIconInbox from '@dialpad/dialtone-icons/vue3/inbox'
import DtIconPhoneMissed from '@dialpad/dialtone-icons/vue3/phone-missed'
import DtIconVoicemail from '@dialpad/dialtone-icons/vue3/voicemail'
import DtIconMic from '@dialpad/dialtone-icons/vue3/mic'
import DtIconBellRing from '@dialpad/dialtone-icons/vue3/bell-ring'

interface InboxRow {
  call_id: string
  user_email: string
  user_name: string | null
  direction: string
  bucket: string
  external_number: string | null
  started_at: string
  connected_at: string | null
  ended_at: string | null
  talk_time_sec: number
  ring_time_sec: number
  was_voicemail: number
  was_transfer: number
  entry_point_target_kind: string | null
  coordinator: string
  is_read: number
  read_at: string | null
}

interface InboxResponse {
  tab: string
  rows: InboxRow[]
  counts: { unread: number; all: number; missed: number; vms: number; recordings: number }
  days: number
  scope: 'me' | 'all'
  coming_soon?: boolean
  note?: string
}

const auth = useAuthStore()
const tab = ref<'unread' | 'all' | 'missed' | 'vms' | 'recordings'>('unread')
const scope = ref<'me' | 'all'>('me')
const resp = ref<InboxResponse | null>(null)
const loading = ref(false)
// Matched projects per call_id so the inbox row can link to a QB project
// without each row firing its own fetch. We prime the cache for every
// visible row on load.
interface MatchedProject { record_id: number; customer_name: string; status: string; state: string; coordinator: string }
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
      const data = await res.json() as { rows: MatchedProject[] }
      projectMatches.value = { ...projectMatches.value, [number]: data.rows || [] }
    }
  } catch { /* ignore */ }
}

async function markRead(callId: string) {
  await fetch(`/api/dialpad/inbox/${encodeURIComponent(callId)}/read`, { method: 'POST', headers: hdrs() })
  if (resp.value) {
    const row = resp.value.rows.find(r => r.call_id === callId)
    if (row) row.is_read = 1
    if (resp.value.counts.unread > 0) resp.value.counts.unread -= 1
  }
  // Unread tab: remove the row from view since it no longer belongs.
  if (tab.value === 'unread' && resp.value) {
    resp.value.rows = resp.value.rows.filter(r => r.call_id !== callId)
  }
}

async function markUnread(callId: string) {
  await fetch(`/api/dialpad/inbox/${encodeURIComponent(callId)}/read`, { method: 'DELETE', headers: hdrs() })
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
  { id: 'recordings', label: 'Recordings', icon: DtIconMic,        countKey: 'recordings' },
]

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
        <template v-else>No activity</template>
      </p>
      <p class="text-xs text-muted-foreground mt-1">Showing the last {{ resp?.days || 14 }} days · {{ scope === 'all' ? 'team' : 'you' }}</p>
    </div>

    <!-- Inbox list -->
    <div v-else class="rounded-xl border bg-card overflow-hidden divide-y">
      <div v-for="r in visibleRows" :key="r.call_id"
        class="px-3 py-3 flex items-start gap-3 transition-colors"
        :class="r.is_read ? 'bg-card' : 'bg-sky-50/30 dark:bg-sky-950/10'"
      >
        <!-- Icon chip -->
        <div class="shrink-0 size-9 rounded-full flex items-center justify-center" :class="bucketMeta(r.bucket).bgClass">
          <component :is="bucketMeta(r.bucket).icon" class="w-4 h-4" :class="bucketMeta(r.bucket).colorClass" />
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
            <span>{{ bucketMeta(r.bucket).short }}</span>
            <template v-if="r.external_number && projectMatches[r.external_number]?.[0]?.customer_name"> · {{ formatPhone(r.external_number) }}</template>
            <template v-if="r.coordinator && scope === 'all'"> · {{ r.coordinator }}</template>
            <template v-if="r.talk_time_sec > 0"> · {{ fmtTalkSec(r.talk_time_sec) }}</template>
          </p>

          <!-- Matched projects row -->
          <div v-if="r.external_number && projectMatches[r.external_number]?.length" class="flex flex-wrap gap-1 pt-0.5">
            <button v-for="p in projectMatches[r.external_number]" :key="p.record_id"
              class="inline-flex items-center gap-1 rounded-md bg-muted/60 hover:bg-muted text-[10px] px-1.5 py-0.5 transition-colors"
              @click="openProject(p.record_id)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17l10-10"/><path d="M7 7h10v10"/></svg>
              <span class="truncate max-w-[120px]">{{ p.customer_name }}</span>
              <span v-if="p.status" class="text-[9px] text-muted-foreground">· {{ p.status }}</span>
            </button>
          </div>

          <!-- Action buttons -->
          <div class="flex items-center gap-1.5 pt-0.5">
            <button v-if="r.external_number"
              class="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium hover:bg-muted transition-colors"
              @click="callBack(r.external_number)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
              Call back
            </button>
            <button v-if="!r.is_read"
              class="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium hover:bg-muted transition-colors"
              @click="markRead(r.call_id)"
            >
              Mark read
            </button>
            <button v-else
              class="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              @click="markUnread(r.call_id)"
            >
              Mark unread
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
