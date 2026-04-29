<script setup lang="ts">
import { computed } from 'vue'
import type { StripStep, TransitDays } from '@/lib/milestoneStrip'
import { fmtShort } from '@/lib/milestoneStrip'

const props = defineProps<{
  steps: StripStep[]
  transits?: TransitDays[]
  activeId?: string | null
}>()

const emit = defineEmits<{ select: [id: string] }>()

interface DotStyle { dot: string; label: string; date: string }

const styles: Record<string, DotStyle> = {
  done:      { dot: 'bg-emerald-500',  label: 'text-slate-700', date: 'text-slate-500' },
  active:    { dot: 'bg-amber-400',    label: 'text-amber-700', date: 'text-amber-700' },
  scheduled: { dot: 'bg-blue-500',     label: 'text-blue-700',  date: 'text-blue-700' },
  rejected:  { dot: 'bg-violet-500',   label: 'text-violet-700', date: 'text-violet-700' },
  overdue:   { dot: 'bg-stone-500 ring-2 ring-stone-300', label: 'text-stone-700', date: 'text-stone-700' },
  not:       { dot: 'bg-slate-200',    label: 'text-slate-400', date: 'text-slate-300' },
}

// Map transit tier → color for the connector pill
const transitColor: Record<TransitDays['tier'], string> = {
  good: 'text-emerald-600',
  warn: 'text-amber-600',
  bad:  'text-rose-600',
}

const firstNonDoneIdx = computed(() => props.steps.findIndex(s => s.state !== 'done'))

function transitFor(toId: StripStep['id']): TransitDays | undefined {
  return (props.transits ?? []).find(t => t.toId === toId)
}
</script>

<template>
  <div
    class="grid w-full"
    :style="{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }"
  >
    <button
      v-for="(s, i) in steps"
      :key="s.id"
      type="button"
      class="group relative flex flex-col items-center text-center pt-1.5 pb-2 px-1 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-teal-500/50 transition-colors cursor-pointer"
      :class="activeId === s.id ? 'bg-white shadow-sm' : 'hover:bg-white/70'"
      :aria-pressed="activeId === s.id"
      :aria-label="`${s.label} — ${s.state}${s.date ? ', ' + fmtShort(s.date) : ''}${s.infoFlag.show ? ', ' + s.infoFlag.reason : ''}`"
      @click="emit('select', s.id)"
    >
      <!-- Label -->
      <div
        class="text-[10.5px] tracking-wide uppercase font-medium select-none leading-tight"
        :class="styles[s.state]?.label ?? 'text-slate-500'"
      >
        <span class="hidden sm:inline">{{ s.label }}</span>
        <span class="sm:hidden">{{ s.abbrev }}</span>
      </div>

      <!-- Dot row + connectors + transit pill -->
      <div class="relative w-full flex items-center justify-center mt-1.5 mb-1 h-4">
        <!-- Left half-connector -->
        <div
          v-if="i > 0"
          class="absolute left-0 right-1/2 h-px"
          :class="steps[i - 1] && steps[i - 1]!.state === 'done' ? 'bg-emerald-300' : 'bg-slate-200'"
        />
        <!-- Right half-connector -->
        <div
          v-if="i < steps.length - 1"
          class="absolute left-1/2 right-0 h-px"
          :class="s.state === 'done' ? 'bg-emerald-300' : 'bg-slate-200'"
        />
        <!-- Dot -->
        <span
          class="relative size-3.5 rounded-full"
          :class="[styles[s.state]?.dot ?? 'bg-slate-200', firstNonDoneIdx === i && s.state !== 'not' ? 'ring-4 ring-amber-100' : '']"
        />
        <!-- Red attention dot top-right of the cell -->
        <span
          v-if="s.infoFlag.show"
          class="absolute -top-0.5 right-1/2 translate-x-[14px] size-2 rounded-full bg-rose-500 ring-2 ring-white"
          :title="s.infoFlag.reason"
        />
        <!-- Inter-step transit pill (sits between this cell and the next) -->
        <span
          v-if="transitFor(s.id) && i < steps.length - 1"
          class="absolute left-[calc(100%-12px)] top-1/2 -translate-y-1/2 text-[9.5px] tabular-nums leading-none px-1 z-10 select-none whitespace-nowrap"
          :class="transitColor[transitFor(s.id)!.tier]"
          :title="`${steps[i+1]?.label}: ${transitFor(s.id)!.days}d ${transitFor(s.id)!.inFlight ? 'open' : 'transit'}`"
        >{{ transitFor(s.id)!.days }}d</span>
      </div>

      <!-- Date -->
      <div
        class="text-[10.5px] tabular-nums font-normal select-none leading-tight"
        :class="styles[s.state]?.date ?? 'text-slate-400'"
      >{{ s.date ? fmtShort(s.date) : '—' }}</div>

      <!-- Within-step duration (e.g. 2d for permit submit→approve) -->
      <div
        v-if="s.durationLabel"
        class="text-[9.5px] tabular-nums text-slate-400 leading-tight mt-0.5"
        :title="s.durationLabel.includes('open') ? 'Days open in this milestone' : 'Total biz days from submit to approve'"
      >{{ s.durationLabel }}</div>
    </button>
  </div>
</template>
