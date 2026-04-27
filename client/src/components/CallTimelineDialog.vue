<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { formatPhone, fmtTalkSec } from '@/lib/callBuckets'
import { usePhoneMatches } from '@/composables/usePhoneMatches'
import DtIconPhoneIncoming from '@dialpad/dialtone-icons/vue3/phone-incoming'
import DtIconPhoneOutgoing from '@dialpad/dialtone-icons/vue3/phone-outgoing'
import DtIconBellRing from '@dialpad/dialtone-icons/vue3/bell-ring'
import DtIconPhoneCall from '@dialpad/dialtone-icons/vue3/phone-call'
import DtIconPhoneHangUp from '@dialpad/dialtone-icons/vue3/phone-hang-up'
import DtIconPhoneForward from '@dialpad/dialtone-icons/vue3/phone-forward'
import DtIconVoicemail from '@dialpad/dialtone-icons/vue3/voicemail'
import DtIconPhoneOff from '@dialpad/dialtone-icons/vue3/phone-off'

interface Props { callId: string; externalNumber?: string; open: boolean }
const props = defineProps<Props>()
const emit = defineEmits<{ (e: 'close'): void }>()

const auth = useAuthStore()

interface TimelineEvent {
  id: number
  state: string
  direction: string
  external_number: string | null
  user_email: string | null
  user_name: string | null
  entry_point: string | null
  target: string | null
  received_at: string
  step_index: number
  sec_since_prev: number
}
const events = ref<TimelineEvent[]>([])
const hasRecording = ref(false)
const hasVoicemail = ref(false)
const loading = ref(false)
const error = ref('')

// Audio expansion — lazily mount the <audio> element only after the
// user clicks Listen so we don't trigger a Dialpad fetch every time
// the dialog opens.
const audioOpen = ref(false)
function audioSrc(): string {
  return `/api/dialpad/call/${encodeURIComponent(props.callId)}/audio?token=${encodeURIComponent(auth.token || '')}`
}

// Customer name lookup — same shared cache as the inbox + live panel,
// so by the time the user opens the timeline the name is usually
// already resolved without a network call.
const { matches: phoneMatches, primeMany } = usePhoneMatches()
const customerName = computed<string>(() => {
  const num = props.externalNumber || ''
  if (!num) return ''
  return phoneMatches.value[num]?.[0]?.customer_name || ''
})

function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

async function load() {
  if (!props.open || !props.callId) return
  audioOpen.value = false
  loading.value = true; error.value = ''
  if (props.externalNumber) primeMany([props.externalNumber])
  try {
    const res = await fetch(`/api/dialpad/call/${encodeURIComponent(props.callId)}/timeline`, { headers: hdrs() })
    if (!res.ok) { error.value = `HTTP ${res.status}`; return }
    const data = await res.json() as { events: TimelineEvent[]; has_recording?: boolean; has_voicemail?: boolean }
    events.value = data.events || []
    hasRecording.value = !!data.has_recording
    hasVoicemail.value = !!data.has_voicemail
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { loading.value = false }
}
watch(() => [props.open, props.callId], load)
onMounted(load)

// Map Dialpad call states to a visual + label. Falls back to "unknown" with
// a generic phone icon when a state isn't in our map.
interface StateMeta { label: string; icon: unknown; iconCls: string; bgCls: string }
const STATE_META: Record<string, StateMeta> = {
  preanswer:  { label: 'Pre-answer',     icon: DtIconBellRing,      iconCls: 'text-amber-600',   bgCls: 'bg-amber-100' },
  ringing:    { label: 'Ringing',        icon: DtIconBellRing,      iconCls: 'text-amber-600',   bgCls: 'bg-amber-100' },
  queued:     { label: 'Queued',         icon: DtIconBellRing,      iconCls: 'text-amber-600',   bgCls: 'bg-amber-100' },
  connected:  { label: 'Connected',      icon: DtIconPhoneCall,     iconCls: 'text-emerald-600', bgCls: 'bg-emerald-100' },
  hangup:     { label: 'Hangup',         icon: DtIconPhoneHangUp,   iconCls: 'text-slate-500',   bgCls: 'bg-slate-100' },
  ended:      { label: 'Ended',          icon: DtIconPhoneHangUp,   iconCls: 'text-slate-500',   bgCls: 'bg-slate-100' },
  hold:       { label: 'On hold',        icon: DtIconPhoneCall,     iconCls: 'text-amber-600',   bgCls: 'bg-amber-100' },
  transferred:{ label: 'Transferred',    icon: DtIconPhoneForward,  iconCls: 'text-orange-600',  bgCls: 'bg-orange-100' },
  voicemail:  { label: 'Voicemail',      icon: DtIconVoicemail,     iconCls: 'text-violet-600',  bgCls: 'bg-violet-100' },
  missed:     { label: 'Missed',         icon: DtIconPhoneHangUp,   iconCls: 'text-amber-600',   bgCls: 'bg-amber-100' },
  abandoned:  { label: 'Abandoned',      icon: DtIconPhoneOff,      iconCls: 'text-rose-600',    bgCls: 'bg-rose-100' },
  blocked:    { label: 'Blocked',        icon: DtIconPhoneOff,      iconCls: 'text-rose-600',    bgCls: 'bg-rose-100' },
  recap:      { label: 'Recap',          icon: DtIconPhoneCall,     iconCls: 'text-slate-500',   bgCls: 'bg-slate-100' },
  postcall:   { label: 'Wrap-up',        icon: DtIconPhoneCall,     iconCls: 'text-slate-500',   bgCls: 'bg-slate-100' },
}
function metaFor(state: string): StateMeta {
  const k = String(state).toLowerCase().replace(/^call\./, '')
  return STATE_META[k] || { label: state || 'unknown', icon: DtIconPhoneCall, iconCls: 'text-slate-500', bgCls: 'bg-slate-100' }
}

const headerKind = computed(() => {
  const dir = events.value[0]?.direction
  if (dir === 'outbound') return { label: 'Outbound call', icon: DtIconPhoneOutgoing, color: 'text-emerald-600' }
  return { label: 'Inbound call', icon: DtIconPhoneIncoming, color: 'text-sky-600' }
})

// Total span — first event to last
const totalDuration = computed(() => {
  if (events.value.length < 2) return 0
  const first = new Date(String(events.value[0]!.received_at).replace(' ', 'T') + 'Z').getTime()
  const last = new Date(String(events.value[events.value.length - 1]!.received_at).replace(' ', 'T') + 'Z').getTime()
  return Math.max(0, Math.round((last - first) / 1000))
})

// Outcome — the final state reached (the "what happened" headline)
const outcome = computed(() => {
  const last = events.value[events.value.length - 1]
  if (!last) return null
  return metaFor(String(last.state))
})

// Did this call go through an entry point (Office line / IVR / contact center)?
const entryPoint = computed(() => {
  for (const e of events.value) {
    if (e.entry_point && e.entry_point !== 'UserProfile') return e.entry_point
  }
  return null
})

function fmtTime(ts: string): string {
  const d = new Date(ts.replace(' ', 'T') + (ts.endsWith('Z') ? '' : 'Z'))
  if (isNaN(d.getTime())) return ts.slice(11, 19)
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

function close() { emit('close') }
function tel() { if (props.externalNumber) window.location.href = `tel:${props.externalNumber}` }
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-[120] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm" @click.self="close">
      <div class="w-full sm:w-[440px] h-[92vh] sm:max-h-[80vh] bg-card sm:rounded-2xl rounded-t-2xl shadow-2xl flex flex-col overflow-hidden">
        <!-- Header — outcome at a glance -->
        <div class="px-3 py-2 border-b flex items-center gap-2 bg-muted/30">
          <button class="size-9 rounded-full hover:bg-muted/60 flex items-center justify-center -ml-1" title="Close" @click="close">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div class="flex-1 min-w-0">
            <!-- Customer name takes the headline when matched; phone moves
                 to the secondary line so the user still has it for callback. -->
            <p class="text-[14px] font-semibold truncate">
              <template v-if="customerName">{{ customerName }}</template>
              <template v-else>Call timeline</template>
            </p>
            <p class="text-[10px] text-muted-foreground truncate">
              {{ formatPhone(externalNumber || null) || 'Unknown' }} · {{ headerKind.label.toLowerCase() }}
              <template v-if="totalDuration"> · total {{ fmtTalkSec(totalDuration) }}</template>
            </p>
          </div>
          <button v-if="externalNumber" class="size-9 rounded-full hover:bg-muted/60 flex items-center justify-center" title="Call back" @click="tel">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
          </button>
        </div>

        <!-- Outcome banner — the big "what happened" line -->
        <div v-if="outcome" class="px-4 py-2.5 border-b flex items-center gap-2.5">
          <div class="size-10 rounded-full flex items-center justify-center shrink-0" :class="outcome.bgCls">
            <component :is="outcome.icon" class="w-5 h-5" :class="outcome.iconCls" />
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-[13px] font-semibold">{{ outcome.label }}</p>
            <p v-if="entryPoint" class="text-[10px] text-muted-foreground">via {{ entryPoint }}</p>
            <p v-else class="text-[10px] text-muted-foreground">direct to user</p>
          </div>
          <!-- Listen toggle — primary CTA when this call has audio. Mounting
               the <audio> element lazily keeps the Dialpad audio proxy idle
               until the user actually wants to play. -->
          <button
            v-if="hasRecording || hasVoicemail"
            class="shrink-0 inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors"
            :class="audioOpen ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-muted/80'"
            @click="audioOpen = !audioOpen"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
            {{ audioOpen ? 'Hide' : (hasVoicemail && !hasRecording ? 'Voicemail' : 'Recording') }}
          </button>
        </div>

        <!-- Inline audio player. Only mounted (and only fetched) after the
             user clicks Listen — preload="none" is belt-and-suspenders. -->
        <div v-if="audioOpen && (hasRecording || hasVoicemail)" class="px-4 py-2 border-b bg-muted/20">
          <audio :src="audioSrc()" controls preload="none" class="w-full h-9" />
        </div>

        <!-- Vertical timeline -->
        <div class="flex-1 overflow-y-auto px-4 py-3">
          <p v-if="loading" class="text-center text-[11px] text-muted-foreground py-6">Loading timeline…</p>
          <p v-else-if="error" class="text-center text-[11px] text-red-600 py-6">{{ error }}</p>
          <p v-else-if="events.length === 0" class="text-center text-[11px] text-muted-foreground py-6">No webhook events recorded for this call.</p>

          <ol v-else class="relative">
            <!-- Vertical rail -->
            <span class="absolute left-[15px] top-2 bottom-2 w-px bg-border" aria-hidden="true" />

            <li v-for="(e, i) in events" :key="e.id" class="relative pl-9 pb-3 last:pb-0">
              <!-- Step icon -->
              <div class="absolute left-0 top-0 size-[31px] rounded-full flex items-center justify-center ring-2 ring-card" :class="metaFor(e.state).bgCls">
                <component :is="metaFor(e.state).icon" class="w-3.5 h-3.5" :class="metaFor(e.state).iconCls" />
              </div>

              <div class="flex items-start justify-between gap-2 min-w-0">
                <div class="flex-1 min-w-0">
                  <p class="text-[13px] font-semibold">{{ metaFor(e.state).label }}</p>
                  <p class="text-[10px] text-muted-foreground">
                    <template v-if="e.target">→ {{ e.target }}</template>
                    <template v-else-if="e.user_name">→ {{ e.user_name }}</template>
                    <template v-else-if="e.entry_point">via {{ e.entry_point }}</template>
                    <template v-else>{{ e.direction || 'event' }}</template>
                  </p>
                </div>
                <div class="text-right shrink-0">
                  <p class="text-[11px] tabular-nums">{{ fmtTime(e.received_at) }}</p>
                  <p v-if="i > 0 && e.sec_since_prev > 0" class="text-[10px] text-muted-foreground tabular-nums">+{{ fmtTalkSec(e.sec_since_prev) }}</p>
                </div>
              </div>
            </li>
          </ol>
        </div>
      </div>
    </div>
  </Teleport>
</template>
