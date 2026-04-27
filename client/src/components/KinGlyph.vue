<script setup lang="ts">
withDefaults(defineProps<{ size?: number; color?: string }>(), {
  size: 28,
  color: '#16202E',
})
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 100 100"
    aria-hidden="true"
  >
    <rect x="14" y="22" width="72" height="10" :fill="color" />
    <rect x="14" y="68" width="72" height="10" :fill="color" />
    <rect x="46" y="40" width="8" height="32" :fill="color" />
    <polygon points="50,32 22,62 22,52 50,22" :fill="color" />
    <polygon points="50,32 78,62 78,52 50,22" :fill="color" />
  </svg>
</template>
