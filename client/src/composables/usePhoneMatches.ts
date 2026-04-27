// Module-level phone → project match cache, shared across the app. Both the
// Comms Inbox and the Live Activity panel render rows for phone numbers and
// want a customer name + record_id alongside. Without this, each row would
// fire its own /api/projects/by-phone request — a 50–100 request fan-out
// that throttles on the browser's per-origin connection limit and leaves
// the inbox staring at "Loading…" for several seconds.
//
// The composable batches all numbers requested in the same tick into a
// single POST /api/projects/by-phones, dedupes by raw input, and caches
// results so the second view that asks for the same number gets it
// synchronously.
import { ref } from 'vue'
import { useAuthStore } from '@/stores/auth'

export interface PhoneMatch {
  record_id: number
  customer_name: string
  phone: string | null
  mobile_phone: string | null
  alt_phone: string | null
  status: string | null
  state: string | null
  coordinator: string | null
  probable: boolean
}

const cache = ref<Record<string, PhoneMatch[]>>({})
const inflight = new Set<string>()
let pending: Set<string> = new Set()
let scheduled = false

function flush() {
  scheduled = false
  const numbers = [...pending]
  pending = new Set()
  if (numbers.length === 0) return
  for (const n of numbers) inflight.add(n)
  const auth = useAuthStore()
  fetch('/api/projects/by-phones', {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ numbers }),
  }).then(async res => {
    if (!res.ok) return
    const data = await res.json() as { matches: Record<string, PhoneMatch[]> }
    const next = { ...cache.value }
    for (const n of numbers) {
      next[n] = data.matches[n] || []
    }
    cache.value = next
  }).catch(() => { /* leave inflight cleared below; another request will retry */ })
    .finally(() => { for (const n of numbers) inflight.delete(n) })
}

// Ensure each number is fetched at most once. Calling primeMany repeatedly
// inside a tight loop is safe — they all coalesce into one HTTP round-trip.
export function primeMany(numbers: Array<string | null | undefined>): void {
  let added = false
  for (const raw of numbers) {
    const n = (raw || '').trim()
    if (!n) continue
    if (cache.value[n] !== undefined) continue
    if (inflight.has(n)) continue
    if (pending.has(n)) continue
    pending.add(n)
    added = true
  }
  if (added && !scheduled) {
    scheduled = true
    queueMicrotask(flush)
  }
}

export function usePhoneMatches() {
  return { matches: cache, primeMany }
}
