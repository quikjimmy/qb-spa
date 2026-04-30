// Cursor-paginated contact timeline state. Owns the unified message + call
// window, "load older" fetch, and scroll-anchor restoration after prepend.
// Items come tagged with `kind: 'sms' | 'call'` so the dialog can render
// chat bubbles for SMS and collapsible cards for calls.
import { ref, computed, type Ref } from 'vue'
import { useAuthStore } from '@/stores/auth'

export interface ThreadSms {
  kind: 'sms'
  id: number
  direction: 'incoming' | 'outgoing' | string
  body: string | null
  status: string | null
  user_email: string | null
  user_name: string | null
  external_number: string | null
  received_at: string
  at: string
  is_read: number
  agent_email?: string | null
  agent_name?: string | null
  agent_number?: string | null
  dialpad_user_id?: string | null
  raw_preview?: string | null
  lookup_error?: string | null
}

export interface ThreadCall {
  kind: 'call'
  call_id: string
  direction: 'inbound' | 'outbound' | string
  bucket: string
  started_at: string
  connected_at: string | null
  ended_at: string | null
  at: string
  talk_time_sec: number
  ring_time_sec: number
  was_voicemail: boolean
  was_recorded: boolean
  was_transfer: boolean
  user_email: string | null
  user_name: string | null
  external_number: string | null
  entry_point_target_kind: string | null
}

export type ThreadItem = ThreadSms | ThreadCall

// Backwards-compat alias — older code paths refer to ThreadMessage.
export type ThreadMessage = ThreadSms

export interface ThreadAgent {
  email: string | null
  name: string | null
  number: string | null
  dialpad_user_id: string | null
  message_count: number
  last_used_at: string | null
}

interface TimelineResponse {
  external_number: string
  items: ThreadItem[]
  count: number
  has_more: boolean
  oldest_at: string | null
  text_count: number
  sms_count: number
  call_count: number
  agents?: ThreadAgent[]
  primary_agent?: ThreadAgent | null
}

const PAGE_SIZE = 30

export function useSmsThread(externalNumber: Ref<string>) {
  const auth = useAuthStore()
  const items = ref<ThreadItem[]>([])
  const hasMore = ref(false)
  const oldestAt = ref<string | null>(null)
  const textCount = ref(0)
  const agents = ref<ThreadAgent[]>([])
  const primaryAgent = ref<ThreadAgent | null>(null)
  const loading = ref(false)
  const loadingOlder = ref(false)
  const error = ref('')

  // SMS-only / call-only views derived from the unified list. Keeps the
  // composable's surface friendly to call sites that only want one kind
  // (the SMS thread search results, or a future calls-only summary view).
  const messages = computed<ThreadSms[]>(() =>
    items.value.filter((i): i is ThreadSms => i.kind === 'sms')
  )
  const calls = computed<ThreadCall[]>(() =>
    items.value.filter((i): i is ThreadCall => i.kind === 'call')
  )

  const isEmpty = computed(() => !loading.value && items.value.length === 0)
  const isStatusOnly = computed(() =>
    !loading.value
    && messages.value.length > 0
    && textCount.value === 0
  )

  function hdrs() {
    return { Authorization: `Bearer ${auth.token}` }
  }

  async function fetchPage(beforeAt: string | null): Promise<TimelineResponse | null> {
    const num = externalNumber.value
    if (!num) return null
    const params = new URLSearchParams()
    params.set('external_number', num)
    params.set('limit', String(PAGE_SIZE))
    if (beforeAt) params.set('before_at', beforeAt)
    const res = await fetch(`/api/dialpad/contact-timeline?${params}`, { headers: hdrs() })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json() as TimelineResponse
  }

  async function loadInitial() {
    loading.value = true
    error.value = ''
    items.value = []
    hasMore.value = false
    oldestAt.value = null
    try {
      const data = await fetchPage(null)
      if (!data) return
      items.value = data.items
      hasMore.value = data.has_more
      oldestAt.value = data.oldest_at
      textCount.value = data.text_count
      agents.value = data.agents || []
      primaryAgent.value = data.primary_agent ?? null
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  // Prepend older items without disturbing the scroll position. The caller
  // captures scrollHeight/scrollTop before invoking and restores after — the
  // composable doesn't touch the DOM. Dedupes by composite key (kind + id)
  // so a ringing-then-connected race doesn't double-render a call.
  async function loadOlder(): Promise<{ added: number }> {
    if (!hasMore.value || loadingOlder.value || !oldestAt.value) return { added: 0 }
    loadingOlder.value = true
    try {
      const data = await fetchPage(oldestAt.value)
      if (!data) return { added: 0 }
      const seen = new Set(items.value.map(itemKey))
      const fresh = data.items.filter(i => !seen.has(itemKey(i)))
      items.value = [...fresh, ...items.value]
      hasMore.value = data.has_more
      if (data.oldest_at) oldestAt.value = data.oldest_at
      textCount.value = messages.value.filter(m => !!m.body).length
      return { added: fresh.length }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return { added: 0 }
    } finally {
      loadingOlder.value = false
    }
  }

  function itemKey(i: ThreadItem): string {
    return i.kind === 'sms' ? `sms-${i.id}` : `call-${i.call_id}`
  }

  // Refetch the latest page (no cursor) and merge anything new into the
  // existing list. Used by the live SSE subscriber when a webhook for this
  // contact lands while the dialog is open. Returns the count of new items
  // so the caller can scroll-to-bottom only when something actually changed.
  async function refreshLatest(): Promise<{ added: number }> {
    if (!externalNumber.value) return { added: 0 }
    try {
      const data = await fetchPage(null)
      if (!data) return { added: 0 }
      const existingKeys = new Set(items.value.map(itemKey))
      const fresh = data.items.filter(i => !existingKeys.has(itemKey(i)))
      if (fresh.length === 0) return { added: 0 }
      // Response is ASC; new items are at the tail of that batch and
      // chronologically newer than anything we've got, so append.
      items.value = [...items.value, ...fresh]
      textCount.value = messages.value.filter(m => !!m.body).length
      // Refresh agent surface in case a new sender just appeared.
      if (data.agents) agents.value = data.agents
      if (data.primary_agent !== undefined) primaryAgent.value = data.primary_agent ?? null
      return { added: fresh.length }
    } catch {
      return { added: 0 }
    }
  }

  return {
    items,
    messages,
    calls,
    hasMore,
    oldestAt,
    textCount,
    agents,
    primaryAgent,
    loading,
    loadingOlder,
    error,
    isEmpty,
    isStatusOnly,
    loadInitial,
    loadOlder,
    refreshLatest,
  }
}
