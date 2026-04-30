<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { formatPhone } from '@/lib/callBuckets'
import SmsThreadDialog from '@/components/SmsThreadDialog.vue'
import DtIconMessage from '@dialpad/dialtone-icons/vue3/message'
import DtIconBellRing from '@dialpad/dialtone-icons/vue3/bell-ring'

interface LastMessage {
  id: number
  at: string
  direction: string
  user_name: string | null
  body: string | null
}
interface Thread {
  phone: string
  digits: string
  last_at: string
  message_count: number
  unread_count: number
  needs_reply: boolean
  customer_name: string | null
  project_id: number | null
  project_status: string | null
  last_message: LastMessage | null
}
interface Response { rows: Thread[]; total_unread: number }

const auth = useAuthStore()
function hdrs() { return { Authorization: `Bearer ${auth.token}` } }

const rows = ref<Thread[]>([])
const totalUnread = ref(0)
const loading = ref(false)
const collapsed = ref(false)

const COLLAPSE_KEY = 'comms.recent.collapsed'

const smsThread = ref<{ open: boolean; number: string; name: string }>({ open: false, number: '', name: '' })

async function load() {
  loading.value = true
  try {
    const res = await fetch('/api/dialpad/recent-threads?limit=15', { headers: hdrs() })
    if (!res.ok) return
    const data = await res.json() as Response
    rows.value = data.rows
    totalUnread.value = data.total_unread
  } finally { loading.value = false }
}

// Refresh on a slow cadence — webhooks update the underlying tables, but
// this list is a digest so 60s polling is fine. Skipped while the dialog
// is open since marking a message read while we're polling would race.
let refreshTimer: ReturnType<typeof setInterval> | null = null
onMounted(async () => {
  collapsed.value = localStorage.getItem(COLLAPSE_KEY) === '1'
  await load()
  refreshTimer = setInterval(() => { if (!smsThread.value.open) void load() }, 60_000)
})
onBeforeUnmount(() => { if (refreshTimer) clearInterval(refreshTimer) })

function toggleCollapsed() {
  collapsed.value = !collapsed.value
  localStorage.setItem(COLLAPSE_KEY, collapsed.value ? '1' : '0')
}

function openThread(t: Thread) {
  const name = t.customer_name || formatPhone(t.phone)
  smsThread.value = { open: true, number: t.phone, name }
}

// On thread close, refresh — the user's read marks may have changed.
function onThreadClose() {
  smsThread.value.open = false
  void load()
}

const needsReplyCount = computed(() => rows.value.filter(r => r.needs_reply).length)

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z')
  if (isNaN(d.getTime())) return ''
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  if (days < 30) return `${days}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function shortBody(body: string | null): string {
  if (!body) return ''
  const trimmed = body.trim()
  return trimmed.length > 100 ? trimmed.slice(0, 100) + '…' : trimmed
}
</script>

<template>
  <div v-if="rows.length > 0" class="recent-threads rounded-xl border bg-card overflow-hidden">
    <!-- Header — clickable to collapse/expand. Needs-reply badge sits next
         to the title so the user spots pending texts even when collapsed. -->
    <button
      type="button"
      class="w-full px-3 py-2 flex items-center justify-between gap-2 cursor-pointer hover:bg-muted/30 transition-colors"
      @click="toggleCollapsed"
    >
      <div class="flex items-center gap-2 min-w-0">
        <component :is="DtIconMessage" class="w-3.5 h-3.5 text-violet-600 shrink-0" />
        <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground truncate">My recent threads</p>
        <span
          v-if="needsReplyCount > 0"
          class="
            inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full
            text-[10px] font-bold tabular-nums leading-none
            bg-rose-500/15 text-rose-700 dark:text-rose-300
          "
        >
          <component :is="DtIconBellRing" class="w-3 h-3" />
          {{ needsReplyCount }} need{{ needsReplyCount === 1 ? 's' : '' }} reply
        </span>
        <span
          v-else-if="totalUnread > 0"
          class="
            inline-flex items-center px-1.5 py-0.5 rounded-full
            text-[10px] font-bold tabular-nums leading-none
            bg-sky-500/15 text-sky-700 dark:text-sky-300
          "
        >
          {{ totalUnread }} unread
        </span>
      </div>
      <span class="text-[10px] text-muted-foreground tabular-nums shrink-0">
        {{ rows.length }} thread{{ rows.length === 1 ? '' : 's' }}
        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="inline ml-1 transition-transform" :class="collapsed ? '' : 'rotate-180'"><polyline points="6 9 12 15 18 9"/></svg>
      </span>
    </button>

    <!-- List — scrollable when many rows, hidden when collapsed -->
    <div v-show="!collapsed" class="max-h-[42vh] overflow-y-auto divide-y border-t">
      <button
        v-for="r in rows"
        :key="r.phone"
        type="button"
        class="w-full text-left px-3 py-2.5 hover:bg-muted/40 transition-colors cursor-pointer min-w-0 flex items-start gap-2"
        @click="openThread(r)"
      >
        <!-- Unread dot — solid rose when needs reply, sky when there's any
             unread, hidden otherwise. Mirrors the Live Activity dot pattern. -->
        <span
          class="size-2 rounded-full shrink-0 mt-1.5"
          :class="r.needs_reply ? 'bg-rose-500' : (r.unread_count > 0 ? 'bg-sky-500' : 'bg-transparent')"
          :aria-label="r.needs_reply ? 'Needs reply' : (r.unread_count > 0 ? 'Unread' : '')"
        />
        <div class="flex-1 min-w-0">
          <div class="flex items-baseline gap-2 min-w-0">
            <p class="text-[13px] font-semibold truncate min-w-0" :class="r.needs_reply ? 'text-foreground' : ''">
              {{ r.customer_name || formatPhone(r.phone) }}
            </p>
            <span
              v-if="r.unread_count > 0"
              class="text-[10px] font-bold tabular-nums leading-none px-1.5 py-0.5 rounded-full shrink-0"
              :class="r.needs_reply ? 'bg-rose-500 text-white' : 'bg-sky-500 text-white'"
            >{{ r.unread_count }}</span>
            <span class="text-[10px] text-muted-foreground tabular-nums shrink-0 ml-auto">{{ timeAgo(r.last_at) }}</span>
          </div>
          <div v-if="r.project_status" class="text-[10.5px] text-muted-foreground tabular-nums truncate mt-0.5">
            {{ formatPhone(r.phone) }} · {{ r.project_status }}
          </div>
          <div v-else class="text-[10.5px] text-muted-foreground tabular-nums truncate mt-0.5">
            {{ formatPhone(r.phone) }}
          </div>
          <p
            v-if="r.last_message?.body"
            class="mt-1 text-[11.5px] leading-snug line-clamp-2"
            :class="r.unread_count > 0 ? 'text-foreground' : 'text-muted-foreground'"
          >
            <span v-if="r.last_message.direction === 'outgoing'" class="text-emerald-700 dark:text-emerald-400 font-medium">You: </span>
            {{ shortBody(r.last_message.body) }}
          </p>
        </div>
      </button>
    </div>

    <SmsThreadDialog
      :open="smsThread.open"
      :external-number="smsThread.number"
      :contact-name="smsThread.name"
      @close="onThreadClose"
    />
  </div>
</template>
