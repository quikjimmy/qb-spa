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
  <div class="rounded-xl border bg-card min-w-0 overflow-hidden">
    <!-- Identical to /projects/site-survey so a survey reads the same everywhere -->
    <div class="p-1.5 pb-0">
      <SurveyTaskCard :task="card" @open="phase === 'assessed' || phase === 'assessing' ? emit('view') : emit('import')" />
    </div>

    <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2 min-w-0">
      <span class="inline-block size-1.5 rounded-full flex-none" :class="dotClass" aria-hidden="true" />
      <p class="text-[11px] font-medium min-w-0 flex-1 truncate" :class="statusClass">
        {{ statusText }}
        <span v-if="phase === 'assessed' && passRate !== null" class="text-muted-foreground">
          · {{ passRate }}% pass
        </span>
      </p>

      <!-- One action, matched to the state -->
      <button
        v-if="phase === 'new'"
        type="button"
        class="flex-none min-h-9 px-3 rounded-full border text-[11px] font-medium bg-foreground text-background border-foreground cursor-pointer transition-colors"
        :aria-label="`Import and assess the survey for ${card.customer_name}`"
        @click="emit('import')"
      >Import &amp; assess</button>

      <button
        v-else-if="phase === 'importing'"
        type="button" disabled
        class="flex-none min-h-9 px-3 rounded-full border text-[11px] font-medium bg-muted text-muted-foreground opacity-70"
      >Importing…</button>

      <button
        v-else
        type="button"
        class="flex-none min-h-9 px-3 rounded-full border text-[11px] font-medium cursor-pointer transition-colors"
        :class="phase === 'assessed'
          ? 'bg-foreground text-background border-foreground'
          : 'bg-card hover:bg-muted'"
        :aria-label="`View the assessment for ${card.customer_name}`"
        @click="emit('view')"
      >{{ phase === 'assessed' ? 'View assessment' : 'View progress' }}</button>
    </div>

    <!-- Only while there's something still to check -->
    <div v-if="phase === 'assessing'" class="h-1 bg-muted">
      <div class="h-full bg-amber-500 transition-all" :style="{ width: `${progressPct}%` }" />
    </div>
  </div>
</template>
