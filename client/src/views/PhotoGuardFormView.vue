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
  authHeaders, photoState, sanitizeBlockHtml, isEmptyBlock,
  type FormDefinition, type FormField, type PhotoRow,
} from '@/lib/photoguard'
import { usePhotoGuardLive } from '@/lib/photoguardLive'
import { useGeolocation } from '@/lib/geolocation'
import PhotoCaptureTile from '@/components/photoguard/PhotoCaptureTile.vue'
import LocationGate from '@/components/photoguard/LocationGate.vue'
import { startQueueWorker, useUploadQueue } from '@/lib/uploadQueue'
import {
  bindConnectivityListeners, flushSamples, isOnline, pingSample,
  recordSample, transitionSample,
} from '@/lib/connectivity'

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
const contributors = ref<Array<{ name: string; photos: number; last_at: string }>>([])
const shareCopied = ref(false)
const queue = useUploadQueue()
const docs = ref<Array<{ recordId: number; type: string; fileName: string | null; url: string | null; linkUrl: string | null }>>([])
const progress = ref<{ requiredTotal: number; requiredApproved: number; percentApproved: number } | null>(null)
const showChecklist = ref(false)
// Surfaced when an answer branches the job into extra requirements — silently
// growing the list would be baffling on a phone.
const branchNote = ref('')

// ─── AI job review ───────────────────────────────────────────────────
interface Finding {
  id: number
  kind: string
  severity: 'blocker' | 'warning' | 'note'
  title: string
  detail: string
  requirement_hash: string | null
  photo_ids: string
  status: 'open' | 'resolved' | 'dismissed' | 'escalated'
  escalated_by: string | null
}
const findings = ref<Finding[]>([])
const reviewing = ref(false)
const reviewNote = ref('')

const openFindings = computed(() => findings.value.filter(f => f.status === 'open' || f.status === 'escalated'))

async function loadFindings() {
  if (!submissionId.value) return
  const res = await fetch(`/api/photoguard/submissions/${submissionId.value}/findings`, { headers: authHeaders() })
  if (res.ok) findings.value = (await res.json() as { findings: Finding[] }).findings
}

async function runReview() {
  if (!submissionId.value) return
  reviewing.value = true
  reviewNote.value = ''
  try {
    const res = await fetch(`/api/photoguard/submissions/${submissionId.value}/review`, {
      method: 'POST', headers: authHeaders(),
    })
    const data = await res.json() as { ran: boolean; reason?: string; findings: Finding[] }
    findings.value = data.findings ?? []
    if (!data.ran) reviewNote.value = data.reason ?? 'Review did not run'
    else if (!openFindings.value.length) reviewNote.value = 'No issues found across the job.'
  } catch (e) {
    reviewNote.value = e instanceof Error ? e.message : 'Review failed'
  } finally {
    reviewing.value = false
  }
}

async function setFindingStatus(f: Finding, status: Finding['status']) {
  await fetch(`/api/photoguard/findings/${f.id}/status`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  })
  await loadFindings()
}

const SEVERITY_TEXT: Record<string, string> = {
  blocker: 'text-rose-600', warning: 'text-amber-600', note: 'text-sky-600',
}

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

/** Outstanding items grouped by their section, so the full list reads as a
 *  route through the job rather than an undifferentiated pile. */
const outstandingBySection = computed(() => {
  const titles = new Map((form.value?.sections ?? []).map(s => [s.key, s.title]))
  const out = new Map<string, { title: string; fields: FormField[] }>()
  for (const f of outstanding.value) {
    const key = f.sectionKey
    const g = out.get(key) ?? { title: titles.get(key) ?? key, fields: [] }
    g.fields.push(f)
    out.set(key, g)
  }
  return [...out.values()]
})

// ─── Load ─────────────────────────────────────────────────────────────

async function refreshSubmission() {
  if (!submissionId.value) return
  const res = await fetch(`/api/photoguard/submissions/${submissionId.value}`, { headers: authHeaders() })
  if (!res.ok) return
  const data = await res.json() as {
    photos: PhotoRow[]
    answers: Array<{ field_hash: string; value: string | null }>
    contributors?: Array<{ name: string; photos: number; last_at: string }>
    progress?: { requiredTotal: number; requiredApproved: number; percentApproved: number }
  }
  photos.value = data.photos
  contributors.value = data.contributors ?? []
  void loadFindings()
  progress.value = data.progress ?? null
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
    form.value = await loadForm(formType.value, projectRid.value,
      { force: true, submissionId: submissionId.value })

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
    if (projectRid.value) void loadDocs()
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

  // Drain anything stranded from a previous visit, then keep draining as
  // signal comes and goes.
  stopQueue = startQueueWorker(() => { refreshSubmission() })

  // Connectivity evidence: a reading when the job is opened, one on each
  // online/offline transition, and a slow heartbeat while the form is open.
  // Uploads contribute their own throughput samples as they happen.
  stopConn = bindConnectivityListeners(online => {
    recordSample(submissionId.value, transitionSample(online ? 'online' : 'offline'))
    if (online) void flushSamples(submissionId.value)
  })
  const takePing = async () => {
    recordSample(submissionId.value, await pingSample(geo.value))
  }
  void takePing()
  pingTimer = setInterval(takePing, 5 * 60_000)
})

let stopQueue: (() => void) | null = null
let stopConn: (() => void) | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null

onBeforeUnmount(() => {
  stopQueue?.()
  stopConn?.()
  if (pingTimer) clearInterval(pingTimer)
  void flushSamples(submissionId.value)
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

/** A link straight to this job's shared checkout — the lead texts it to
 *  whoever is on site, including subs who don't navigate the app. */
async function copyJobLink() {
  const url = new URL(window.location.href)
  if (projectRid.value) url.searchParams.set('project', String(projectRid.value))
  // Deliberately omits ?submission= — the server joins by project + form type,
  // so anyone opening it lands in the same shared checkout.
  url.searchParams.delete('submission')
  try {
    await navigator.clipboard.writeText(url.toString())
    shareCopied.value = true
    setTimeout(() => { shareCopied.value = false }, 2500)
  } catch { /* clipboard blocked — the URL bar still works */ }
}

/** The design the crew is actually building to, proxied from Quickbase so no
 *  QB login is needed on site. */
async function loadDocs() {
  try {
    const res = await fetch(`/api/photoguard/documents/${projectRid.value}`, { headers: authHeaders() })
    if (!res.ok) return
    docs.value = (await res.json() as { documents: typeof docs.value }).documents
  } catch { /* documents are a convenience, not a blocker */ }
}

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
  try {
    await fetch(`/api/photoguard/submissions/${submissionId.value}/answers`, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: payload }),
    })
    // An answer can branch the job — choosing a mounting method may add the
    // evidence that method requires — so re-resolve requirements after saving.
    await reloadRequirements()
  } catch { /* autosave is best-effort; submit re-checks anyway */ }
}

async function reloadRequirements() {
  if (!submissionId.value) return
  try {
    const before = new Set((form.value?.fields ?? []).filter(f => f.required).map(f => f.hash))
    form.value = await loadForm(formType.value, projectRid.value,
      { force: true, submissionId: submissionId.value })
    const added = (form.value.fields ?? [])
      .filter(f => f.fieldType === 'photo' && f.required && !before.has(f.hash))
    if (added.length) {
      branchNote.value = `${added.length} extra photo${added.length > 1 ? 's' : ''} now required: ${added.map(f => f.label).slice(0, 3).join(', ')}`
      setTimeout(() => { branchNote.value = '' }, 8000)
    }
  } catch { /* keep the form we have */ }
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
      <!-- Several trades share one checkout; show who's been on it. -->
      <p v-if="contributors.length" class="text-[11px] text-muted-foreground">
        <span class="font-medium text-foreground">On this job:</span>
        <span v-for="(c, i) in contributors" :key="c.name">
          {{ i ? ' · ' : ' ' }}{{ c.name }} ({{ c.photos }})
        </span>
      </p>
      <!-- What was sold, straight from Quickbase — so the crew can check the
           equipment on site against it, and so the AI can too. -->
      <p v-if="form?.design?.text" class="text-[11px] text-muted-foreground">
        <span class="font-medium text-foreground">Design:</span> {{ form.design.text }}
      </p>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-2 min-w-0">
      <LocationGate
        :state="loc.state.value"
        :fix="loc.fix.value"
        :error="loc.error.value"
        :requesting="loc.requesting.value"
        :coarse="loc.coarse.value"
        @request="askLocation"
      />
      <button
        v-if="projectRid" type="button"
        class="flex-none px-2.5 py-1 rounded-full border text-[10px] font-medium bg-card hover:bg-muted"
        @click="copyJobLink"
      >{{ shareCopied ? 'Link copied' : 'Share job' }}</button>
    </div>

    <!-- Offline / pending uploads. Only shown when it matters. -->
    <div
      v-if="!isOnline || queue.queueCount.value"
      class="rounded-xl border bg-card p-2.5 min-w-0"
      :class="isOnline ? 'border-amber-300' : 'border-slate-300'"
    >
      <p class="text-[12px] font-medium" :class="isOnline ? 'text-amber-600' : 'text-slate-600'">
        <span v-if="!isOnline">No connection — keep shooting</span>
        <span v-else-if="queue.draining.value">Uploading saved photos…</span>
        <span v-else>{{ queue.queueCount.value }} photo(s) waiting to upload</span>
      </p>
      <p class="mt-0.5 text-[11px] text-muted-foreground">
        <span v-if="queue.queueCount.value">
          {{ queue.queueCount.value }} saved on this device.
        </span>
        Photos are stored on the phone and sent automatically when signal
        returns — keep this page open until the count reaches zero.
      </p>
      <p v-if="queue.lastError.value" class="mt-0.5 text-[11px] text-amber-600">
        {{ queue.lastError.value }}
      </p>
      <button
        v-if="isOnline && queue.queueCount.value" type="button" :disabled="queue.draining.value"
        class="mt-1.5 px-2.5 py-1 rounded-full border text-[10px] font-medium bg-card hover:bg-muted disabled:opacity-50"
        @click="queue.drainQueue(refreshSubmission)"
      >{{ queue.draining.value ? 'Uploading…' : 'Retry now' }}</button>
    </div>

    <!-- The design the crew is building to. Served through our server with the
         app's own QB token, so a sub on a roof doesn't need a Quickbase login. -->
    <div v-if="docs.length" class="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1 min-w-0">
      <a
        v-for="d in docs" :key="d.recordId"
        :href="d.url ?? d.linkUrl ?? '#'" target="_blank" rel="noopener"
        class="flex-none px-2.5 py-1.5 rounded-full border text-[11px] font-medium bg-card hover:bg-muted whitespace-nowrap"
      >📄 {{ d.type }}<span v-if="d.fileName" class="text-muted-foreground"> · {{ d.fileName.slice(0, 24) }}</span></a>
    </div>

    <p v-if="branchNote" class="rounded-lg border border-sky-300 bg-card p-2.5 text-[12px] text-sky-700">
      {{ branchNote }}
    </p>

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
              :example="form?.examples?.[field.hash] ?? null"
              :geo="geo"
              @uploaded="refreshSubmission"
              @queued="queue.refreshQueue()"
            />

            <!-- Instruction block. Arrivy stores these as rich HTML, so it
                 is sanitized and rendered rather than escaped into tag soup. -->
            <div
              v-else-if="field.fieldType === 'block'"
              class="text-[12px] text-muted-foreground leading-relaxed
                     [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:text-foreground [&_h1]:mt-1
                     [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-foreground [&_h2]:mt-1
                     [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:text-foreground
                     [&_p]:mb-1.5 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4
                     [&_li]:mb-0.5 [&_strong]:font-semibold [&_strong]:text-foreground
                     [&_a]:underline [&_a]:underline-offset-2"
              v-html="sanitizeBlockHtml(field.label)"
            />

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

      <!-- AI job review. Reviews the job as a whole — the cross-cutting
           problems per-photo checks can't see. Advisory: a crew can dismiss a
           finding, or escalate it to a human when the call isn't the AI's to
           make. -->
      <div class="rounded-xl border bg-card p-3 min-w-0">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            AI job review<span v-if="openFindings.length"> · {{ openFindings.length }}</span>
          </p>
          <button
            type="button" :disabled="reviewing"
            class="px-2.5 py-1 rounded-full border text-[10px] font-medium bg-card hover:bg-muted disabled:opacity-50"
            @click="runReview"
          >{{ reviewing ? 'Reviewing…' : 'Review job now' }}</button>
        </div>

        <p v-if="reviewNote" class="mt-1.5 text-[11px] text-muted-foreground">{{ reviewNote }}</p>

        <div v-if="openFindings.length" class="mt-2 grid gap-2">
          <div v-for="f in openFindings" :key="f.id" class="rounded-lg border p-2.5 min-w-0">
            <p class="text-[12px] font-medium" :class="SEVERITY_TEXT[f.severity]">
              {{ f.title }}
              <span class="text-[10px] uppercase tracking-wider text-muted-foreground">· {{ f.kind }}</span>
            </p>
            <p v-if="f.detail" class="mt-0.5 text-[11px] text-muted-foreground">{{ f.detail }}</p>
            <p v-if="f.status === 'escalated'" class="mt-0.5 text-[11px] text-violet-600">
              Human review requested{{ f.escalated_by ? ` by ${f.escalated_by}` : '' }}
            </p>
            <div class="mt-1.5 flex flex-wrap gap-1.5">
              <button
                v-if="f.requirement_hash" type="button"
                class="px-2 py-0.5 rounded-full border text-[10px] font-medium bg-card hover:bg-muted"
                @click="jumpTo(f.requirement_hash!)"
              >Go to item</button>
              <button
                v-if="f.status !== 'escalated'" type="button"
                class="px-2 py-0.5 rounded-full border text-[10px] font-medium bg-card hover:bg-muted"
                @click="setFindingStatus(f, 'escalated')"
              >Ask a human</button>
              <button
                type="button"
                class="px-2 py-0.5 rounded-full border text-[10px] font-medium bg-card hover:bg-muted"
                @click="setFindingStatus(f, 'resolved')"
              >Fixed</button>
              <button
                type="button"
                class="px-2 py-0.5 rounded-full border text-[10px] font-medium bg-card hover:bg-muted"
                @click="setFindingStatus(f, 'dismissed')"
              >Not an issue</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Progress + what's left.
           Was a wall of ~40 unexplained chips, which read as clutter rather
           than a to-do list. Now: a progress bar you can actually judge
           yourself against, one obvious next action, and the full list behind
           a disclosure grouped by section so it's navigable rather than a heap. -->
      <div class="rounded-xl border bg-card p-3 min-w-0">
        <div class="flex items-baseline justify-between gap-2">
          <p class="text-sm font-medium">
            <span v-if="progress">{{ progress.percentApproved }}% approved</span>
            <span v-else>{{ overall.done }} / {{ overall.total }} done</span>
          </p>
          <p class="text-[11px] text-muted-foreground tabular-nums">
            <span v-if="progress">{{ progress.requiredApproved }} / {{ progress.requiredTotal }} required</span>
          </p>
        </div>

        <div class="mt-1.5 h-2 rounded-full bg-muted overflow-hidden">
          <div
            class="h-full transition-all"
            :class="(progress?.percentApproved ?? 0) === 100 ? 'bg-emerald-500' : 'bg-sky-500'"
            :style="{ width: `${progress?.percentApproved ?? 0}%` }"
          />
        </div>

        <p v-if="!outstanding.length" class="mt-2 text-[12px] text-emerald-600 font-medium">
          Everything required is approved — ready to submit.
        </p>

        <template v-else>
          <p class="mt-2 text-[12px] text-muted-foreground">
            <span class="font-medium text-foreground">{{ outstanding.length }}</span>
            still needed. Next: <span class="font-medium text-foreground">{{ outstanding[0]?.label }}</span>
          </p>
          <div class="mt-2 flex flex-wrap gap-1.5">
            <button
              type="button"
              class="px-3 py-1.5 rounded-full border text-[11px] font-medium bg-foreground text-background border-foreground"
              @click="jumpTo(outstanding[0]!.hash)"
            >Go to next</button>
            <button
              type="button"
              class="px-3 py-1.5 rounded-full border text-[11px] font-medium bg-card hover:bg-muted"
              @click="showChecklist = !showChecklist"
            >{{ showChecklist ? 'Hide list' : `Show all ${outstanding.length}` }}</button>
          </div>

          <div v-if="showChecklist" class="mt-2 grid gap-2">
            <div v-for="g in outstandingBySection" :key="g.title" class="min-w-0">
              <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {{ g.title }} · {{ g.fields.length }}
              </p>
              <ul class="mt-0.5 grid gap-0.5">
                <li v-for="f in g.fields" :key="f.hash">
                  <button
                    type="button"
                    class="text-left text-[12px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                    @click="jumpTo(f.hash)"
                  >{{ f.label }}</button>
                </li>
              </ul>
            </div>
          </div>
        </template>
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
