<script setup lang="ts">
import { computed } from 'vue'

// Generic non-status pill. Used for milestone done/active, ticket open/pending,
// info chips, etc. The PROJECT status pill lives in ProjectStatusBadge.vue and
// reads from lib/status.ts so it stays consistent app-wide.
type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'soft' | 'blue' | 'pending' | 'complete' | 'teal'

const props = defineProps<{
  tone?: Tone
  dot?: boolean
}>()

const tones: Record<Tone, { bg: string; fg: string }> = {
  teal:     { bg: '#ccfbf1', fg: '#0f766e' },  // teal-100 / teal-700
  ok:       { bg: '#dcfce7', fg: '#166534' },
  warn:     { bg: '#fef3c7', fg: '#b45309' },
  bad:      { bg: '#fee2e2', fg: '#b91c1c' },
  info:     { bg: '#e0f2fe', fg: '#0369a1' },
  soft:     { bg: '#eef2f7', fg: '#334155' },
  blue:     { bg: '#dbeafe', fg: '#1d4ed8' },
  pending:  { bg: '#fde68a', fg: '#92400e' },
  complete: { bg: '#dcfce7', fg: '#166534' },
}

const t = computed(() => tones[props.tone ?? 'soft'])
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 px-2.5 py-[3px] rounded-full text-[11px] font-medium whitespace-nowrap"
    :style="{ background: t.bg, color: t.fg }"
  >
    <span v-if="dot" class="size-1.5 rounded-full opacity-90" :style="{ background: t.fg }" />
    <slot />
  </span>
</template>
