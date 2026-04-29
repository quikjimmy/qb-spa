<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ text: string | null | undefined }>()

const visible = computed(() => {
  const t = String(props.text ?? '').trim()
  // QB convention — empty or "0" means no banner.
  return t !== '' && t !== '0'
})
</script>

<template>
  <div
    v-if="visible"
    role="alert"
    class="rounded-xl bg-amber-500 text-white py-2.5 px-4 text-[13px] font-medium leading-snug flex items-center gap-2.5"
  >
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" class="shrink-0" aria-hidden="true">
      <path d="M12 2L1 21H23L12 2Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M12 9V14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
      <circle cx="12" cy="17.5" r="1.2" fill="currentColor"/>
    </svg>
    <span class="flex-1">{{ text }}</span>
  </div>
</template>
