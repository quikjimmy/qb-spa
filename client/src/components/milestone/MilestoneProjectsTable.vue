<script setup lang="ts">
// Skinny per-milestone projects table — replaces the card-style
// MilestoneDrillList for chart/tile drills. Configurable columns so
// each milestone surfaces fields relevant to that stage (PTO shows
// install date + PTO submit/approve dates; Inspection shows install
// date + scheduled / passed dates; etc.)
//
// Click a row → emits `select(project)`. The parent typically opens
// ProjectDetailDialog (lite slide-in panel) so the user keeps their
// place in the milestone view behind it.

import { computed } from 'vue'
import { fmtDate } from '@/lib/dates'
import { getStatusConfig } from '@/lib/status'

interface ProjectRow {
  record_id: number
  customer_name: string
  status?: string | null
  [k: string]: unknown
}

export interface ColumnDef {
  /** Project field key (e.g. 'install_completed'). */
  key: string
  /** Header label (short — table is dense). */
  label: string
  /** Optional formatter. Default behavior:
   *   • date-looking field (matches a known date-suffix list) → fmtDate
   *   • other → coerce to string */
  format?: (value: unknown, row: ProjectRow) => string
  /** Right-align numeric / date columns. Default: left for first column,
   *  right for date columns, left otherwise. */
  align?: 'left' | 'right'
  /** Tailwind text class for the cell value (e.g. 'text-emerald-600'). */
  toneClass?: string
  /** Pixel width hint — keeps the table dense at the dimensions tabs care about. */
  width?: string
}

const props = defineProps<{
  /** Title shown at the top of the table — typically the drill label
   *  (e.g. "Need INSPX (124)" or "PTO Approved · Apr '26 (38)"). */
  title: string
  columns: ColumnDef[]
  projects: ProjectRow[]
  loading?: boolean
}>()

const emit = defineEmits<{
  select: [project: ProjectRow]
  close: []
}>()

const DATE_RX = /(_date|_at|_completed|_scheduled|_submitted|_approved|_passed|_rejected|sales_date|created_at)$/

function defaultFormat(col: ColumnDef, row: ProjectRow): string {
  const v = row[col.key]
  if (v == null || v === '') return '—'
  if (col.format) return col.format(v, row)
  if (DATE_RX.test(col.key)) return fmtDate(String(v))
  return String(v)
}

function alignClass(col: ColumnDef, idx: number): string {
  const a = col.align ?? (idx === 0 ? 'left' : (DATE_RX.test(col.key) ? 'right' : 'left'))
  return a === 'right' ? 'text-right' : 'text-left'
}

const count = computed(() => props.projects.length)
</script>

<template>
  <div id="milestone-projects-table" class="rounded-xl bg-card overflow-hidden">
    <div class="px-3 py-2 border-b flex items-center justify-between gap-2 flex-wrap">
      <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
        {{ title }} <span class="ml-1 text-foreground">{{ count }}</span>
      </p>
      <button
        type="button"
        class="text-[11px] text-muted-foreground hover:text-foreground cursor-pointer"
        @click="emit('close')"
      >Close</button>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="p-3 space-y-2">
      <div v-for="i in 4" :key="i" class="h-7 rounded bg-muted/50 animate-pulse" />
    </div>

    <!-- Empty -->
    <div v-else-if="!projects.length" class="text-center py-8 text-xs text-muted-foreground">
      No projects in this slice.
    </div>

    <template v-else>
      <!-- Desktop — sticky-header table. First column sticky-left so
           customer name stays visible while horizontally scrolling. -->
      <div class="hidden sm:block overflow-x-auto">
        <table class="w-full text-[12px] tabular-nums">
          <thead class="bg-muted/30 text-muted-foreground sticky top-0">
            <tr>
              <th
                v-for="(c, i) in columns"
                :key="c.key"
                class="font-medium px-3 py-1.5 whitespace-nowrap"
                :class="[
                  alignClass(c, i),
                  i === 0 ? 'sticky left-0 bg-muted/30 z-[1]' : '',
                ]"
                :style="c.width ? { width: c.width } : undefined"
              >{{ c.label }}</th>
            </tr>
          </thead>
          <tbody class="divide-y">
            <tr
              v-for="p in projects"
              :key="p.record_id"
              class="hover:bg-muted/30 cursor-pointer border-l-[3px] transition-colors"
              :class="getStatusConfig(p.status || '').border"
              @click="emit('select', p)"
            >
              <td
                v-for="(c, i) in columns"
                :key="c.key"
                class="px-3 py-1.5"
                :class="[
                  alignClass(c, i),
                  i === 0 ? 'sticky left-0 bg-card z-[1] font-medium truncate max-w-[220px]' : '',
                  c.toneClass,
                ]"
                :title="i === 0 ? p.customer_name : undefined"
              >{{ defaultFormat(c, p) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Mobile — compact card per row. Customer name on top, the
           remaining columns wrap as label/value pairs underneath. -->
      <div class="sm:hidden divide-y">
        <button
          v-for="p in projects"
          :key="p.record_id"
          type="button"
          class="w-full text-left px-3 py-2 hover:bg-muted/30 cursor-pointer border-l-[3px]"
          :class="getStatusConfig(p.status || '').border"
          @click="emit('select', p)"
        >
          <p class="font-semibold text-[13px] truncate">{{ p.customer_name }}</p>
          <div class="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5 text-[11px] text-muted-foreground">
            <template v-for="(c, i) in columns" :key="c.key">
              <span v-if="i > 0 && defaultFormat(c, p) !== '—'">
                <span class="opacity-70">{{ c.label }}:</span>
                <span class="ml-1" :class="c.toneClass">{{ defaultFormat(c, p) }}</span>
              </span>
            </template>
          </div>
        </button>
      </div>
    </template>
  </div>
</template>
