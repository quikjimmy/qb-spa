<script setup lang="ts">
import { ref } from 'vue'
import { bucketMeta, formatPhone, splitStartedAt } from '@/lib/callBuckets'
import { useDialpadLive, type LiveEvent } from '@/lib/dialpadLive'
import DtIconPhone from '@dialpad/dialtone-icons/vue3/phone'
import DtIconBellRing from '@dialpad/dialtone-icons/vue3/bell-ring'
import DtIconMessage from '@dialpad/dialtone-icons/vue3/message'

// Live activity panel — presentation-only. All SSE + sound + filter state
// lives in the shared useDialpadLive composable so this panel and the
// GlobalIncomingCallAlert share one event stream.
const {
  visibleEvents,
  stateHistory,
  connected,
  reconnectAttempt,
  scope,
  setScope,
  soundEnabled,
  toggleSound,
} = useDialpadLive()

const expanded = ref<Record<number, boolean>>({})

interface EventVisual { icon: unknown; label: string; colorClass: string; bgClass: string; sublabel: string }
function visualFor(e: LiveEvent): EventVisual {
  if (e.event_kind === 'call') {
    const state = (e.event_state || '').toLowerCase()
    const dir = (e.direction || '').toLowerCase()
    if (state === 'ringing' || state === 'preanswer') return { ...bucketMeta('in_callback_requested'), icon: DtIconBellRing, label: 'Ringing', sublabel: state }
    if (state === 'connected') return dir === 'outbound'
      ? { ...bucketMeta('out_connected'), sublabel: 'Connected' }
      : { ...bucketMeta('in_answered'), sublabel: 'Connected' }
    if (state === 'hangup' || state === 'ended') {
      if (dir === 'outbound') return { ...bucketMeta('out_connected'), sublabel: 'Ended' }
      return { ...bucketMeta('in_answered'), sublabel: 'Ended' }
    }
    if (state === 'missed') return { ...bucketMeta('in_missed'), sublabel: 'Missed' }
    if (state === 'voicemail') return { ...bucketMeta('in_voicemail'), sublabel: 'Voicemail' }
    if (state === 'transferred') return { ...bucketMeta('in_transfer_unanswered'), sublabel: 'Transferred' }
    return { ...bucketMeta('other'), icon: DtIconPhone, sublabel: state || dir || 'call' }
  }
  if (e.event_kind === 'sms') {
    const dir = e.direction === 'outgoing' ? 'out' : 'in'
    return {
      icon: DtIconMessage,
      label: 'SMS',
      colorClass: dir === 'in' ? 'text-sky-600' : 'text-emerald-600',
      bgClass: dir === 'in' ? 'bg-sky-100' : 'bg-emerald-100',
      sublabel: dir === 'in' ? 'Received' : 'Sent',
    }
  }
  return { ...bucketMeta('other'), icon: DtIconPhone, sublabel: e.event_kind }
}

function formatRaw(raw: string): string {
  try { return JSON.stringify(JSON.parse(raw), null, 2) } catch { return raw }
}
</script>

<template>
  <div class="rounded-xl border bg-card overflow-hidden">
    <div class="px-3 sm:px-4 py-2.5 border-b flex items-center justify-between gap-2 flex-wrap">
      <div class="flex items-center gap-2 min-w-0">
        <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Live Activity</p>
        <span class="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0">
          <span class="size-1.5 rounded-full" :class="connected ? 'bg-emerald-500' : reconnectAttempt > 0 ? 'bg-amber-500' : 'bg-slate-400'" />
          <span>{{ connected ? 'Live' : reconnectAttempt > 0 ? 'Reconnecting…' : 'Offline' }}</span>
        </span>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <div class="flex rounded-md border overflow-hidden">
          <button class="px-2 h-6 text-[10px] font-medium transition-colors" :class="scope === 'me' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'" @click="setScope('me')">Me</button>
          <button class="px-2 h-6 text-[10px] font-medium transition-colors" :class="scope === 'all' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'" @click="setScope('all')">All</button>
        </div>
        <button
          class="inline-flex items-center justify-center size-6 rounded-md border transition-colors"
          :class="soundEnabled ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'"
          :title="soundEnabled ? 'Sound on — click to mute' : 'Sound off — click to enable'"
          @click="toggleSound"
        >
          <svg v-if="soundEnabled" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
          <svg v-else xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
        </button>
        <p v-if="visibleEvents.length > 0" class="text-[10px] text-muted-foreground tabular-nums">{{ visibleEvents.length }}</p>
      </div>
    </div>

    <div v-if="visibleEvents.length === 0" class="px-4 py-8 text-center text-[11px] text-muted-foreground">
      <template v-if="connected && scope === 'me'">No events for you yet — try changing filter to All to see team activity.</template>
      <template v-else-if="connected">Listening for events…</template>
      <template v-else-if="reconnectAttempt > 0">Reconnecting to event stream…</template>
      <template v-else>No recent events.</template>
    </div>

    <div v-else class="divide-y max-h-[360px] overflow-y-auto">
      <div v-for="e in visibleEvents" :key="e.call_id || `evt-${e.id}`" class="px-3 sm:px-4 py-2">
        <div class="flex items-center gap-2.5 sm:gap-3 cursor-pointer" @click="expanded[e.id] = !expanded[e.id]">
          <div class="shrink-0 size-8 rounded-full flex items-center justify-center" :class="visualFor(e).bgClass">
            <component :is="visualFor(e).icon" class="w-4 h-4" :class="visualFor(e).colorClass" />
          </div>
          <div class="flex-1 min-w-0">
            <p class="font-mono text-[12px] truncate">{{ formatPhone(e.external_number) || e.user_name || e.user_email || 'Event' }}</p>
            <p class="text-[10px] text-muted-foreground truncate flex items-center gap-1">
              <template v-if="e.call_id && stateHistory[e.call_id]">
                <span v-for="(s, i) in stateHistory[e.call_id]" :key="i" class="inline-flex items-center gap-1">
                  <span v-if="i > 0" class="text-muted-foreground/60">→</span>
                  <span :class="i === (stateHistory[e.call_id]!.length - 1) ? 'font-medium text-foreground' : ''">{{ s }}</span>
                </span>
              </template>
              <template v-else>{{ visualFor(e).sublabel }}</template>
              <template v-if="e.user_name || e.user_email"> · {{ e.user_name || e.user_email }}</template>
            </p>
          </div>
          <div class="shrink-0 text-right">
            <p class="text-[11px] tabular-nums">{{ splitStartedAt(e.received_at).time }}</p>
            <p class="text-[10px] text-muted-foreground">{{ splitStartedAt(e.received_at).date }}</p>
          </div>
        </div>
        <pre v-if="expanded[e.id]" class="mt-2 text-[9px] leading-snug bg-muted/40 rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-all">{{ formatRaw(e.raw_json) }}</pre>
      </div>
    </div>
  </div>
</template>
