<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useAuthStore } from '@/stores/auth'
import DtIconClose from '@dialpad/dialtone-icons/vue3/close'
import DtIconBookmark from '@dialpad/dialtone-icons/vue3/bookmark-filled'
import DtIconCheckCircle from '@dialpad/dialtone-icons/vue3/check-circle'

const props = defineProps<{
  open: boolean
  /** Optional pre-fill — when launched from a thread, the phone is locked. */
  prefillPhone?: string
  prefillName?: string
}>()
const emit = defineEmits<{ close: []; saved: [{ phone: string; first_name: string; last_name: string }] }>()

const auth = useAuthStore()

type ContactKind = 'customer' | 'employee' | 'crew' | 'supplier'
const KINDS: Array<{ value: ContactKind; label: string }> = [
  { value: 'customer', label: 'Customer' },
  { value: 'employee', label: 'Employee' },
  { value: 'crew',     label: 'Crew' },
  { value: 'supplier', label: 'Supplier' },
]

const phone = ref('')
const first = ref('')
const last = ref('')
const kind = ref<ContactKind | null>(null)
const saving = ref(false)
const error = ref<string | null>(null)
const success = ref(false)

const phoneInput = ref<HTMLInputElement | null>(null)
const firstInput = ref<HTMLInputElement | null>(null)

watch(() => props.open, async (o) => {
  if (!o) return
  // Reset form, then prefill, then focus the right field.
  error.value = null
  success.value = false
  saving.value = false
  phone.value = props.prefillPhone || ''
  // If prefillName is "First Last", split for convenience.
  if (props.prefillName) {
    const parts = props.prefillName.trim().split(/\s+/)
    first.value = parts[0] || ''
    last.value = parts.slice(1).join(' ')
  } else {
    first.value = ''
    last.value = ''
  }
  kind.value = null
  await nextTick()
  if (props.prefillPhone) firstInput.value?.focus()
  else phoneInput.value?.focus()
})

const phoneLocked = computed(() => !!props.prefillPhone)
const phoneDigits = computed(() => phone.value.replace(/\D/g, ''))
const canSave = computed(() => phoneDigits.value.length >= 10 && first.value.trim().length > 0 && !saving.value)

function close() {
  if (saving.value) return
  emit('close')
}

async function trySave() {
  if (!canSave.value) return
  error.value = null
  saving.value = true
  try {
    const res = await fetch('/api/dialpad/contact/save', {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: phone.value.trim(),
        first_name: first.value.trim(),
        last_name: last.value.trim(),
        kind: kind.value,
      }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({} as { error?: string; upstream_body?: string }))
      const upstream = (body.upstream_body || '').slice(0, 240)
      error.value = body.error
        ? (upstream ? `${body.error} — ${upstream}` : body.error)
        : `Save failed (${res.status}).`
      return
    }
    success.value = true
    emit('saved', {
      phone: phone.value.trim(),
      first_name: first.value.trim(),
      last_name: last.value.trim(),
    })
    // Auto-dismiss after the user sees the green check.
    setTimeout(() => emit('close'), 1400)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Network error'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <!-- Teleport to body so the dialog escapes any ancestor containing block.
       The Comms Hub and SmsThreadDialog drawer both use backdrop-filter,
       which creates a containing block for position:fixed descendants —
       without this teleport the sheet gets clipped to the drawer's 440px
       bounds instead of the viewport. -->
  <Teleport to="body">
    <!-- Backdrop -->
    <Transition
      appear
      enter-active-class="transition-opacity duration-200 ease-out motion-reduce:transition-none"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-150 ease-in motion-reduce:transition-none"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-[140] bg-black/40 backdrop-blur-md"
        aria-hidden="true"
        @click="close"
      />
    </Transition>

    <!-- Centering wrapper. Flex centers the panel: bottom-aligned on mobile
         (so it slides up like a sheet), centered on desktop. The wrapper
         is pointer-events-none so the click-through still hits the
         backdrop; the panel re-enables pointer events. -->
    <Transition
      appear
      enter-active-class="transition-all duration-300 ease-out motion-reduce:transition-none"
      enter-from-class="translate-y-6 opacity-0"
      enter-to-class="translate-y-0 opacity-100"
      leave-active-class="transition-all duration-200 ease-in motion-reduce:transition-none"
      leave-from-class="translate-y-0 opacity-100"
      leave-to-class="translate-y-6 opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-[141] flex items-end justify-center sm:items-center pointer-events-none"
      >
      <div
        class="
          w-full sm:w-[440px] sm:max-w-[calc(100vw-2rem)]
          max-h-[88dvh] sm:max-h-[calc(100vh-2rem)]
          rounded-t-3xl sm:rounded-3xl
          flex flex-col overflow-hidden
          bg-card/95 supports-[backdrop-filter]:bg-card/85 backdrop-blur-xl
          shadow-2xl shadow-black/30
          ring-1 ring-foreground/5
          pointer-events-auto
        "
        role="dialog"
        aria-modal="true"
        aria-label="Add contact"
      >
      <!-- Drag handle (mobile) -->
      <div class="sm:hidden flex justify-center pt-2 pb-0.5 select-none">
        <div class="w-10 h-1 rounded-full bg-foreground/15" />
      </div>

      <!-- Header -->
      <header
        class="
          relative flex items-center gap-3 px-4 py-3
          before:absolute before:inset-x-3 before:bottom-0 before:h-px
          before:bg-gradient-to-r before:from-transparent before:via-foreground/10 before:to-transparent
        "
      >
        <div class="
          size-9 rounded-full flex items-center justify-center shrink-0
          bg-gradient-to-br from-sky-400/30 via-sky-500/20 to-violet-500/25
          ring-1 ring-foreground/5
        ">
          <component :is="DtIconBookmark" class="w-4 h-4 text-sky-700 dark:text-sky-300" />
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Save contact</p>
          <h2 class="text-[15px] font-semibold tracking-tight truncate">Add to Dialpad</h2>
        </div>
        <button
          class="size-9 -mr-1 rounded-full hover:bg-foreground/5 active:bg-foreground/10 transition-colors flex items-center justify-center"
          aria-label="Close"
          :disabled="saving"
          @click="close"
        >
          <component :is="DtIconClose" class="w-4 h-4" />
        </button>
      </header>

      <!-- Body -->
      <div class="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        <!-- Phone -->
        <div class="space-y-1">
          <label class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground" for="add-contact-phone">Phone</label>
          <input
            id="add-contact-phone"
            ref="phoneInput"
            v-model="phone"
            type="tel"
            inputmode="tel"
            autocomplete="tel"
            placeholder="(555) 555-1212"
            :disabled="phoneLocked || saving"
            class="
              w-full h-10 px-3 rounded-lg bg-background text-[14px] tabular-nums
              ring-1 ring-foreground/10
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
              disabled:opacity-70 disabled:cursor-not-allowed
            "
            @keydown.enter.prevent="trySave"
          />
          <p v-if="phoneLocked" class="text-[10.5px] text-muted-foreground">From this conversation — phone is locked.</p>
          <p v-else-if="phone && phoneDigits.length < 10" class="text-[10.5px] text-muted-foreground">At least 10 digits required.</p>
        </div>

        <!-- First / Last name -->
        <div class="grid grid-cols-2 gap-2">
          <div class="space-y-1">
            <label class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground" for="add-contact-first">First name</label>
            <input
              id="add-contact-first"
              ref="firstInput"
              v-model="first"
              type="text"
              autocomplete="given-name"
              placeholder="Maria"
              :disabled="saving"
              class="
                w-full h-10 px-3 rounded-lg bg-background text-[14px]
                ring-1 ring-foreground/10
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
              "
              @keydown.enter.prevent="trySave"
            />
          </div>
          <div class="space-y-1">
            <label class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground" for="add-contact-last">Last name</label>
            <input
              id="add-contact-last"
              v-model="last"
              type="text"
              autocomplete="family-name"
              placeholder="de la Cruz"
              :disabled="saving"
              class="
                w-full h-10 px-3 rounded-lg bg-background text-[14px]
                ring-1 ring-foreground/10
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
              "
              @keydown.enter.prevent="trySave"
            />
          </div>
        </div>

        <!-- Type — optional, four pills. Drives the chip color on inbound
             rows (crew/employee get their own chips; customer/supplier
             render as plain external). -->
        <div class="space-y-1.5">
          <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Type <span class="font-normal text-muted-foreground/70 normal-case tracking-normal">(optional)</span></p>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="k in KINDS"
              :key="k.value"
              type="button"
              class="
                h-7 px-2.5 rounded-full text-[11.5px] font-medium
                ring-1 transition-colors cursor-pointer
                active:scale-[0.97]
              "
              :class="kind === k.value
                ? 'bg-foreground text-background ring-foreground'
                : 'bg-card hover:bg-muted ring-foreground/15 text-foreground'"
              :disabled="saving"
              @click="kind = kind === k.value ? null : k.value"
            >{{ k.label }}</button>
          </div>
        </div>

        <p class="text-[10.5px] text-muted-foreground leading-snug">
          Saved locally and pushed to your team's Dialpad address book. The name shows on future inbound events here and on each agent's Dialpad app.
        </p>

        <!-- Error -->
        <div
          v-if="error"
          class="rounded-lg bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300 px-3 py-2 text-[12px] leading-snug"
        >{{ error }}</div>

        <!-- Success -->
        <div
          v-if="success"
          class="inline-flex items-center gap-2 rounded-lg bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 px-3 py-2 text-[12px] font-medium"
        >
          <component :is="DtIconCheckCircle" class="w-4 h-4" />
          Saved to Dialpad.
        </div>
      </div>

      <!-- Sticky footer action -->
      <div class="
        px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]
        bg-background/70 supports-[backdrop-filter]:bg-background/55 backdrop-blur-xl
        before:absolute before:inset-x-3 before:top-0 before:h-px
        before:bg-gradient-to-r before:from-transparent before:via-foreground/10 before:to-transparent
        relative
      ">
        <button
          type="button"
          class="
            w-full h-11 rounded-xl text-[13.5px] font-semibold text-white
            bg-gradient-to-br from-sky-500 to-blue-600
            hover:from-sky-400 hover:to-blue-500
            active:scale-[0.985] transition-all
            disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100
            shadow-lg shadow-sky-500/20
          "
          :disabled="!canSave"
          @click="trySave"
        >{{ saving ? 'Saving…' : success ? 'Saved' : 'Save contact' }}</button>
      </div>
    </div>
      </div>
    </Transition>
  </Teleport>
</template>
