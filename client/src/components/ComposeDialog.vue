<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { formatPhone } from '@/lib/callBuckets'
import DtIconClose from '@dialpad/dialtone-icons/vue3/close'
import DtIconMessage from '@dialpad/dialtone-icons/vue3/message'
import DtIconPhone from '@dialpad/dialtone-icons/vue3/phone'

interface Sender {
  dialpad_user_id: string
  name: string | null
  email: string | null
  number: string | null
  messages: number
  last_at: string | null
  is_me?: boolean
}

interface Props {
  open: boolean
  // Pre-filled phone — set when launched from a contact card / search row.
  prefillNumber?: string
  prefillName?: string
}
const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'sent', kind: 'sms' | 'call'): void
}>()

const auth = useAuthStore()
function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

const senders = ref<Sender[]>([])
const sendersLoading = ref(false)
const senderId = ref<string>('')
const toNumber = ref('')
const body = ref('')
const sending = ref(false)
const calling = ref(false)
const error = ref<string | null>(null)

const PREF_KEY = 'comms.preferredSenderId'

async function loadSenders() {
  sendersLoading.value = true
  try {
    const res = await fetch('/api/dialpad/senders', { headers: hdrs() })
    if (!res.ok) { senders.value = []; return }
    const data = await res.json() as { senders: Sender[]; default_sender_id: string | null }
    senders.value = data.senders
    // Sender resolution priority: stored preference → server default
    // (current user) → first available.
    const stored = localStorage.getItem(PREF_KEY)
    if (stored && senders.value.some(s => s.dialpad_user_id === stored)) {
      senderId.value = stored
    } else if (data.default_sender_id) {
      senderId.value = data.default_sender_id
    } else if (senders.value.length > 0) {
      senderId.value = senders.value[0]!.dialpad_user_id
    }
  } finally { sendersLoading.value = false }
}

watch(() => props.open, async (isOpen) => {
  if (!isOpen) return
  // Reset transient state on open. The sender persists across opens via
  // localStorage so the user doesn't have to re-pick every time.
  error.value = null
  body.value = ''
  toNumber.value = props.prefillNumber || ''
  if (senders.value.length === 0) await loadSenders()
})

watch(senderId, (v) => {
  if (v) localStorage.setItem(PREF_KEY, v)
})

const selectedSender = computed(() => senders.value.find(s => s.dialpad_user_id === senderId.value) || null)

// Recipient must contain at least 7 digits (international numbers vary —
// 7 is the smallest reasonable phone length we'll see in this product).
const toDigits = computed(() => toNumber.value.replace(/\D/g, ''))
const canSendText = computed(() => toDigits.value.length >= 7 && body.value.trim().length > 0 && !!senderId.value && !sending.value && !calling.value)
const canCall = computed(() => toDigits.value.length >= 7 && !!senderId.value && !sending.value && !calling.value)

function close() { if (!sending.value && !calling.value) emit('close') }

// Normalize to E.164: prepend "+1" if it looks like a 10-digit US number,
// otherwise just prepend "+" if missing. The Dialpad API also accepts raw
// digits with infer_country_code, but explicit E.164 is safer.
function toE164(input: string): string {
  const d = input.replace(/\D/g, '')
  if (input.trim().startsWith('+')) return '+' + d
  if (d.length === 10) return '+1' + d
  if (d.length === 11 && d.startsWith('1')) return '+' + d
  return '+' + d
}

async function trySendText() {
  if (!canSendText.value) return
  error.value = null
  sending.value = true
  try {
    const res = await fetch('/api/dialpad/sms/send', {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify({
        external_number: toE164(toNumber.value),
        text: body.value.trim(),
        user_id: senderId.value,
      }),
    })
    const data = await res.json().catch(() => ({})) as { error?: string; upstream_body?: string }
    if (!res.ok) {
      error.value = data.error || 'Send failed'
      return
    }
    emit('sent', 'sms')
    emit('close')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally { sending.value = false }
}

async function tryCall() {
  if (!canCall.value) return
  error.value = null
  calling.value = true
  try {
    const res = await fetch('/api/dialpad/call/initiate', {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify({
        to_number: toE164(toNumber.value),
        user_id: senderId.value,
      }),
    })
    const data = await res.json().catch(() => ({})) as { error?: string; upstream_body?: string }
    if (!res.ok) {
      error.value = data.error || 'Call failed'
      return
    }
    emit('sent', 'call')
    emit('close')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally { calling.value = false }
}

const headlineName = computed(() => props.prefillName || (toDigits.value.length >= 7 ? formatPhone(toNumber.value) : 'New conversation'))
</script>

<template>
  <Transition
    appear
    enter-active-class="transition-opacity duration-200 ease-out motion-reduce:transition-none"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition-opacity duration-200 ease-in motion-reduce:transition-none"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div
      v-if="open"
      class="fixed inset-0 z-[115] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-md"
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
            w-full rounded-t-3xl
            sm:w-[440px] sm:rounded-3xl
            bg-card/95 supports-[backdrop-filter]:bg-card/85 backdrop-blur-2xl
            shadow-2xl shadow-black/30
            ring-1 ring-foreground/5
          "
        >
          <div class="sm:hidden flex justify-center pt-2 pb-0 select-none">
            <div class="w-10 h-1 rounded-full bg-foreground/15" />
          </div>

          <!-- Header -->
          <div class="flex items-start justify-between gap-3 px-5 pt-5 pb-4">
            <div class="min-w-0">
              <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">New message</p>
              <h2 class="text-[18px] font-semibold leading-tight truncate mt-0.5">{{ headlineName }}</h2>
            </div>
            <button
              type="button"
              aria-label="Close"
              class="size-8 -mr-1 -mt-1 rounded-full hover:bg-foreground/5 active:bg-foreground/10 transition-colors flex items-center justify-center cursor-pointer shrink-0"
              :disabled="sending || calling"
              @click="close"
            >
              <component :is="DtIconClose" class="w-4 h-4" />
            </button>
          </div>

          <!-- To -->
          <div class="px-5 pb-3">
            <label class="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">To</label>
            <input
              v-model="toNumber"
              type="tel"
              placeholder="+1 555 123 4567"
              autocomplete="off"
              spellcheck="false"
              :disabled="sending || calling"
              class="w-full h-10 px-3 rounded-lg border bg-background text-[14px] tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          <!-- From -->
          <div class="px-5 pb-3">
            <label class="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">From</label>
            <select
              v-model="senderId"
              :disabled="sending || calling || sendersLoading"
              class="w-full h-10 px-3 rounded-lg border bg-background text-[14px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option v-if="sendersLoading" value="" disabled>Loading senders…</option>
              <option v-else-if="senders.length === 0" value="" disabled>No Dialpad senders found</option>
              <option v-for="s in senders" :key="s.dialpad_user_id" :value="s.dialpad_user_id">
                {{ s.name || s.email || `User ${s.dialpad_user_id}` }}{{ s.is_me ? ' (you)' : '' }}{{ s.number ? ` · ${formatPhone(s.number)}` : '' }}
              </option>
            </select>
            <p v-if="!sendersLoading && senders.length === 0" class="mt-1 text-[11px] text-muted-foreground">
              No senders are cached locally. Once any user texts via Dialpad, they'll appear here.
            </p>
          </div>

          <!-- Body (only required for SMS) -->
          <div class="px-5 pb-3">
            <label class="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Message</label>
            <textarea
              v-model="body"
              placeholder="Type to send a text. Leave empty if you only want to call."
              rows="4"
              :disabled="sending || calling"
              class="w-full px-3 py-2 rounded-lg border bg-background text-[14px] leading-snug resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          <!-- Error -->
          <div v-if="error" class="mx-5 mb-3 rounded-lg bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300 text-[12px] px-3 py-2 leading-snug">
            {{ error }}
          </div>

          <!-- Actions -->
          <div class="px-5 pt-1 pb-[max(1rem,env(safe-area-inset-bottom))] grid grid-cols-2 gap-2.5">
            <button
              type="button"
              class="
                inline-flex items-center justify-center gap-2 h-11 rounded-xl cursor-pointer font-semibold text-[14px]
                bg-gradient-to-br from-sky-500 to-blue-600 text-white
                shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_2px_6px_rgba(2,132,199,0.25)]
                hover:from-sky-400 hover:to-blue-500 active:scale-[0.98] transition-all
                disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100
              "
              :disabled="!canSendText"
              @click="trySendText"
            >
              <component :is="DtIconMessage" class="w-4 h-4" />
              {{ sending ? 'Sending…' : 'Send text' }}
            </button>
            <button
              type="button"
              class="
                inline-flex items-center justify-center gap-2 h-11 rounded-xl cursor-pointer font-semibold text-[14px]
                bg-gradient-to-br from-emerald-500 to-emerald-600 text-white
                shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_2px_6px_rgba(5,150,105,0.25)]
                hover:from-emerald-400 hover:to-emerald-500 active:scale-[0.98] transition-all
                disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100
              "
              :disabled="!canCall"
              @click="tryCall"
            >
              <component :is="DtIconPhone" class="w-4 h-4" />
              {{ calling ? 'Ringing…' : 'Call' }}
            </button>
          </div>
        </div>
      </Transition>
    </div>
  </Transition>
</template>
