<script setup lang="ts">
// PhotoGuard dashboard — oversight for work captured in the app, plus review
// of anything pulled in from Arrivy historically.
//
// Field agents don't live here; they live in /photoguard/form/:formType. This
// view answers "is the quality holding up, and what needs a human?".
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import {
  accentBar, accentText, authHeaders, fmtBytes, fmtConfidence, fmtCoords,
  parseIssues, parseStringList, photoState, stateAccent, stateLabel,
  type PhotoGuardStats, type PhotoRow,
} from '@/lib/photoguard'
import { usePhotoGuardLive } from '@/lib/photoguardLive'
import { formLabel } from '@/data/arrivy-forms'

const auth = useAuthStore()

const stats = ref<PhotoGuardStats | null>(null)
const coverage = ref<Array<{ key: string; title: string; expectedPhotos: number; captured: number; passed: number; blocked: number }>>([])
const submissions = ref<Array<Record<string, unknown>>>([])
const reviewCount = ref(0)
const loading = ref(true)
const error = ref('')
const busy = ref('')
const toast = ref('')

const coverageForm = ref<'site_survey' | 'install_checkout'>('site_survey')

// Review drawer
const openPhoto = ref<PhotoRow | null>(null)
const reviewNote = ref('')

function flash(msg: string) {
  toast.value = msg
  setTimeout(() => { if (toast.value === msg) toast.value = '' }, 4000)
}

async function loadAll() {
  error.value = ''
  try {
    const [s, r, subs] = await Promise.all([
      fetch('/api/photoguard/stats', { headers: authHeaders() }),
      fetch('/api/photoguard/review-queue', { headers: authHeaders() }),
      fetch('/api/photoguard/submissions?limit=25', { headers: authHeaders() }),
    ])
    if (!s.ok) throw new Error(`Stats failed (${s.status})`)
    stats.value = await s.json()
    if (r.ok) reviewCount.value = (await r.json() as { count: number }).count
    if (subs.ok) submissions.value = (await subs.json() as { submissions: Array<Record<string, unknown>> }).submissions
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load'
  } finally {
    loading.value = false
  }
}

async function loadCoverage() {
  const res = await fetch(`/api/photoguard/coverage?formType=${coverageForm.value}`, { headers: authHeaders() })
  if (!res.ok) { coverage.value = []; return }
  coverage.value = (await res.json() as { sections: typeof coverage.value }).sections
}

async function importForms() {
  busy.value = 'import'
  try {
    const res = await fetch('/api/photoguard/forms/import/arrivy', { method: 'POST', headers: authHeaders() })
    const data = await res.json() as {
      error?: string
      reports?: Array<{ formType: string; title: string; photoFields: number; sections: number }>
    }
    if (!res.ok) throw new Error(data.error || `Import failed (${res.status})`)
    flash((data.reports ?? [])
      .map(r => `${r.title}: ${r.photoFields} photos / ${r.sections} sections`)
      .join(' · ') || 'Imported')
    await Promise.all([loadAll(), loadCoverage()])
  } catch (e) {
    flash(e instanceof Error ? e.message : 'Import failed')
  } finally {
    busy.value = ''
  }
}

async function scanArrivy() {
  busy.value = 'scan'
  try {
    const res = await fetch('/api/photoguard/scan?days=3', { method: 'POST', headers: authHeaders() })
    const data = await res.json() as { error?: string; imported?: number; photosAdded?: number }
    if (!res.ok) throw new Error(data.error || `Scan failed (${res.status})`)
    flash(`Scanned: ${data.imported ?? 0} task(s), ${data.photosAdded ?? 0} photo(s)`)
    await loadAll()
  } catch (e) {
    flash(e instanceof Error ? e.message : 'Scan failed')
  } finally {
    busy.value = ''
  }
}

async function review(status: 'approved' | 'rejected' | 'resubmit') {
  if (!openPhoto.value) return
  const id = openPhoto.value.id
  await fetch(`/api/photoguard/photos/${id}/review`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, note: reviewNote.value || null }),
  })
  openPhoto.value = null
  reviewNote.value = ''
  flash(`Marked ${status}`)
  loadAll()
}

async function revalidate(id: number) {
  await fetch(`/api/photoguard/revalidate/${id}`, { method: 'POST', headers: authHeaders() })
  flash('Re-queued for validation')
}

onMounted(() => { loadAll(); loadCoverage() })

const { connected, onPhotoGuardEvent } = usePhotoGuardLive()
const stopLive = onPhotoGuardEvent(evt => {
  if (evt.type === 'photo_validated' || evt.type === 'photo_reviewed' || evt.type === 'scan_complete') {
    loadAll()
  }
})
onBeforeUnmount(() => stopLive())

const passRateLabel = computed(() =>
  stats.value?.passRate == null ? '—' : `${stats.value.passRate}%`)

const modalIssues = computed(() => (openPhoto.value ? parseIssues(openPhoto.value.metadata_issues) : []))
const modalAiIssues = computed(() => (openPhoto.value ? parseStringList(openPhoto.value.validation_issues) : []))
</script>

<template>
  <div class="grid gap-3 min-w-0">
    <!-- Header -->
    <div class="flex flex-wrap items-start justify-between gap-2 min-w-0">
      <div class="flex flex-col gap-0.5 min-w-0">
        <h1 class="text-2xl font-semibold tracking-tight">PhotoGuard</h1>
        <p class="text-[11px] text-muted-foreground">
          <span :class="connected ? 'text-emerald-600' : 'text-slate-500'">●</span>
          {{ connected ? 'Live' : 'Reconnecting' }}
          <span v-if="stats"> · {{ stats.openSubmissions }} open survey(s)</span>
          <span v-if="stats && !stats.visionConfigured" class="text-amber-600">
            · vision model not configured
          </span>
        </p>
      </div>
      <div class="flex flex-wrap gap-1.5">
        <RouterLink
          to="/photoguard/form/site_survey"
          class="px-3 py-2 rounded-full border text-[11px] font-medium bg-foreground text-background border-foreground"
        >Start site survey</RouterLink>
        <RouterLink
          to="/photoguard/form/install_checkout"
          class="px-3 py-2 rounded-full border text-[11px] font-medium bg-card hover:bg-muted"
        >Install checkout</RouterLink>
      </div>
    </div>

    <p v-if="error" class="text-sm text-rose-600">{{ error }}</p>
    <p v-else-if="loading" class="text-sm text-muted-foreground">Loading…</p>

    <template v-else-if="stats">
      <!-- KPI strip -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 min-w-0">
        <div class="rounded-xl border bg-card p-3 min-w-0 relative overflow-hidden">
          <div class="absolute top-0 left-0 right-0 h-[3px] bg-sky-500" />
          <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Photos</p>
          <p class="mt-1 flex items-baseline gap-1.5 min-w-0">
            <span class="text-2xl font-extrabold tabular-nums text-sky-600 leading-none">
              {{ stats.totalPhotos }}
            </span>
            <span class="text-[11px] font-bold tabular-nums text-sky-600 truncate">
              / {{ stats.totalSubmissions }} surveys
            </span>
          </p>
        </div>
        <div class="rounded-xl border bg-card p-3 min-w-0 relative overflow-hidden">
          <div class="absolute top-0 left-0 right-0 h-[3px] bg-emerald-500" />
          <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Pass rate</p>
          <p class="mt-1 flex items-baseline gap-1.5 min-w-0">
            <span class="text-2xl font-extrabold tabular-nums text-emerald-600 leading-none">
              {{ passRateLabel }}
            </span>
            <span class="text-[11px] font-bold tabular-nums text-emerald-600 truncate">
              / {{ stats.passed }} passed
            </span>
          </p>
        </div>
        <div class="rounded-xl border bg-card p-3 min-w-0 relative overflow-hidden">
          <div class="absolute top-0 left-0 right-0 h-[3px] bg-rose-500" />
          <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Needs retake</p>
          <p class="mt-1 flex items-baseline gap-1.5 min-w-0">
            <span class="text-2xl font-extrabold tabular-nums text-rose-600 leading-none">
              {{ stats.failed + stats.blocked }}
            </span>
            <span class="text-[11px] font-bold tabular-nums text-rose-600 truncate">
              / {{ stats.blocked }} blocked
            </span>
          </p>
        </div>
        <div class="rounded-xl border bg-card p-3 min-w-0 relative overflow-hidden">
          <div class="absolute top-0 left-0 right-0 h-[3px] bg-violet-500" />
          <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">GPS tagged</p>
          <p class="mt-1 flex items-baseline gap-1.5 min-w-0">
            <span class="text-2xl font-extrabold tabular-nums text-violet-600 leading-none">
              {{ stats.withGps }}
            </span>
            <span class="text-[11px] font-semibold tabular-nums text-muted-foreground truncate">
              / {{ stats.totalPhotos }} photos
            </span>
          </p>
        </div>
      </div>

      <!-- Setup prompt when nothing is imported -->
      <div v-if="coverage.length === 0" class="rounded-xl border bg-card p-3">
        <p class="text-sm font-medium">No form definitions yet</p>
        <p class="mt-1 text-[12px] text-muted-foreground">
          Import the form structure from Arrivy once. After that the forms are ours —
          they're stored locally, editable, and Arrivy isn't in the capture path.
        </p>
        <button
          type="button" :disabled="busy === 'import' || !stats.arrivyConfigured"
          class="mt-2 px-3 py-1.5 rounded-full border text-[11px] font-medium bg-foreground text-background border-foreground disabled:opacity-50"
          @click="importForms"
        >{{ busy === 'import' ? 'Importing…' : 'Import forms from Arrivy' }}</button>
        <p v-if="!stats.arrivyConfigured" class="mt-1 text-[11px] text-amber-600">
          Arrivy credentials aren't configured on the server.
        </p>
      </div>

      <!-- Coverage -->
      <div v-else class="grid gap-2 min-w-0">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            Coverage · {{ formLabel(coverageForm).toUpperCase() }}
          </p>
          <div class="inline-flex rounded-md border overflow-hidden">
            <button
              type="button" class="px-2 py-1 text-[11px] font-medium"
              :class="coverageForm === 'site_survey' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'"
              @click="coverageForm = 'site_survey'; loadCoverage()"
            >Site Survey</button>
            <button
              type="button" class="px-2 py-1 text-[11px] font-medium"
              :class="coverageForm === 'install_checkout' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'"
              @click="coverageForm = 'install_checkout'; loadCoverage()"
            >Install</button>
          </div>
        </div>

        <div class="rounded-xl border bg-card p-3 grid gap-2 min-w-0">
          <div v-for="s in coverage" :key="s.key" class="min-w-0">
            <div class="flex items-baseline justify-between gap-2 text-[11px]">
              <span class="truncate font-medium">{{ s.title }}</span>
              <span class="flex-none tabular-nums text-muted-foreground">
                {{ s.passed }}/{{ s.expectedPhotos }}
              </span>
            </div>
            <div class="mt-1 h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                class="h-full bg-emerald-500"
                :style="{ width: `${s.expectedPhotos ? Math.min(100, (s.passed / s.expectedPhotos) * 100) : 0}%` }"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- Recent surveys -->
      <div class="grid gap-2 min-w-0">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            Recent surveys
          </p>
          <p v-if="reviewCount" class="text-[10px] text-rose-600 font-medium">
            {{ reviewCount }} photo(s) need review
          </p>
        </div>

        <p v-if="!submissions.length" class="text-[12px] text-muted-foreground">
          Nothing captured yet. Start a survey above.
        </p>

        <div v-else class="grid gap-2 min-w-0">
          <RouterLink
            v-for="s in submissions" :key="String(s['id'])"
            :to="`/photoguard/form/${s['form_type']}?submission=${s['id']}`"
            class="rounded-xl border bg-card p-3 min-w-0 hover:bg-muted transition-colors"
          >
            <div class="flex items-baseline justify-between gap-2 min-w-0">
              <span class="truncate text-sm font-medium">
                {{ s['customer_name'] || formLabel(String(s['form_type'])) }}
              </span>
              <span class="flex-none text-[10px] uppercase tracking-wider font-semibold"
                :class="s['status'] === 'in_progress' ? 'text-amber-600' : 'text-emerald-600'">
                {{ s['status'] === 'in_progress' ? 'In progress' : 'Submitted' }}
              </span>
            </div>
            <p class="mt-0.5 text-[11px] text-muted-foreground truncate">
              {{ s['started_by_name'] || 'Unknown' }} ·
              {{ s['passed_count'] || 0 }}/{{ s['photo_count'] || 0 }} photos passing
            </p>
          </RouterLink>
        </div>
      </div>

      <!-- Admin actions live at the bottom: they're maintenance, not the point
           of the page (see docs/ui-component-specs.md on process triggers). -->
      <div v-if="auth.isAdmin && coverage.length" class="flex flex-wrap gap-1.5 pt-1">
        <button
          type="button" :disabled="busy === 'import'"
          class="px-2.5 py-1 rounded-full border text-[10px] font-medium bg-card hover:bg-muted disabled:opacity-50"
          @click="importForms"
        >{{ busy === 'import' ? 'Importing…' : 'Re-import forms' }}</button>
        <button
          type="button" :disabled="busy === 'scan' || !stats.arrivyConfigured"
          class="px-2.5 py-1 rounded-full border text-[10px] font-medium bg-card hover:bg-muted disabled:opacity-50"
          @click="scanArrivy"
        >{{ busy === 'scan' ? 'Scanning…' : 'Scan Arrivy (3d)' }}</button>
      </div>
    </template>

    <!-- Toast -->
    <p
      v-if="toast"
      class="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 rounded-full border bg-card px-3 py-1.5 text-[11px] shadow"
    >{{ toast }}</p>

    <!-- Review drawer -->
    <div
      v-if="openPhoto"
      class="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      @click.self="openPhoto = null"
    >
      <div class="bg-card w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl p-4 max-h-[90vh] overflow-y-auto">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="text-sm font-medium break-words">{{ openPhoto.category_label || 'Photo' }}</p>
            <p class="text-[11px]" :class="accentText(stateAccent(photoState(openPhoto)))">
              {{ stateLabel(photoState(openPhoto)) }} ·
              {{ fmtConfidence(openPhoto.validation_confidence) }} confidence
            </p>
          </div>
          <button type="button" class="text-[11px] text-muted-foreground" @click="openPhoto = null">Close</button>
        </div>

        <img
          v-if="openPhoto.file_path" :src="openPhoto.file_path" alt=""
          class="mt-2 w-full rounded-lg object-contain max-h-[45vh] bg-muted"
        />

        <p v-if="openPhoto.validation_description" class="mt-2 text-[12px] text-muted-foreground">
          {{ openPhoto.validation_description }}
        </p>

        <ul v-if="modalIssues.length || modalAiIssues.length" class="mt-2 grid gap-1">
          <li v-for="(i, idx) in modalIssues" :key="`m${idx}`" class="text-[11px]"
            :class="i.severity === 'fail' ? 'text-rose-600' : 'text-amber-600'">{{ i.message }}</li>
          <li v-for="(i, idx) in modalAiIssues" :key="`ai${idx}`" class="text-[11px] text-rose-600">{{ i }}</li>
        </ul>

        <dl class="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
          <dt class="text-muted-foreground">Captured by</dt>
          <dd class="text-right truncate">{{ openPhoto.captured_by_name || '—' }}</dd>
          <dt class="text-muted-foreground">Taken</dt>
          <dd class="text-right truncate">{{ openPhoto.photo_timestamp || '—' }}</dd>
          <dt class="text-muted-foreground">GPS</dt>
          <dd class="text-right truncate">{{ fmtCoords(openPhoto.gps_lat, openPhoto.gps_lng) }}</dd>
          <dt class="text-muted-foreground">Device</dt>
          <dd class="text-right truncate">
            {{ [openPhoto.camera_make, openPhoto.camera_model].filter(Boolean).join(' ') || '—' }}
          </dd>
          <dt class="text-muted-foreground">Size</dt>
          <dd class="text-right truncate">
            {{ openPhoto.width }}×{{ openPhoto.height }} · {{ fmtBytes(openPhoto.file_size) }}
          </dd>
          <dt class="text-muted-foreground">Source</dt>
          <dd class="text-right truncate">{{ openPhoto.capture_source || '—' }}</dd>
        </dl>

        <textarea
          v-model="reviewNote" rows="2" placeholder="Note (optional)"
          class="mt-3 w-full rounded-md border bg-background px-2 py-2 text-sm"
        />

        <div class="mt-2 flex flex-wrap gap-1.5">
          <button
            type="button"
            class="px-3 py-2 rounded-full border text-[11px] font-medium bg-foreground text-background border-foreground"
            @click="review('approved')"
          >Approve</button>
          <button
            type="button"
            class="px-3 py-2 rounded-full border text-[11px] font-medium bg-card hover:bg-muted"
            @click="review('resubmit')"
          >Request retake</button>
          <button
            type="button"
            class="px-3 py-2 rounded-full border text-[11px] font-medium bg-card hover:bg-muted"
            @click="review('rejected')"
          >Reject</button>
          <button
            type="button"
            class="px-3 py-2 rounded-full border text-[11px] font-medium bg-card hover:bg-muted"
            @click="revalidate(openPhoto.id)"
          >Re-run AI</button>
        </div>
      </div>
    </div>
  </div>
</template>
