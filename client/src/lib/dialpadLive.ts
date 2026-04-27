// Singleton Dialpad live-events composable. Owns one SSE connection for the
// whole app so the Comms Hub panel and the global incoming-call alert share
// the same stream — we don't open a second EventSource when both are mounted.
//
// All state is module-level (reactive), so repeated useDialpadLive() calls
// return the same refs.
import { ref, computed, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'

export interface LiveEvent {
  id: number
  event_kind: string
  event_state: string | null
  call_id: string | null
  user_email: string | null
  user_name: string | null
  external_number: string | null
  direction: string | null
  raw_json: string
  received_at: string
}

const MAX_EVENTS = 50

const events = ref<LiveEvent[]>([])
const stateHistory = ref<Record<string, string[]>>({})
const connected = ref(false)
const reconnectAttempt = ref(0)
const lastId = ref(0)

let es: EventSource | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let initialized = false
let auth: ReturnType<typeof useAuthStore> | null = null

// ── Filter (Me / All) ──
const scope = ref<'me' | 'all'>((typeof localStorage !== 'undefined' ? (localStorage.getItem('comms.live.scope') as 'me' | 'all' | null) : null) || 'me')
const myEmail = computed(() => (auth?.user?.email || '').toLowerCase().trim())
export function setScope(s: 'me' | 'all') {
  scope.value = s
  try { localStorage.setItem('comms.live.scope', s) } catch { /* ignore */ }
}

// ── Sound ──
const soundEnabled = ref(typeof localStorage !== 'undefined' ? localStorage.getItem('comms.live.sound') !== '0' : true)
const audioUnlocked = ref(false)
let audioCtx: AudioContext | null = null

function ensureAudioCtx(): AudioContext | null {
  if (audioCtx) return audioCtx
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctx) return null
  try { audioCtx = new Ctx() } catch { return null }
  return audioCtx
}

export function unlockAudio(): void {
  const ctx = ensureAudioCtx()
  if (!ctx) return
  ctx.resume?.().catch(() => { /* ignore */ })
  audioUnlocked.value = true
}

export function toggleSound(): void {
  soundEnabled.value = !soundEnabled.value
  try { localStorage.setItem('comms.live.sound', soundEnabled.value ? '1' : '0') } catch { /* ignore */ }
  if (soundEnabled.value) unlockAudio()
}

export function playTone(kind: 'call' | 'sms' | 'ringing'): void {
  if (!soundEnabled.value) return
  const ctx = ensureAudioCtx()
  if (!ctx || ctx.state !== 'running') return
  const now = ctx.currentTime

  if (kind === 'ringing') {
    // Longer, more insistent ring for incoming — two higher pitched beeps.
    for (const offset of [0, 0.35]) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(880, now + offset)
      osc.frequency.setValueAtTime(988, now + offset + 0.15)
      gain.gain.setValueAtTime(0, now + offset)
      gain.gain.linearRampToValueAtTime(0.22, now + offset + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.3)
      osc.connect(gain).connect(ctx.destination)
      osc.start(now + offset)
      osc.stop(now + offset + 0.32)
    }
    return
  }
  if (kind === 'call') {
    for (const offset of [0, 0.22]) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = 880
      gain.gain.setValueAtTime(0, now + offset)
      gain.gain.linearRampToValueAtTime(0.18, now + offset + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.18)
      osc.connect(gain).connect(ctx.destination)
      osc.start(now + offset)
      osc.stop(now + offset + 0.2)
    }
    return
  }
  // sms — single rising chime
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'triangle'
  osc.frequency.setValueAtTime(1320, now)
  osc.frequency.exponentialRampToValueAtTime(1760, now + 0.12)
  gain.gain.setValueAtTime(0, now)
  gain.gain.linearRampToValueAtTime(0.14, now + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22)
  osc.connect(gain).connect(ctx.destination)
  osc.start(now)
  osc.stop(now + 0.25)
}

// ── Scope-aware visible events ──
export const visibleEvents = computed<LiveEvent[]>(() => {
  if (scope.value === 'all') return events.value
  if (!myEmail.value) return events.value
  return events.value.filter(e => (e.user_email || '').toLowerCase() === myEmail.value)
})

// ── Ringing tracker ──
// An "active incoming ring" is a call event that's currently in ringing/
// preanswer state and hasn't yet been connected, hung up, missed, or had a
// voicemail dropped. We track these so the GlobalIncomingCallAlert can pop
// the top of the screen and dismiss automatically when the call resolves.
const RINGING_STATES = new Set(['ringing', 'preanswer', 'queued'])
const RESOLVED_STATES = new Set(['connected', 'hangup', 'ended', 'missed', 'voicemail', 'transferred', 'abandoned', 'hold'])

export const activeRinging = computed<LiveEvent[]>(() => {
  // Dedupe by external_number, not call_id — a single inbound call can
  // fan out to multiple agents, with Dialpad emitting one webhook per
  // agent (each with a different call_id). From the user's perspective
  // it's one alert, not N. We pick the earliest-received ringing event
  // for each number so the elapsed timer reflects the real ring time.
  const byNumber = new Map<string, LiveEvent>()
  for (const e of events.value) {
    if (e.event_kind !== 'call' || !e.call_id) continue
    const s = (e.event_state || '').toLowerCase()
    const history = stateHistory.value[e.call_id] || []
    const hasResolution = history.some(st => RESOLVED_STATES.has(st))
    if (hasResolution) continue
    if (!RINGING_STATES.has(s)) continue
    const key = e.external_number || `call:${e.call_id}`  // fall back so unknown-number rings still appear
    const existing = byNumber.get(key)
    if (!existing || e.received_at < existing.received_at) byNumber.set(key, e)
  }
  // Scope filter
  const out = [...byNumber.values()]
  if (scope.value === 'me' && myEmail.value) {
    return out.filter(e => (e.user_email || '').toLowerCase() === myEmail.value)
  }
  return out
})

// Manual dismissals — an alert can be acknowledged before the call resolves.
// Tracked by external_number so dismissing one fan-out leg dismisses all
// sibling rings; falls back to call_id when no number is available.
const dismissedKeys = ref<Set<string>>(new Set())
function dismissKey(ev: LiveEvent): string {
  return ev.external_number || (ev.call_id ? `call:${ev.call_id}` : '')
}
export function dismissRinging(callOrEvent: string | LiveEvent): void {
  const key = typeof callOrEvent === 'string' ? `call:${callOrEvent}` : dismissKey(callOrEvent)
  if (!key) return
  dismissedKeys.value = new Set([...dismissedKeys.value, key])
}
export const pendingRinging = computed<LiveEvent[]>(() =>
  activeRinging.value.filter(e => {
    const k = dismissKey(e)
    return k && !dismissedKeys.value.has(k)
  })
)

// ── Ingest ──
function ingest(ev: LiveEvent): void {
  // Track full state history by call
  if (ev.call_id && ev.event_state) {
    const seq = stateHistory.value[ev.call_id] || []
    if (!seq.length || seq[seq.length - 1] !== ev.event_state) {
      stateHistory.value = { ...stateHistory.value, [ev.call_id]: [...seq, ev.event_state] }
    }
    // If this event resolves a previously-dismissed ringing call, clean up.
    // Check both number-keyed and call-id-keyed dismissals.
    if (RESOLVED_STATES.has((ev.event_state || '').toLowerCase())) {
      const numberKey = ev.external_number || ''
      const callKey = `call:${ev.call_id}`
      if (dismissedKeys.value.has(numberKey) || dismissedKeys.value.has(callKey)) {
        const next = new Set(dismissedKeys.value)
        next.delete(numberKey)
        next.delete(callKey)
        dismissedKeys.value = next
      }
    }
  }

  // Collapse lifecycle events into one card per call_id.
  if (ev.call_id) {
    const idx = events.value.findIndex(e => e.call_id === ev.call_id)
    if (idx >= 0) {
      const next = [...events.value]
      next[idx] = ev
      const [moved] = next.splice(idx, 1)
      events.value = [moved!, ...next].slice(0, MAX_EVENTS)
      if (ev.id > lastId.value) lastId.value = ev.id
      return
    }
  }
  events.value = [ev, ...events.value].slice(0, MAX_EVENTS)
  if (ev.id > lastId.value) lastId.value = ev.id

  // Play sound on truly new events that match scope.
  const scopeOk = scope.value === 'all' || (myEmail.value && (ev.user_email || '').toLowerCase() === myEmail.value)
  if (!scopeOk) return
  const state = (ev.event_state || '').toLowerCase()
  const isRinging = ev.event_kind === 'call' && RINGING_STATES.has(state)
  const isNewCall = ev.event_kind === 'call' && !stateHistory.value[ev.call_id || '']?.length
  const isSms = ev.event_kind === 'sms'
  if (isRinging) playTone('ringing')
  else if (isSms) playTone('sms')
  else if (isNewCall) playTone('call')
}

async function backfill(): Promise<void> {
  if (!auth?.token) return
  try {
    const res = await fetch(`/api/dialpad/events/recent?limit=${MAX_EVENTS}&since_id=${lastId.value}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    if (!res.ok) return
    const data = await res.json() as { rows: LiveEvent[] }
    for (const row of data.rows.slice().reverse()) {  // oldest first so state_history builds correctly
      ingest(row)
    }
  } catch { /* ignore */ }
}

function connect(): void {
  if (!auth?.token) return
  if (es) { es.close(); es = null }
  const url = `/api/dialpad/events/stream?token=${encodeURIComponent(auth.token)}${lastId.value ? `&since_id=${lastId.value}` : ''}`
  es = new EventSource(url)
  es.onopen = () => {
    connected.value = true
    reconnectAttempt.value = 0
  }
  es.addEventListener('dialpad', (e) => {
    try {
      const ev = JSON.parse((e as MessageEvent).data) as LiveEvent
      ingest(ev)
    } catch { /* malformed */ }
  })
  es.onerror = () => {
    connected.value = false
    if (es) { es.close(); es = null }
    const delay = Math.min(1000 * 2 ** reconnectAttempt.value, 30_000)
    reconnectAttempt.value += 1
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(() => { backfill().then(connect) }, delay)
  }
}

export function useDialpadLive() {
  if (!initialized) {
    initialized = true
    auth = useAuthStore()
    // Watch auth token so we reconnect once the user logs in.
    watch(() => auth!.token, (t) => {
      if (!t) {
        if (es) { es.close(); es = null }
        connected.value = false
        return
      }
      backfill().then(connect)
    }, { immediate: true })
  }
  return {
    events,
    visibleEvents,
    stateHistory,
    connected,
    reconnectAttempt,
    scope,
    setScope,
    soundEnabled,
    toggleSound,
    unlockAudio,
    playTone,
    activeRinging,
    pendingRinging,
    dismissRinging,
  }
}
