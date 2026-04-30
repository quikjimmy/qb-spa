<script setup lang="ts">
// 10-preset date chip bar + Cal/Biz day-unit toggle used by every
// milestone dashboard. Owns the date math; emits the resolved
// from/to range plus the active preset key. Parents bind v-model
// for the day-unit toggle.

import { computed } from 'vue'

const props = defineProps<{
  preset: string         // current preset key
  bizDays: boolean        // current day-unit
  showBizToggle?: boolean // hide the Cal/Biz toggle when irrelevant (default true)
}>()
const emit = defineEmits<{
  'update:preset': [key: string]
  'update:bizDays': [v: boolean]
  /** Fires on every change with the resolved {from,to,preset,bizDays}.
   *  Parent uses this to refetch data. */
  change: [payload: { preset: string; from: string; to: string; bizDays: boolean }]
}>()

const showBiz = computed(() => props.showBizToggle !== false)

// Same 10 presets used across Inspx + PTO. "all" clears the range.
const presets: Array<{ key: string; label: string }> = [
  { key: 'last_30',      label: '30d' },
  { key: 'last_60',      label: '60d' },
  { key: 'last_90',      label: '90d' },
  { key: 'this_month',   label: 'Mo' },
  { key: 'this_quarter', label: 'Qtr' },
  { key: 'this_year',    label: 'YTD' },
  { key: 'last_month',   label: 'L.Mo' },
  { key: 'last_quarter', label: 'L.Qtr' },
  { key: 'last_year',    label: 'L.Yr' },
  { key: 'all',          label: 'All' },
]

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function rangeFor(key: string): { from: string; to: string } {
  const t = new Date()
  const to = fmt(t)
  if (key === 'last_30')      { const d = new Date(t); d.setDate(d.getDate() - 30); return { from: fmt(d), to } }
  if (key === 'last_60')      { const d = new Date(t); d.setDate(d.getDate() - 60); return { from: fmt(d), to } }
  if (key === 'last_90')      { const d = new Date(t); d.setDate(d.getDate() - 90); return { from: fmt(d), to } }
  if (key === 'this_month')   return { from: `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-01`, to }
  if (key === 'this_quarter') return { from: `${t.getFullYear()}-${String(Math.floor(t.getMonth() / 3) * 3 + 1).padStart(2, '0')}-01`, to }
  if (key === 'this_year')    return { from: `${t.getFullYear()}-01-01`, to }
  if (key === 'last_month')   { const d = new Date(t.getFullYear(), t.getMonth() - 1, 1); return { from: fmt(d), to: fmt(new Date(t.getFullYear(), t.getMonth(), 0)) } }
  if (key === 'last_quarter') { const q = Math.floor(t.getMonth() / 3); const d = new Date(t.getFullYear(), (q - 1) * 3, 1); return { from: fmt(d), to: fmt(new Date(t.getFullYear(), q * 3, 0)) } }
  if (key === 'last_year')    return { from: `${t.getFullYear() - 1}-01-01`, to: `${t.getFullYear() - 1}-12-31` }
  return { from: '', to: '' }
}

function selectPreset(key: string) {
  emit('update:preset', key)
  const { from, to } = rangeFor(key)
  emit('change', { preset: key, from, to, bizDays: props.bizDays })
}

function toggleBiz(v: boolean) {
  emit('update:bizDays', v)
  const { from, to } = rangeFor(props.preset)
  emit('change', { preset: props.preset, from, to, bizDays: v })
}
</script>

<template>
  <!-- Two rows so neither the day-unit toggle nor the preset chips
       crowd the other off-screen on narrow viewports. The Cal/Biz
       toggle is its own labelled segmented-control above the date
       chips so it's never hidden behind horizontal overflow. -->
  <div class="flex flex-col gap-1.5 min-w-0">
    <div v-if="showBiz" class="flex items-center gap-2 min-w-0">
      <span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground shrink-0">Days</span>
      <div class="inline-flex rounded-md border overflow-hidden shrink-0">
        <button
          type="button"
          class="px-2.5 py-1 text-[11px] font-medium cursor-pointer transition-colors"
          :class="!bizDays ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted'"
          @click="toggleBiz(false)"
        >Cal days</button>
        <button
          type="button"
          class="px-2.5 py-1 text-[11px] font-medium cursor-pointer transition-colors border-l"
          :class="bizDays ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted'"
          @click="toggleBiz(true)"
        >Biz days</button>
      </div>
    </div>

    <div class="flex gap-1 items-center overflow-x-auto no-scrollbar min-w-0">
      <button
        v-for="p in presets"
        :key="p.key"
        type="button"
        class="px-2 py-0.5 rounded-full text-[9px] font-semibold border whitespace-nowrap shrink-0 cursor-pointer transition-colors"
        :class="preset === p.key
          ? 'bg-foreground text-background border-foreground'
          : 'bg-card border-border text-muted-foreground hover:text-foreground'"
        @click="selectPreset(p.key)"
      >{{ p.label }}</button>
    </div>
  </div>
</template>

<style scoped>
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
.no-scrollbar::-webkit-scrollbar { display: none; }
</style>
