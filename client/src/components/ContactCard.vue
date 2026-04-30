<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { formatPhone, fmtTalkSec } from '@/lib/callBuckets'
import DtIconClose from '@dialpad/dialtone-icons/vue3/close'
import DtIconMessage from '@dialpad/dialtone-icons/vue3/message'
import DtIconPhone from '@dialpad/dialtone-icons/vue3/phone'
import DtIconBriefcase from '@dialpad/dialtone-icons/vue3/briefcase'
import DtIconBookmark from '@dialpad/dialtone-icons/vue3/bookmark-filled'
import DtIconCheckCircle from '@dialpad/dialtone-icons/vue3/check-circle'

interface SmsLatest {
  id: number
  at: string
  direction: string
  user_name: string | null
  body: string | null
}
interface CallLatest {
  call_id: string
  at: string
  direction: string
  user_name: string | null
  bucket: string
  talk_time_sec: number
  was_voicemail: boolean
  was_recorded: boolean
}
export interface ContactCardData {
  phone: string
  customer_name: string | null
  project_id: number | null
  project_status: string | null
  project_coordinator: string | null
  sms: SmsLatest | null
  call: CallLatest | null
}

interface Props { open: boolean; contact: ContactCardData | null }
const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'message'): void
  (e: 'view-call'): void
}>()

const router = useRouter()
const auth = useAuthStore()
function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

// Save-as-contact inline form. Closed by default; expanded when the user
// clicks "Save to Dialpad". Pre-fills first/last from `customer_name` if we
// have one (split on the first space — good enough for "First Last" most of
// the time; user can edit before submitting).
const saveOpen = ref(false)
const saveFirst = ref('')
const saveLast = ref('')
const saving = ref(false)
const saveError = ref<string | null>(null)
const saveSuccess = ref(false)

watch(() => props.open, (o) => {
  if (!o) {
    // Reset every time the card closes — next open should start fresh.
    saveOpen.value = false
    saveError.value = null
    saveSuccess.value = false
    saveFirst.value = ''
    saveLast.value = ''
  }
})

function startSave() {
  saveError.value = null
  saveSuccess.value = false
  // Best-effort name split. "Maria de la Cruz" → ("Maria", "de la Cruz").
  const name = props.contact?.customer_name || ''
  if (name) {
    const i = name.indexOf(' ')
    if (i > 0) { saveFirst.value = name.slice(0, i); saveLast.value = name.slice(i + 1) }
    else { saveFirst.value = name; saveLast.value = '' }
  } else {
    saveFirst.value = ''
    saveLast.value = ''
  }
  saveOpen.value = true
}

async function trySave() {
  if (!props.contact) return
  if (!saveFirst.value.trim()) { saveError.value = 'First name required'; return }
  saveError.value = null
  saving.value = true
  try {
    const res = await fetch('/api/dialpad/contact/save', {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify({
        phone: props.contact.phone,
        first_name: saveFirst.value.trim(),
        last_name: saveLast.value.trim() || undefined,
      }),
    })
    const data = await res.json().catch(() => ({})) as { error?: string }
    if (!res.ok) {
      saveError.value = data.error || 'Failed to save contact'
      return
    }
    saveSuccess.value = true
    saveOpen.value = false
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : String(e)
  } finally { saving.value = false }
}

const heading = computed(() => props.contact?.customer_name || (props.contact ? formatPhone(props.contact.phone) : ''))
const initials = computed(() => {
  const name = props.contact?.customer_name
  if (!name) return '#'
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(n => n[0]?.toUpperCase()).join('') || '#'
})
const telHref = computed(() => {
  if (!props.contact) return '#'
  const digits = props.contact.phone.replace(/\D/g, '')
  return `tel:+${digits}`
})

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

function close() { emit('close') }

function openProject() {
  if (!props.contact?.project_id) return
  emit('close')
  router.push(`/projects/${props.contact.project_id}`)
}
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
      v-if="open && contact"
      class="fixed inset-0 z-[110] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-md"
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
          v-if="open && contact"
          class="
            relative flex flex-col overflow-hidden
            w-full rounded-t-3xl
            sm:w-[400px] sm:rounded-3xl
            bg-card/95 supports-[backdrop-filter]:bg-card/85 backdrop-blur-2xl
            shadow-2xl shadow-black/30
            ring-1 ring-foreground/5
          "
        >
          <!-- Drag handle (mobile) -->
          <div class="sm:hidden flex justify-center pt-2 pb-0 select-none">
            <div class="w-10 h-1 rounded-full bg-foreground/15" />
          </div>

          <!-- Header -->
          <div class="relative flex items-start justify-between gap-3 px-5 pt-5 pb-3">
            <div class="flex items-center gap-3 min-w-0">
              <div
                class="
                  size-12 shrink-0 rounded-full flex items-center justify-center
                  bg-gradient-to-br from-sky-400/30 via-sky-500/20 to-violet-500/25
                  ring-1 ring-foreground/5
                  text-[15px] font-semibold tracking-tight text-foreground/85
                  select-none
                "
              >{{ initials }}</div>
              <div class="min-w-0">
                <h2 class="text-[18px] font-semibold leading-tight truncate">{{ heading }}</h2>
                <p class="text-[12px] text-muted-foreground tabular-nums mt-0.5">{{ formatPhone(contact.phone) }}</p>
              </div>
            </div>
            <button
              type="button"
              aria-label="Close"
              class="size-8 -mr-1 -mt-1 rounded-full hover:bg-foreground/5 active:bg-foreground/10 transition-colors flex items-center justify-center cursor-pointer shrink-0"
              @click="close"
            >
              <component :is="DtIconClose" class="w-4 h-4" />
            </button>
          </div>

          <!-- Project metadata strip — shown when matched -->
          <div v-if="contact.project_status || contact.project_coordinator" class="mx-5 mb-3 rounded-xl border bg-muted/30 px-3 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
            <span v-if="contact.project_status" class="inline-flex items-center gap-1.5">
              <span class="size-1.5 rounded-full bg-sky-500" />
              <span class="font-medium">{{ contact.project_status }}</span>
            </span>
            <span v-if="contact.project_coordinator" class="text-muted-foreground">PC: <span class="text-foreground">{{ contact.project_coordinator }}</span></span>
          </div>
          <p v-else class="mx-5 mb-3 text-[11.5px] text-muted-foreground italic">No project on file for this number.</p>

          <!-- Recent activity summary -->
          <div v-if="contact.sms || contact.call" class="mx-5 mb-4 space-y-1.5">
            <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Recent</p>
            <div v-if="contact.sms" class="flex items-baseline gap-2 text-[12px]">
              <component :is="DtIconMessage" class="w-3.5 h-3.5 text-violet-600 shrink-0 self-center" />
              <span class="font-medium">{{ contact.sms.direction === 'outgoing' ? 'Sent' : 'Received' }} text</span>
              <span class="text-muted-foreground tabular-nums">{{ timeAgo(contact.sms.at) }}</span>
              <span v-if="contact.sms.user_name" class="text-muted-foreground truncate">· {{ contact.sms.user_name }}</span>
            </div>
            <div v-if="contact.call" class="flex items-baseline gap-2 text-[12px]">
              <component :is="DtIconPhone" class="w-3.5 h-3.5 shrink-0 self-center" :class="contact.call.was_voicemail ? 'text-violet-600' : (contact.call.direction === 'outgoing' ? 'text-emerald-600' : 'text-sky-600')" />
              <span class="font-medium">
                {{ contact.call.was_voicemail ? 'Voicemail' : (contact.call.direction === 'outgoing' ? 'Outbound call' : 'Inbound call') }}
              </span>
              <span class="text-muted-foreground tabular-nums">{{ timeAgo(contact.call.at) }}</span>
              <span v-if="contact.call.talk_time_sec > 0" class="text-muted-foreground tabular-nums">· {{ fmtTalkSec(contact.call.talk_time_sec) }}</span>
              <span v-else-if="!contact.call.was_voicemail && contact.call.direction === 'incoming'" class="text-muted-foreground">· no answer</span>
            </div>
          </div>

          <!-- Primary actions — Message + Call side-by-side -->
          <div class="px-5 grid grid-cols-2 gap-2.5">
            <button
              type="button"
              class="
                inline-flex items-center justify-center gap-2 h-11 rounded-xl cursor-pointer
                bg-gradient-to-br from-sky-500 to-blue-600 text-white font-semibold text-[14px]
                shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_2px_6px_rgba(2,132,199,0.25)]
                hover:from-sky-400 hover:to-blue-500 active:scale-[0.98] transition-all
              "
              @click="emit('message')"
            >
              <component :is="DtIconMessage" class="w-4 h-4" />
              Message
            </button>
            <a
              :href="telHref"
              class="
                inline-flex items-center justify-center gap-2 h-11 rounded-xl cursor-pointer
                bg-gradient-to-br from-emerald-500 to-emerald-600 text-white font-semibold text-[14px] no-underline
                shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_2px_6px_rgba(5,150,105,0.25)]
                hover:from-emerald-400 hover:to-emerald-500 active:scale-[0.98] transition-all
              "
              @click="close"
            >
              <component :is="DtIconPhone" class="w-4 h-4" />
              Call
            </a>
          </div>

          <!-- Secondary actions -->
          <div class="px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] space-y-1">
            <button
              v-if="contact.project_id"
              type="button"
              class="w-full inline-flex items-center gap-2 h-9 px-2 rounded-lg cursor-pointer text-[12.5px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground transition-colors"
              @click="openProject"
            >
              <component :is="DtIconBriefcase" class="w-3.5 h-3.5" />
              Open project #{{ contact.project_id }}
            </button>
            <!-- Save to Dialpad — collapsed link until clicked, then expands
                 to an inline first/last form. Success state stays visible
                 so the user knows it worked. -->
            <template v-if="!saveOpen && !saveSuccess">
              <button
                type="button"
                class="w-full inline-flex items-center gap-2 h-9 px-2 rounded-lg cursor-pointer text-[12.5px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground transition-colors"
                @click="startSave"
              >
                <component :is="DtIconBookmark" class="w-3.5 h-3.5" />
                Save to Dialpad contacts
              </button>
            </template>
            <div v-else-if="saveOpen" class="rounded-lg border bg-muted/30 px-3 py-2.5 mt-1 space-y-2">
              <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Save contact in Dialpad</p>
              <div class="grid grid-cols-2 gap-2">
                <input
                  v-model="saveFirst"
                  type="text"
                  placeholder="First name"
                  autocomplete="given-name"
                  :disabled="saving"
                  class="h-8 px-2 rounded-md border bg-background text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  @keydown.enter.prevent="trySave"
                />
                <input
                  v-model="saveLast"
                  type="text"
                  placeholder="Last name"
                  autocomplete="family-name"
                  :disabled="saving"
                  class="h-8 px-2 rounded-md border bg-background text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  @keydown.enter.prevent="trySave"
                />
              </div>
              <div v-if="saveError" class="text-[11px] text-rose-700 dark:text-rose-300 leading-snug">{{ saveError }}</div>
              <div class="flex items-center gap-2 justify-end">
                <button
                  type="button"
                  class="h-7 px-2.5 rounded-md text-[12px] text-muted-foreground hover:bg-foreground/5 cursor-pointer transition-colors"
                  :disabled="saving"
                  @click="saveOpen = false"
                >Cancel</button>
                <button
                  type="button"
                  class="
                    h-7 px-3 rounded-md cursor-pointer text-[12px] font-semibold text-white
                    bg-gradient-to-br from-sky-500 to-blue-600
                    hover:from-sky-400 hover:to-blue-500 active:scale-[0.98] transition-all
                    disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100
                  "
                  :disabled="saving || !saveFirst.trim()"
                  @click="trySave"
                >{{ saving ? 'Saving…' : 'Save' }}</button>
              </div>
            </div>
            <div v-else-if="saveSuccess" class="inline-flex items-center gap-2 h-9 px-2 text-[12.5px] text-emerald-700 dark:text-emerald-400">
              <component :is="DtIconCheckCircle" class="w-3.5 h-3.5" />
              Saved to Dialpad — calls will show this name now.
            </div>
          </div>
        </div>
      </Transition>
    </div>
  </Transition>
</template>
