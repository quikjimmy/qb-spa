<script setup lang="ts">
import type { SelectRootProps } from "reka-ui"
import { SelectRoot, useForwardPropsEmits } from "reka-ui"

const props = defineProps<SelectRootProps>()
const emits = defineEmits<{
  "update:modelValue": [value: string]
  "update:open": [value: boolean]
}>()

const forwarded = useForwardPropsEmits(props, emits as unknown as (name: string, ...args: any[]) => void)
</script>

<template>
  <SelectRoot
    v-slot="slotProps"
    data-slot="select"
    v-bind="forwarded"
  >
    <slot v-bind="slotProps" />
  </SelectRoot>
</template>
