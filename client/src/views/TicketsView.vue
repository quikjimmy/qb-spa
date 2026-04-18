<template>
  <div class="grid gap-6">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Tickets</h1>
      <p class="text-muted-foreground mt-1">Track and manage issues across all projects.</p>
    </div>

    <div class="rounded-xl border bg-card p-6">
      <div class="h-5 w-32 rounded bg-muted animate-pulse mb-4" />
      <div class="space-y-3">
        <div v-for="i in 8" :key="i" class="h-14 rounded bg-muted/50 animate-pulse" />
      </div>
    </div>
  </div>
</template>
