import { ref } from 'vue'
import { defineStore } from 'pinia'
import { useAuthStore } from './auth'
import { localTodayIso } from '@/lib/dates'

export const useTicketBadgesStore = defineStore('ticketBadges', () => {
  const overdue = ref(0)
  const dueToday = ref(0)

  let interval: ReturnType<typeof setInterval> | null = null

  async function fetch() {
    const auth = useAuthStore()
    if (!auth.token) return
    try {
      const qp = new URLSearchParams({ today: localTodayIso() })
      if (auth.user?.name) qp.set('user', auth.user.name)
      const res = await globalThis.fetch(`/api/tickets/badges?${qp}`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      })
      if (res.ok) {
        const data = await res.json()
        overdue.value = data.overdue
        dueToday.value = data.dueToday
      }
    } catch { /* silent */ }
  }

  function startPolling() {
    fetch()
    if (interval) clearInterval(interval)
    interval = setInterval(fetch, 60000) // every minute
  }

  function stopPolling() {
    if (interval) { clearInterval(interval); interval = null }
  }

  return { overdue, dueToday, fetch, startPolling, stopPolling }
})
