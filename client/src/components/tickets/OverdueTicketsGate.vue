<script setup lang="ts">
// SHELVED 2026-07-05 — built but deliberately NOT mounted. James is
// deciding the policy with his team before turning it on. To enable:
// import + render in AppLayout.vue (one line each, next to CommsLiveRail).
//
// The deliberately-annoying past-due gate. When the logged-in user has
// overdue assigned tickets, a modal interrupts them listing every one —
// and any dismissal only buys 4 hours before it comes back. It stops
// appearing the moment the tickets are completed or re-dated.
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

const auth = useAuthStore()
const router = useRouter()

interface OverdueTicket {
  record_id: number
  title: string | null
  due_date: string | null
  project_rid: number | null
  project_name: string | null
  priority: string | null
}

const open = ref(false)
const items = ref<OverdueTicket[]>([])

const ACK_KEY = 'overdue_gate_ack_at'
const REARM_MS = 4 * 60 * 60 * 1000  // dismissal buys 4 hours

function daysOverdue(d: string | null): number {
  if (!d) return 0
  const due = new Date(d.slice(0, 10) + 'T12:00:00')
  return Math.max(0, Math.floor((Date.now() - due.getTime()) / 86_400_000))
}

async function check() {
  if (!auth.token || !auth.user?.name) return
  const ackAt = parseInt(localStorage.getItem(ACK_KEY) ?? '0', 10) || 0
  if (Date.now() - ackAt < REARM_MS) return
  try {
    const res = await fetch(
      `/api/tickets?assigned=${encodeURIComponent(auth.user.name)}&due=overdue&open=1&limit=20`,
      { headers: { Authorization: `Bearer ${auth.token}` } },
    )
    if (!res.ok) return
    const data = await res.json()
    const overdue = (data.tickets as OverdueTicket[]) ?? []
    if (overdue.length) {
      items.value = overdue
      open.value = true
    }
  } catch { /* gate is best-effort */ }
}

function acknowledge() {
  localStorage.setItem(ACK_KEY, String(Date.now()))
  open.value = false
}
function onOpenChange(v: boolean) {
  // Closing by ANY means (X, escape, overlay) counts as an acknowledgment
  // — the 4-hour re-arm is the enforcement, not trapping the click.
  if (!v) acknowledge()
}
function goTo(t: OverdueTicket) {
  acknowledge()
  router.push(t.project_rid ? `/projects/${t.project_rid}#tickets` : `/tickets?focus=${t.record_id}`)
}

let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  setTimeout(check, 2500)  // let the app settle before interrupting
  timer = setInterval(check, 30 * 60 * 1000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent class="max-w-md rounded-2xl">
      <DialogHeader>
        <DialogTitle class="text-[15px] flex items-center gap-2">
          <span class="w-7 h-7 rounded-lg bg-red-100 text-red-600 flex items-center justify-center shrink-0">
            <svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
          </span>
          You have {{ items.length }} past-due ticket{{ items.length > 1 ? 's' : '' }}
        </DialogTitle>
      </DialogHeader>

      <div class="flex flex-col gap-1.5 max-h-[50vh] overflow-y-auto">
        <button
          v-for="t in items"
          :key="t.record_id"
          type="button"
          class="text-left rounded-xl bg-red-50/60 hover:bg-red-50 px-3.5 py-2.5 cursor-pointer transition-colors"
          @click="goTo(t)"
        >
          <div class="flex items-baseline gap-2">
            <span class="text-[13px] font-medium text-slate-800 truncate flex-1">{{ t.title || `Ticket #${t.record_id}` }}</span>
            <span class="text-[11px] font-semibold text-red-600 tabular-nums shrink-0">{{ daysOverdue(t.due_date) }}d overdue</span>
          </div>
          <div v-if="t.project_name" class="text-[11px] text-slate-500 truncate">{{ t.project_name }}</div>
        </button>
      </div>

      <div class="flex items-center justify-between gap-3 pt-1">
        <span class="text-[10.5px] text-slate-400">This reminder returns every 4 hours until these are handled.</span>
        <Button size="sm" @click="acknowledge">I'm on it</Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
