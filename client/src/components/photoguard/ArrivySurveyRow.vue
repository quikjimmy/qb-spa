<script setup lang="ts">
// One Arrivy survey, with an explicit state so it's never ambiguous whether
// it's been imported, is still being assessed, or is ready to read.
//
// The previous version showed a count and a button and left you guessing:
// "18/63 passing" looks identical whether the other 45 failed or simply
// haven't been looked at yet. Each state now has its own label, colour and
// single obvious action.
//
//   new        → nothing pulled yet            → Import & assess
//   importing  → photos downloading            → (busy)
//   assessing  → photos in, AI still running   → View progress
//   assessed   → done                          → View assessment
import { computed } from 'vue'
import SurveyTaskCard from '@/components/survey/SurveyTaskCard.vue'
import type { SurveyCard } from '@/lib/surveyTasks'

export interface ImportState {
  taskRowId: number | null
  photos: number
  passed: number
  failed: number
  pending: number
  reviewed: number
  lastImportedAt: string | null
}

const props = defineProps<{
  card: SurveyCard
  state: ImportState | null
  importing: boolean
}>()

const emit = defineEmits<{ (e: 'import'): void; (e: 'view'): void }>()

type Phase = 'new' | 'importing' | 'assessing' | 'assessed'

const phase = computed<Phase>(() => {
  if (props.importing) return 'importing'
  if (!props.state || props.state.photos === 0) return 'new'
  return props.state.pending > 0 ? 'assessing' : 'assessed'
})

const judged = computed(() => (props.state ? props.state.passed + props.state.failed : 0))

const passRate = computed(() =>
  judged.value ? Math.round(((props.state?.passed ?? 0) / judged.value) * 100) : null)

/** Assessment progress, not pass rate — how much has been looked at. */
const progressPct = computed(() => {
  if (!props.state || !props.state.photos) return 0
  return Math.round((judged.value / props.state.photos) * 100)
})

const dotClass = computed(() => ({
  new: 'bg-slate-300',
  importing: 'bg-sky-500 animate-pulse',
  assessing: 'bg-amber-500 animate-pulse',
  assessed: (passRate.value ?? 100) >= 80 ? 'bg-emerald-500' : 'bg-rose-500',
}[phase.value]))

const statusText = computed(() => {
  const s = props.state
  switch (phase.value) {
    case 'importing': return 'Importing photos from Arrivy…'
    case 'assessing': return `Assessing · ${judged.value} of ${s?.photos ?? 0} photos checked`
    case 'assessed': return `Assessed · ${s?.passed ?? 0} passed, ${s?.failed ?? 0} failed`
    default: return 'Not imported'
  }
})

const statusClass = computed(() => ({
  new: 'text-muted-foreground',
  importing: 'text-sky-600',
  assessing: 'text-amber-600',
  assessed: (passRate.value ?? 100) >= 80 ? 'text-emerald-600' : 'text-rose-600',
}[phase.value]))
</script>

<template>
  <!-- No outer card: SurveyTaskCard already draws one, and nesting produced a
       double border with a stretched dead gap on wide screens. The PhotoGuard
       strip hangs directly under it, left-aligned next to the status rather
       than floated to the far edge. -->
  <div class="min-w-0">
    <SurveyTaskCard :task="card" @open="phase === 'new' ? emit('import') : emit('view')" />

    <div class="flex flex-wrap items-center gap-2 pl-2.5 pr-1 pt-1 min-w-0">
      <span class="inline-block size-1.5 rounded-full flex-none" :class="dotClass" aria-hidden="true" />
      <span class="text-[11px] font-medium truncate" :class="statusClass">
        {{ statusText }}
        <span v-if="phase === 'assessed' && passRate !== null" class="text-muted-foreground">
          · {{ passRate }}% pass
        </span>
      </span>

      <button
        v-if="phase === 'new'"
        type="button"
        class="flex-none px-2.5 py-1 rounded-full border text-[10px] font-medium bg-foreground text-background border-foreground cursor-pointer transition-colors"
        :aria-label="`Import and assess the survey for ${card.customer_name}`"
        @click="emit('import')"
      >Import &amp; assess</button>

      <span
        v-else-if="phase === 'importing'"
        class="flex-none px-2.5 py-1 rounded-full border text-[10px] font-medium bg-muted text-muted-foreground"
      >Importing…</span>

      <button
        v-else
        type="button"
        class="flex-none px-2.5 py-1 rounded-full border text-[10px] font-medium cursor-pointer transition-colors"
        :class="phase === 'assessed'
          ? 'bg-foreground text-background border-foreground'
          : 'bg-card hover:bg-muted'"
        :aria-label="`View the assessment for ${card.customer_name}`"
        @click="emit('view')"
      >{{ phase === 'assessed' ? 'View assessment →' : 'View progress →' }}</button>

      <!-- Inline progress: reads next to the count it belongs to -->
      <span v-if="phase === 'assessing'" class="flex-none w-16 h-1 rounded-full bg-muted overflow-hidden">
        <span class="block h-full bg-amber-500 transition-all" :style="{ width: `${progressPct}%` }" />
      </span>
    </div>
  </div>
</template>
