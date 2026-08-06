<script setup lang="ts">
// Reviewing one photo's assessment.
//
// Rebuilt from the phone-width sheet it started as. Three things were wrong:
// a 2000px screen rendered a narrow column with the image pushing every fact
// below the fold; there was no way to move between failures without closing
// and reopening for each one; and missing metadata rendered as bare em-dashes,
// which reads as broken rather than "not recorded".
//
// Desktop now splits image and detail side by side, the reviewer can walk the
// list with the arrow keys, and every field says what it means.
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import {
  accentText, fmtBytes, fmtConfidence, fmtCoords, parseIssues, parseStringList,
  photoState, stateAccent, stateLabel, type PhotoRow,
} from '@/lib/photoguard'
import AssessmentChat from '@/components/photoguard/AssessmentChat.vue'

const props = defineProps<{
  /** The list being reviewed, so the dialog can navigate within it. */
  photos: PhotoRow[]
  index: number
  busy?: boolean
  /** Enables per-photo chat when the dialog knows its assessment scope. */
  chatScope?: 'submission' | 'task' | null
  chatScopeId?: number | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'navigate', index: number): void
  (e: 'review', status: 'approved' | 'rejected' | 'resubmit', note: string): void
  (e: 'revalidate', id: number): void
}>()

const note = ref('')
const closeBtn = ref<HTMLButtonElement | null>(null)

const photo = computed<PhotoRow | null>(() => props.photos[props.index] ?? null)
const state = computed(() => (photo.value ? photoState(photo.value) : 'pending'))
const gateIssues = computed(() => (photo.value ? parseIssues(photo.value.metadata_issues) : []))
const aiIssues = computed(() => (photo.value ? parseStringList(photo.value.validation_issues) : []))

const hasPrev = computed(() => props.index > 0)
const hasNext = computed(() => props.index < props.photos.length - 1)

function go(delta: number) {
  const next = props.index + delta
  if (next >= 0 && next < props.photos.length) emit('navigate', next)
}

// A note belongs to the photo it was typed against, not the dialog.
watch(() => props.index, () => { note.value = '' })

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { emit('close'); return }
  // Don't hijack arrows while someone is typing their note.
  const tag = (e.target as HTMLElement | null)?.tagName
  if (tag === 'TEXTAREA' || tag === 'INPUT') return
  if (e.key === 'ArrowLeft') go(-1)
  if (e.key === 'ArrowRight') go(1)
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  closeBtn.value?.focus()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

/** "—" reads as broken. Say what's actually true instead. */
function orNotRecorded(v: string | null | undefined, fallback = 'Not recorded'): string {
  const s = (v ?? '').toString().trim()
  return s === '' ? fallback : s
}

const capturedBy = computed(() => {
  const p = photo.value
  if (!p) return '—'
  if (p.captured_by_name) return p.captured_by_name
  // Arrivy imports carry no app user; saying "not recorded" would imply a gap
  // that doesn't exist.
  return p.capture_source === 'arrivy_import' ? 'Field crew (via Arrivy)' : 'Not recorded'
})

const sourceLabel = computed(() => ({
  camera: 'Live camera',
  upload: 'Photo library',
  video_frame: 'Video frame',
  arrivy_import: 'Imported from Arrivy',
}[photo.value?.capture_source ?? ''] ?? 'Unknown'))

const takenAt = computed(() => {
  const t = photo.value?.photo_timestamp
  if (!t) return 'Not recorded'
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? t : d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })
})
</script>

<template>
  <div
    v-if="photo"
    class="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4"
    role="dialog" aria-modal="true" :aria-label="`Assessment for ${photo.category_label ?? 'photo'}`"
    @click.self="emit('close')"
  >
    <div class="bg-card w-full sm:max-w-5xl rounded-t-2xl sm:rounded-2xl max-h-[92vh] flex flex-col overflow-hidden">
      <!-- Header: verdict is the first thing read -->
      <div class="flex items-start justify-between gap-3 px-4 py-3 border-b min-w-0">
        <div class="min-w-0">
          <p class="text-sm font-medium truncate">{{ photo.category_label || 'Photo' }}</p>
          <p class="mt-0.5 flex flex-wrap items-center gap-1.5">
            <span
              class="px-1.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider"
              :class="state === 'passed' || state === 'approved'
                ? 'bg-emerald-100 text-emerald-700'
                : state === 'pending' ? 'bg-slate-100 text-slate-600' : 'bg-rose-100 text-rose-700'"
            >{{ stateLabel(state) }}</span>
            <span v-if="photo.validation_confidence != null" class="text-[11px] text-muted-foreground">
              {{ fmtConfidence(photo.validation_confidence) }} confidence
            </span>
            <span v-if="photo.category_section" class="text-[11px] text-muted-foreground">
              · {{ photo.category_section.replace(/_/g, ' ') }}
            </span>
          </p>
        </div>

        <div class="flex items-center gap-1.5 flex-none">
          <span v-if="photos.length > 1" class="text-[11px] text-muted-foreground tabular-nums">
            {{ index + 1 }} / {{ photos.length }}
          </span>
          <button
            type="button" :disabled="!hasPrev" aria-label="Previous photo"
            class="size-8 rounded-full border grid place-items-center cursor-pointer hover:bg-muted disabled:opacity-30 disabled:cursor-default transition-colors"
            @click="go(-1)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M15 18l-6-6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <button
            type="button" :disabled="!hasNext" aria-label="Next photo"
            class="size-8 rounded-full border grid place-items-center cursor-pointer hover:bg-muted disabled:opacity-30 disabled:cursor-default transition-colors"
            @click="go(1)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <button
            ref="closeBtn" type="button"
            class="ml-1 px-3 h-8 rounded-full border text-[11px] font-medium bg-card hover:bg-muted cursor-pointer transition-colors"
            @click="emit('close')"
          >Close</button>
        </div>
      </div>

      <!-- Body: side by side once there's room for it -->
      <div class="flex-1 overflow-y-auto min-h-0">
        <div class="grid md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div class="bg-muted/40 p-3 flex items-start justify-center">
            <a :href="photo.file_path ?? '#'" target="_blank" rel="noopener" class="block max-w-full">
              <img
                :src="photo.file_path ?? photo.thumb_path ?? ''"
                :alt="`Photo submitted for ${photo.category_label ?? 'this requirement'}`"
                class="max-h-[60vh] w-auto max-w-full rounded-lg object-contain"
              />
            </a>
          </div>

          <div class="p-4 grid gap-3 min-w-0">
            <!-- Why it was judged this way -->
            <div v-if="photo.validation_description" class="min-w-0">
              <p class="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                What the check saw
              </p>
              <p class="mt-1 text-[12px] leading-relaxed">{{ photo.validation_description }}</p>
            </div>

            <div v-if="aiIssues.length || gateIssues.length" class="min-w-0">
              <p class="text-[10px] font-semibold uppercase tracking-widest text-rose-600">
                Why it failed
              </p>
              <ul class="mt-1 grid gap-1.5">
                <li v-for="(i, idx) in aiIssues" :key="`a${idx}`"
                  class="text-[12px] text-rose-700 leading-relaxed pl-3 border-l-2 border-rose-300">{{ i }}</li>
                <li v-for="(i, idx) in gateIssues" :key="`g${idx}`"
                  class="text-[12px] leading-relaxed pl-3 border-l-2"
                  :class="i.severity === 'fail' ? 'text-rose-700 border-rose-300' : 'text-amber-700 border-amber-300'"
                >{{ i.message }}</li>
              </ul>
            </div>

            <p v-if="photo.validation_error" class="text-[11px] text-amber-600">
              {{ photo.validation_error }}
            </p>

            <!-- Provenance -->
            <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] min-w-0">
              <dt class="text-muted-foreground">Captured by</dt>
              <dd class="text-right truncate">{{ capturedBy }}</dd>
              <dt class="text-muted-foreground">Taken</dt>
              <dd class="text-right truncate">{{ takenAt }}</dd>
              <dt class="text-muted-foreground">Location</dt>
              <dd class="text-right truncate">
                {{ photo.has_gps ? fmtCoords(photo.gps_lat, photo.gps_lng) : 'No GPS in photo' }}
              </dd>
              <dt class="text-muted-foreground">Device</dt>
              <dd class="text-right truncate">
                {{ orNotRecorded([photo.camera_make, photo.camera_model].filter(Boolean).join(' ')) }}
              </dd>
              <dt class="text-muted-foreground">Size</dt>
              <dd class="text-right truncate">
                {{ photo.width }}×{{ photo.height }} · {{ fmtBytes(photo.file_size) }}
              </dd>
              <dt class="text-muted-foreground">Source</dt>
              <dd class="text-right truncate">{{ sourceLabel }}</dd>
            </dl>

            <!-- Ask about THIS photo — the image goes with the question, so
                 "is there a label in the corner?" is answerable. -->
            <div v-if="chatScope && chatScopeId" class="border-t pt-3">
              <AssessmentChat
                :scope="chatScope" :scope-id="chatScopeId"
                :photo-id="photo.id" :photo-label="photo.category_label"
                compact
              />
            </div>

            <p v-if="photo.review_status" class="text-[11px]" :class="accentText(stateAccent(state))">
              {{ photo.reviewer }} marked this {{ photo.review_status }}
              <span v-if="photo.review_note" class="text-muted-foreground">— “{{ photo.review_note }}”</span>
            </p>
          </div>
        </div>
      </div>

      <!-- Actions pinned so they're reachable without scrolling back -->
      <div class="border-t p-3 grid gap-2">
        <textarea
          v-model="note" rows="2" placeholder="Note (optional)"
          aria-label="Review note"
          class="w-full rounded-md border bg-background px-2 py-2 text-sm"
        />
        <div class="flex flex-wrap gap-1.5">
          <button
            type="button" :disabled="busy"
            class="min-h-11 px-4 rounded-full border text-[11px] font-medium bg-foreground text-background border-foreground cursor-pointer transition-colors disabled:opacity-50"
            @click="emit('review', 'approved', note)"
          >Approve</button>
          <button
            type="button" :disabled="busy"
            class="min-h-11 px-4 rounded-full border text-[11px] font-medium bg-card hover:bg-muted cursor-pointer transition-colors disabled:opacity-50"
            @click="emit('review', 'resubmit', note)"
          >Request retake</button>
          <button
            type="button" :disabled="busy"
            class="min-h-11 px-4 rounded-full border text-[11px] font-medium bg-card hover:bg-muted cursor-pointer transition-colors disabled:opacity-50"
            @click="emit('review', 'rejected', note)"
          >Reject</button>
          <button
            type="button" :disabled="busy"
            class="min-h-11 px-4 rounded-full border text-[11px] font-medium bg-card hover:bg-muted cursor-pointer transition-colors disabled:opacity-50"
            @click="emit('revalidate', photo.id)"
          >Re-run AI</button>
          <span v-if="photos.length > 1" class="self-center text-[10px] text-muted-foreground">
            ← → to move between photos
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
