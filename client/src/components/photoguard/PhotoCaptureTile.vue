<script setup lang="ts">
// One photo requirement in the native form.
//
// Feedback is layered so the agent is never left waiting:
//   1. on-device check (ms)      → blur / dark / resolution, blocks before upload
//   2. server gates (fast)       → EXIF, GPS, geofence, staleness, duplicate
//   3. vision verdict (~6s, SSE) → does the photo actually show the subject
// A tile only goes green once the subject check agrees, so "I took something"
// can't be mistaken for "I took the right thing".
import { computed, onBeforeUnmount, ref } from 'vue'
import {
  accentBar, accentText, authHeaders, parseIssues, parseStringList,
  photoState, stateAccent, stateLabel,
  type FormField, type GateIssue, type PhotoRow,
} from '@/lib/photoguard'
import { checkPhotoLocally, extractBestFrames, type LocalIssue, type VideoFrame } from '@/lib/photoQuality'
import { enqueue, queuedFor } from '@/lib/uploadQueue'
import { uploadSample, recordSample } from '@/lib/connectivity'

const props = defineProps<{
  field: FormField
  submissionId: number
  photos: PhotoRow[]
  geo: { lat: number; lng: number } | null
}>()

const emit = defineEmits<{ (e: 'uploaded'): void; (e: 'queued'): void }>()

const busy = ref(false)
// Batch progress for library multi-select: crews commonly shoot on the native
// camera app and upload a stack afterwards, often from the truck.
const batch = ref<{ done: number; total: number; failed: number } | null>(null)
const localIssues = ref<LocalIssue[]>([])
const uploadError = ref('')
const frames = ref<VideoFrame[]>([])
const framesFor = ref('')

const photoInput = ref<HTMLInputElement | null>(null)
const videoInput = ref<HTMLInputElement | null>(null)
const uploadInput = ref<HTMLInputElement | null>(null)

// Object URLs for the extracted frame previews, revoked whenever the set is
// replaced so a long survey doesn't leak blobs.
const frameUrls = ref<string[]>([])

function setFrames(list: VideoFrame[]) {
  for (const u of frameUrls.value) URL.revokeObjectURL(u)
  frames.value = list
  frameUrls.value = list.map(f => URL.createObjectURL(f.blob))
}

onBeforeUnmount(() => {
  for (const u of frameUrls.value) URL.revokeObjectURL(u)
})

// Newest first — a retake should be what the tile reflects.
const ordered = computed(() =>
  [...props.photos].sort((a, b) => b.created_at.localeCompare(a.created_at)))

const latest = computed<PhotoRow | null>(() => ordered.value[0] ?? null)

const state = computed(() => (latest.value ? photoState(latest.value) : null))
const accent = computed(() => (state.value ? stateAccent(state.value) : 'slate'))

/** Satisfied = we have at least one photo that isn't blocked/rejected and
 *  either passed the model or is still being judged. */
const satisfied = computed(() =>
  ordered.value.some(p => {
    const s = photoState(p)
    return s === 'passed' || s === 'approved'
  }))

const needsAttention = computed(() =>
  !!state.value && ['blocked', 'failed', 'rejected', 'resubmit'].includes(state.value))

const serverIssues = computed<GateIssue[]>(() =>
  latest.value ? parseIssues(latest.value.metadata_issues) : [])

const aiIssues = computed<string[]>(() =>
  latest.value ? parseStringList(latest.value.validation_issues) : [])

const waiting = computed(() => queuedFor(props.field.hash).length)

const pending = computed(() =>
  !!latest.value && latest.value.gate_status !== 'blocked' &&
  latest.value.validation_status !== 'done')

async function queueIt(blob: Blob, filename: string, source: 'camera' | 'upload' | 'video_frame') {
  await enqueue({
    submissionId: props.submissionId,
    fieldHash: props.field.hash,
    fieldLabel: props.field.label,
    source,
    filename,
    capturedAt: new Date().toISOString(),
    lat: props.geo?.lat ?? null,
    lng: props.geo?.lng ?? null,
    blob,
    bytes: blob.size,
  })
  emit('queued')
}

/**
 * Upload, or bank it for later.
 *
 * A crew on a metal roof or in a basement shouldn't have to stop shooting
 * because the network died — so anything that fails at the transport level
 * goes to the durable IndexedDB queue and drains when signal returns. A
 * server-side REJECTION is different: that's a verdict the agent needs to see
 * now, so it surfaces rather than being silently retried forever.
 */
async function uploadBlob(blob: Blob, filename: string, source: 'camera' | 'upload' | 'video_frame') {
  if (!navigator.onLine) { await queueIt(blob, filename, source); return }

  const fd = new FormData()
  fd.append('file', blob, filename)
  fd.append('submissionId', String(props.submissionId))
  fd.append('fieldHash', props.field.hash)
  fd.append('source', source)
  fd.append('capturedAt', new Date().toISOString())
  if (props.geo) {
    fd.append('lat', String(props.geo.lat))
    fd.append('lng', String(props.geo.lng))
  }

  const t0 = performance.now()
  let res: Response
  try {
    res = await fetch('/api/photoguard/upload', { method: 'POST', headers: authHeaders(), body: fd })
  } catch {
    await queueIt(blob, filename, source)   // transport failure — keep the photo
    return
  }
  if (res.status >= 500 || res.status === 429) {
    await queueIt(blob, filename, source)   // server wobble — retry later
    return
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error || `Upload failed (${res.status})`)
  }
  // A successful upload is also our best throughput measurement.
  recordSample(props.submissionId, uploadSample(blob.size, performance.now() - t0, props.geo))
  emit('uploaded')
}

async function handleFile(file: File, source: 'camera' | 'upload') {
  busy.value = true
  uploadError.value = ''
  localIssues.value = []
  setFrames([])
  try {
    // Refuse to spend an upload — or the agent's time — on a photo we can
    // already see is unusable.
    const check = await checkPhotoLocally(file)
    localIssues.value = check.issues
    if (check.blocked) return
    await uploadBlob(file, file.name || 'capture.jpg', source)
  } catch (e) {
    uploadError.value = e instanceof Error ? e.message : 'Upload failed'
  } finally {
    busy.value = false
  }
}

async function handleVideo(file: File) {
  busy.value = true
  uploadError.value = ''
  localIssues.value = []
  setFrames([])
  try {
    const best = await extractBestFrames(file, 6)
    if (!best.length) {
      uploadError.value = 'No usable frames found in that video.'
      return
    }
    setFrames(best)
    framesFor.value = file.name
  } catch (e) {
    uploadError.value = e instanceof Error ? e.message : 'Could not read that video'
  } finally {
    busy.value = false
  }
}

async function keepFrame(f: VideoFrame) {
  busy.value = true
  uploadError.value = ''
  try {
    await uploadBlob(f.blob, `frame_${Math.round(f.timeSeconds * 1000)}.jpg`, 'video_frame')
    setFrames([])
  } catch (e) {
    uploadError.value = e instanceof Error ? e.message : 'Upload failed'
  } finally {
    busy.value = false
  }
}

function onPhotoPick(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) handleFile(f, 'camera')
  ;(e.target as HTMLInputElement).value = ''
}
/**
 * Library multi-select. Uploads sequentially rather than in parallel so a
 * phone on a patchy LTE connection doesn't stall every request at once, and
 * so the agent sees steady progress. One bad file doesn't abort the rest.
 */
async function handleFiles(files: File[]) {
  if (!files.length) return
  busy.value = true
  uploadError.value = ''
  localIssues.value = []
  setFrames([])
  batch.value = { done: 0, total: files.length, failed: 0 }
  const rejected: string[] = []
  try {
    for (const file of files) {
      try {
        const check = await checkPhotoLocally(file)
        if (check.blocked) {
          rejected.push(`${file.name}: ${check.issues.find(i => i.severity === 'fail')?.message ?? 'unusable'}`)
          batch.value.failed++
        } else {
          await uploadBlob(file, file.name || 'photo.jpg', 'upload')
        }
      } catch (e) {
        rejected.push(`${file.name}: ${e instanceof Error ? e.message : 'upload failed'}`)
        batch.value.failed++
      }
      batch.value.done++
    }
    if (rejected.length) uploadError.value = rejected.slice(0, 3).join(' · ')
  } finally {
    busy.value = false
    // Leave the summary up briefly so the count is readable.
    setTimeout(() => { batch.value = null }, 4000)
  }
}

function onUploadPick(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  if (files.length === 1) handleFile(files[0]!, 'upload')
  else if (files.length > 1) handleFiles(files)
  input.value = ''
}
function onVideoPick(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) handleVideo(f)
  ;(e.target as HTMLInputElement).value = ''
}
</script>

<template>
  <div
    class="rounded-xl border bg-card p-3 min-w-0 relative overflow-hidden"
    :class="needsAttention ? 'border-rose-300' : ''"
  >
    <div class="absolute top-0 left-0 right-0 h-[3px]" :class="accentBar(accent)" />

    <!-- Label + requirement -->
    <div class="flex items-start justify-between gap-2 min-w-0">
      <div class="min-w-0">
        <p class="text-sm font-medium leading-snug break-words">{{ field.label }}</p>
        <p class="mt-0.5 flex flex-wrap items-center gap-1.5">
          <span
            v-if="field.required"
            class="text-[10px] font-semibold uppercase tracking-wider text-rose-600"
          >Required</span>
          <span
            v-else
            class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
          >Optional</span>
          <span
            v-if="field.requiredReasons?.length"
            class="text-[10px] text-amber-600"
            :title="field.requiredReasons.join(' · ')"
          >· {{ field.requiredReasons[0] }}</span>
        </p>
      </div>
      <span
        v-if="state"
        class="flex-none text-[10px] font-bold uppercase tracking-wider"
        :class="accentText(accent)"
      >{{ stateLabel(state) }}</span>
    </div>

    <!-- Other captures on this requirement (teammates, extra angles) -->
    <div v-if="ordered.length > 1" class="mt-2 flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1">
      <a
        v-for="p in ordered.slice(1, 9)" :key="p.id"
        :href="p.file_path ?? '#'" target="_blank" rel="noopener"
        class="flex-none block w-12 h-12 rounded-md overflow-hidden bg-muted"
        :title="`${p.captured_by_name ?? 'Unknown'} · ${stateLabel(photoState(p))}`"
      >
        <img v-if="p.thumb_path" :src="p.thumb_path" alt="" class="w-full h-full object-cover"
          :class="photoState(p) === 'blocked' ? 'opacity-40' : ''" />
      </a>
    </div>

    <!-- Latest capture -->
    <div v-if="latest" class="mt-2 flex gap-2 min-w-0">
      <a
        :href="latest.file_path ?? '#'" target="_blank" rel="noopener"
        class="flex-none block w-20 h-20 rounded-lg overflow-hidden bg-muted"
      >
        <img
          v-if="latest.thumb_path"
          :src="latest.thumb_path" :alt="field.label"
          class="w-full h-full object-cover"
          :class="latest.gate_status === 'blocked' ? 'opacity-50' : ''"
        />
      </a>
      <div class="min-w-0 flex-1 text-[11px] leading-relaxed">
        <p v-if="pending" class="text-slate-500">Checking the subject…</p>
        <p v-else-if="latest.validation_description" class="text-muted-foreground break-words">
          {{ latest.validation_description }}
        </p>
        <p v-if="latest.validation_error" class="text-amber-600 break-words">
          {{ latest.validation_error }}
        </p>
        <p class="mt-0.5 text-[10px] text-muted-foreground">
          {{ latest.captured_by_name || 'Unknown' }}
          <span v-if="latest.has_gps"> · GPS ✓</span>
          <span v-else> · no GPS</span>
          <span v-if="latest.capture_source === 'video_frame'"> · from video</span>
        </p>
      </div>
    </div>

    <!-- Why it isn't accepted -->
    <ul
      v-if="localIssues.length || serverIssues.length || aiIssues.length"
      class="mt-2 grid gap-1"
    >
      <li
        v-for="(i, idx) in localIssues" :key="`l${idx}`"
        class="text-[11px]" :class="i.severity === 'fail' ? 'text-rose-600' : 'text-amber-600'"
      >{{ i.message }}</li>
      <li
        v-for="(i, idx) in serverIssues" :key="`s${idx}`"
        class="text-[11px]" :class="i.severity === 'fail' ? 'text-rose-600' : 'text-amber-600'"
      >{{ i.message }}</li>
      <li v-for="(i, idx) in aiIssues" :key="`a${idx}`" class="text-[11px] text-rose-600">{{ i }}</li>
    </ul>

    <p v-if="waiting" class="mt-2 text-[11px] text-amber-600">
      {{ waiting }} photo{{ waiting > 1 ? 's' : '' }} saved on this device — will upload when back online.
    </p>
    <p v-if="batch" class="mt-2 text-[11px] text-muted-foreground">
      Uploading {{ batch.done }} / {{ batch.total }}<span v-if="batch.failed"> · {{ batch.failed }} rejected</span>
    </p>
    <p v-if="uploadError" class="mt-2 text-[11px] text-rose-600">{{ uploadError }}</p>

    <!-- Video frame picker -->
    <div v-if="frames.length" class="mt-2">
      <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Sharpest frames · {{ framesFor }}
      </p>
      <div class="mt-1 flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1">
        <button
          v-for="(f, idx) in frames" :key="idx" type="button"
          class="flex-none w-20 text-left" :disabled="busy"
          @click="keepFrame(f)"
        >
          <span class="block w-20 h-20 rounded-lg overflow-hidden bg-muted">
            <img
              v-if="frameUrls[idx]" :src="frameUrls[idx]" alt=""
              class="w-full h-full object-cover"
            />
          </span>
          <span class="block text-[10px] text-muted-foreground mt-0.5">
            {{ f.timeSeconds.toFixed(1) }}s · {{ f.check.sharpness }}
          </span>
        </button>
      </div>
      <p class="text-[10px] text-muted-foreground">Tap a frame to use it.</p>
    </div>

    <!-- Actions -->
    <div class="mt-2 flex flex-wrap gap-1.5">
      <button
        type="button" :disabled="busy"
        class="px-2.5 py-1.5 rounded-full border text-[11px] font-medium transition-colors bg-foreground text-background border-foreground disabled:opacity-50"
        @click="photoInput?.click()"
      >{{ busy ? 'Working…' : latest ? 'Retake' : 'Take photo' }}</button>
      <button
        type="button" :disabled="busy"
        class="px-2.5 py-1.5 rounded-full border text-[11px] font-medium bg-card hover:bg-muted disabled:opacity-50"
        @click="videoInput?.click()"
      >Video</button>
      <button
        type="button" :disabled="busy"
        class="px-2.5 py-1.5 rounded-full border text-[11px] font-medium bg-card hover:bg-muted disabled:opacity-50"
        @click="uploadInput?.click()"
      >From library</button>
      <span v-if="satisfied" class="self-center text-[11px] text-emerald-600 font-medium">Good to go</span>
    </div>

    <input
      ref="photoInput" type="file" accept="image/*" capture="environment"
      class="hidden" @change="onPhotoPick"
    />
    <input
      ref="videoInput" type="file" accept="video/*" capture="environment"
      class="hidden" @change="onVideoPick"
    />
    <input ref="uploadInput" type="file" accept="image/*" multiple class="hidden" @change="onUploadPick" />
  </div>
</template>
