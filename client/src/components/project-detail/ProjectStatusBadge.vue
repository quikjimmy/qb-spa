<script setup lang="ts">
import { computed } from 'vue'
import { getStatusConfig } from '@/lib/status'

const props = defineProps<{ status: string | null | undefined; dot?: boolean }>()
const cfg = computed(() => getStatusConfig(props.status ?? ''))
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 px-2.5 py-[3px] rounded-full text-[11px] font-medium whitespace-nowrap"
    :class="[cfg.bg, cfg.text]"
  >
    <span v-if="dot" class="size-1.5 rounded-full" :class="cfg.dot" />
    {{ cfg.label || '—' }}
  </span>
</template>
