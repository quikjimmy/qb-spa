<script setup lang="ts">
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
</script>

<template>
  <div class="grid gap-6">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Welcome back, {{ auth.user?.name?.split(' ')[0] }}</h1>
      <p class="text-muted-foreground mt-1">Here's what's happening across your projects.</p>
    </div>

    <!-- KPI cards placeholder -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <div v-for="i in 4" :key="i" class="rounded-xl border bg-card p-6 space-y-2">
        <div class="h-4 w-24 rounded bg-muted animate-pulse" />
        <div class="h-8 w-16 rounded bg-muted animate-pulse" />
      </div>
    </div>

    <!-- Activity placeholder -->
    <div class="rounded-xl border bg-card p-6">
      <div class="h-5 w-32 rounded bg-muted animate-pulse mb-4" />
      <div class="space-y-3">
        <div v-for="i in 5" :key="i" class="h-12 rounded bg-muted/50 animate-pulse" />
      </div>
    </div>
  </div>
</template>
