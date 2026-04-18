<script setup lang="ts">
import { RouterView } from 'vue-router'
import { onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()

onMounted(() => {
  if (auth.token && !auth.user) auth.fetchUser()
})
</script>

<template>
  <RouterView />
</template>
