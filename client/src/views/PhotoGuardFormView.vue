<script setup lang="ts">
// PhotoGuard native form — the field agent's surface.
//
// This is a full replacement for filling the form in Arrivy: the schema was
// imported from Arrivy once, but capture, validation, storage and submission
// all happen here. Nothing is written back to Arrivy.
//
// The design goal is that an agent never has to return to site, so a photo is
// judged while they're still standing in front of the subject — on-device
// checks immediately, server metadata gates on upload, and the vision verdict
// over SSE a few seconds later.
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { loadForm, groupBySection, formLabel, FormNotImportedError } from '@/data/arrivy-forms'
import {
  authHeaders, photoState,
  type FormDefinition, type FormField, type PhotoRow,
} from '@/lib/photoguard'
import { usePhotoGuardLive } from '@/lib/photoguardLive'
import { useGeolocation } from '@/lib/geolocation'
import PhotoCaptureTile from '@/components/photoguard/PhotoCaptureTile.vue'
import LocationGate from '@/components/photoguard/LocationGate.vue'

const route = useRoute()
const router = useRouter()

const formType = computed(() => String(route.params['formType'] ?? 'site_survey'))
const projectRid = computed(() => {
  const q = route.query['project']
  const n = q != null ? Number(q) : NaN
  return Number.isFinite(n) ? n : null
})

const form = ref<FormDefinition | null>(null)
const submissionId = ref<number | null>(null)
const photos = ref<PhotoRow[]>([])
const answers = ref<Record<string, unknown>>({})
const loc = useGeolocation()
// Capture tiles only need the coordinate pair.
const geo = computed(() => (loc.fix.value ? { lat: loc.fix.value.lat, lng: loc.fix.value.lng } : null))

const loading = ref(true)
const error = ref('')
const notImported = ref(false)
const sectionIndex = ref(0)
const submitting = ref(false)
const submitResult = ref<{ ok: boolean; gaps: Array<{ hash: string; label: string; reason: string }> } | null>(null)

const groups = computed(() => (form.value ? groupBySection(form.value) : []))
const current = computed(() => groups.value[sectionIndex.value] ?? null)

const photosByHash = computed(() => {
  const m = new Map<string, PhotoRow[]>()
  for (const p of photos.value) {
    if (!p.category_hash) continue
    const list = m.get(p.category_hash) ?? []
    list.push(p)
    m.set(p.category_hash, list)
  }
  return m
})

function isSatisfied(f: FormField): boolean {
  const list = photosByHash.value.get(f.hash) ?? []
  return list.some(p => {
    const s = photoState(p)
    return s === 'passed' || s === 'approved'
  })
}

/** Progress counts only REQUIRED photos — optional extras shouldn't make a
 *  half-finished survey look complete. */
function sectionProgress(fields: FormField[]): { done: number; total: number; blocked: number } {
  const required = fields.filter(f => f.fieldType === 'photo' && f.required)
  const done = required.filter(isSatisfied).length
  const blocked = fields.filter(f => {
    const list = photosByHash.value.get(f.hash) ?? []
    return list.length > 0 && !isSatisfied(f)
  }).length
  return { done, total: required.length, blocked }
}

const overall = computed(() => {
  const all = (form.value?.fields ?? []).filter(f => f.fieldType === 'photo' && f.required)
  return { done: all.filter(isSatisfied).length, total: all.length }
})

const outstanding = computed(() =>
  (form.value?.fields ?? []).filter(f => f.fieldType === 'photo' && f.required && !isSatisfied(f)))

// ─── Load ─────────────────────────────────────────────────────────────

async function refreshSubmission() {
  if (!submissionId.value) return
  const res = await fetch(`/api/photoguard/submissions/${submissionId.value}`, { headers: authHeaders() })
  if (!res.ok) return
  const data = await res.json() as {
    photos: PhotoRow[]
    answers: Array<{ field_hash: string; value: string | null }>
  }
  photos.value = data.photos
  const next: Record<string, unknown> = {}
  for (const a of data.answers) {
    if (a.value == null) continue
    try { next[a.field_hash] = JSON.parse(a.value) } catch { next[a.field_hash] = a.value }
  }
  answers.value = next
}

async function start() {
  loading.value = true
  error.value = ''
  notImported.value = false
  try {
    form.value = await loadForm(formType.value, projectRid.value, { force: true })

    // Resume an existing submission when the URL names one, else open a new run.
    const existing = route.query['submission'] ? Number(route.query['submission']) : null
    if (existing && Number.isFinite(existing)) {
      submissionId.value = existing
    } else {
      const res = await fetch('/api/photoguard/submissions', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          formType: formType.value,
          projectRid: projectRid.value,
          siteLat: loc.fix.value?.lat ?? null,
          siteLng: loc.fix.value?.lng ?? null,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error || `Could not start the form (${res.status})`)
      }
      const created = await res.json() as { id: number }
      submissionId.value = created.id
      router.replace({ query: { ...route.query, submission: String(created.id) } })
    }
    await refreshSubmission()
  } catch (e) {
    if (e instanceof FormNotImportedError) {
      notImported.value = true
      error.value = e.message
    } else {
      error.value = e instanceof Error ? e.message : 'Failed to load'
    }
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  // Deliberately does NOT prompt — a cold permission dialog with no context
  // gets denied, and a denial is permanent for the origin. This only reads the
  // current state (and silently fetches a fix if already granted); the actual
  // ask happens from the LocationGate button.
  void loc.refreshPermission()
  await start()
})

// Anchor the site as soon as a fix exists. Surveys frequently begin before
// permission is granted, and without this the submission keeps a null anchor
// and the geofence never applies.
watch(() => loc.fix.value, async f => {
  if (!f || !submissionId.value) return
  await fetch(`/api/photoguard/submissions/${submissionId.value}/site`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ siteLat: f.lat, siteLng: f.lng }),
  }).catch(() => { /* anchoring is best-effort */ })
}, { immediate: true })

async function askLocation() {
  const f = await loc.request()
  if (f) loc.startWatch()   // let GPS sharpen the initial coarse fix
}

watch(formType, () => { submissionId.value = null; sectionIndex.value = 0; start() })

// ─── Live verdicts ────────────────────────────────────────────────────

const { onPhotoGuardEvent } = usePhotoGuardLive()
const stopLive = onPhotoGuardEvent(evt => {
  if (evt.type !== 'photo_validated' && evt.type !== 'photo_added' && evt.type !== 'photo_reviewed') return
  const sid = evt.data?.['submissionId']
  if (sid != null && Number(sid) !== submissionId.value) return
  refreshSubmission()
})
onBeforeUnmount(() => stopLive())

// ─── Answers ──────────────────────────────────────────────────────────

let saveTimer: ReturnType<typeof setTimeout> | null = null

function setAnswer(hash: string, value: unknown) {
  answers.value = { ...answers.value, [hash]: value }
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(saveAnswers, 600)
}

function toggleChecklist(hash: string, option: string) {
  const cur = Array.isArray(answers.value[hash]) ? [...(answers.value[hash] as string[])] : []
  const i = cur.indexOf(option)
  if (i >= 0) cur.splice(i, 1)
  else cur.push(option)
  setAnswer(hash, cur)
}

function isChecked(hash: string, option: string): boolean {
  const v = answers.value[hash]
  return Array.isArray(v) && (v as string[]).includes(option)
}

async function saveAnswers() {
  if (!submissionId.value) return
  const payload = Object.entries(answers.value).map(([fieldHash, value]) => ({ fieldHash, value }))
  if (!payload.length) return
  await fetch(`/api/photoguard/submissions/${submissionId.value}/answers`, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers: payload }),
  }).catch(() => { /* autosave is best-effort; submit re-checks anyway */ })
}

onBeforeUnmount(() => { if (saveTimer) clearTimeout(saveTimer) })

// ─── Navigation / submit ──────────────────────────────────────────────

function go(delta: number) {
  const next = sectionIndex.value + delta
  if (next < 0 || next >= groups.value.length) return
  sectionIndex.value = next
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function jumpTo(hash: string) {
  const idx = groups.value.findIndex(g => g.fields.some(f => f.hash === hash))
  if (idx >= 0) {
    sectionIndex.value = idx
    requestAnimationFrame(() => {
      document.getElementById(`field-${hash}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }
}

async function submit(force = false) {
  if (!submissionId.value) return
  submitting.value = true
  submitResult.value = null
  try {
    await saveAnswers()
    const res = await fetch(`/api/photoguard/submissions/${submissionId.value}/submit`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
    })
    const data = await res.json() as {
      error?: string
      missing?: Array<{ hash: string; label: string; reason: string }>
      gaps?: Array<{ hash: string; label: string; reason: string }>
    }
    if (res.status === 422) {
      submitResult.value = { ok: false, gaps: data.missing ?? [] }
      return
    }
    if (!res.ok) throw new Error(data.error || `Submit failed (${res.status})`)
    submitResult.value = { ok: true, gaps: data.gaps ?? [] }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Submit failed'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="grid gap-3 min-w-0">
    <!-- Header -->
    <div class="flex flex-col gap-0.5 min-w-0">
      <h1 class="text-2xl font-semibold tracking-tight">{{ formLabel(formType) }}</h1>
      <p class="text-[11px] text-muted-foreground">
        {{ overall.done }} / {{ overall.total }} required photos captured
      </p>
    </div>

    <LocationGate
      :state="loc.state.value"
      :fix="loc.fix.value"
      :error="loc.error.value"
      :requesting="loc.requesting.value"
      :coarse="loc.coarse.value"
      @request="askLocation"
    />

    <p v-if="loading" class="text-sm text-muted-foreground">Loading form…</p>

    <!-- Form not imported yet -->
    <div v-else-if="notImported" class="rounded-xl border bg-card p-4">
      <p class="text-sm font-medium">This form hasn't been imported yet.</p>
      <p class="mt-1 text-[12px] text-muted-foreground">{{ error }}</p>
      <p class="mt-2 text-[12px] text-muted-foreground">
        An admin can pull the definitions in once from the PhotoGuard dashboard.
      </p>
      <RouterLink
        to="/photoguard"
        class="mt-3 inline-block px-3 py-1.5 rounded-full border text-[11px] font-medium bg-foreground text-background border-foreground"
      >Go to dashboard</RouterLink>
    </div>

    <p v-else-if="error && !form" class="text-sm text-rose-600">{{ error }}</p>

    <template v-else-if="form && current">
      <!-- Section strip (h-scroll is allowed for filter/nav strips) -->
      <div class="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1 min-w-0">
        <button
          v-for="(g, i) in groups" :key="g.section.key" type="button"
          class="flex-none px-2.5 py-1 rounded-full border text-[11px] font-medium transition-colors whitespace-nowrap"
          :class="i === sectionIndex ? 'bg-foreground text-background border-foreground' : 'bg-card hover:bg-muted'"
          @click="sectionIndex = i"
        >
          {{ g.section.title }}
          <span class="opacity-70">
            {{ sectionProgress(g.fields).done }}/{{ sectionProgress(g.fields).total }}
          </span>
        </button>
      </div>

      <!-- Section body -->
      <div class="grid gap-2 min-w-0">
        <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          {{ current.section.title }}
        </p>

        <template v-for="field in current.fields" :key="field.hash">
          <div :id="`field-${field.hash}`" class="min-w-0">
            <!-- Photo -->
            <PhotoCaptureTile
              v-if="field.fieldType === 'photo' && submissionId"
              :field="field"
              :submission-id="submissionId"
              :photos="photosByHash.get(field.hash) ?? []"
              :geo="geo"
              @uploaded="refreshSubmission"
            />

            <!-- Static text block -->
            <p
              v-else-if="field.fieldType === 'block'"
              class="text-[12px] text-muted-foreground leading-relaxed"
            >{{ field.label }}</p>

            <!-- Everything else -->
            <div v-else class="rounded-xl border bg-card p-3 min-w-0">
              <label class="text-sm font-medium leading-snug break-words">
                {{ field.label }}
                <span v-if="field.required" class="text-rose-600">*</span>
              </label>

              <select
                v-if="field.fieldType === 'dropdown'"
                class="mt-2 w-full rounded-md border bg-background px-2 py-2 text-sm"
                :value="(answers[field.hash] as string) ?? ''"
                @change="setAnswer(field.hash, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">Select…</option>
                <option v-for="o in field.options ?? []" :key="o" :value="o">{{ o }}</option>
              </select>

              <div v-else-if="field.fieldType === 'checklist'" class="mt-2 grid gap-1.5">
                <label
                  v-for="o in field.options ?? []" :key="o"
                  class="flex items-center gap-2 text-sm"
                >
                  <input
                    type="checkbox" class="size-4"
                    :checked="isChecked(field.hash, o)"
                    @change="toggleChecklist(field.hash, o)"
                  />
                  <span>{{ o }}</span>
                </label>
              </div>

              <textarea
                v-else-if="field.fieldType === 'textarea'"
                class="mt-2 w-full rounded-md border bg-background px-2 py-2 text-sm" rows="3"
                :value="(answers[field.hash] as string) ?? ''"
                @input="setAnswer(field.hash, ($event.target as HTMLTextAreaElement).value)"
              />

              <input
                v-else
                :type="field.fieldType === 'number' ? 'number' : 'text'"
                class="mt-2 w-full rounded-md border bg-background px-2 py-2 text-sm"
                :value="(answers[field.hash] as string) ?? ''"
                @input="setAnswer(field.hash, ($event.target as HTMLInputElement).value)"
              />
            </div>
          </div>
        </template>
      </div>

      <!-- Prev / next -->
      <div class="flex items-center justify-between gap-2">
        <button
          type="button" :disabled="sectionIndex === 0"
          class="px-3 py-2 rounded-full border text-[12px] font-medium bg-card hover:bg-muted disabled:opacity-40"
          @click="go(-1)"
        >Back</button>
        <span class="text-[11px] text-muted-foreground">
          Section {{ sectionIndex + 1 }} of {{ groups.length }}
        </span>
        <button
          v-if="sectionIndex < groups.length - 1"
          type="button"
          class="px-3 py-2 rounded-full border text-[12px] font-medium bg-foreground text-background border-foreground"
          @click="go(1)"
        >Next</button>
        <button
          v-else type="button" :disabled="submitting"
          class="px-3 py-2 rounded-full border text-[12px] font-medium bg-foreground text-background border-foreground disabled:opacity-50"
          @click="submit(false)"
        >{{ submitting ? 'Checking…' : 'Submit' }}</button>
      </div>

      <!-- What's still missing -->
      <div v-if="outstanding.length" class="rounded-xl border bg-card p-3">
        <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          Still needed · {{ outstanding.length }}
        </p>
        <div class="mt-1.5 flex flex-wrap gap-1.5">
          <button
            v-for="f in outstanding.slice(0, 20)" :key="f.hash" type="button"
            class="px-2 py-0.5 rounded-full border text-[10px] font-medium bg-card hover:bg-muted"
            @click="jumpTo(f.hash)"
          >{{ f.label }}</button>
          <span v-if="outstanding.length > 20" class="text-[10px] text-muted-foreground self-center">
            +{{ outstanding.length - 20 }} more
          </span>
        </div>
      </div>

      <!-- Submit outcome -->
      <div
        v-if="submitResult"
        class="rounded-xl border bg-card p-3"
        :class="submitResult.ok ? 'border-emerald-300' : 'border-amber-300'"
      >
        <p v-if="submitResult.ok" class="text-sm font-medium text-emerald-600">
          Submitted{{ submitResult.gaps.length ? ' with gaps' : ' — everything captured' }}.
        </p>
        <template v-else>
          <p class="text-sm font-medium text-amber-600">
            Not submitted — {{ submitResult.gaps.length }} required photo(s) still missing or unusable.
          </p>
          <ul class="mt-1.5 grid gap-1">
            <li v-for="g in submitResult.gaps.slice(0, 12)" :key="g.hash" class="text-[11px]">
              <button class="underline underline-offset-2" type="button" @click="jumpTo(g.hash)">
                {{ g.label }}
              </button>
              <span class="text-muted-foreground"> — {{ g.reason }}</span>
            </li>
          </ul>
          <button
            type="button" :disabled="submitting"
            class="mt-2 px-3 py-1.5 rounded-full border text-[11px] font-medium bg-card hover:bg-muted disabled:opacity-50"
            @click="submit(true)"
          >Submit anyway</button>
        </template>
      </div>
    </template>
  </div>
</template>
