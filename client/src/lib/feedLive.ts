// Singleton SSE client for the live activity feed, modeled on
// lib/dialpadLive.ts (connection lifecycle only — no buffering here:
// FeedView owns the items array, so this module just hands new items
// to subscribers and tracks connection state).
import { ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'

// Mirrors the item shape GET /api/feed returns (and what the server
// publishes on mint) — reactions/media arrive empty on a fresh post.
export interface LiveFeedItem {
  id: number
  qb_source: string
  qb_record_id: number | null
  event_type: string
  title: string
  body: string | null
  actor_name: string | null
  actor_email: string | null
  project_id: number | null
  project_name: string | null
  metadata: string | null
  occurred_at: string
  comment_count: number
  reactions: Array<{ emoji: string; count: number; reacted: boolean }>
  media: unknown[]
}

type FeedListener = (item: LiveFeedItem) => void

const connected = ref(false)
const reconnectAttempt = ref(0)

let es: EventSource | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let initialized = false
let auth: ReturnType<typeof useAuthStore> | null = null

const listeners = new Set<FeedListener>()

export function onFeedItem(fn: FeedListener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function connect(): void {
  if (!auth?.token) return
  // Referral Agents are excluded from the global stream server-side
  // (403 via referralAgentScope) — don't open a guaranteed-fail
  // reconnect loop for them.
  if (auth.isReferralAgent) return
  if (es) { es.close(); es = null }
  es = new EventSource(`/api/feed/stream?token=${encodeURIComponent(auth.token)}`)
  es.onopen = () => {
    connected.value = true
    reconnectAttempt.value = 0
  }
  es.addEventListener('feed', (e) => {
    try {
      const item = JSON.parse((e as MessageEvent).data) as LiveFeedItem
      for (const fn of listeners) {
        try { fn(item) } catch { /* one bad consumer shouldn't break others */ }
      }
    } catch { /* malformed */ }
  })
  es.onerror = () => {
    connected.value = false
    if (es) { es.close(); es = null }
    const delay = Math.min(1000 * 2 ** reconnectAttempt.value, 30_000)
    reconnectAttempt.value += 1
    if (reconnectTimer) clearTimeout(reconnectTimer)
    // No SSE-side backfill: FeedView re-fetches page 1 on reconnect via
    // the onConnect callbacks if it cares about missed items.
    reconnectTimer = setTimeout(connect, delay)
  }
}

export function useFeedLive() {
  if (!initialized) {
    initialized = true
    auth = useAuthStore()
    watch(() => auth!.token, (t) => {
      if (!t) {
        if (es) { es.close(); es = null }
        connected.value = false
        return
      }
      connect()
    }, { immediate: true })
  }
  return { connected, reconnectAttempt, onFeedItem }
}
