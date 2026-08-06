<script setup lang="ts">
// The assessment for one imported Arrivy survey.
//
// This is what was missing entirely: photos could be imported and judged with
// nowhere to go and read the result. Failures lead, because they're the only
// part anyone needs to act on; everything else is available but folded away.
import { computed, ref, watch } from 'vue'
import {
  accentText, authHeaders, parseStringList, photoState, stateAccent, stateLabel,
  fmtConfidence, type PhotoRow,
} from '@/lib/photoguard'

const props = defineProps<{ taskRowId: number | null; title: string }>()
// The list travels with the photo so the dialog can walk it — reviewing 15
// failures shouldn't mean 15 open/close cycles.
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'openPhoto', p: PhotoRow, list: PhotoRow[]): void
}>()

const photos = ref<PhotoRow[]>([])
const loading = ref(false)
const showAll = ref(false)

async function load() {
  if (!props.taskRowId) return
  loading.value = true
  try {
    const res = await fetch(`/api/photoguard/tasks/${props.taskRowId}`, { headers: authHeaders() })
    photos.value = res.ok ? (await res.json() as { photos: PhotoRow[] }).photos : []
  } catch {
    photos.value = []
  } finally {
    loading.value = false
  }
}
watch(() => props.taskRowId, load, { immediate: true })

const judged = computed(() => photos.value.filter(p => p.validation_status === 'done'))
const failed = computed(() => photos.value.filter(p => photoState(p) === 'failed' || photoState(p) === 'blocked'))
const passed = computed(() => photos.value.filter(p => photoState(p) === 'passed' || photoState(p) === 'approved'))
const pending = computed(() => photos.value.filter(p => photoState(p) === 'pending'))

const passRate = computed(() =>
  judged.value.length ? Math.round((passed.value.length / judged.value.length) * 100) : null)

/** Grouped by the form section so a reviewer can see where a survey is weak,
 *  rather than reading 63 photos as one undifferentiated list. */
const bySection = computed(() => {
  const m = new Map<string, { pass: number; fail: number; pending: number }>()
  for (const p of photos.value) {
    const key = p.category_section || 'Other'
    const g = m.get(key) ?? { pass: 0, fail: 0, pending: 0 }
    const s = photoState(p)
    if (s === 'passed' || s === 'approved') g.pass++
    else if (s === 'pending') g.pending++
    else g.fail++
    m.set(key, g)
  }
  return [...m.entries()].sort((a, b) => b[1].fail - a[1].fail)
})

function issuesOf(p: PhotoRow): string[] {
  return parseStringList(p.validation_issues)
}

function sectionLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4"
    @click.self="emit('close')"
  >
    <div class="bg-card w-full sm:max-w-2xl rounded-t-2xl sm:rounded-2xl max-h-[90vh] overflow-y-auto">
      <!-- Header sticks so the verdict stays visible while scrolling photos -->
      <div class="sticky top-0 bg-card border-b px-4 py-3 flex items-start justify-between gap-2">
        <div class="min-w-0">
          <p class="text-sm font-medium truncate">{{ title }}</p>
          <p class="text-[11px]" :class="passRate !== null && passRate >= 80 ? 'text-emerald-600' : 'text-rose-600'">
            <span v-if="passRate !== null">{{ passRate }}% pass · </span>
            {{ passed.length }} passed · {{ failed.length }} need attention
            <span v-if="pending.length" class="text-amber-600"> · {{ pending.length }} still assessing</span>
          </p>
        </div>
        <button
          type="button"
          class="flex-none min-h-9 px-3 rounded-full border text-[11px] font-medium bg-card hover:bg-muted cursor-pointer"
          @click="emit('close')"
        >Close</button>
      </div>

      <div class="p-4 grid gap-4">
        <p v-if="loading" class="text-[12px] text-muted-foreground">Loading assessment…</p>

        <template v-else-if="photos.length">
          <!-- Coverage by section -->
          <div class="grid gap-1.5">
            <p class="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              By section
            </p>
            <div v-for="[key, g] in bySection" :key="key" class="min-w-0">
              <div class="flex items-baseline justify-between gap-2 text-[11px]">
                <span class="truncate">{{ sectionLabel(key) }}</span>
                <span class="flex-none tabular-nums text-muted-foreground">
                  {{ g.pass }} pass<span v-if="g.fail"> · <span class="text-rose-600">{{ g.fail }} fail</span></span>
                </span>
              </div>
              <div class="mt-0.5 h-1.5 rounded-full bg-muted overflow-hidden flex">
                <div class="h-full bg-emerald-500" :style="{ width: `${(g.pass / (g.pass + g.fail + g.pending)) * 100}%` }" />
                <div class="h-full bg-rose-500" :style="{ width: `${(g.fail / (g.pass + g.fail + g.pending)) * 100}%` }" />
              </div>
            </div>
          </div>

          <!-- Failures first — the only actionable part -->
          <div v-if="failed.length" class="grid gap-1.5">
            <p class="text-[10px] font-semibold uppercase tracking-widest text-rose-600">
              Needs attention · {{ failed.length }}
            </p>
            <button
              v-for="p in failed" :key="p.id" type="button"
              class="flex gap-2 items-start rounded-lg border border-l-2 border-l-rose-500 p-2 min-w-0 text-left cursor-pointer hover:bg-muted transition-colors"
              @click="emit('openPhoto', p, failed)"
            >
              <img
                v-if="p.thumb_path" :src="p.thumb_path"
                :alt="`Photo for ${p.category_label ?? 'unknown requirement'}`"
                class="flex-none w-12 h-12 rounded object-cover bg-muted"
              />
              <span class="min-w-0 flex-1">
                <span class="block text-[12px] font-medium truncate">{{ p.category_label || 'Unassigned' }}</span>
                <span v-if="issuesOf(p).length" class="block text-[11px] text-rose-600">
                  {{ issuesOf(p)[0] }}
                </span>
                <span v-else-if="p.validation_description" class="block text-[11px] text-muted-foreground truncate">
                  {{ p.validation_description }}
                </span>
              </span>
              <span class="flex-none text-[10px] text-muted-foreground tabular-nums">
                {{ fmtConfidence(p.validation_confidence) }}
              </span>
            </button>
          </div>

          <!-- Everything else, folded away -->
          <div class="grid gap-1.5">
            <button
              type="button"
              class="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2 text-left cursor-pointer"
              :aria-expanded="showAll"
              @click="showAll = !showAll"
            >{{ showAll ? 'Hide' : `Show all ${photos.length} photos` }}</button>

            <div v-if="showAll" class="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
              <button
                v-for="p in photos" :key="p.id" type="button"
                class="relative block rounded-lg overflow-hidden bg-muted aspect-square cursor-pointer"
                :aria-label="`${p.category_label ?? 'Photo'} — ${stateLabel(photoState(p))}`"
                @click="emit('openPhoto', p, photos)"
              >
                <img
                  v-if="p.thumb_path" :src="p.thumb_path"
                  :alt="`Photo for ${p.category_label ?? 'unknown requirement'}`"
                  class="w-full h-full object-cover"
                />
                <span
                  class="absolute bottom-0 inset-x-0 text-[9px] font-bold uppercase tracking-wider px-1 py-0.5 bg-black/55 text-white"
                >{{ stateLabel(photoState(p)) }}</span>
              </button>
            </div>
          </div>
        </template>

        <p v-else class="text-[12px] text-muted-foreground">
          No photos imported for this survey yet.
        </p>
      </div>
    </div>
  </div>
</template>
