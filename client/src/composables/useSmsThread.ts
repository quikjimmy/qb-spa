// Cursor-paginated SMS thread state. Owns the message window, "load older"
// fetch, scroll-anchor restoration after prepend, and the diagnostic
// counts. Designed to be reused when send-from-app lands: the same
// composable will gain optimistic insert + delivery state without the
// list component needing to know.
import { ref, computed, type Ref } from 'vue'
import { useAuthStore } from '@/stores/auth'

export interface ThreadMessage {
  id: number
  direction: 'incoming' | 'outgoing' | string
  body: string | null
  status: string | null
  user_email: string | null
  user_name: string | null
  external_number: string | null
  received_at: string
  is_read: number
  raw_preview?: string | null
}

interface ThreadResponse {
  messages: ThreadMessage[]
  has_more: boolean
  oldest_id: number | null
  newest_id: number | null
  text_count: number
}

const PAGE_SIZE = 30

export function useSmsThread(externalNumber: Ref<string>) {
  const auth = useAuthStore()
  const messages = ref<ThreadMessage[]>([])
  const hasMore = ref(false)
  const oldestId = ref<number | null>(null)
  const textCount = ref(0)
  const loading = ref(false)
  const loadingOlder = ref(false)
  const error = ref('')

  const isEmpty = computed(() => !loading.value && messages.value.length === 0)
  const isStatusOnly = computed(() => !loading.value && messages.value.length > 0 && textCount.value === 0)

  function hdrs() {
    return { Authorization: `Bearer ${auth.token}` }
  }

  async function fetchPage(beforeId: number | null): Promise<ThreadResponse | null> {
    const num = externalNumber.value
    if (!num) return null
    const params = new URLSearchParams()
    params.set('external_number', num)
    params.set('limit', String(PAGE_SIZE))
    if (beforeId) params.set('before_id', String(beforeId))
    const res = await fetch(`/api/dialpad/sms/thread?${params}`, { headers: hdrs() })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json() as ThreadResponse
  }

  async function loadInitial() {
    loading.value = true
    error.value = ''
    messages.value = []
    hasMore.value = false
    oldestId.value = null
    try {
      const data = await fetchPage(null)
      if (!data) return
      messages.value = data.messages
      hasMore.value = data.has_more
      oldestId.value = data.oldest_id
      textCount.value = data.text_count
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  // Prepend older messages without disturbing the scroll position. The
  // caller is responsible for capturing scrollHeight before invoking and
  // restoring scrollTop after — the composable doesn't know about the DOM.
  async function loadOlder(): Promise<{ added: number }> {
    if (!hasMore.value || loadingOlder.value || !oldestId.value) return { added: 0 }
    loadingOlder.value = true
    try {
      const data = await fetchPage(oldestId.value)
      if (!data) return { added: 0 }
      // Filter out any messages we already have (defensive against
      // duplicate live appends racing the load-older fetch).
      const seen = new Set(messages.value.map(m => m.id))
      const fresh = data.messages.filter(m => !seen.has(m.id))
      messages.value = [...fresh, ...messages.value]
      hasMore.value = data.has_more
      if (data.oldest_id) oldestId.value = data.oldest_id
      // text_count is for the whole conversation — recount client-side
      // now that we have more rows.
      textCount.value = messages.value.filter(m => !!m.body).length
      return { added: fresh.length }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return { added: 0 }
    } finally {
      loadingOlder.value = false
    }
  }

  return {
    messages,
    hasMore,
    oldestId,
    textCount,
    loading,
    loadingOlder,
    error,
    isEmpty,
    isStatusOnly,
    loadInitial,
    loadOlder,
  }
}
