<script setup lang="ts">
// /whats-new — full changelog archive, grouped by publish day. The
// popup is the glanceable daily wrap-up; this page is the record.

import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'

interface Entry {
  id: number
  publish_date: string
  category: string
  title: string
  body: string
  path: string | null
  requested_by: string | null
}

const auth = useAuthStore()
const entries = ref<Entry[]>([])
const loading = ref(true)

const CATEGORY_META: Record<string, { label: string; chip: string }> = {
  new:      { label: 'New',      chip: 'bg-sky-500/10 text-sky-600' },
  improved: { label: 'Improved', chip: 'bg-violet-500/10 text-violet-600' },
  fixed:    { label: 'Fixed',    chip: 'bg-emerald-500/10 text-emerald-600' },
}
function catMeta(c: string) { return CATEGORY_META[c] || CATEGORY_META['improved']! }

const groups = computed(() => {
  const byDate = new Map<string, Entry[]>()
  for (const e of entries.value) {
    const list = byDate.get(e.publish_date) || []
    list.push(e)
    byDate.set(e.publish_date, list)
  }
  return [...byDate.entries()].map(([date, list]) => ({ date, list }))
})

function fmtDay(d: string): string {
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

onMounted(async () => {
  try {
    const res = await fetch('/api/changelog', { headers: { Authorization: `Bearer ${auth.token}` } })
    if (res.ok) entries.value = ((await res.json()) as { entries: Entry[] }).entries
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="grid grid-cols-1 gap-3 min-w-0 max-w-2xl">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">What's New</h1>
      <p class="text-xs text-muted-foreground mt-0.5">Updates and fixes, newest first. Items born from your feedback carry your name.</p>
    </div>

    <div v-if="loading" class="space-y-3">
      <div class="h-24 rounded-xl bg-card animate-pulse" />
      <div class="h-24 rounded-xl bg-card animate-pulse" />
    </div>
    <div v-else-if="groups.length === 0" class="rounded-xl bg-card p-8 text-center text-sm text-muted-foreground">
      Nothing published yet — check back soon.
    </div>

    <section v-for="g in groups" :key="g.date" class="space-y-2">
      <h2 class="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{{ fmtDay(g.date) }}</h2>
      <div class="rounded-xl bg-card overflow-hidden divide-y divide-border/40">
        <div v-for="e in g.list" :key="e.id" class="px-4 py-3">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider" :class="catMeta(e.category).chip">
              {{ catMeta(e.category).label }}
            </span>
            <span v-if="e.requested_by" class="text-[11px] text-muted-foreground">
              Requested by <span class="font-semibold text-foreground">{{ e.requested_by }}</span>
            </span>
          </div>
          <h3 class="mt-1.5 text-[14px] font-semibold leading-snug">{{ e.title }}</h3>
          <p v-if="e.body" class="mt-1 text-[13px] leading-relaxed text-muted-foreground">{{ e.body }}</p>
          <RouterLink
            v-if="e.path"
            :to="e.path"
            class="mt-1.5 inline-block text-[12px] font-semibold text-sky-600 hover:text-sky-700"
          >See it →</RouterLink>
        </div>
      </div>
    </section>
  </div>
</template>
