<script setup lang="ts">
// Reusable decile-by-dimension table extracted from FieldPerformance.
// Every milestone view has at least one duration metric worth slicing
// (e.g. install→inspection-passed days, install→PTO-approved days).
// This component:
//
//   • Renders a metric chip strip (e.g. "Pass Days" | "First Sched Days")
//   • Renders a dimension chip strip (State | Lender | EPC | AHJ | Utility)
//   • Renders a numeric decile grid: D10..D100 + Mean across columns,
//     dimension values down rows, totals row at the bottom.
//   • Mobile collapses to D20 / Mean / D90 / Max only.
//
// The table is *display-only* — the parent owns fetching + cal/biz state.
// Cal vs biz adjustment is server-side; the parent just passes dayUnit
// through so the subtitle reads correctly.

import { computed, ref } from 'vue'

export interface DecileRow {
  dimension_value: string
  count: number
  kw?: number
  d10: number; d20: number; d30: number; d40: number; d50: number
  d60: number; d70: number; d80: number; d90: number; d100: number
  mean: number
}

export interface MetricDef  { key: string; label: string }
export interface DimDef     { key: string; label: string }

const props = defineProps<{
  title: string
  metric: string
  metrics: MetricDef[]
  dimension: string
  dimensions: DimDef[]
  dayUnit: 'biz' | 'cal'
  rows: DecileRow[]
  total?: DecileRow | null
  loading?: boolean
}>()

const emit = defineEmits<{
  'update:metric':    [key: string]
  'update:dimension': [key: string]
}>()

// ── Sort state — same shape as FieldPerformance ──
type DecSortKey = 'count' | 'd20' | 'mean' | 'd90' | 'd100'
const decSortKey = ref<DecSortKey>('count')
const decSortDir = ref<'desc' | 'asc'>('desc')
function setDecSort(k: DecSortKey) {
  if (decSortKey.value === k) decSortDir.value = decSortDir.value === 'desc' ? 'asc' : 'desc'
  else { decSortKey.value = k; decSortDir.value = 'desc' }
}
const sortedRows = computed(() => {
  const rows = [...(props.rows || [])]
  rows.sort((a, b) => {
    const av = (a[decSortKey.value] as number) || 0
    const bv = (b[decSortKey.value] as number) || 0
    return decSortDir.value === 'desc' ? bv - av : av - bv
  })
  return rows
})

const dimensionLabel = computed(() => props.dimensions.find(d => d.key === props.dimension)?.label ?? props.dimension)
const dimensionLabelUpper = computed(() => dimensionLabel.value.toUpperCase())
const metricLabelUpper = computed(() =>
  (props.metrics.find(m => m.key === props.metric)?.label ?? props.metric).toUpperCase()
)

function fmtNum(n: number): string { return (n || 0).toLocaleString() }
function fmtDays(n: number): string { return n > 0 ? `${n.toFixed(1)}` : '—' }
function caretFor(k: DecSortKey): string {
  if (decSortKey.value !== k) return ''
  return decSortDir.value === 'desc' ? '↓' : '↑'
}
</script>

<template>
  <div class="grid gap-1.5 min-w-0">
    <!-- Metric chip strip (KPI selector). Hidden when only one metric. -->
    <div v-if="metrics.length > 1" class="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1 min-w-0">
      <button
        v-for="m in metrics"
        :key="m.key"
        type="button"
        class="flex-none px-2.5 py-1 rounded-full border text-[11px] font-medium transition-colors whitespace-nowrap cursor-pointer"
        :class="metric === m.key ? 'bg-foreground text-background border-foreground' : 'bg-card hover:bg-muted'"
        @click="emit('update:metric', m.key)"
      >{{ m.label }}</button>
    </div>

    <!-- Dimension chip strip — same pattern as FieldPerformance. -->
    <div class="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1 min-w-0">
      <button
        v-for="d in dimensions"
        :key="d.key"
        type="button"
        class="flex-none px-2.5 py-1 rounded-full border text-[11px] font-medium transition-colors whitespace-nowrap cursor-pointer"
        :class="dimension === d.key ? 'bg-foreground text-background border-foreground' : 'bg-card hover:bg-muted'"
        @click="emit('update:dimension', d.key)"
      >{{ d.label }}</button>
    </div>

    <div class="rounded-xl border bg-card overflow-hidden min-w-0">
      <div class="px-3 py-2 border-b flex items-baseline justify-between gap-2 flex-wrap">
        <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          {{ title.toUpperCase() }} · {{ metricLabelUpper }} · {{ dimensionLabelUpper }}
        </p>
        <p class="text-[10px] text-muted-foreground">
          {{ dayUnit === 'biz' ? 'business' : 'calendar' }} days · D100 = max
        </p>
      </div>

      <!-- Loading skeleton -->
      <div v-if="loading" class="p-4 space-y-2">
        <div v-for="i in 4" :key="i" class="h-6 rounded bg-muted/50 animate-pulse" />
      </div>

      <template v-else>
        <!-- Desktop full-decile grid -->
        <div class="hidden sm:block overflow-x-auto">
          <table class="w-full text-[11px] tabular-nums">
            <thead class="bg-muted/30 text-muted-foreground">
              <tr>
                <th class="text-left font-medium px-3 py-2 sticky left-0 bg-muted/30 z-[1]">{{ dimensionLabel }}</th>
                <th class="text-right font-medium px-2 py-2 cursor-pointer hover:text-foreground" @click="setDecSort('count')">n {{ caretFor('count') }}</th>
                <th class="text-right font-medium px-2 py-2">D10</th>
                <th class="text-right font-medium px-2 py-2">D20</th>
                <th class="text-right font-medium px-2 py-2">D30</th>
                <th class="text-right font-medium px-2 py-2">D40</th>
                <th class="text-right font-medium px-2 py-2">D50</th>
                <th class="text-right font-medium px-2 py-2">D60</th>
                <th class="text-right font-medium px-2 py-2">D70</th>
                <th class="text-right font-medium px-2 py-2">D80</th>
                <th class="text-right font-medium px-2 py-2 cursor-pointer hover:text-foreground" @click="setDecSort('d90')">D90 {{ caretFor('d90') }}</th>
                <th class="text-right font-medium px-2 py-2 cursor-pointer hover:text-foreground" @click="setDecSort('d100')">Max {{ caretFor('d100') }}</th>
                <th class="text-right font-medium px-2 py-2 cursor-pointer hover:text-foreground" @click="setDecSort('mean')">Mean {{ caretFor('mean') }}</th>
              </tr>
            </thead>
            <tbody class="divide-y">
              <tr v-for="r in sortedRows" :key="r.dimension_value" class="hover:bg-muted/30">
                <td class="px-3 py-1.5 font-medium truncate max-w-[180px] sticky left-0 bg-card z-[1]" :title="r.dimension_value">{{ r.dimension_value }}</td>
                <td class="text-right px-2">{{ fmtNum(r.count) }}</td>
                <td class="text-right px-2">{{ fmtDays(r.d10) }}</td>
                <td class="text-right px-2">{{ fmtDays(r.d20) }}</td>
                <td class="text-right px-2">{{ fmtDays(r.d30) }}</td>
                <td class="text-right px-2">{{ fmtDays(r.d40) }}</td>
                <td class="text-right px-2">{{ fmtDays(r.d50) }}</td>
                <td class="text-right px-2">{{ fmtDays(r.d60) }}</td>
                <td class="text-right px-2">{{ fmtDays(r.d70) }}</td>
                <td class="text-right px-2">{{ fmtDays(r.d80) }}</td>
                <td class="text-right px-2">{{ fmtDays(r.d90) }}</td>
                <td class="text-right px-2">{{ fmtDays(r.d100) }}</td>
                <td class="text-right px-2 font-semibold">{{ fmtDays(r.mean) }}</td>
              </tr>
              <tr v-if="sortedRows.length === 0">
                <td colspan="13" class="text-center py-6 text-muted-foreground">No data in this window.</td>
              </tr>
            </tbody>
            <tfoot v-if="total && sortedRows.length > 0" class="border-t-2 bg-muted/20 font-semibold">
              <tr>
                <td class="px-3 py-1.5 sticky left-0 bg-muted/20 z-[1]">Total</td>
                <td class="text-right px-2">{{ fmtNum(total.count) }}</td>
                <td class="text-right px-2">{{ fmtDays(total.d10) }}</td>
                <td class="text-right px-2">{{ fmtDays(total.d20) }}</td>
                <td class="text-right px-2">{{ fmtDays(total.d30) }}</td>
                <td class="text-right px-2">{{ fmtDays(total.d40) }}</td>
                <td class="text-right px-2">{{ fmtDays(total.d50) }}</td>
                <td class="text-right px-2">{{ fmtDays(total.d60) }}</td>
                <td class="text-right px-2">{{ fmtDays(total.d70) }}</td>
                <td class="text-right px-2">{{ fmtDays(total.d80) }}</td>
                <td class="text-right px-2">{{ fmtDays(total.d90) }}</td>
                <td class="text-right px-2">{{ fmtDays(total.d100) }}</td>
                <td class="text-right px-2">{{ fmtDays(total.mean) }}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <!-- Mobile: D20 / Mean / D90 / Max only -->
        <div class="sm:hidden">
          <table class="w-full text-[11px] tabular-nums">
            <thead class="bg-muted/30 text-muted-foreground">
              <tr>
                <th class="text-left font-medium px-2 py-2">{{ dimensionLabel }}</th>
                <th class="text-right font-medium px-1.5 py-2 cursor-pointer hover:text-foreground" @click="setDecSort('d20')">D20 {{ caretFor('d20') }}</th>
                <th class="text-right font-medium px-1.5 py-2 cursor-pointer hover:text-foreground" @click="setDecSort('mean')">Mean {{ caretFor('mean') }}</th>
                <th class="text-right font-medium px-1.5 py-2 cursor-pointer hover:text-foreground" @click="setDecSort('d90')">D90 {{ caretFor('d90') }}</th>
                <th class="text-right font-medium px-1.5 py-2 cursor-pointer hover:text-foreground" @click="setDecSort('d100')">Max {{ caretFor('d100') }}</th>
              </tr>
            </thead>
            <tbody class="divide-y">
              <tr v-for="r in sortedRows" :key="r.dimension_value" class="hover:bg-muted/30">
                <td class="px-2 py-1.5 font-medium truncate max-w-[110px]" :title="r.dimension_value">{{ r.dimension_value }}</td>
                <td class="text-right px-1.5">{{ fmtDays(r.d20) }}</td>
                <td class="text-right px-1.5 font-semibold">{{ fmtDays(r.mean) }}</td>
                <td class="text-right px-1.5">{{ fmtDays(r.d90) }}</td>
                <td class="text-right px-1.5">{{ fmtDays(r.d100) }}</td>
              </tr>
              <tr v-if="sortedRows.length === 0">
                <td colspan="5" class="text-center py-6 text-muted-foreground">No data.</td>
              </tr>
            </tbody>
            <tfoot v-if="total && sortedRows.length > 0" class="border-t-2 bg-muted/20 font-semibold">
              <tr>
                <td class="px-2 py-1.5">Total</td>
                <td class="text-right px-1.5">{{ fmtDays(total.d20) }}</td>
                <td class="text-right px-1.5">{{ fmtDays(total.mean) }}</td>
                <td class="text-right px-1.5">{{ fmtDays(total.d90) }}</td>
                <td class="text-right px-1.5">{{ fmtDays(total.d100) }}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
.no-scrollbar::-webkit-scrollbar { display: none; }
</style>
