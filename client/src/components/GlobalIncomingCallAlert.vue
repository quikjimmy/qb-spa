<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useDialpadLive, unlockAudio as globalUnlockAudio, type LiveEvent } from '@/lib/dialpadLive'
import { formatPhone } from '@/lib/callBuckets'
import DtIconPhoneIncoming from '@dialpad/dialtone-icons/vue3/phone-incoming'
import DtIconPhoneCall from '@dialpad/dialtone-icons/vue3/phone-call'

// Pops up any time a Dialpad webhook reports an unresolved ringing call
// that matches the current Me/All scope. Clicking the card jumps to the
// matched project (if any); X dismisses without resolving the underlying
// call. When the call resolves (connected / hangup / missed) the alert
// auto-dismisses via the composable's `pendingRinging` computed.

const auth = useAuthStore()
const { pendingRinging, dismissRinging } = useDialpadLive()

// Per-call contact match cache. Keyed by external_number + call_id so if
// the same number calls twice we re-match; avoids duplicate network calls
// while the ring is active.
interface MatchedProject {
  record_id: number
  customer_name: string
  phone: string
  status: string
  state: string
  coordinator: string
  closer: string
}
const matches = ref<Record<string, MatchedProject[]>>({})
const matchLoading = ref<Record<string, boolean>>({})

function keyFor(ev: LiveEvent): string {
  return `${ev.call_id || ''}|${ev.external_number || ''}`
}

async function lookup(ev: LiveEvent) {
  if (!ev.external_number) return
  const k = keyFor(ev)
  if (matches.value[k] || matchLoading.value[k]) return
  matchLoading.value = { ...matchLoading.value, [k]: true }
  try {
    const res = await fetch(`/api/projects/by-phone?number=${encodeURIComponent(ev.external_number)}&limit=5`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    if (res.ok) {
      const data = await res.json() as { rows: MatchedProject[] }
      matches.value = { ...matches.value, [k]: data.rows || [] }
    }
  } finally {
    matchLoading.value = { ...matchLoading.value, [k]: false }
  }
}

// Auto-lookup whenever a new ringing call appears
watch(pendingRinging, (list) => {
  for (const ev of list) lookup(ev)
}, { immediate: true })

function openProject(rid: number) {
  // Opens the QuickBase project detail page in a new tab — same pattern as
  // the existing dashboard views (Projects/PTO/Inspx). Keeps the portal as
  // the comms + ops overlay without cloning QB's data entry UX.
  window.open(`https://kin.quickbase.com/nav/app/br9kwm8bk/table/br9kwm8na/action/dr?rid=${rid}`, '_blank')
}

// Elapsed time since the ring started (updates every second while alerts visible)
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
watch(pendingRinging, (list) => {
  if (list.length > 0 && !timer) {
    timer = setInterval(() => { now.value = Date.now() }, 1_000)
  } else if (list.length === 0 && timer) {
    clearInterval(timer); timer = null
  }
}, { immediate: true })

function elapsed(ev: LiveEvent): string {
  const start = new Date(ev.received_at.replace(' ', 'T') + (ev.received_at.endsWith('Z') ? '' : 'Z')).getTime()
  if (!Number.isFinite(start)) return ''
  const sec = Math.max(0, Math.floor((now.value - start) / 1000))
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m ${sec % 60}s`
}

const visible = computed(() => pendingRinging.value.slice(0, 3))   // cap to 3 stacked alerts
</script>

<template>
  <!-- Fixed position container on top of everything. Full width on mobile,
       centered card on larger screens. Stacks up to 3 concurrent calls. -->
  <div
    v-if="visible.length > 0"
    class="fixed z-[100] top-2 left-2 right-2 sm:top-3 sm:left-auto sm:right-3 sm:w-[380px] pointer-events-none"
  >
    <div class="grid gap-2">
      <div v-for="ev in visible" :key="ev.call_id || String(ev.id)"
        class="pointer-events-auto rounded-xl border-2 border-sky-400 bg-card shadow-2xl shadow-sky-500/20 overflow-hidden animate-pulse-soft"
        @click="globalUnlockAudio"
      >
        <!-- Header -->
        <div class="flex items-start gap-3 px-3.5 py-2.5 bg-gradient-to-br from-sky-50 to-blue-50 dark:from-sky-950/40 dark:to-blue-950/40">
          <div class="shrink-0 size-10 rounded-full bg-sky-500 text-white flex items-center justify-center ring-2 ring-sky-300 animate-ring">
            <component :is="DtIconPhoneCall" class="w-5 h-5" />
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-[10px] uppercase tracking-wider text-sky-700 dark:text-sky-300 font-semibold">Incoming call</p>
            <!-- Resolved customer name if we matched, else the raw number -->
            <p class="font-semibold text-[15px] truncate">
              <template v-if="matches[keyFor(ev)]?.[0]?.customer_name">{{ matches[keyFor(ev)]![0]!.customer_name }}</template>
              <template v-else>{{ formatPhone(ev.external_number) || 'Unknown caller' }}</template>
            </p>
            <p class="text-[11px] text-muted-foreground truncate">
              <template v-if="matches[keyFor(ev)]?.[0]?.customer_name">{{ formatPhone(ev.external_number) || '' }}</template>
              <template v-if="ev.user_name"> · to {{ ev.user_name }}</template>
              <span class="ml-1 tabular-nums">· {{ elapsed(ev) }}</span>
            </p>
          </div>
          <button class="shrink-0 size-6 rounded-full hover:bg-muted/60 flex items-center justify-center" title="Dismiss" @click.stop="ev.call_id && dismissRinging(ev.call_id)">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <!-- Matched projects (if any) -->
        <div v-if="matches[keyFor(ev)]?.length" class="border-t bg-muted/30">
          <p class="px-3.5 pt-2 pb-1 text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">Related projects</p>
          <div class="divide-y">
            <button v-for="p in matches[keyFor(ev)]" :key="p.record_id"
              class="w-full flex items-center gap-2 px-3.5 py-1.5 hover:bg-muted/60 text-left transition-colors"
              @click.stop="openProject(p.record_id)"
            >
              <component :is="DtIconPhoneIncoming" class="w-3 h-3 text-sky-500 shrink-0" />
              <div class="flex-1 min-w-0">
                <p class="text-[12px] font-medium truncate">{{ p.customer_name }}</p>
                <p class="text-[10px] text-muted-foreground truncate">
                  {{ p.status }}<template v-if="p.state"> · {{ p.state }}</template><template v-if="p.coordinator"> · {{ p.coordinator }}</template>
                </p>
              </div>
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground shrink-0"><path d="M7 17l10-10"/><path d="M7 7h10v10"/></svg>
            </button>
          </div>
        </div>
        <div v-else-if="matchLoading[keyFor(ev)]" class="px-3.5 py-1.5 text-[10px] text-muted-foreground border-t">Looking up caller…</div>
        <div v-else class="px-3.5 py-1.5 text-[10px] text-muted-foreground border-t">No matching project found for this number.</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Subtle breathing pulse to draw attention without being obnoxious. */
@keyframes pulse-soft {
  0%, 100% { box-shadow: 0 10px 25px -5px rgba(14, 165, 233, 0.25), 0 8px 10px -6px rgba(14, 165, 233, 0.15); }
  50%      { box-shadow: 0 10px 32px -3px rgba(14, 165, 233, 0.45), 0 10px 12px -4px rgba(14, 165, 233, 0.3); }
}
.animate-pulse-soft { animation: pulse-soft 1.4s ease-in-out infinite; }

/* Icon ring pulse */
@keyframes ring-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(14, 165, 233, 0.5); }
  50%      { box-shadow: 0 0 0 6px rgba(14, 165, 233, 0); }
}
.animate-ring { animation: ring-pulse 1.2s ease-out infinite; }
</style>
