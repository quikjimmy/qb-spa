<script setup lang="ts">
// The ONE survey record card — used by every KPI slice on the Site Survey
// page (day window, unsubmitted-deal groups, unassigned) so records read
// identically regardless of which tile is active. Condensed 3-row layout:
// name+pill / meta / chips+links. Clicking emits `open` — the parent
// decides which bump-out to show (project peek vs deal peek).
import { windowTaskEmoji, type SurveyCard } from '@/lib/surveyTasks'

defineProps<{ task: SurveyCard }>()
const emit = defineEmits<{ open: [] }>()

function fmtDateTime(ds: string): string {
  if (!ds) return 'Not scheduled'
  const d = new Date(ds)
  if (isNaN(d.getTime())) return ds
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}
</script>

<template>
  <div
    class="block rounded-lg border-l-[3px] border px-2.5 py-1.5 transition-transform active:scale-[0.99] min-w-0 overflow-hidden cursor-pointer"
    :class="[
      task.borderCls,
      task.status === 'cancelled' ? 'bg-rose-50 ring-1 ring-rose-200' : 'bg-card',
    ]"
    role="button"
    tabindex="0"
    @click="emit('open')"
    @keydown.enter="emit('open')"
  >
    <div class="flex items-center gap-1.5 min-w-0">
      <span
        v-if="task.status === 'cancelled'"
        class="size-4 shrink-0 rounded-full bg-rose-600 text-white flex items-center justify-center"
        aria-hidden="true"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" class="size-2.5">
          <path d="M6 6l12 12" /><path d="M18 6L6 18" />
        </svg>
      </span>
      <p class="font-semibold text-[13px] leading-snug min-w-0 flex-1 truncate" :class="task.status === 'cancelled' ? 'text-rose-900' : ''">
        {{ task.status === 'cancelled' ? '' : windowTaskEmoji(task.status) + ' ' }}{{ task.customer_name || 'Unknown' }}
      </p>
      <span
        class="rounded-full font-semibold shrink-0 whitespace-nowrap px-1.5 py-px text-[9.5px]"
        :class="[task.pillCls, task.status === 'cancelled' ? 'uppercase tracking-wide' : '']"
      >{{ task.status_label }}</span>
    </div>
    <p class="text-[10.5px] leading-snug truncate min-w-0" :class="task.status === 'cancelled' ? 'text-rose-800/80' : 'text-muted-foreground'">
      {{ fmtDateTime(task.scheduled_at) }} ·
      {{ task.template_name || 'Task' }}
      <template v-if="task.kw > 0"> · {{ task.kw.toFixed(1) }} kW</template>
      <template v-if="task.crew"> · {{ task.crew }}</template>
      <span v-if="task.signed_note" class="text-amber-600 font-medium"> · {{ task.signed_note }}</span>
    </p>
    <div class="flex flex-wrap items-center gap-1 min-w-0 mt-0.5">
      <span v-for="(c, i) in task.chips" :key="i" class="text-[8.5px] font-bold px-1 py-px rounded whitespace-nowrap" :class="c.cls" :title="c.title">{{ c.label }}</span>
      <span class="ml-auto inline-flex items-center gap-1.5 shrink-0">
        <a
          v-if="task.deal_url"
          :href="task.deal_url"
          target="_blank"
          rel="noopener"
          class="p-1 -m-1 opacity-70 hover:opacity-100 transition-opacity"
          aria-label="Open Enerflo deal"
          title="Open Enerflo deal"
          @click.stop
        >
          <img src="/integrations/enerflo.png" alt="" class="size-3 object-contain" />
        </a>
        <a
          v-if="task.task_url"
          :href="task.task_url"
          target="_blank"
          rel="noopener"
          class="p-1 -m-1 opacity-70 hover:opacity-100 transition-opacity"
          aria-label="Open in Arrivy"
          title="Open in Arrivy"
          @click.stop
        >
          <img src="/integrations/arrivy.png" alt="" class="size-3 object-contain" />
        </a>
      </span>
    </div>
  </div>
</template>
