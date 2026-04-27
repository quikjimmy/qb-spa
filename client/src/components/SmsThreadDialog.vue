<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { formatPhone } from '@/lib/callBuckets'
import { useSmsThread, type ThreadMessage } from '@/composables/useSmsThread'
import { useAuthStore } from '@/stores/auth'

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

const externalNumberRef = computed(() => props.externalNumber)
const {
  messages, hasMore, loading, loadingOlder, error,
  isEmpty, isStatusOnly, textCount,
  loadInitial, loadOlder,
} = useSmsThread(externalNumberRef)

// ─── Virtualized list ──────────────────────────────────────
// We render every message + day separator + status pill as a discrete
// virtual row. tanstack-virtual measures actual heights via measureElement
// so 1000+ messages stays smooth.
type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'msg'; key: string; msg: ThreadMessage; showTime: boolean; groupTop: boolean; groupBottom: boolean }

const rows = computed<Row[]>(() => {
  const out: Row[] = []
  let lastDay = ''
  let lastTs = 0
  let lastDirection = ''
  for (let i = 0; i < messages.value.length; i++) {
    const m = messages.value[i]!
    const d = parseTs(m.received_at)
    if (!d) continue
    const ymd = d.toISOString().slice(0, 10)
    if (ymd !== lastDay) {
      out.push({ kind: 'day', key: `day-${ymd}`, label: dayLabel(d) })
      lastDay = ymd
      lastTs = 0
      lastDirection = ''
    }
    const showTime = d.getTime() - lastTs > 5 * 60_000
    const next = messages.value[i + 1]
    const sameNextAuthor = !!next && next.direction === m.direction
    const samePrevAuthor = lastDirection === m.direction
    out.push({
      kind: 'msg',
      key: `m-${m.id}`,
      msg: m,
      showTime,
      groupTop: !samePrevAuthor,
      groupBottom: !sameNextAuthor,
    })
    lastTs = d.getTime()
    lastDirection = m.direction
  }
  return out
})

const scrollEl = ref<HTMLElement | null>(null)

const virtualizer = computed(() =>
  useVirtualizer({
    count: rows.value.length,
    getScrollElement: () => scrollEl.value,
    estimateSize: () => 56,
    overscan: 12,
    getItemKey: (i: number) => rows.value[i]?.key ?? i,
  }),
)

// ─── Initial load + open/close ─────────────────────────────
watch(() => [props.open, props.externalNumber], async ([open]) => {
  if (!open) return
  await loadInitial()
  await nextTick()
  // Wait one more tick so the virtualizer has measured before we jump.
  await nextTick()
  if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight
}, { immediate: true })

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

// ─── Composer (read-only this iteration) ───────────────────
const draft = ref('')
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
function trySend() { /* coming next iteration */ }

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
    <Transition
      enter-active-class="transition-all duration-200 ease-out motion-reduce:transition-none"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-all duration-150 ease-in motion-reduce:transition-none"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-[120] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-md"
        @click.self="close"
      >
        <Transition
          appear
          enter-active-class="transition-transform duration-300 ease-out motion-reduce:transition-none"
          enter-from-class="translate-y-6 sm:translate-y-2 opacity-0"
          enter-to-class="translate-y-0 opacity-100"
          leave-active-class="transition-transform duration-200 ease-in motion-reduce:transition-none"
          leave-from-class="translate-y-0 opacity-100"
          leave-to-class="translate-y-6 sm:translate-y-2 opacity-0"
        >
          <div
            v-if="open"
            class="
              relative flex flex-col overflow-hidden
              w-full h-[92vh] rounded-t-3xl
              sm:w-[440px] sm:h-[82vh] sm:rounded-3xl
              bg-card/95 supports-[backdrop-filter]:bg-card/85 backdrop-blur-2xl
              shadow-2xl shadow-black/30
              ring-1 ring-foreground/5
            "
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
              <p v-if="!hasMore && messages.length > 0" class="text-center text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60 py-3">
                Beginning of conversation
              </p>

              <!-- Loading older indicator -->
              <div v-if="loadingOlder" class="flex justify-center py-2">
                <div class="size-5 rounded-full border-2 border-foreground/15 border-t-foreground/60 animate-spin" />
              </div>

              <!-- States -->
              <p v-if="loading" class="text-center text-[11px] text-muted-foreground py-10">Loading thread…</p>
              <p v-else-if="error" class="text-center text-[11px] text-rose-600 py-10">{{ error }}</p>
              <p v-else-if="isEmpty" class="text-center text-[11px] text-muted-foreground py-10">No SMS recorded for this contact yet.</p>

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
                    <template v-else-if="rows[vrow.index]?.kind === 'msg'">
                      <div :class="(rows[vrow.index] as Extract<Row, { kind: 'msg' }>).groupTop ? 'mt-2.5' : 'mt-0.5'">
                        <p
                          v-if="(rows[vrow.index] as Extract<Row, { kind: 'msg' }>).showTime"
                          class="text-center text-[10px] text-muted-foreground/70 pt-1.5 pb-1 tabular-nums"
                        >{{ fmtTime((rows[vrow.index] as Extract<Row, { kind: 'msg' }>).msg.received_at) }}</p>

                        <!-- Real message: chat bubble -->
                        <template v-if="(rows[vrow.index] as Extract<Row, { kind: 'msg' }>).msg.body">
                          <div class="flex" :class="(rows[vrow.index] as Extract<Row, { kind: 'msg' }>).msg.direction === 'outgoing' ? 'justify-end' : 'justify-start'">
                            <div
                              class="max-w-[78%] px-3.5 py-2 text-[15px] leading-[1.35] tracking-[-0.01em] whitespace-pre-wrap break-words"
                              :class="(rows[vrow.index] as Extract<Row, { kind: 'msg' }>).msg.direction === 'outgoing'
                                ? `text-white bg-gradient-to-br from-sky-500 to-blue-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_2px_rgba(2,132,199,0.25)] ${(rows[vrow.index] as Extract<Row, { kind: 'msg' }>).groupBottom ? 'rounded-[18px] rounded-br-md' : 'rounded-[18px]'}`
                                : `text-foreground bg-foreground/[0.07] dark:bg-foreground/[0.10] ${(rows[vrow.index] as Extract<Row, { kind: 'msg' }>).groupBottom ? 'rounded-[18px] rounded-bl-md' : 'rounded-[18px]'}`"
                            >{{ (rows[vrow.index] as Extract<Row, { kind: 'msg' }>).msg.body }}</div>
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
                              :class="auth.isAdmin && (rows[vrow.index] as Extract<Row, { kind: 'msg' }>).msg.raw_preview ? 'hover:bg-foreground/10 cursor-pointer' : 'cursor-default'"
                              :disabled="!auth.isAdmin || !(rows[vrow.index] as Extract<Row, { kind: 'msg' }>).msg.raw_preview"
                              @click="(auth.isAdmin && (rows[vrow.index] as Extract<Row, { kind: 'msg' }>).msg.raw_preview) && (expandedRaw[(rows[vrow.index] as Extract<Row, { kind: 'msg' }>).msg.id] = !expandedRaw[(rows[vrow.index] as Extract<Row, { kind: 'msg' }>).msg.id])"
                            >
                              {{ (rows[vrow.index] as Extract<Row, { kind: 'msg' }>).msg.status || 'status' }}
                              ·
                              {{ (rows[vrow.index] as Extract<Row, { kind: 'msg' }>).msg.direction || 'sms' }}
                              <span v-if="auth.isAdmin && (rows[vrow.index] as Extract<Row, { kind: 'msg' }>).msg.raw_preview" class="ml-1 normal-case tracking-normal opacity-70">{{ expandedRaw[(rows[vrow.index] as Extract<Row, { kind: 'msg' }>).msg.id] ? '▾' : '▸' }} raw</span>
                            </button>
                            <!-- Always-visible backfill diagnostic for admins. -->
                            <p
                              v-if="auth.isAdmin && (rows[vrow.index] as Extract<Row, { kind: 'msg' }>).msg.lookup_error"
                              class="w-full max-w-[92%] text-[10px] text-rose-700 bg-rose-50 dark:bg-rose-500/10 dark:text-rose-300 rounded-md px-2 py-1.5 font-mono break-all leading-snug"
                            >API: {{ (rows[vrow.index] as Extract<Row, { kind: 'msg' }>).msg.lookup_error }}</p>
                            <!-- Raw payload, expand on click. -->
                            <pre
                              v-if="auth.isAdmin && expandedRaw[(rows[vrow.index] as Extract<Row, { kind: 'msg' }>).msg.id] && (rows[vrow.index] as Extract<Row, { kind: 'msg' }>).msg.raw_preview"
                              class="w-full max-w-[92%] text-[10px] leading-snug bg-foreground/[0.04] rounded-md p-2 whitespace-pre-wrap break-all font-mono text-muted-foreground/90"
                            >{{ (rows[vrow.index] as Extract<Row, { kind: 'msg' }>).msg.raw_preview }}</pre>
                          </div>
                        </template>
                      </div>
                    </template>
                  </div>
                </template>
              </div>
            </div>

            <!-- Composer — disabled this iteration; layout matches the
                 future send-from-app flow (textarea + attach + send). -->
            <footer
              class="
                relative shrink-0 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]
                bg-background/70 supports-[backdrop-filter]:bg-background/55 backdrop-blur-xl
                before:absolute before:inset-x-3 before:top-0 before:h-px
                before:bg-gradient-to-r before:from-transparent before:via-foreground/10 before:to-transparent
              "
            >
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
                    placeholder="Reply coming soon…"
                    class="block w-full resize-none bg-transparent text-[16px] leading-[1.35] placeholder:text-muted-foreground/70 focus:outline-none max-h-[140px] overflow-y-auto"
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
                  :disabled="!draft.trim() || true"
                  class="shrink-0 size-9 rounded-full grid place-items-center bg-gradient-to-br from-sky-500 to-blue-600 text-white shadow-[0_1px_2px_rgba(2,132,199,0.35)] disabled:from-foreground/15 disabled:to-foreground/15 disabled:text-muted-foreground disabled:shadow-none disabled:cursor-not-allowed transition-all"
                  title="Sending coming soon"
                  aria-label="Send message"
                  @click="trySend"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
                </button>
              </div>
              <p class="text-[10px] text-muted-foreground/60 mt-1 px-1">
                Replying via the portal is coming next — for now use the Dialpad app or tap call.
              </p>
            </footer>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>
