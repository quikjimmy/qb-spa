<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { formatPhone, fmtTalkSec, BUCKET_META, type CallBucket } from '@/lib/callBuckets'
import { useSmsThread, type ThreadSms, type ThreadCall, type ThreadItem } from '@/composables/useSmsThread'
import { useAuthStore } from '@/stores/auth'
import { useDialpadLive } from '@/lib/dialpadLive'
import { parseMessageBody, bodyHasImage } from '@/lib/smsBody'

interface Props {
  externalNumber: string
  contactName?: string
  open: boolean
}
const props = defineProps<Props>()
const emit = defineEmits<{ (e: 'close'): void }>()

// ─── Thread state ──────────────────────────────────────────
const auth = useAuthStore()
const expandedRaw = ref<Record<number, boolean>>({})

// Sender state — picked by the user from a dropdown that lists every Dialpad
// identity (cached on /senders). Default resolves to the most-recent agent
// on the thread (primaryAgent), then to the current user, so a fresh thread
// can still send. The picker stays visible so the user can override.
interface Sender {
  dialpad_user_id: string
  name: string | null
  email: string | null
  number: string | null
  is_me?: boolean
}
const senders = ref<Sender[]>([])
const sendersLoaded = ref(false)
const sendersDefaultId = ref<string>('')
const senderId = ref<string>('')
const SENDER_PREF_KEY = 'comms.preferredSenderId'

const externalNumberRef = computed(() => props.externalNumber)
const {
  items, messages, hasMore, loading, loadingOlder, error,
  isEmpty, isStatusOnly, textCount,
  agents, primaryAgent,
  loadInitial, loadOlder, refreshLatest,
} = useSmsThread(externalNumberRef)

// ─── Live updates via SSE ───────────────────────────────────
// Subscribes to the singleton Dialpad event stream. When a webhook lands
// for this thread's external_number, debounced refreshLatest() pulls the
// new SMS / call-record into the timeline so the dialog stays current
// without a manual refresh.
const live = useDialpadLive()
let liveDebounce: ReturnType<typeof setTimeout> | null = null
let lastSeenLiveId = 0

function digitsLast10(s: string | null | undefined): string {
  return (s || '').replace(/\D/g, '').slice(-10)
}
const myDigits = computed(() => digitsLast10(props.externalNumber))

// ─── Filter pills (ALL / SMS / CALL) ───────────────────────
// Client-side filter on the unified item stream. Composer + sender stay
// available regardless of the active filter — sending always emits SMS.
type KindFilter = 'all' | 'sms' | 'call'
const kindFilter = ref<KindFilter>('all')
const filteredItems = computed(() => {
  if (kindFilter.value === 'all') return items.value
  return items.value.filter(i => i.kind === kindFilter.value)
})

// ─── Virtualized list ──────────────────────────────────────
// Rows are heterogeneous: day separators, SMS bubbles, and call cards. The
// virtualizer measures real heights via measureElement so a long history
// stays smooth even when call cards are taller than message bubbles.
type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'sms'; key: string; msg: ThreadSms; showTime: boolean; groupTop: boolean; groupBottom: boolean }
  | { kind: 'call'; key: string; call: ThreadCall }

// Track per-call expand state. A call card collapses to one line by
// default; tap to reveal the full event timing + recording controls.
const expandedCalls = ref<Record<string, boolean>>({})
function toggleCall(callId: string) {
  expandedCalls.value = { ...expandedCalls.value, [callId]: !expandedCalls.value[callId] }
}

const rows = computed<Row[]>(() => {
  const out: Row[] = []
  let lastDay = ''
  let lastTs = 0
  let lastDirection = ''
  let lastKind: 'sms' | 'call' | '' = ''
  for (let i = 0; i < filteredItems.value.length; i++) {
    const item = filteredItems.value[i]!
    const d = parseTs(item.at)
    if (!d) continue
    const ymd = d.toISOString().slice(0, 10)
    if (ymd !== lastDay) {
      out.push({ kind: 'day', key: `day-${ymd}`, label: dayLabel(d) })
      lastDay = ymd
      lastTs = 0
      lastDirection = ''
      lastKind = ''
    }
    if (item.kind === 'sms') {
      const showTime = d.getTime() - lastTs > 5 * 60_000 || lastKind !== 'sms'
      const next = filteredItems.value[i + 1] as ThreadItem | undefined
      const sameNextAuthor = !!next && next.kind === 'sms' && next.direction === item.direction
      const samePrevAuthor = lastKind === 'sms' && lastDirection === item.direction
      out.push({
        kind: 'sms',
        key: `sms-${item.id}`,
        msg: item,
        showTime,
        groupTop: !samePrevAuthor,
        groupBottom: !sameNextAuthor,
      })
      lastDirection = item.direction
    } else {
      out.push({ kind: 'call', key: `call-${item.call_id}`, call: item })
      lastDirection = ''
    }
    lastTs = d.getTime()
    lastKind = item.kind
  }
  return out
})

// Counts for the pill labels — pulled from the loaded window. They reflect
// what the user actually sees ("CALL 11" not "CALL 487 across all time").
const smsCount = computed(() => items.value.filter(i => i.kind === 'sms').length)
const callCount = computed(() => items.value.filter(i => i.kind === 'call').length)

// Derived call status label + icon-tone for the card. Reuses the bucket
// metadata table so the label stays consistent with Comms Hub drill-down.
function callMeta(call: ThreadCall) {
  const bucket = (call.bucket || 'other') as CallBucket
  const meta = BUCKET_META[bucket] || BUCKET_META['other']
  return { label: meta.label, color: meta.colorClass, bg: meta.bgClass, icon: meta.icon }
}

const recordingHref = (call: ThreadCall) =>
  `/api/dialpad/call/${encodeURIComponent(call.call_id)}/audio?token=${encodeURIComponent(auth.token || '')}`

const scrollEl = ref<HTMLElement | null>(null)

const virtualizer = computed(() =>
  useVirtualizer({
    count: rows.value.length,
    getScrollElement: () => scrollEl.value,
    // Estimate covers a typical SMS bubble or a collapsed call card. Real
    // heights are measured via measureElement so this is just the seed.
    estimateSize: () => 64,
    overscan: 12,
    getItemKey: (i: number) => rows.value[i]?.key ?? i,
  }),
)

async function loadSenders() {
  if (sendersLoaded.value) return
  try {
    const res = await fetch('/api/dialpad/senders', {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    if (!res.ok) return
    const data = await res.json() as { senders: Sender[]; default_sender_id: string | null }
    senders.value = data.senders
    sendersDefaultId.value = data.default_sender_id || ''
    sendersLoaded.value = true
  } catch { /* leave empty — composer falls back to primaryAgent */ }
}

// Resolve which sender to default to when the thread opens. Priority:
//   1. The most-recent agent on this thread (carbon-copy iMessage feel —
//      stay in the same conversation thread)
//   2. The user's stored preference from a previous compose session
//   3. The server-marked current-user sender (is_me)
//   4. First available sender
function resolveDefaultSender() {
  if (!senders.value.length) { senderId.value = ''; return }
  const known = (id: string) => senders.value.some(s => s.dialpad_user_id === id)
  const fromThread = primaryAgent.value?.dialpad_user_id
  if (fromThread && known(fromThread)) { senderId.value = fromThread; return }
  const stored = localStorage.getItem(SENDER_PREF_KEY)
  if (stored && known(stored)) { senderId.value = stored; return }
  if (sendersDefaultId.value && known(sendersDefaultId.value)) { senderId.value = sendersDefaultId.value; return }
  senderId.value = senders.value[0]!.dialpad_user_id
}

watch(senderId, (v) => {
  // Persist explicit user-driven overrides so cross-thread compose flows
  // remember the choice. Empty values aren't saved.
  if (v) localStorage.setItem(SENDER_PREF_KEY, v)
})

// ─── Initial load + open/close ─────────────────────────────
watch(() => [props.open, props.externalNumber], async ([open]) => {
  if (!open) return
  // Run senders fetch + thread load in parallel so the picker is ready by
  // the time the messages render.
  await Promise.all([loadInitial(), loadSenders()])
  resolveDefaultSender()
  await nextTick()
  // Wait one more tick so the virtualizer has measured before we jump.
  await nextTick()
  if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight
  // Auto-focus the composer — iMessage-style, the user can start typing
  // without an extra tap. Skipped for the no-sender edge case so a typed
  // message doesn't fail to send.
  if (senderId.value && taRef.value) {
    taRef.value.focus({ preventScroll: true })
  }
}, { immediate: true })

// Re-resolve the sender when primaryAgent loads after the senders list does
// (network race). Without this, a fresh thread could land on the wrong line.
watch(primaryAgent, () => {
  if (props.open && sendersLoaded.value) resolveDefaultSender()
})

// Live-update subscriber. We watch the singleton SSE events ref; whenever a
// new event for this contact arrives we debounce a refreshLatest() so a
// burst (call ringing → connected → ended) only triggers one fetch.
watch(() => live.events.value, (evs) => {
  if (!props.open || !myDigits.value) return
  // Find any genuinely-new event for this thread (id > last seen, digits
  // suffix matches our external_number). The events ref is module-level
  // and shared with the Live Activity panel — multiple threads watching
  // it is fine, each filters down to its own contact.
  let matched = false
  let highestId = lastSeenLiveId
  for (const e of evs) {
    if (e.id <= lastSeenLiveId) continue
    if (e.id > highestId) highestId = e.id
    if (digitsLast10(e.external_number) === myDigits.value) matched = true
  }
  lastSeenLiveId = highestId
  if (!matched) return
  if (liveDebounce) clearTimeout(liveDebounce)
  liveDebounce = setTimeout(async () => {
    const { added } = await refreshLatest()
    if (added <= 0) return
    // Always scroll the new arrival into view — the user expects iMessage
    // behavior where the bottom always tracks the latest exchange.
    await nextTick()
    await nextTick()
    const el = scrollEl.value
    if (el) el.scrollTop = el.scrollHeight
  }, 500)
}, { deep: false })

onBeforeUnmount(() => {
  if (liveDebounce) clearTimeout(liveDebounce)
})

// ─── Load older when the user scrolls near the top ─────────
let topObserver: IntersectionObserver | null = null
const topSentinel = ref<HTMLElement | null>(null)
watch([topSentinel, () => props.open], ([el, open]) => {
  if (topObserver) { topObserver.disconnect(); topObserver = null }
  if (!el || !open) return
  topObserver = new IntersectionObserver(async (entries) => {
    if (!entries[0]?.isIntersecting) return
    if (!hasMore.value || loadingOlder.value) return
    const container = scrollEl.value
    if (!container) return
    const prevHeight = container.scrollHeight
    const prevTop = container.scrollTop
    const { added } = await loadOlder()
    if (added <= 0) return
    await nextTick()
    await nextTick()
    container.scrollTop = container.scrollHeight - prevHeight + prevTop
  }, { root: scrollEl.value, rootMargin: '200px 0px 0px 0px', threshold: 0 })
  topObserver.observe(el)
})
onBeforeUnmount(() => topObserver?.disconnect())

// ─── Composer ──────────────────────────────────────────────
const draft = ref('')
const sending = ref(false)
const sendError = ref('')
const taRef = ref<HTMLTextAreaElement | null>(null)
function autoGrow() {
  const ta = taRef.value
  if (!ta) return
  ta.style.height = 'auto'
  ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`
}
const segments = computed(() => {
  const len = draft.value.length
  if (!len) return 0
  const hasUnicode = /[^\x00-\x7F]/.test(draft.value)
  return Math.ceil(len / (hasUnicode ? 70 : 160))
})
const canSend = computed(() => !!draft.value.trim() && !!senderId.value && !sending.value)
async function trySend() {
  if (!canSend.value) return
  const text = draft.value.trim()
  const userId = senderId.value
  if (!text || !userId) return
  sending.value = true
  sendError.value = ''
  try {
    const res = await fetch('/api/dialpad/sms/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        external_number: props.externalNumber,
        text,
        user_id: userId,
      }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string; upstream_body?: string }
      sendError.value = body.error || `Send failed (${res.status})`
      return
    }
    draft.value = ''
    if (taRef.value) taRef.value.style.height = 'auto'
    // Pull the latest thread so the new outgoing bubble shows. The
    // server pre-cached the message, so this is a quick local read.
    await loadInitial()
    await nextTick()
    if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight
  } catch (e) {
    sendError.value = e instanceof Error ? e.message : String(e)
  } finally {
    sending.value = false
  }
}

// ─── Bubble action menu (long-press / right-click) ────────
// Slack-style "remind me about this", plus mark-as-unread + save-contact.
// Triggered by long-press on touch (500ms hold) or right-click on desktop.
interface ActionMenuState {
  open: boolean
  x: number
  y: number
  msg: ThreadSms | null
}
const actionMenu = ref<ActionMenuState>({ open: false, x: 0, y: 0, msg: null })
let longPressTimer: ReturnType<typeof setTimeout> | null = null
let longPressOriginX = 0
let longPressOriginY = 0
const LONG_PRESS_MS = 500
const LONG_PRESS_TOLERANCE = 8 // px movement before we cancel

function startLongPress(e: PointerEvent, msg: ThreadSms) {
  // Skip mouse non-primary buttons — desktop uses contextmenu instead.
  if (e.pointerType === 'mouse' && e.button !== 0) return
  longPressOriginX = e.clientX
  longPressOriginY = e.clientY
  longPressTimer = setTimeout(() => {
    actionMenu.value = { open: true, x: e.clientX, y: e.clientY, msg }
    longPressTimer = null
  }, LONG_PRESS_MS)
}
function maybeCancelLongPress(e: PointerEvent) {
  if (!longPressTimer) return
  // Tolerate small wiggles, cancel on a real drag (scroll) so the menu
  // doesn't fire when the user is just moving the list.
  if (Math.hypot(e.clientX - longPressOriginX, e.clientY - longPressOriginY) > LONG_PRESS_TOLERANCE) {
    cancelLongPress()
  }
}
function cancelLongPress() {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null }
}
function onContextMenu(e: MouseEvent, msg: ThreadSms) {
  e.preventDefault()
  actionMenu.value = { open: true, x: e.clientX, y: e.clientY, msg }
}
function closeActionMenu() {
  actionMenu.value = { open: false, x: 0, y: 0, msg: null }
}

// Position the menu so it stays inside the viewport. We measure after the
// browser paints; nudge up/left if it would clip.
const menuEl = ref<HTMLElement | null>(null)
const menuStyle = computed(() => ({
  top: `${actionMenu.value.y}px`,
  left: `${actionMenu.value.x}px`,
}))
watch(() => actionMenu.value.open, async (open) => {
  if (!open) return
  await nextTick()
  const el = menuEl.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  let { x, y } = actionMenu.value
  if (rect.right > vw - 8) x = vw - rect.width - 8
  if (rect.bottom > vh - 8) y = vh - rect.height - 8
  if (x < 8) x = 8
  if (y < 8) y = 8
  if (x !== actionMenu.value.x || y !== actionMenu.value.y) {
    actionMenu.value.x = x
    actionMenu.value.y = y
  }
})

// ─── Action handlers ──────────────────────────────────────
const markBusy = ref(false)
async function markCurrentUnread() {
  const m = actionMenu.value.msg
  if (!m || markBusy.value) return
  markBusy.value = true
  try {
    await fetch(`/api/dialpad/events/${m.id}/read`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${auth.token}` },
    })
  } finally {
    markBusy.value = false
    closeActionMenu()
  }
}

// Reminder presets — minutes from now. "Later today" / "Tomorrow" / "Custom"
// build absolute timestamps via small helpers below.
async function scheduleReminderMinutes(mins: number) {
  await scheduleReminder(new Date(Date.now() + mins * 60_000))
}
async function scheduleLaterToday() {
  // "Later today" = 5pm in local time, or +3 hours if past 4pm to ensure
  // a future timestamp. Slack uses similar logic.
  const now = new Date()
  const candidate = new Date(now)
  candidate.setHours(17, 0, 0, 0)
  if (candidate.getTime() <= now.getTime() + 30 * 60_000) {
    candidate.setTime(now.getTime() + 3 * 60 * 60_000)
  }
  await scheduleReminder(candidate)
}
async function scheduleTomorrow() {
  // 9am local tomorrow.
  const now = new Date()
  const candidate = new Date(now)
  candidate.setDate(candidate.getDate() + 1)
  candidate.setHours(9, 0, 0, 0)
  await scheduleReminder(candidate)
}

const customPickerOpen = ref(false)
const customPickerValue = ref('')
function openCustomPicker() {
  // Default to ~tomorrow 9am rendered as datetime-local string.
  const t = new Date()
  t.setDate(t.getDate() + 1)
  t.setHours(9, 0, 0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  customPickerValue.value = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`
  customPickerOpen.value = true
}
async function submitCustomPicker() {
  const v = customPickerValue.value
  if (!v) return
  const t = new Date(v)
  if (isNaN(t.getTime())) return
  await scheduleReminder(t)
  customPickerOpen.value = false
}

const reminderToast = ref<{ open: boolean; text: string }>({ open: false, text: '' })
let toastTimer: ReturnType<typeof setTimeout> | null = null
function showToast(text: string) {
  reminderToast.value = { open: true, text }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { reminderToast.value.open = false }, 3500)
}

async function scheduleReminder(at: Date) {
  const m = actionMenu.value.msg
  if (!m) return
  try {
    const res = await fetch(`/api/dialpad/events/${m.id}/remind`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ remind_at: at.toISOString() }),
    })
    if (res.ok) {
      showToast(`Reminder set for ${at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`)
    } else {
      const err = await res.json().catch(() => ({})) as { error?: string }
      showToast(`Reminder failed: ${err.error || res.status}`)
    }
  } catch (e) {
    showToast(`Reminder failed: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    closeActionMenu()
  }
}

// ─── Save contact (inline form) ───────────────────────────
const saveOpen = ref(false)
const saveFirst = ref('')
const saveLast = ref('')
const saveBusy = ref(false)
const saveError = ref<string | null>(null)
const saveSuccess = ref(false)
function startSaveFromMenu() {
  closeActionMenu()
  // Best-effort name split from contactName prop.
  const nm = (props.contactName || '').trim()
  if (nm) {
    const i = nm.indexOf(' ')
    if (i > 0) { saveFirst.value = nm.slice(0, i); saveLast.value = nm.slice(i + 1) }
    else { saveFirst.value = nm; saveLast.value = '' }
  } else {
    saveFirst.value = ''
    saveLast.value = ''
  }
  saveError.value = null
  saveSuccess.value = false
  saveOpen.value = true
}
async function trySaveContact() {
  if (!saveFirst.value.trim()) { saveError.value = 'First name required'; return }
  saveError.value = null
  saveBusy.value = true
  try {
    const res = await fetch('/api/dialpad/contact/save', {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: props.externalNumber,
        first_name: saveFirst.value.trim(),
        last_name: saveLast.value.trim() || undefined,
      }),
    })
    const data = await res.json().catch(() => ({})) as { error?: string }
    if (!res.ok) { saveError.value = data.error || 'Failed to save'; return }
    saveSuccess.value = true
    saveOpen.value = false
    showToast('Contact saved to Dialpad')
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : String(e)
  } finally { saveBusy.value = false }
}

// ─── Header derivations ────────────────────────────────────
const headerTitle = computed(() => props.contactName || formatPhone(props.externalNumber) || 'Conversation')
const headerSub = computed(() => props.contactName ? formatPhone(props.externalNumber) || '' : '')
const initials = computed(() => {
  const name = (props.contactName || '').trim()
  if (name) {
    const parts = name.split(/\s+/).slice(0, 2)
    return parts.map(p => p[0] || '').join('').toUpperCase()
  }
  const digits = (props.externalNumber || '').replace(/\D/g, '')
  return digits.slice(-2) || '#'
})

// ─── Helpers ───────────────────────────────────────────────
function parseTs(ts: string): Date | null {
  const d = new Date(ts.replace(' ', 'T') + (ts.endsWith('Z') ? '' : 'Z'))
  return isNaN(d.getTime()) ? null : d
}
function dayLabel(d: Date): string {
  const today = new Date()
  const ymd = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
  if (ymd(d) === ymd(today)) return 'Today'
  const yest = new Date(today); yest.setDate(today.getDate() - 1)
  if (ymd(d) === ymd(yest)) return 'Yesterday'
  const days = Math.floor((today.getTime() - d.getTime()) / 86400_000)
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}
function fmtTime(ts: string): string {
  const d = parseTs(ts); if (!d) return ''
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}
function close() { emit('close') }
function tel() { if (props.externalNumber) window.location.href = `tel:${props.externalNumber}` }
</script>

<template>
  <Teleport to="body">
    <!-- Mobile backdrop — dims behind, click to close. Hidden on sm+ so
         desktop becomes a right-side drawer that doesn't block the rest of
         the app (worker can keep clicking around while a thread is open). -->
    <Transition
      enter-active-class="transition-opacity duration-200 ease-out motion-reduce:transition-none"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-150 ease-in motion-reduce:transition-none"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-[119] bg-black/40 backdrop-blur-md sm:hidden"
        aria-hidden="true"
        @click="close"
      />
    </Transition>

    <Transition
      appear
      enter-active-class="transition-transform duration-300 ease-out motion-reduce:transition-none"
      enter-from-class="translate-y-full sm:translate-y-0 sm:translate-x-full"
      enter-to-class="translate-y-0 sm:translate-x-0"
      leave-active-class="transition-transform duration-250 ease-in motion-reduce:transition-none"
      leave-from-class="translate-y-0 sm:translate-x-0"
      leave-to-class="translate-y-full sm:translate-y-0 sm:translate-x-full"
    >
      <!-- Drawer panel.
           Mobile: bottom sheet at 92dvh (dynamic viewport height — handles
           keyboard show/hide on iOS without the layout breaking).
           Desktop: fixed right-side drawer, full screen height, no backdrop
           dim so the rest of the app stays usable. -->
      <div
        v-if="open"
        class="
          fixed z-[120]
          inset-x-0 bottom-0 max-h-[92dvh] h-[92dvh] rounded-t-3xl
          sm:inset-x-auto sm:inset-y-0 sm:right-0 sm:top-0 sm:bottom-0
          sm:w-[440px] sm:max-w-[90vw] sm:h-dvh sm:max-h-dvh
          sm:rounded-none sm:border-l sm:border-foreground/10
          flex flex-col overflow-hidden
          bg-card/95 supports-[backdrop-filter]:bg-card/85 backdrop-blur-xl
          shadow-2xl shadow-black/30
          ring-1 ring-foreground/5
          motion-reduce:transition-none
        "
        role="dialog"
        :aria-label="`Conversation with ${headerTitle}`"
      >
            <!-- Drag handle (mobile) -->
            <div class="sm:hidden flex justify-center pt-2 pb-0.5 select-none">
              <div class="w-10 h-1 rounded-full bg-foreground/15" />
            </div>

            <!-- Header — sticky glass with gradient hairline at the bottom -->
            <header
              class="
                relative flex items-center gap-3 px-4 py-3
                bg-background/70 supports-[backdrop-filter]:bg-background/55 backdrop-blur-xl
                before:absolute before:inset-x-3 before:bottom-0 before:h-px
                before:bg-gradient-to-r before:from-transparent before:via-foreground/10 before:to-transparent
              "
            >
              <button
                class="size-9 -ml-1 rounded-full hover:bg-foreground/5 active:bg-foreground/10 transition-colors flex items-center justify-center"
                aria-label="Close conversation"
                @click="close"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
              </button>

              <!-- Avatar — initials chip with subtle gradient -->
              <div
                class="
                  size-10 rounded-full flex items-center justify-center
                  bg-gradient-to-br from-sky-400/30 via-sky-500/20 to-violet-500/25
                  ring-1 ring-foreground/5
                  text-[13px] font-semibold tracking-tight text-foreground/85
                  select-none
                "
              >{{ initials }}</div>

              <div class="flex-1 min-w-0">
                <p class="text-[15px] font-semibold tracking-tight leading-tight truncate">{{ headerTitle }}</p>
                <p v-if="headerSub" class="text-[11px] text-muted-foreground tabular-nums truncate leading-tight mt-0.5">
                  {{ headerSub }}
                </p>
              </div>

              <button
                class="size-9 rounded-full hover:bg-foreground/5 active:bg-foreground/10 transition-colors flex items-center justify-center"
                aria-label="Call back"
                @click="tel"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
              </button>
            </header>

            <!-- Agent identity row — who on our side is in this thread,
                 and which Dialpad number was used. The primary agent
                 (most-recent) is the default reply-from identity for
                 the upcoming send-from-app flow. -->
            <div
              v-if="primaryAgent && (primaryAgent.name || primaryAgent.number)"
              class="flex items-center gap-2 px-4 py-2 text-[11px] bg-foreground/[0.025] border-b border-foreground/5 flex-wrap"
            >
              <span class="text-muted-foreground shrink-0">Texting via</span>
              <span v-if="primaryAgent.name" class="font-medium text-foreground truncate">{{ primaryAgent.name }}</span>
              <span v-if="primaryAgent.number" class="font-mono tabular-nums text-foreground/80 shrink-0">{{ formatPhone(primaryAgent.number) || primaryAgent.number }}</span>
              <span v-if="agents.length > 1" class="ml-auto text-[10px] text-muted-foreground shrink-0">+{{ agents.length - 1 }} other agent{{ agents.length === 2 ? '' : 's' }}</span>
            </div>

            <!-- Filter pills — switch the timeline between ALL / SMS / CALL.
                 Counts reflect the loaded window so the user knows when more
                 history is available behind the scroll. -->
            <div class="px-3 pt-2 flex items-center gap-1.5">
              <button
                type="button"
                class="px-2.5 py-0.5 rounded-full border text-[11px] font-medium transition-colors cursor-pointer"
                :class="kindFilter === 'all' ? 'bg-foreground text-background border-foreground' : 'bg-card hover:bg-muted'"
                @click="kindFilter = 'all'"
              >All<span class="ml-1 tabular-nums opacity-70">{{ items.length }}</span></button>
              <button
                type="button"
                class="px-2.5 py-0.5 rounded-full border text-[11px] font-medium transition-colors cursor-pointer"
                :class="kindFilter === 'sms' ? 'bg-foreground text-background border-foreground' : 'bg-card hover:bg-muted'"
                @click="kindFilter = 'sms'"
              >SMS<span class="ml-1 tabular-nums opacity-70">{{ smsCount }}</span></button>
              <button
                type="button"
                class="px-2.5 py-0.5 rounded-full border text-[11px] font-medium transition-colors cursor-pointer"
                :class="kindFilter === 'call' ? 'bg-foreground text-background border-foreground' : 'bg-card hover:bg-muted'"
                @click="kindFilter = 'call'"
              >Calls<span class="ml-1 tabular-nums opacity-70">{{ callCount }}</span></button>
              <span v-if="hasMore" class="ml-auto text-[10px] text-muted-foreground">scroll up for more</span>
            </div>

            <!-- Diagnostic banner: events received but no readable text -->
            <div
              v-if="!loading && isStatusOnly"
              class="px-3 pt-2"
            >
              <p class="text-[11px] text-amber-700 bg-amber-100/70 dark:bg-amber-500/10 dark:text-amber-300 rounded-md px-3 py-2 leading-snug">
                {{ messages.length }} SMS event<template v-if="messages.length !== 1">s</template> received, but no readable text body — likely status pings only. Events are listed below.
              </p>
            </div>

            <!-- Scrolling conversation -->
            <div
              ref="scrollEl"
              role="log"
              aria-live="polite"
              class="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 py-3"
            >
              <!-- Sentinel for IntersectionObserver: when this enters the
                   viewport (with a 200px rootMargin) we fetch older
                   messages. Hidden when there's nothing more to load. -->
              <div ref="topSentinel" v-if="hasMore" class="h-px" />

              <!-- Top-of-conversation marker -->
              <p v-if="!hasMore && items.length > 0" class="text-center text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60 py-3">
                Beginning of conversation
              </p>

              <!-- Loading older indicator -->
              <div v-if="loadingOlder" class="flex justify-center py-2">
                <div class="size-5 rounded-full border-2 border-foreground/15 border-t-foreground/60 animate-spin" />
              </div>

              <!-- States -->
              <p v-if="loading" class="text-center text-[11px] text-muted-foreground py-10">Loading thread…</p>
              <p v-else-if="error" class="text-center text-[11px] text-rose-600 py-10">{{ error }}</p>
              <p v-else-if="isEmpty" class="text-center text-[11px] text-muted-foreground py-10">No conversation history yet — start one below.</p>

              <!-- Virtualized rows -->
              <div
                v-else
                class="relative w-full"
                :style="{ height: virtualizer.value.getTotalSize() + 'px' }"
              >
                <template v-for="vrow in virtualizer.value.getVirtualItems()" :key="String(vrow.key)">
                  <div
                    :data-index="vrow.index"
                    :ref="(el) => virtualizer.value.measureElement(el as Element | null)"
                    class="absolute inset-x-0 px-0.5"
                    :style="{ transform: `translateY(${vrow.start}px)` }"
                  >
                    <!-- Day separator -->
                    <template v-if="rows[vrow.index]?.kind === 'day'">
                      <div class="flex justify-center my-3">
                        <span class="text-[10px] font-semibold tracking-[0.18em] uppercase text-muted-foreground/70">
                          {{ (rows[vrow.index] as Extract<Row, { kind: 'day' }>).label }}
                        </span>
                      </div>
                    </template>

                    <!-- Message -->
                    <template v-else-if="rows[vrow.index]?.kind === 'sms'">
                      <div :class="(rows[vrow.index] as Extract<Row, { kind: 'sms' }>).groupTop ? 'mt-2.5' : 'mt-0.5'">
                        <p
                          v-if="(rows[vrow.index] as Extract<Row, { kind: 'sms' }>).showTime"
                          class="text-center text-[10px] text-muted-foreground/70 pt-1.5 pb-1 tabular-nums"
                        >{{ fmtTime((rows[vrow.index] as Extract<Row, { kind: 'sms' }>).msg.received_at) }}</p>

                        <!-- Real message: chat bubble. Body is parsed into
                             text/image/link parts so MMS image URLs
                             (content.dialpad.com/s/img/...) render inline
                             instead of dumping raw URLs into the bubble. -->
                        <template v-if="(rows[vrow.index] as Extract<Row, { kind: 'sms' }>).msg.body">
                          <div class="flex" :class="(rows[vrow.index] as Extract<Row, { kind: 'sms' }>).msg.direction === 'outgoing' ? 'justify-end' : 'justify-start'">
                            <div
                              class="px-3.5 py-2 text-[15px] leading-[1.35] tracking-[-0.01em] break-words select-none"
                              :class="[
                                bodyHasImage((rows[vrow.index] as Extract<Row, { kind: 'sms' }>).msg.body) ? 'max-w-[88%]' : 'max-w-[78%]',
                                (rows[vrow.index] as Extract<Row, { kind: 'sms' }>).msg.direction === 'outgoing'
                                  ? `text-white bg-gradient-to-br from-sky-500 to-blue-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_2px_rgba(2,132,199,0.25)] ${(rows[vrow.index] as Extract<Row, { kind: 'sms' }>).groupBottom ? 'rounded-[18px] rounded-br-md' : 'rounded-[18px]'}`
                                  : `text-foreground bg-foreground/[0.07] dark:bg-foreground/[0.10] ${(rows[vrow.index] as Extract<Row, { kind: 'sms' }>).groupBottom ? 'rounded-[18px] rounded-bl-md' : 'rounded-[18px]'}`,
                              ]"
                              @pointerdown="startLongPress($event, (rows[vrow.index] as Extract<Row, { kind: 'sms' }>).msg)"
                              @pointerup="cancelLongPress"
                              @pointermove="maybeCancelLongPress"
                              @pointercancel="cancelLongPress"
                              @contextmenu="onContextMenu($event, (rows[vrow.index] as Extract<Row, { kind: 'sms' }>).msg)"
                            >
                              <template v-for="(part, pi) in parseMessageBody((rows[vrow.index] as Extract<Row, { kind: 'sms' }>).msg.body)" :key="pi">
                                <span v-if="part.kind === 'text'" class="whitespace-pre-wrap">{{ part.value }}</span>
                                <a
                                  v-else-if="part.kind === 'image'"
                                  :href="part.url" target="_blank" rel="noopener"
                                  class="block my-0.5 first:mt-0 last:mb-0"
                                >
                                  <img
                                    :src="part.url"
                                    loading="lazy"
                                    class="block max-w-full max-h-[280px] rounded-lg object-cover ring-1 ring-black/5 cursor-zoom-in"
                                    alt="MMS attachment"
                                  />
                                </a>
                                <a
                                  v-else
                                  :href="part.url" target="_blank" rel="noopener"
                                  class="underline underline-offset-2 break-all hover:opacity-80"
                                  :class="(rows[vrow.index] as Extract<Row, { kind: 'sms' }>).msg.direction === 'outgoing' ? 'text-white' : 'text-sky-600 dark:text-sky-400'"
                                  @click.stop
                                >{{ part.url }}</a>
                              </template>
                            </div>
                          </div>
                        </template>

                        <!-- Status-only event: compact centered pill.
                             Admins also see the backfill error inline
                             (always visible, no expand needed) so we can
                             diagnose API failures without hunting. -->
                        <template v-else>
                          <div class="flex flex-col items-center gap-1">
                            <button
                              type="button"
                              class="text-[10px] font-medium tracking-wider uppercase text-muted-foreground/80 px-2.5 py-0.5 rounded-full bg-foreground/[0.05] transition-colors"
                              :class="auth.isAdmin && (rows[vrow.index] as Extract<Row, { kind: 'sms' }>).msg.raw_preview ? 'hover:bg-foreground/10 cursor-pointer' : 'cursor-default'"
                              :disabled="!auth.isAdmin || !(rows[vrow.index] as Extract<Row, { kind: 'sms' }>).msg.raw_preview"
                              @click="(auth.isAdmin && (rows[vrow.index] as Extract<Row, { kind: 'sms' }>).msg.raw_preview) && (expandedRaw[(rows[vrow.index] as Extract<Row, { kind: 'sms' }>).msg.id] = !expandedRaw[(rows[vrow.index] as Extract<Row, { kind: 'sms' }>).msg.id])"
                            >
                              {{ (rows[vrow.index] as Extract<Row, { kind: 'sms' }>).msg.status || 'status' }}
                              ·
                              {{ (rows[vrow.index] as Extract<Row, { kind: 'sms' }>).msg.direction || 'sms' }}
                              <span v-if="auth.isAdmin && (rows[vrow.index] as Extract<Row, { kind: 'sms' }>).msg.raw_preview" class="ml-1 normal-case tracking-normal opacity-70">{{ expandedRaw[(rows[vrow.index] as Extract<Row, { kind: 'sms' }>).msg.id] ? '▾' : '▸' }} raw</span>
                            </button>
                            <!-- Always-visible backfill diagnostic for admins. -->
                            <p
                              v-if="auth.isAdmin && (rows[vrow.index] as Extract<Row, { kind: 'sms' }>).msg.lookup_error"
                              class="w-full max-w-[92%] text-[10px] text-rose-700 bg-rose-50 dark:bg-rose-500/10 dark:text-rose-300 rounded-md px-2 py-1.5 font-mono break-all leading-snug"
                            >API: {{ (rows[vrow.index] as Extract<Row, { kind: 'sms' }>).msg.lookup_error }}</p>
                            <!-- Raw payload, expand on click. -->
                            <pre
                              v-if="auth.isAdmin && expandedRaw[(rows[vrow.index] as Extract<Row, { kind: 'sms' }>).msg.id] && (rows[vrow.index] as Extract<Row, { kind: 'sms' }>).msg.raw_preview"
                              class="w-full max-w-[92%] text-[10px] leading-snug bg-foreground/[0.04] rounded-md p-2 whitespace-pre-wrap break-all font-mono text-muted-foreground/90"
                            >{{ (rows[vrow.index] as Extract<Row, { kind: 'sms' }>).msg.raw_preview }}</pre>
                          </div>
                        </template>
                      </div>
                    </template>

                    <!-- Call card — collapsible. One row per call_id; tap to
                         reveal duration breakdown + recording playback. -->
                    <template v-else-if="rows[vrow.index]?.kind === 'call'">
                      <div class="my-1.5">
                        <button
                          type="button"
                          class="w-full px-3 py-2 rounded-2xl bg-foreground/[0.04] hover:bg-foreground/[0.07] transition-colors flex items-start gap-2.5 text-left cursor-pointer"
                          @click="toggleCall((rows[vrow.index] as Extract<Row, { kind: 'call' }>).call.call_id)"
                        >
                          <span
                            class="size-7 shrink-0 rounded-full inline-flex items-center justify-center"
                            :class="callMeta((rows[vrow.index] as Extract<Row, { kind: 'call' }>).call).bg"
                          >
                            <component
                              :is="callMeta((rows[vrow.index] as Extract<Row, { kind: 'call' }>).call).icon"
                              class="w-3.5 h-3.5"
                              :class="callMeta((rows[vrow.index] as Extract<Row, { kind: 'call' }>).call).color"
                            />
                          </span>
                          <div class="flex-1 min-w-0">
                            <div class="flex items-baseline gap-2 min-w-0">
                              <p class="text-[13px] font-semibold truncate">
                                {{ callMeta((rows[vrow.index] as Extract<Row, { kind: 'call' }>).call).label }}
                              </p>
                              <span class="text-[11px] text-muted-foreground tabular-nums shrink-0 ml-auto">
                                {{ fmtTime((rows[vrow.index] as Extract<Row, { kind: 'call' }>).call.started_at) }}
                              </span>
                            </div>
                            <p class="text-[11px] text-muted-foreground tabular-nums mt-0.5">
                              <template v-if="(rows[vrow.index] as Extract<Row, { kind: 'call' }>).call.talk_time_sec > 0">
                                {{ fmtTalkSec((rows[vrow.index] as Extract<Row, { kind: 'call' }>).call.talk_time_sec) }} talk
                              </template>
                              <template v-else-if="(rows[vrow.index] as Extract<Row, { kind: 'call' }>).call.was_voicemail">
                                voicemail left
                              </template>
                              <template v-else>
                                no answer
                              </template>
                              <span v-if="(rows[vrow.index] as Extract<Row, { kind: 'call' }>).call.user_name">
                                · {{ (rows[vrow.index] as Extract<Row, { kind: 'call' }>).call.user_name }}
                              </span>
                              <span v-if="(rows[vrow.index] as Extract<Row, { kind: 'call' }>).call.was_recorded" class="ml-1 inline-flex items-center gap-0.5 text-rose-600 dark:text-rose-400">
                                <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>
                                rec
                              </span>
                            </p>
                          </div>
                          <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground shrink-0 mt-1.5 transition-transform" :class="expandedCalls[(rows[vrow.index] as Extract<Row, { kind: 'call' }>).call.call_id] ? 'rotate-180' : ''">
                            <polyline points="6 9 12 15 18 9"/>
                          </svg>
                        </button>

                        <!-- Expanded detail — duration breakdown + recording -->
                        <div
                          v-if="expandedCalls[(rows[vrow.index] as Extract<Row, { kind: 'call' }>).call.call_id]"
                          class="mt-1 ml-9 mr-3 px-3 py-2.5 rounded-xl bg-foreground/[0.025] space-y-2"
                        >
                          <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] tabular-nums">
                            <span class="text-muted-foreground">Direction</span>
                            <span class="capitalize">{{ (rows[vrow.index] as Extract<Row, { kind: 'call' }>).call.direction }}</span>
                            <span class="text-muted-foreground">Started</span>
                            <span>{{ fmtTime((rows[vrow.index] as Extract<Row, { kind: 'call' }>).call.started_at) }}</span>
                            <template v-if="(rows[vrow.index] as Extract<Row, { kind: 'call' }>).call.connected_at">
                              <span class="text-muted-foreground">Connected</span>
                              <span>{{ fmtTime((rows[vrow.index] as Extract<Row, { kind: 'call' }>).call.connected_at!) }}</span>
                            </template>
                            <template v-if="(rows[vrow.index] as Extract<Row, { kind: 'call' }>).call.ended_at">
                              <span class="text-muted-foreground">Ended</span>
                              <span>{{ fmtTime((rows[vrow.index] as Extract<Row, { kind: 'call' }>).call.ended_at!) }}</span>
                            </template>
                            <template v-if="(rows[vrow.index] as Extract<Row, { kind: 'call' }>).call.ring_time_sec > 0">
                              <span class="text-muted-foreground">Ring time</span>
                              <span>{{ fmtTalkSec((rows[vrow.index] as Extract<Row, { kind: 'call' }>).call.ring_time_sec) }}</span>
                            </template>
                            <template v-if="(rows[vrow.index] as Extract<Row, { kind: 'call' }>).call.talk_time_sec > 0">
                              <span class="text-muted-foreground">Talk time</span>
                              <span>{{ fmtTalkSec((rows[vrow.index] as Extract<Row, { kind: 'call' }>).call.talk_time_sec) }}</span>
                            </template>
                          </div>
                          <!-- Inline recording playback. Only rendered after
                               expand so we don't preload audio for every
                               call in the list. -->
                          <audio
                            v-if="(rows[vrow.index] as Extract<Row, { kind: 'call' }>).call.was_recorded"
                            :src="recordingHref((rows[vrow.index] as Extract<Row, { kind: 'call' }>).call)"
                            controls
                            preload="none"
                            class="w-full h-8"
                          />
                        </div>
                      </div>
                    </template>
                  </div>
                </template>
              </div>
            </div>

            <!-- Composer with sender picker. The picker stays visible so the
                 user can switch identity mid-thread (e.g., handing off to a
                 specialist). Pre-selected to the most-recent agent on this
                 thread, then to the current user when there's no prior
                 activity. -->
            <footer
              class="
                relative shrink-0 px-3 pt-2 pb-[max(1.25rem,calc(env(safe-area-inset-bottom)+0.75rem))] sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]
                bg-background/70 supports-[backdrop-filter]:bg-background/55 backdrop-blur-xl
                before:absolute before:inset-x-3 before:top-0 before:h-px
                before:bg-gradient-to-r before:from-transparent before:via-foreground/10 before:to-transparent
              "
            >
              <!-- From: row — small pill above the textarea. Hidden when no
                   senders are available (cold cache + no fetch yet). -->
              <div v-if="senders.length > 0" class="flex items-center gap-1.5 mb-2 px-1 text-[11px]">
                <span class="text-muted-foreground">From</span>
                <select
                  v-model="senderId"
                  :disabled="sending"
                  class="h-6 max-w-[260px] truncate rounded-md border bg-background/60 px-1.5 text-[11px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option v-for="s in senders" :key="s.dialpad_user_id" :value="s.dialpad_user_id">
                    {{ s.name || s.email || `User ${s.dialpad_user_id}` }}{{ s.is_me ? ' (you)' : '' }}{{ s.number ? ` · ${formatPhone(s.number)}` : '' }}
                  </option>
                </select>
              </div>

              <div class="flex items-end gap-2">
                <button
                  disabled
                  class="shrink-0 size-9 rounded-full text-muted-foreground/60 hover:bg-foreground/5 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                  title="Attachments coming soon"
                  aria-label="Attach file"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                </button>

                <div class="flex-1 min-w-0 rounded-3xl bg-foreground/[0.06] focus-within:bg-foreground/[0.09] transition-colors px-3.5 py-2">
                  <label class="sr-only" for="sms-composer">Message</label>
                  <textarea
                    id="sms-composer"
                    ref="taRef"
                    v-model="draft"
                    rows="1"
                    :maxlength="1600"
                    :disabled="sending"
                    :placeholder="senderId ? 'iMessage' : 'Pick a sender to start typing'"
                    class="block w-full resize-none bg-transparent text-[16px] leading-[1.35] placeholder:text-muted-foreground/70 focus:outline-none max-h-[140px] overflow-y-auto disabled:opacity-50"
                    @input="autoGrow"
                    @keydown.enter.exact.prevent="trySend"
                    @keydown.meta.enter.prevent="trySend"
                    @keydown.ctrl.enter.prevent="trySend"
                  />
                  <p
                    v-if="draft.length > 140"
                    class="text-[10px] tabular-nums text-muted-foreground/70 text-right -mt-0.5"
                  >{{ draft.length }} / {{ segments }} segment{{ segments === 1 ? '' : 's' }}</p>
                </div>

                <button
                  :disabled="!canSend"
                  class="shrink-0 size-9 rounded-full grid place-items-center bg-gradient-to-br from-sky-500 to-blue-600 text-white shadow-[0_1px_2px_rgba(2,132,199,0.35)] disabled:from-foreground/15 disabled:to-foreground/15 disabled:text-muted-foreground disabled:shadow-none disabled:cursor-not-allowed transition-all"
                  :title="sending ? 'Sending…' : (senderId ? 'Send' : 'Pick a sender first')"
                  aria-label="Send message"
                  @click="trySend"
                >
                  <svg v-if="sending" class="animate-spin" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg>
                  <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
                </button>
              </div>
              <p v-if="sendError" class="text-[10px] text-rose-600 mt-1 px-1">{{ sendError }}</p>
              <p v-else-if="!senderId && sendersLoaded && senders.length === 0" class="text-[10px] text-muted-foreground/60 mt-1 px-1">
                No Dialpad senders cached yet — open Compose to refresh the directory.
              </p>
            </footer>

            <!-- Inline Save-contact form. Shown over the composer when the
                 user picks "Save contact" from the long-press menu. -->
            <div
              v-if="saveOpen"
              class="absolute inset-x-0 bottom-0 z-[5] p-3 pb-[max(1rem,env(safe-area-inset-bottom))] bg-card/95 backdrop-blur-xl border-t border-foreground/10 shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.25)]"
            >
              <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Save to Dialpad contacts</p>
              <div class="grid grid-cols-2 gap-2 mb-2">
                <input
                  v-model="saveFirst"
                  type="text"
                  placeholder="First name"
                  autocomplete="given-name"
                  :disabled="saveBusy"
                  class="h-8 px-2 rounded-md border bg-background text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  @keydown.enter.prevent="trySaveContact"
                />
                <input
                  v-model="saveLast"
                  type="text"
                  placeholder="Last name"
                  autocomplete="family-name"
                  :disabled="saveBusy"
                  class="h-8 px-2 rounded-md border bg-background text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  @keydown.enter.prevent="trySaveContact"
                />
              </div>
              <div v-if="saveError" class="text-[11px] text-rose-700 dark:text-rose-300 mb-2">{{ saveError }}</div>
              <div class="flex justify-end gap-2">
                <button class="h-7 px-2.5 rounded-md text-[12px] text-muted-foreground hover:bg-foreground/5 cursor-pointer" :disabled="saveBusy" @click="saveOpen = false">Cancel</button>
                <button class="h-7 px-3 rounded-md text-[12px] font-semibold text-white bg-gradient-to-br from-sky-500 to-blue-600 hover:from-sky-400 hover:to-blue-500 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer" :disabled="saveBusy || !saveFirst.trim()" @click="trySaveContact">{{ saveBusy ? 'Saving…' : 'Save' }}</button>
              </div>
            </div>

            <!-- Custom reminder picker — shown when the user clicks Custom -->
            <div
              v-if="customPickerOpen"
              class="absolute inset-x-0 bottom-0 z-[5] p-3 pb-[max(1rem,env(safe-area-inset-bottom))] bg-card/95 backdrop-blur-xl border-t border-foreground/10 shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.25)]"
            >
              <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Remind me at</p>
              <input
                v-model="customPickerValue"
                type="datetime-local"
                class="w-full h-9 px-2 rounded-md border bg-background text-[14px] tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <div class="flex justify-end gap-2 mt-2">
                <button class="h-7 px-2.5 rounded-md text-[12px] text-muted-foreground hover:bg-foreground/5 cursor-pointer" @click="customPickerOpen = false">Cancel</button>
                <button class="h-7 px-3 rounded-md text-[12px] font-semibold text-white bg-gradient-to-br from-sky-500 to-blue-600 hover:from-sky-400 hover:to-blue-500 cursor-pointer" @click="submitCustomPicker">Set reminder</button>
              </div>
            </div>

            <!-- Toast for reminder confirmations / errors -->
            <Transition
              enter-active-class="transition-all duration-200 ease-out"
              enter-from-class="opacity-0 translate-y-2"
              enter-to-class="opacity-100 translate-y-0"
              leave-active-class="transition-opacity duration-200 ease-in"
              leave-from-class="opacity-100"
              leave-to-class="opacity-0"
            >
              <div
                v-if="reminderToast.open"
                class="absolute bottom-20 left-1/2 -translate-x-1/2 z-[6] px-3 py-2 rounded-full bg-foreground text-background text-[12px] font-medium shadow-lg whitespace-nowrap max-w-[85%] truncate"
              >{{ reminderToast.text }}</div>
            </Transition>
      </div>
    </Transition>

    <!-- Action menu — long-press / right-click on a message bubble. Lives
         outside the panel so positioning stays viewport-relative even when
         the panel is the right-side drawer. -->
    <div
      v-if="actionMenu.open"
      class="fixed inset-0 z-[124]"
      @click="closeActionMenu"
      @contextmenu.prevent="closeActionMenu"
    />
    <div
      v-if="actionMenu.open"
      ref="menuEl"
      class="fixed z-[125] w-56 rounded-xl bg-card/95 backdrop-blur-xl shadow-2xl ring-1 ring-foreground/10 py-1 select-none"
      :style="menuStyle"
      role="menu"
    >
      <button class="w-full px-3 py-2 text-left text-[13px] hover:bg-foreground/5 cursor-pointer" :disabled="markBusy" @click="markCurrentUnread">Mark as unread</button>
      <button class="w-full px-3 py-2 text-left text-[13px] hover:bg-foreground/5 cursor-pointer" @click="startSaveFromMenu">Save contact…</button>
      <div class="my-1 border-t border-foreground/10" />
      <p class="px-3 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Remind me</p>
      <button class="w-full px-3 py-1.5 text-left text-[13px] hover:bg-foreground/5 cursor-pointer" @click="scheduleReminderMinutes(10)">In 10 minutes</button>
      <button class="w-full px-3 py-1.5 text-left text-[13px] hover:bg-foreground/5 cursor-pointer" @click="scheduleReminderMinutes(30)">In 30 minutes</button>
      <button class="w-full px-3 py-1.5 text-left text-[13px] hover:bg-foreground/5 cursor-pointer" @click="scheduleReminderMinutes(60)">In 1 hour</button>
      <button class="w-full px-3 py-1.5 text-left text-[13px] hover:bg-foreground/5 cursor-pointer" @click="scheduleLaterToday">Later today</button>
      <button class="w-full px-3 py-1.5 text-left text-[13px] hover:bg-foreground/5 cursor-pointer" @click="scheduleTomorrow">Tomorrow</button>
      <button class="w-full px-3 py-1.5 text-left text-[13px] hover:bg-foreground/5 cursor-pointer" @click="closeActionMenu(); openCustomPicker()">Custom…</button>
    </div>
  </Teleport>
</template>
