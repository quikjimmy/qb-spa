<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { bucketMeta, formatPhone, splitStartedAt } from '@/lib/callBuckets'
import DtIconPhone from '@dialpad/dialtone-icons/vue3/phone'
import DtIconBellRing from '@dialpad/dialtone-icons/vue3/bell-ring'
import DtIconMessage from '@dialpad/dialtone-icons/vue3/message'

// Live activity panel — subscribes to the Dialpad event stream via SSE and
// renders the last ~25 events as cards. Auto-reconnects on disconnect with
// backoff + backfills missed events via /events/recent?since_id=last.

interface LiveEvent {
  id: number
  event_kind: string   // 'call' | 'sms' | 'generic'
  event_state: string | null   // for calls: 'ringing' | 'connected' | 'hangup'
  call_id: string | null
  user_email: string | null
  user_name: string | null
  external_number: string | null
  direction: string | null
  raw_json: string
  received_at: string
}

const auth = useAuthStore()
const events = ref<LiveEvent[]>([])
// Aggregate events per call_id so a single call's lifecycle (preanswer →
// ringing → connected → hangup) collapses into one card that updates its
// state. Events missing a call_id are kept as-is (SMS, generic).
const stateHistory = ref<Record<string, string[]>>({})
const connected = ref(false)
const lastId = ref(0)
const expanded = ref<Record<number, boolean>>({})
let es: EventSource | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempt = 0

const MAX_EVENTS = 25

function ingest(ev: LiveEvent, prepend = true) {
  // Track the state sequence for this call so we can display "ringing → connected → hangup".
  if (ev.call_id) {
    const seq = stateHistory.value[ev.call_id] || []
    if (ev.event_state && (!seq.length || seq[seq.length - 1] !== ev.event_state)) {
      stateHistory.value = { ...stateHistory.value, [ev.call_id]: [...seq, ev.event_state] }
    }
  }

  // For events with a call_id, collapse into the existing card (update in place).
  if (ev.call_id) {
    const idx = events.value.findIndex(e => e.call_id === ev.call_id)
    if (idx >= 0) {
      const next = [...events.value]
      next[idx] = ev
      // Move to top so the most recently updated call sits first.
      const [moved] = next.splice(idx, 1)
      events.value = [moved!, ...next].slice(0, MAX_EVENTS)
      if (ev.id > lastId.value) lastId.value = ev.id
      return
    }
  }

  if (prepend) {
    events.value = [ev, ...events.value].slice(0, MAX_EVENTS)
  } else {
    events.value = [...events.value, ev].slice(0, MAX_EVENTS)
  }
  if (ev.id > lastId.value) lastId.value = ev.id
}

async function backfill() {
  try {
    const res = await fetch(`/api/dialpad/events/recent?limit=${MAX_EVENTS}&since_id=${lastId.value}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    if (!res.ok) return
    const data = await res.json() as { rows: LiveEvent[] }
    // Server returns DESC (newest first); ingest in that order.
    for (const row of data.rows) ingest(row, false)
  } catch { /* ignore */ }
}

function connect() {
  if (es) { es.close(); es = null }
  if (!auth.token) return
  // EventSource can't set headers, so auth goes via ?token= (server accepts both).
  const url = `/api/dialpad/events/stream?token=${encodeURIComponent(auth.token)}${lastId.value ? `&since_id=${lastId.value}` : ''}`
  es = new EventSource(url)
  es.onopen = () => {
    connected.value = true
    reconnectAttempt = 0
  }
  es.addEventListener('dialpad', (e) => {
    try {
      const ev = JSON.parse((e as MessageEvent).data) as LiveEvent
      ingest(ev)
    } catch { /* ignore malformed */ }
  })
  es.onerror = () => {
    connected.value = false
    if (es) { es.close(); es = null }
    // Exponential-ish backoff capped at 30s.
    const delay = Math.min(1000 * 2 ** reconnectAttempt, 30_000)
    reconnectAttempt += 1
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(() => {
      backfill().then(connect)
    }, delay)
  }
}

onMounted(async () => {
  await backfill()
  connect()
})

onBeforeUnmount(() => {
  connected.value = false
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (es) { es.close(); es = null }
})

// Map live event → { icon, label, colorClass, bgClass } for display
interface EventVisual { icon: unknown; label: string; colorClass: string; bgClass: string; sublabel: string }
function visualFor(e: LiveEvent): EventVisual {
  // Calls — map by direction + state
  if (e.event_kind === 'call') {
    const state = (e.event_state || '').toLowerCase()
    const dir = (e.direction || '').toLowerCase()
    if (state === 'ringing') return { ...bucketMeta('in_callback_requested'), icon: DtIconBellRing, label: 'Ringing', sublabel: dir || 'call' }
    if (state === 'connected') return dir === 'outbound'
      ? { ...bucketMeta('out_connected'), sublabel: 'Connected' }
      : { ...bucketMeta('in_answered'), sublabel: 'Connected' }
    if (state === 'hangup' || state === 'ended') {
      if (dir === 'outbound') return { ...bucketMeta('out_connected'), sublabel: 'Ended' }
      return { ...bucketMeta('in_answered'), sublabel: 'Ended' }
    }
    if (state === 'missed') return { ...bucketMeta('in_missed'), sublabel: 'Missed' }
    if (state === 'voicemail') return { ...bucketMeta('in_voicemail'), sublabel: 'Voicemail' }
    if (state === 'transferred') return { ...bucketMeta('in_transfer_unanswered'), sublabel: 'Transferred' }
    return { ...bucketMeta('other'), icon: DtIconPhone, sublabel: state || dir || 'call' }
  }
  if (e.event_kind === 'sms') {
    const dir = e.direction === 'outgoing' ? 'out' : 'in'
    return {
      icon: DtIconMessage,
      label: 'SMS',
      colorClass: dir === 'in' ? 'text-sky-600' : 'text-emerald-600',
      bgClass: dir === 'in' ? 'bg-sky-100' : 'bg-emerald-100',
      sublabel: dir === 'in' ? 'Received' : 'Sent',
    }
  }
  return { ...bucketMeta('other'), icon: DtIconPhone, sublabel: e.event_kind }
}

function formatRaw(raw: string): string {
  try { return JSON.stringify(JSON.parse(raw), null, 2) } catch { return raw }
}

const connectionLabel = computed(() => connected.value ? 'Live' : reconnectAttempt > 0 ? 'Reconnecting…' : 'Offline')
const connectionDot = computed(() => connected.value ? 'bg-emerald-500' : reconnectAttempt > 0 ? 'bg-amber-500' : 'bg-slate-400')
</script>

<template>
  <div class="rounded-xl border bg-card overflow-hidden">
    <div class="px-3 sm:px-4 py-2.5 border-b flex items-center justify-between gap-2">
      <div class="flex items-center gap-2 min-w-0">
        <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Live Activity</p>
        <span class="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0">
          <span class="size-1.5 rounded-full" :class="connectionDot" />
          <span>{{ connectionLabel }}</span>
        </span>
      </div>
      <p v-if="events.length > 0" class="text-[10px] text-muted-foreground">{{ events.length }} shown</p>
    </div>

    <div v-if="events.length === 0" class="px-4 py-8 text-center text-[11px] text-muted-foreground">
      <template v-if="connected">Listening for events…</template>
      <template v-else-if="reconnectAttempt > 0">Reconnecting to event stream…</template>
      <template v-else>No recent events.</template>
    </div>

    <div v-else class="divide-y max-h-[360px] overflow-y-auto">
      <div v-for="e in events" :key="e.call_id || `evt-${e.id}`" class="px-3 sm:px-4 py-2">
        <div class="flex items-center gap-2.5 sm:gap-3 cursor-pointer" @click="expanded[e.id] = !expanded[e.id]">
          <div class="shrink-0 size-8 rounded-full flex items-center justify-center" :class="visualFor(e).bgClass">
            <component :is="visualFor(e).icon" class="w-4 h-4" :class="visualFor(e).colorClass" />
          </div>
          <div class="flex-1 min-w-0">
            <p class="font-mono text-[12px] truncate">{{ formatPhone(e.external_number) || e.user_name || e.user_email || 'Event' }}</p>
            <p class="text-[10px] text-muted-foreground truncate flex items-center gap-1">
              <!-- Full state progression for this call: ringing → connected → hangup -->
              <template v-if="e.call_id && stateHistory[e.call_id]">
                <span v-for="(s, i) in stateHistory[e.call_id]" :key="i" class="inline-flex items-center gap-1">
                  <span v-if="i > 0" class="text-muted-foreground/60">→</span>
                  <span :class="i === (stateHistory[e.call_id]!.length - 1) ? 'font-medium text-foreground' : ''">{{ s }}</span>
                </span>
              </template>
              <template v-else>{{ visualFor(e).sublabel }}</template>
              <template v-if="e.user_name || e.user_email"> · {{ e.user_name || e.user_email }}</template>
            </p>
          </div>
          <div class="shrink-0 text-right">
            <p class="text-[11px] tabular-nums">{{ splitStartedAt(e.received_at).time }}</p>
            <p class="text-[10px] text-muted-foreground">{{ splitStartedAt(e.received_at).date }}</p>
          </div>
        </div>
        <!-- Tap the row to reveal the raw Dialpad payload — helpful for debugging classification -->
        <pre v-if="expanded[e.id]" class="mt-2 text-[9px] leading-snug bg-muted/40 rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-all">{{ formatRaw(e.raw_json) }}</pre>
      </div>
    </div>
  </div>
</template>
