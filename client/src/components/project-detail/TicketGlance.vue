<script setup lang="ts">
// At-a-glance open-ticket counts: ticket icon (optional) + red / amber / green
// bubbles for overdue / due-today / future. Counts come from the tickets API's
// kpi block (bucketed against the Denver office calendar server-side). Shared
// by the bump-out header, the full project header, and the Tickets tab.
import { computed } from 'vue'

const props = defineProps<{
  overdue: number
  today: number
  future: number
  /** Show the ticket icon before the bubbles (header use). Omit on a tab where
   *  the label already provides context. */
  showIcon?: boolean
  /** Muted text shown when there are no open tickets. Omit to render nothing
   *  (e.g. on a tab, where an empty glance should just disappear). */
  emptyText?: string
}>()

const hasAny = computed(() => props.overdue > 0 || props.today > 0 || props.future > 0)
</script>

<template>
  <span
    v-if="hasAny || (showIcon && emptyText)"
    class="inline-flex items-center gap-1 align-middle"
    title="Open tickets — overdue / due today / upcoming"
  >
    <svg v-if="showIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="size-3.5 text-muted-foreground" aria-hidden="true">
      <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 11v2"/><path d="M13 17v2"/>
    </svg>
    <span v-if="overdue" class="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold tabular-nums bg-red-600 text-white">{{ overdue }}</span>
    <span v-if="today" class="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold tabular-nums bg-amber-500 text-white">{{ today }}</span>
    <span v-if="future" class="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold tabular-nums bg-emerald-600 text-white">{{ future }}</span>
    <span v-if="!hasAny && emptyText" class="text-[10px] text-muted-foreground">{{ emptyText }}</span>
  </span>
</template>
