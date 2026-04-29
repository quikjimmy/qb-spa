<script setup lang="ts">
defineProps<{
  title?: string
  count?: number
  action?: string
  noPadding?: boolean
}>()

const emit = defineEmits<{ action: [] }>()
</script>

<template>
  <div
    class="bg-white rounded-2xl"
    style="box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 1px 0 rgba(15,23,42,0.03)"
  >
    <div
      v-if="title"
      class="flex items-center gap-2 px-4 pt-3.5 pb-2.5"
    >
      <div class="text-[11px] font-medium text-slate-500 tracking-[0.08em] uppercase">{{ title }}</div>
      <span
        v-if="count != null"
        class="bg-slate-100 text-slate-700 font-medium text-[11px] px-1.5 rounded-full min-w-[18px] text-center"
      >{{ count }}</span>
      <div class="flex-1" />
      <button
        v-if="action"
        class="text-teal-700 font-medium text-[13px] hover:underline cursor-pointer"
        @click="emit('action')"
      >{{ action }}</button>
    </div>
    <div :class="noPadding ? '' : 'px-4 pb-3.5'">
      <slot />
    </div>
  </div>
</template>
