<script setup lang="ts">
// Stub view for milestone-organized Project sub-pages that haven't been
// built yet. Each route in `router/index.ts` points here with its own
// `name` (e.g. 'milestone-sales') — the component reads route.meta.title
// + route.meta.description so each page reads as itself.
//
// As individual milestone surfaces grow real content, swap their route's
// component to a dedicated view file. This file stays for the rest.
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()

const title = computed(() => String(route.meta['title'] ?? 'Milestone'))
const description = computed(() => String(route.meta['description'] ?? ''))
const order = computed(() => route.meta['order'] as number | undefined)
</script>

<template>
  <div class="max-w-[920px] mx-auto px-4 sm:px-6 py-6">
    <div class="rounded-2xl bg-white px-5 py-6 sm:px-7 sm:py-8" style="box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 1px 0 rgba(15,23,42,0.03);">
      <div class="flex items-center gap-2 mb-1">
        <span
          v-if="order != null"
          class="inline-flex items-center justify-center size-6 rounded-full bg-slate-100 text-slate-600 text-[11px] font-semibold tabular-nums"
          aria-hidden="true"
        >{{ order }}</span>
        <span class="text-[10px] uppercase tracking-[0.12em] text-slate-400">Milestone</span>
      </div>
      <h1 class="text-2xl font-semibold text-slate-900 tracking-tight">{{ title }}</h1>
      <p v-if="description" class="text-[13px] text-slate-500 mt-1.5 leading-relaxed">{{ description }}</p>

      <div class="mt-6 rounded-lg bg-slate-50 ring-1 ring-slate-200 px-4 py-5 text-[13px] text-slate-600 leading-relaxed">
        This milestone surface hasn't been built yet. The nav slot is in place
        so links and bookmarks land somewhere useful.
        <span class="block mt-1 text-slate-500">
          Coming up: a milestone-scoped projects table, KPI strip, and the
          tooling that the team working this stage actually uses day-to-day.
        </span>
      </div>
    </div>
  </div>
</template>
