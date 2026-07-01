<script setup lang="ts">
// Per-milestone funding notes for the project bump-out. Surfaces the
// "Not Ready for Funding" reason (what's holding the milestone up) and the
// "Most Recent Funding Note" (whether/when the team last looked) so a funder
// can read the real story the M2/M3 *status* alone hides. Renders nothing
// when no milestone carries a note, so the parent can mount it unconditionally.
import { computed } from 'vue'
import { collectMilestoneNotes } from '@/lib/fundingNotes'

const props = defineProps<{
  /** project_cache row (SELECT *) — carries m{1,2,3}_not_ready_note / _funding_note. */
  p: Record<string, unknown>
  /** Emphasize the section when opened from a funding report. */
  emphasis?: boolean
}>()

const groups = computed(() => collectMilestoneNotes(props.p))
</script>

<template>
  <div v-if="groups.length" class="px-4 pb-4">
    <p
      class="text-[10px] font-semibold uppercase tracking-wider mb-1.5"
      :class="emphasis ? 'text-amber-700' : 'text-muted-foreground'"
    >
      Not ready for funding
    </p>

    <div class="rounded-2xl bg-card px-3 py-2.5 space-y-2.5" style="box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 1px 0 rgba(15,23,42,0.03);">
      <div v-for="g in groups" :key="g.key" class="space-y-1">
        <!-- Milestone tag + current QB status -->
        <div class="flex items-center gap-1.5">
          <span class="text-[10px] font-semibold tracking-wide px-1.5 py-[1px] rounded bg-slate-100 text-slate-600">{{ g.label }}</span>
          <span v-if="g.status" class="text-[11px] text-muted-foreground">{{ g.status }}</span>
        </div>

        <!-- The "why it's held up" reason — the actionable headline -->
        <p
          v-if="g.reason"
          class="text-[12.5px] leading-snug rounded-lg px-2 py-1.5 bg-amber-50 text-amber-900"
        >
          {{ g.reason }}
        </p>

        <!-- Most-recent funding note(s) with when/who, if logged -->
        <div v-if="g.recent.length" class="space-y-1">
          <div
            v-for="(n, i) in g.recent"
            :key="i"
            class="text-[12px] leading-snug text-slate-600"
          >
            <span v-if="n.when || n.actor" class="text-[10.5px] text-muted-foreground tabular-nums">
              {{ [n.when, n.actor].filter(Boolean).join(' · ') }}
            </span>
            <span class="block whitespace-pre-line">{{ n.body }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
