import { ref } from 'vue'
import { useAuthStore } from '@/stores/auth'

// Shared loader for the per-project open-ticket buckets that feed TicketGlance
// on project lists. One bulk fetch (GET /api/tickets/by-project) builds a map
// keyed by record_id; rows without any dated open ticket are omitted server-side
// so `get()` returns null for them and the glance renders nothing.
export interface TicketBucket { overdue: number; dueToday: number; futureDue: number }

export function useTicketBuckets() {
  const auth = useAuthStore()
  const byProject = ref<Record<string, TicketBucket>>({})

  async function loadTicketBuckets(): Promise<void> {
    try {
      const res = await fetch('/api/tickets/by-project', { headers: { Authorization: `Bearer ${auth.token}` } })
      if (res.ok) {
        const data = await res.json()
        byProject.value = data.byProject ?? {}
      }
    } catch { /* non-fatal — rows simply render without the glance */ }
  }

  function ticketsFor(rid: number | string | null | undefined): TicketBucket | null {
    if (rid == null) return null
    return byProject.value[String(rid)] ?? null
  }

  return { byProject, loadTicketBuckets, ticketsFor }
}
