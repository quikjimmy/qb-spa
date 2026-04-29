<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ status: string | null | undefined }>()

const kind = computed<'cancelled' | 'pending-cancel' | null>(() => {
  const s = String(props.status ?? '').toUpperCase()
  if (!s) return null
  if (s === 'PENDING CANCEL' || s.includes('PENDING CANCEL')) return 'pending-cancel'
  if (s.includes('CANCEL')) return 'cancelled'
  return null
})
</script>

<template>
  <div
    v-if="kind === 'cancelled'"
    role="alert"
    class="rounded-xl bg-rose-600 text-white text-center py-2.5 px-4 text-[13px] font-semibold tracking-wide flex items-center justify-center gap-2"
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
    </svg>
    Project cancelled
  </div>
  <div
    v-else-if="kind === 'pending-cancel'"
    role="alert"
    class="rounded-xl bg-amber-500 text-white text-center py-2.5 px-4 text-[13px] font-semibold tracking-wide flex items-center justify-center gap-2"
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 8V13" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
      <circle cx="12" cy="16.5" r="1.2" fill="currentColor"/>
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.2"/>
    </svg>
    Pending cancellation
  </div>
</template>
