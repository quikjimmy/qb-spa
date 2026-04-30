<script setup lang="ts">
// Stub view for milestone-organized Project sub-pages that haven't been
// fully wired up yet. Composes the same milestone primitives the real
// dashboards use (shell, KPI strip, filter bar, date presets, drill
// list) so each stub looks like a real page from day one — the data
// just isn't loaded yet. As individual milestones get real fetchers,
// swap their route's component to a dedicated view.

import { ref } from 'vue'
import { useRoute } from 'vue-router'
import MilestoneShell from '@/components/milestone/MilestoneShell.vue'
import MilestoneFilterBar, { type FilterDef } from '@/components/milestone/MilestoneFilterBar.vue'
import MilestoneDatePresetBar from '@/components/milestone/MilestoneDatePresetBar.vue'
import MilestoneKpiStrip from '@/components/milestone/MilestoneKpiStrip.vue'

const route = useRoute()

const title = String(route.meta['title'] ?? 'Milestone')
const description = String(route.meta['description'] ?? '')
const order = route.meta['order'] as number | undefined

// Skeleton state — these populate from /api/projects + the milestone-specific
// analytics endpoint when each page is built out. For now they stay empty
// so the layout reads as "no data yet" rather than fake numbers.
const datePreset = ref('last_30')
const useBizDays = ref(false)
const filters = ref<FilterDef[]>([
  { key: 'state',  placeholder: 'State',  options: [], value: '' },
  { key: 'lender', placeholder: 'Lender', options: [], value: '' },
  { key: 'epc',    placeholder: 'EPC',    options: [], value: 'Kin Home', defaultValue: 'Kin Home' },
])

const tiles = [
  { key: 'count', label: 'Count',     value: '—', tone: 'info'    as const },
  { key: 'avg',   label: 'Avg Days',  value: '—', tone: 'neutral' as const },
  { key: 'wip',   label: 'In Flight', value: '—', tone: 'warning' as const },
  { key: 'done',  label: 'Done',      value: '—', tone: 'success' as const },
]

function onFilterChange(key: string, value: string) {
  const f = filters.value.find(f => f.key === key)
  if (f) f.value = value
}
function resetFilters() {
  for (const f of filters.value) f.value = f.defaultValue ?? ''
}
</script>

<template>
  <MilestoneShell :title="title" :description="description" :show-freshness="false">
    <template #filters>
      <MilestoneFilterBar
        :filters="filters"
        @update="onFilterChange"
        @reset="resetFilters"
      />
    </template>

    <template #dates>
      <MilestoneDatePresetBar
        :preset="datePreset"
        :biz-days="useBizDays"
        @update:preset="(k: string) => (datePreset = k)"
        @update:biz-days="(v: boolean) => (useBizDays = v)"
      />
    </template>

    <template #kpis>
      <MilestoneKpiStrip :tiles="tiles" />
    </template>

    <template #charts>
      <div class="rounded-xl bg-card px-5 py-6 sm:px-7 sm:py-8" style="box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 1px 0 rgba(15,23,42,0.03);">
        <div class="flex items-center gap-2 mb-1">
          <span
            v-if="order != null"
            class="inline-flex items-center justify-center size-6 rounded-full bg-slate-100 text-slate-600 text-[11px] font-semibold tabular-nums"
            aria-hidden="true"
          >{{ order }}</span>
          <span class="text-[10px] uppercase tracking-[0.12em] text-slate-400">Milestone</span>
        </div>
        <h2 class="text-lg font-semibold text-slate-900 tracking-tight">{{ title }}</h2>
        <p v-if="description" class="text-[13px] text-slate-500 mt-1 leading-relaxed">{{ description }}</p>

        <div class="mt-5 rounded-lg bg-slate-50 ring-1 ring-slate-200 px-4 py-5 text-[13px] text-slate-600 leading-relaxed">
          Data isn't wired up here yet — this surface composes the shared
          milestone primitives (shell, KPI strip, filters, date presets) so
          the eventual dashboard will drop straight in.
          <span class="block mt-1 text-slate-500">
            Up next: a milestone-scoped projects table and the tooling the
            team working this stage actually uses day-to-day.
          </span>
        </div>
      </div>
    </template>
  </MilestoneShell>
</template>
