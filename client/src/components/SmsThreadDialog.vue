<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { formatPhone } from '@/lib/callBuckets'

// iOS-style SMS thread modal. Click a text in Live Activity or the Inbox
// and this opens a fullscreen-on-mobile / centered-on-desktop pane that
// shows every message we have between the Dialpad user and that contact.
//
// Outgoing: right-aligned, sky bubble, white text (the "I sent this" side).
// Incoming: left-aligned, neutral bubble (the "they sent this" side).
// Day separators between groups; tight time stamps on hover.

interface Props {
  externalNumber: string
  contactName?: string
  open: boolean
}
const props = defineProps<Props>()
const emit = defineEmits<{ (e: 'close'): void }>()

const auth = useAuthStore()

interface Message {
  id: number
  direction: 'incoming' | 'outgoing' | string
  body: string | null
  status: string | null
  user_email: string | null
  user_name: string | null
  external_number: string | null
  received_at: string
  is_read: number
}
const messages = ref<Message[]>([])
const textCount = ref(0)
const loading = ref(false)
const error = ref('')
const scrollEl = ref<HTMLElement | null>(null)

function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

async function load() {
  if (!props.open || !props.externalNumber) return
  loading.value = true
  error.value = ''
  try {
    const res = await fetch(`/api/dialpad/sms/thread?external_number=${encodeURIComponent(props.externalNumber)}&limit=200`, { headers: hdrs() })
    if (!res.ok) { error.value = `HTTP ${res.status}`; return }
    const data = await res.json() as { messages: Message[]; text_count?: number }
    messages.value = data.messages || []
    textCount.value = data.text_count ?? messages.value.filter(m => m.body).length
    // Scroll to bottom (latest) once layout settles.
    await nextTick()
    if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally { loading.value = false }
}

watch(() => [props.open, props.externalNumber], load)
onMounted(load)

// ── Day grouping + smart timestamp display ──
// Day rows separate the chronological stream into groups; msg rows wrap a
// single message with whether to render its timestamp above the bubble.
type RenderItem =
  | { kind: 'day'; label: string }
  | { kind: 'msg'; msg: Message; showTime: boolean }
const items = computed<RenderItem[]>(() => {
  const out: RenderItem[] = []
  let lastDay = ''
  let lastTs = 0
  for (const m of messages.value) {
    const d = new Date(m.received_at.replace(' ', 'T') + (m.received_at.endsWith('Z') ? '' : 'Z'))
    if (isNaN(d.getTime())) continue
    const ymd = d.toISOString().slice(0, 10)
    if (ymd !== lastDay) {
      out.push({ kind: 'day', label: dayLabel(d) })
      lastDay = ymd
      lastTs = 0
    }
    // Show a timestamp above the bubble if >5 min since the previous one.
    const showTime = d.getTime() - lastTs > 5 * 60_000
    lastTs = d.getTime()
    out.push({ kind: 'msg', msg: m, showTime })
  }
  return out
})

function dayLabel(d: Date): string {
  const today = new Date()
  const ymd = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
  if (ymd(d) === ymd(today)) return 'Today'
  const yest = new Date(today); yest.setDate(today.getDate() - 1)
  if (ymd(d) === ymd(yest)) return 'Yesterday'
  // This week → weekday name; older → "Mon, Apr 3" style.
  const days = Math.floor((today.getTime() - d.getTime()) / 86400_000)
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}
function fmtTime(ts: string): string {
  const d = new Date(ts.replace(' ', 'T') + (ts.endsWith('Z') ? '' : 'Z'))
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

const headerTitle = computed(() => props.contactName || formatPhone(props.externalNumber) || 'Conversation')
const headerSub = computed(() => props.contactName ? formatPhone(props.externalNumber) : '')

function close() { emit('close') }
function tel() { if (props.externalNumber) window.location.href = `tel:${props.externalNumber}` }
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-[120] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm" @click.self="close">
      <!-- Sheet style on mobile, centered card on desktop -->
      <div class="w-full sm:w-[420px] sm:max-h-[80vh] h-[92vh] sm:h-[80vh] bg-card sm:rounded-2xl rounded-t-2xl shadow-2xl flex flex-col overflow-hidden">
        <!-- iOS-style header -->
        <div class="px-3 py-2 border-b flex items-center gap-2 bg-muted/30">
          <button class="size-9 rounded-full hover:bg-muted/60 flex items-center justify-center -ml-1" title="Close" @click="close">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div class="flex-1 min-w-0 text-center">
            <p class="text-[14px] font-semibold truncate">{{ headerTitle }}</p>
            <p class="text-[10px] text-muted-foreground truncate">{{ headerSub }}</p>
          </div>
          <button class="size-9 rounded-full hover:bg-muted/60 flex items-center justify-center" title="Call" @click="tel">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
          </button>
        </div>

        <!-- Body / scrolling thread -->
        <div ref="scrollEl" class="flex-1 overflow-y-auto bg-background px-3 py-3 space-y-1.5">
          <p v-if="loading" class="text-center text-[11px] text-muted-foreground py-6">Loading thread…</p>
          <p v-else-if="error" class="text-center text-[11px] text-red-600 py-6">{{ error }}</p>
          <p v-else-if="messages.length === 0" class="text-center text-[11px] text-muted-foreground py-6">No SMS events recorded for this contact yet.</p>
          <!-- Diagnostic banner: when we received events but couldn't extract
               text from any of them, show that explicitly so the user knows
               activity exists but our parser isn't finding the body. -->
          <p v-else-if="textCount === 0" class="text-center text-[11px] text-amber-700 bg-amber-50 rounded px-3 py-2 mx-2">
            {{ messages.length }} SMS event<template v-if="messages.length !== 1">s</template> received but no readable text body —
            likely status pings (delivery / read receipts) only. The events are listed below.
          </p>

          <template v-for="(it, i) in items" :key="i">
            <!-- Day divider -->
            <div v-if="it.kind === 'day'" class="text-center pt-3 pb-1">
              <span class="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{{ it.label }}</span>
            </div>

            <!-- Message -->
            <template v-else>
              <p v-if="it.showTime" class="text-center text-[10px] text-muted-foreground/80 pt-2 pb-0.5">{{ fmtTime(it.msg.received_at) }}</p>
              <!-- Real message: chat bubble. -->
              <div v-if="it.msg.body" class="flex" :class="it.msg.direction === 'outgoing' ? 'justify-end' : 'justify-start'">
                <div
                  class="max-w-[78%] px-3 py-1.5 rounded-2xl text-[14px] leading-snug whitespace-pre-wrap break-words"
                  :class="it.msg.direction === 'outgoing'
                    ? 'bg-sky-500 text-white rounded-br-sm'
                    : 'bg-muted text-foreground rounded-bl-sm'"
                >{{ it.msg.body }}</div>
              </div>
              <!-- Status-only event: small centered pill so the user sees
                   that *something* happened without us pretending it was a
                   chat message. -->
              <div v-else class="flex justify-center">
                <span class="text-[10px] text-muted-foreground bg-muted/50 rounded-full px-2 py-0.5">
                  {{ it.msg.status || 'status' }} · {{ it.msg.direction || 'sms' }}
                </span>
              </div>
            </template>
          </template>
        </div>

        <!-- Footer hint — full reply send is a separate scope (needs Dialpad
             user_id mapping). For now we surface a quick-tel + a note. -->
        <div class="px-3 py-2 border-t bg-muted/20 text-[10px] text-muted-foreground flex items-center justify-between gap-2">
          <span>Replying via portal coming next — for now use the Dialpad app or tap the call icon.</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>
