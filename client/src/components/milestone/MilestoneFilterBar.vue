<script setup lang="ts">
// Filter bar — Select dropdowns for each filter the milestone supports,
// plus a Reset button when anything is active. Designed to be flexible
// enough for every milestone:
//   • Inspx: state, lender, EPC
//   • PTO:   state, lender, EPC, NEM user
//   • PC:    state, coordinator, status
// Pass `filters` describing what to render; emit `update` with the
// changed key + value so the parent owns the source-of-truth.

import { computed } from 'vue'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export interface FilterDef {
  key: string                             // 'state', 'lender', 'epc', etc.
  placeholder: string                     // 'State', 'Lender', 'EPC'
  allLabel?: string                       // default 'All'
  options: ReadonlyArray<string>          // dropdown options
  value: string                           // current value
  /** Default value used when computing whether the user has touched
   *  this filter (e.g. EPC = 'Kin Home' is the implicit default). */
  defaultValue?: string
}

const props = defineProps<{
  filters: FilterDef[]
  /** Show Reset button when ANY filter differs from its defaultValue. */
  showReset?: boolean
  /** Additional active signal — e.g. "the date preset isn't the default"
   *  or "the bizDays toggle is on". Adds an OR to the visibility of the
   *  Reset button so the parent can scope the master reset wider than
   *  just the dropdown filters. */
  extraActive?: boolean
}>()
const emit = defineEmits<{
  update: [key: string, value: string]
  reset: []
}>()

const anyActive = computed(() =>
  props.extraActive === true ||
  props.filters.some(f => f.value !== '' && f.value !== (f.defaultValue ?? ''))
)

function onChange(key: string, raw: string) {
  emit('update', key, raw === '__all__' ? '' : raw)
}
</script>

<template>
  <div class="flex gap-1.5 flex-wrap items-center">
    <Select
      v-for="f in filters"
      :key="f.key"
      :model-value="f.value || '__all__'"
      @update:model-value="(v: string) => onChange(f.key, v)"
    >
      <!-- Trigger always shows "<Title>: <value>" so the user knows
           which dimension this dropdown represents even when something
           is selected. The label is uppercase + dim, the value is
           foreground-toned for contrast. -->
      <SelectTrigger class="h-7 w-auto text-[11px] cursor-pointer gap-1">
        <span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{{ f.placeholder }}</span>
        <span class="text-[11px] font-medium text-foreground">
          {{ f.value || (f.allLabel ?? 'All') }}
        </span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__all__">{{ f.allLabel ?? 'All' }}</SelectItem>
        <SelectItem v-for="opt in f.options" :key="opt" :value="opt">{{ opt }}</SelectItem>
      </SelectContent>
    </Select>
    <button
      v-if="(showReset !== false) && anyActive"
      type="button"
      class="text-[11px] text-muted-foreground hover:text-foreground shrink-0 cursor-pointer"
      @click="emit('reset')"
    >Reset</button>
  </div>
</template>
