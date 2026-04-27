<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { bucketMeta, formatPhone, splitStartedAt } from '@/lib/callBuckets'
import { useDialpadLive, type LiveEvent } from '@/lib/dialpadLive'
import { usePhoneMatches } from '@/composables/usePhoneMatches'
import SmsThreadDialog from '@/components/SmsThreadDialog.vue'
import CallTimelineDialog from '@/components/CallTimelineDialog.vue'
import DtIconPhone from '@dialpad/dialtone-icons/vue3/phone'
import DtIconBellRing from '@dialpad/dialtone-icons/vue3/bell-ring'
import DtIconMessage from '@dialpad/dialtone-icons/vue3/message'

// Live activity panel — presentation-only. All SSE + sound + filter state
// lives in the shared useDialpadLive composable so this panel and the
// GlobalIncomingCallAlert share one event stream.
const {
  visibleEvents,
  stateHistory,
  connected,
  reconnectAttempt,
  scope,
  setScope,
  soundEnabled,
  toggleSound,
} = useDialpadLive()

// Phone → customer name lookup. Batched in one HTTP call across all
// visible events; results cached across the inbox + live panel.
const { matches: phoneMatches, primeMany } = usePhoneMatches()
watch(visibleEvents, (events) => {
  primeMany(events.map(e => e.external_number))
}, { immediate: true, deep: false })

// Eager computed map from raw external_number → customer_name. Renders
// pull from this rather than calling a function per row, so reactivity
// tracks via the computed's dependency on the phoneMatches ref.
const nameByNumber = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {}
  for (const [num, list] of Object.entries(phoneMatches.value)) {
    const name = list?.[0]?.customer_name
    if (name) out[num] = name
  }
  return out
})
function customerName(e: LiveEvent): string {
  return e.external_number ? (nameByNumber.value[e.external_number] || '') : ''
}

const expanded = ref<Record<number, boolean>>({})

// Dialog state — clicking a row opens either the SMS thread or call timeline.
// Keeping these inline rather than per-row: only one is open at a time.
const smsThread = ref<{ open: boolean; number: string; name: string }>({ open: false, number: '', name: '' })
const callTimeline = ref<{ open: boolean; callId: string; number: string }>({ open: false, callId: '', number: '' })

function openEvent(e: LiveEvent) {
  if (e.event_kind === 'sms' && e.external_number) {
    smsThread.value = { open: true, number: e.external_number, name: customerName(e) }
  } else if (e.event_kind === 'call' && e.call_id) {
    callTimeline.value = { open: true, callId: e.call_id, number: e.external_number || '' }
  }
}

// Pull message body out of the raw_json blob for SMS rows so we can render
// the actual text inline instead of a `[no body]` block of JSON. Walks
// the common Dialpad payload shapes (text/message/body/content + nested
// data/sms wrappers) since the schema varies by event type.
function smsBody(e: LiveEvent): string {
  try {
    const p = JSON.parse(e.raw_json || '{}') as Record<string, unknown>
    return findBody(p)
  } catch { return '' }
}
function findBody(payload: Record<string, unknown>): string {
  const direct = payload['text'] || payload['message'] || payload['body'] || payload['message_body'] || payload['content']
  if (typeof direct === 'string' && direct.trim()) return direct
  for (const key of ['data', 'sms', 'message_object', 'event']) {
    const nested = payload[key]
    if (nested && typeof nested === 'object') {
      const inner = findBody(nested as Record<string, unknown>)
      if (inner) return inner
    }
  }
  return ''
}

interface EventVisual { icon: unknown; label: string; colorClass: string; bgClass: string; sublabel: string }
function visualFor(e: LiveEvent): EventVisual {
  if (e.event_kind === 'call') {
    const state = (e.event_state || '').toLowerCase()
    const dir = (e.direction || '').toLowerCase()
    if (state === 'ringing' || state === 'preanswer') return { ...bucketMeta('in_callback_requested'), icon: DtIconBellRing, label: 'Ringing', sublabel: state }
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
</script>

<template>
  <div class="rounded-xl border bg-card overflow-hidden">
    <div class="px-3 sm:px-4 py-2.5 border-b flex items-center justify-between gap-2 flex-wrap">
      <div class="flex items-center gap-2 min-w-0">
        <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Live Activity</p>
        <span class="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0">
          <span class="size-1.5 rounded-full" :class="connected ? 'bg-emerald-500' : reconnectAttempt > 0 ? 'bg-amber-500' : 'bg-slate-400'" />
          <span>{{ connected ? 'Live' : reconnectAttempt > 0 ? 'Reconnecting…' : 'Offline' }}</span>
        </span>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <div class="flex rounded-md border overflow-hidden">
          <button class="px-2 h-6 text-[10px] font-medium transition-colors" :class="scope === 'me' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'" @click="setScope('me')">Me</button>
          <button class="px-2 h-6 text-[10px] font-medium transition-colors" :class="scope === 'all' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'" @click="setScope('all')">All</button>
        </div>
        <button
          class="inline-flex items-center justify-center size-6 rounded-md border transition-colors"
          :class="soundEnabled ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'"
          :title="soundEnabled ? 'Sound on — click to mute' : 'Sound off — click to enable'"
          @click="toggleSound"
        >
          <svg v-if="soundEnabled" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
          <svg v-else xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
        </button>
        <p v-if="visibleEvents.length > 0" class="text-[10px] text-muted-foreground tabular-nums">{{ visibleEvents.length }}</p>
      </div>
    </div>

    <div v-if="visibleEvents.length === 0" class="px-4 py-8 text-center text-[11px] text-muted-foreground">
      <template v-if="connected && scope === 'me'">No events for you yet — try changing filter to All to see team activity.</template>
      <template v-else-if="connected">Listening for events…</template>
      <template v-else-if="reconnectAttempt > 0">Reconnecting to event stream…</template>
      <template v-else>No recent events.</template>
    </div>

    <div v-else class="divide-y max-h-[360px] overflow-y-auto">
      <div v-for="e in visibleEvents" :key="e.call_id || `evt-${e.id}`" class="px-3 sm:px-4 py-2">
        <div class="flex items-center gap-2.5 sm:gap-3 cursor-pointer" @click="expanded[e.id] = !expanded[e.id]">
          <div class="shrink-0 size-8 rounded-full flex items-center justify-center" :class="visualFor(e).bgClass">
            <component :is="visualFor(e).icon" class="w-4 h-4" :class="visualFor(e).colorClass" />
          </div>
          <div class="flex-1 min-w-0">
            <!-- Caller line: matched customer name when we have one; otherwise
                 the formatted phone. The phone gets a secondary line below
                 the name so it stays visible for callbacks. -->
            <p v-if="customerName(e)" class="font-semibold text-[12px] truncate">{{ customerName(e) }}</p>
            <p v-else class="font-mono text-[12px] truncate">{{ formatPhone(e.external_number) || e.user_name || e.user_email || 'Event' }}</p>
            <!-- For SMS rows, show the actual message body as the secondary
                 line when the row is collapsed. Calls keep the state arc. -->
            <p v-if="e.event_kind === 'sms' && smsBody(e)" class="text-[11px] truncate" :class="e.direction === 'outgoing' ? 'text-emerald-700' : 'text-foreground'">
              <span v-if="e.direction === 'outgoing'" class="text-muted-foreground">You: </span>{{ smsBody(e) }}
            </p>
            <p v-else class="text-[10px] text-muted-foreground truncate flex items-center gap-1">
              <template v-if="customerName(e) && e.external_number"><span class="font-mono">{{ formatPhone(e.external_number) }}</span> · </template>
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

        <!-- Expanded view — replaces the old <pre>raw json</pre> with a
             type-specific summary + a single CTA that opens the right
             modal (SMS thread or Call timeline). Raw JSON is one click
             away in case we still need it for debugging. -->
        <div v-if="expanded[e.id]" class="mt-2 rounded-md bg-muted/30 px-3 py-2 space-y-2 text-[11px]">
          <!-- SMS expansion: bubble preview + Open thread CTA. We only
               render a bubble when there's actual text — Dialpad sends
               empty-body events for delivery confirmations and other
               status pings, and rendering them as fake messages was
               misleading. Empty events still show the row metadata above
               and the Open thread button below. -->
          <template v-if="e.event_kind === 'sms'">
            <div v-if="smsBody(e)" class="flex" :class="e.direction === 'outgoing' ? 'justify-end' : 'justify-start'">
              <div class="max-w-[85%] px-3 py-1.5 rounded-2xl text-[12px] leading-snug whitespace-pre-wrap break-words"
                :class="e.direction === 'outgoing' ? 'bg-sky-500 text-white rounded-br-sm' : 'bg-card text-foreground rounded-bl-sm border'">
                {{ smsBody(e) }}
              </div>
            </div>
            <p v-else class="text-[10px] text-muted-foreground italic px-1">
              Status update — open the thread to see the full conversation.
            </p>
            <div class="flex flex-wrap items-center gap-1.5 pt-1">
              <button v-if="e.external_number"
                class="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-0.5 text-[10px] font-medium hover:bg-muted transition-colors"
                @click.stop="openEvent(e)"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                Open thread
              </button>
              <span class="text-[10px] text-muted-foreground">{{ e.user_name || e.user_email }} · {{ formatPhone(e.external_number) }}</span>
            </div>
          </template>

          <!-- Call expansion: state path + Open timeline CTA -->
          <template v-else-if="e.event_kind === 'call'">
            <div class="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
              <template v-for="(s, i) in (e.call_id && stateHistory[e.call_id] ? stateHistory[e.call_id]! : [e.event_state || 'unknown'])" :key="i">
                <span v-if="i > 0" class="opacity-60">→</span>
                <span class="px-1.5 py-0.5 rounded-full bg-card border text-foreground" :class="i === (stateHistory[e.call_id || '']!.length - 1) ? 'font-semibold' : ''">{{ s }}</span>
              </template>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-[10px] text-muted-foreground">{{ formatPhone(e.external_number) || 'Unknown' }}<template v-if="e.user_name"> · {{ e.user_name }}</template></span>
              <button v-if="e.call_id"
                class="ml-auto inline-flex items-center gap-1 rounded-md border bg-card px-2 py-0.5 text-[10px] font-medium hover:bg-muted transition-colors"
                @click.stop="openEvent(e)"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>
                Open timeline
              </button>
            </div>
          </template>

          <!-- Generic / unknown event: still keep a raw JSON peek for debug. -->
          <pre v-else class="text-[9px] leading-snug bg-card border rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-all">{{ formatRaw(e.raw_json) }}</pre>
        </div>
      </div>
    </div>

    <!-- Mounted dialogs — one of each, parameterized by event clicked. -->
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
