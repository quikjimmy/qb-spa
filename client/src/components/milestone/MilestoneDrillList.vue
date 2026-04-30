<script setup lang="ts">
// Generic drill-down list shown beneath the dashboard when the user
// taps a KPI tile. Renders a uniform set of project cards with the
// status border accent + a small set of meta fields that vary by
// milestone (passed in as `metaFields`).
//
// Replaces the per-view loops in PtoDashboardView + InspxDashboardView.

import { computed } from 'vue'
import { fmtDate } from '@/lib/dates'
import { getStatusConfig } from '@/lib/status'
import { useRouter } from 'vue-router'

interface ProjectRow {
  record_id: number
  customer_name: string
  status?: string
  coordinator?: string | null
  [k: string]: unknown
}

export interface MetaField {
  /** Project field name to read (e.g. 'install_completed'). */
  field: string
  /** Short prefix shown before the date, e.g. 'Inst:'. */
  label: string
  /** Format as a date (default true). When false, prints the raw value. */
  asDate?: boolean
}

const props = defineProps<{
  label: string
  projects: ProjectRow[]
  loading?: boolean
  /** Meta rows shown under the customer name, in order. Hidden when the
   *  field is missing on the project — keeps cards short. */
  metaFields?: MetaField[]
}>()
const emit = defineEmits<{ close: [] }>()

const router = useRouter()

const meta = computed<MetaField[]>(() => props.metaFields ?? [
  { field: 'install_completed',     label: 'Inst:'  },
  { field: 'inspection_scheduled',  label: 'Sched:' },
  { field: 'inspection_passed',     label: 'Pass:'  },
])

function metaValue(p: ProjectRow, m: MetaField): string {
  const v = p[m.field]
  if (v == null || v === '') return ''
  if (m.asDate === false) return String(v)
  return fmtDate(String(v))
}

function openProject(rid: number) {
  router.push({ name: 'project-detail', params: { id: rid } })
}
</script>

<template>
  <div id="drill-list" class="rounded-xl bg-card p-3">
    <div class="flex items-center justify-between mb-2">
      <h3 class="text-xs font-semibold">{{ label }} — {{ projects.length }}</h3>
      <button
        type="button"
        class="text-[11px] text-muted-foreground hover:text-foreground cursor-pointer"
        @click="emit('close')"
      >Close</button>
    </div>
    <div v-if="loading" class="space-y-2">
      <div v-for="i in 3" :key="i" class="h-10 rounded bg-muted/50 animate-pulse" />
    </div>
    <div v-else-if="!projects.length" class="text-center py-6 text-xs text-muted-foreground">No projects in this group.</div>
    <div v-else class="space-y-1">
      <div
        v-for="p in projects"
        :key="p.record_id"
        class="rounded-lg border-l-[3px] border border-border bg-background px-3 py-2 cursor-pointer hover:bg-muted/30 transition-colors"
        :class="getStatusConfig(p.status || '').border"
        @click="openProject(p.record_id)"
      >
        <p class="text-sm font-semibold truncate">{{ p.customer_name }}</p>
        <div class="flex gap-3 mt-0.5 text-[11px] text-muted-foreground flex-wrap">
          <span v-if="p.coordinator">{{ p.coordinator }}</span>
          <template v-for="m in meta" :key="m.field">
            <span v-if="metaValue(p, m)">{{ m.label }} {{ metaValue(p, m) }}</span>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
