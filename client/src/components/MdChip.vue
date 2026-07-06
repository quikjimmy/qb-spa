<script setup lang="ts">
// "MD" (Material Delivered) chip — TOA material-order state for an
// install. Renders in front of the En Route / On Site progression on
// install tiles. One fixed "MD" label; the tone carries the state
// (slate = ordered, amber = confirmed, emerald = delivered) and the
// tooltip spells it out with PO + distributor.
import { computed } from 'vue'
import { TOA_INFO, toaTitle, type ToaState } from '@/lib/arrivyStatus'

const props = defineProps<{
  toa: ToaState | null | undefined
  /** 'pill' (default) matches task status pills; 'dot' for dense rails. */
  variant?: 'pill' | 'dot'
}>()

const info = computed(() => props.toa ? TOA_INFO[props.toa.status] : null)
const title = computed(() => props.toa ? toaTitle(props.toa) : '')
</script>

<template>
  <span
    v-if="toa && info"
    :title="title"
    :aria-label="title"
    :class="variant === 'dot'
      ? ['inline-block size-2 rounded-full shrink-0', info.dotCls]
      : ['inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-bold tracking-wide shrink-0', info.pillCls]"
  ><template v-if="variant !== 'dot'">MD</template></span>
</template>
