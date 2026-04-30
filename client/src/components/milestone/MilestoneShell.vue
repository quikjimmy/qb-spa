<script setup lang="ts">
// Outer chrome for milestone dashboards. Owns the back link, title,
// DataFreshness badge, and three named slots for the milestone's
// content. Each milestone view becomes:
//
//   <MilestoneShell title="Inspection">
//     <template #filters>...</template>
//     <template #kpis>...</template>
//     <template #charts>...</template>
//     <template #drill>...</template>
//   </MilestoneShell>

import DataFreshness from '@/components/DataFreshness.vue'
import { RouterLink } from 'vue-router'

defineProps<{
  title: string
  /** Optional small caption under the title. */
  description?: string
  /** Where the back-arrow goes; defaults to /projects. */
  backTo?: string
  /** Hide the freshness badge if the page doesn't have a cache concept. */
  showFreshness?: boolean
}>()
</script>

<template>
  <div class="grid gap-2 sm:gap-3 max-w-full">
    <!-- Header row -->
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2 min-w-0">
        <RouterLink :to="backTo ?? '/projects'" class="text-muted-foreground hover:text-foreground" aria-label="Back">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>
        </RouterLink>
        <div class="flex flex-col gap-0.5 min-w-0">
          <h1 class="text-xl sm:text-2xl font-semibold tracking-tight truncate">{{ title }}</h1>
          <DataFreshness v-if="showFreshness !== false" label="Cache" />
          <p v-else-if="description" class="text-[11px] text-muted-foreground truncate">{{ description }}</p>
        </div>
      </div>
      <div class="shrink-0">
        <slot name="header-actions" />
      </div>
    </div>

    <!-- Filters / date / KPIs / charts / drill — each optional. -->
    <slot name="filters" />
    <slot name="dates" />
    <slot name="kpis" />
    <slot name="charts" />
    <slot name="drill" />

    <!-- Default slot — anything else specific to the milestone. -->
    <slot />
  </div>
</template>
