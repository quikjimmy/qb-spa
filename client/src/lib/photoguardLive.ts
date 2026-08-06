// Singleton SSE client for PhotoGuard, modeled on lib/feedLive.ts.
// Carries the AI verdicts that land after an upload has already returned its
// instant gate result, so the capture UI can fill in the slow half in place.
import { ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'

export interface PhotoGuardEvent {
  type:
    | 'scan_started' | 'scan_progress' | 'scan_complete' | 'scan_failed'
    | 'photo_added' | 'photo_validated' | 'photo_reviewed'
    | 'form_imported'
  taskId?: number
  photoId?: number
  arrivyTaskId?: string
  status?: string
  message?: string
  data?: Record<string, unknown>
  at: string
}

type Listener = (evt: PhotoGuardEvent) => void

const connected = ref(false)
const reconnectAttempt = ref(0)

let es: EventSource | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let initialized = false
let auth: ReturnType<typeof useAuthStore> | null = null

const listeners = new Set<Listener>()

export function onPhotoGuardEvent(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function connect(): void {
  if (!auth?.token) return
  // Referral Agents are 403'd on this router server-side — don't open a
  // guaranteed-fail reconnect loop for them.
  if (auth.isReferralAgent) return
  if (es) { es.close(); es = null }
  es = new EventSource(`/api/photoguard/events?token=${encodeURIComponent(auth.token)}`)
  es.onopen = () => {
    connected.value = true
    reconnectAttempt.value = 0
  }
  es.addEventListener('photoguard', e => {
    try {
      const evt = JSON.parse((e as MessageEvent).data) as PhotoGuardEvent
      for (const fn of listeners) {
        try { fn(evt) } catch { /* one bad consumer shouldn't break others */ }
      }
    } catch { /* malformed */ }
  })
  es.onerror = () => {
    connected.value = false
    if (es) { es.close(); es = null }
    const delay = Math.min(1000 * 2 ** reconnectAttempt.value, 30_000)
    reconnectAttempt.value += 1
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(connect, delay)
  }
}

export function usePhotoGuardLive() {
  if (!initialized) {
    initialized = true
    auth = useAuthStore()
    watch(() => auth!.token, t => {
      if (!t) {
        if (es) { es.close(); es = null }
        connected.value = false
        return
      }
      connect()
    }, { immediate: true })
  }
  return { connected, reconnectAttempt, onPhotoGuardEvent }
}
