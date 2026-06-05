<script setup lang="ts">
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
</script>

<template>
  <!-- Referral Agent: a single "bucket" tile into their filtered project list. -->
  <div v-if="auth.isReferralAgent" class="grid gap-6">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Welcome back, {{ auth.user?.name?.split(' ')[0] }}</h1>
      <p class="text-muted-foreground mt-1">Your activated projects, ready to review.</p>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      <RouterLink
        to="/projects"
        class="group rounded-xl bg-gradient-to-br from-card to-muted/40 p-6 transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div class="flex items-center justify-between">
          <div class="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
          </div>
          <svg class="text-muted-foreground transition-transform group-hover:translate-x-0.5" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
        </div>
        <h2 class="mt-4 text-lg font-semibold tracking-tight">Projects</h2>
        <p class="text-sm text-muted-foreground mt-1">Completed projects, PTO-approved 30+ days ago.</p>
      </RouterLink>
    </div>
  </div>

  <div v-else class="grid gap-6">
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
