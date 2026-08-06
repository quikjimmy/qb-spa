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
import { windowTaskToCard, type WindowResponse, type SurveyCard } from '@/lib/surveyTasks'
import { arrivyTaskIdFrom } from '@/lib/photoguard'
import ArrivySurveyRow, { type ImportState } from '@/components/photoguard/ArrivySurveyRow.vue'
import AssessmentDrawer from '@/components/photoguard/AssessmentDrawer.vue'

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

// ─── Today's jobs — the crew's way in ────────────────────────────────
interface Job {
  projectRid: number
  customerName: string | null
  customerAddress: string | null
  scheduled: string
  hasCoords: boolean
  formType: string
  submission: { id: number; status: string; photos: number; contributors: number } | null
}
const jobKind = ref<'install' | 'survey'>('install')
const jobDays = ref(1)
const jobs = ref<Job[]>([])
const jobsLoading = ref(true)

async function loadJobs() {
  jobsLoading.value = true
  try {
    const res = await fetch(`/api/photoguard/jobs?kind=${jobKind.value}&days=${jobDays.value}`, { headers: authHeaders() })
    jobs.value = res.ok ? (await res.json() as { jobs: Job[] }).jobs : []
  } catch { jobs.value = [] } finally { jobsLoading.value = false }
}

function jobHref(j: Job): string {
  // No ?submission= — the server joins by project + form type so every trade
  // on this install lands in the same shared checkout.
  return `/photoguard/form/${j.formType}?project=${j.projectRid}`
}

// ─── Audit trail ─────────────────────────────────────────────────────
interface AuditEntry {
  photoId: number
  requirement: string | null
  section: string | null
  uploadedBy: string | null
  captureSource: string | null
  takenAt: string | null
  uploadedAt: string | null
  delayMinutes: number | null
  onSite: boolean | null
  distanceM: number | null
  passed: boolean | null
  reviewStatus: string | null
  thumbPath: string | null
}
const auditFor = ref<number | null>(null)
const audit = ref<{ entries: AuditEntry[]; summary: Record<string, number | null> } | null>(null)

async function openAudit(submissionId: number) {
  auditFor.value = submissionId
  audit.value = null
  const res = await fetch(`/api/photoguard/submissions/${submissionId}/audit`, { headers: authHeaders() })
  if (res.ok) audit.value = await res.json()
}

function fmtDelay(min: number | null): string {
  if (min == null) return 'unknown'
  if (min < 2) return 'immediately'
  if (min < 90) return `${min}m later`
  const h = Math.round(min / 60)
  return h < 48 ? `${h}h later` : `${Math.round(h / 24)}d later`
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined,
    { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// ─── Pull a survey from Arrivy on demand ─────────────────────────────
//
// Deliberately reuses the Field view's survey window endpoint and its
// SurveyTaskCard, so a survey reads here exactly as it does on
// /projects/site-survey — same fields, same status pills, same chips. Two
// benefits beyond consistency: that endpoint is served from local cache, so
// browsing costs Arrivy nothing, and Arrivy is only touched when someone
// actually presses import.
type SurveyPreset = 'today' | 'yesterday' | 'week'
const surveyPreset = ref<SurveyPreset>('yesterday')
const surveyCards = ref<SurveyCard[]>([])
const surveysLoading = ref(false)
const pulling = ref<string | null>(null)
const showArrivy = ref(false)
// arrivy task id -> what PhotoGuard already holds for it
const importedTasks = ref<Record<string, ImportState>>({})
// Which assessment is open, if any.
const assessmentTask = ref<{ id: number; title: string } | null>(null)

/** Just the PhotoGuard overlay — no Arrivy call, cheap enough to poll on SSE. */
async function refreshImported() {
  try {
    const r = await fetch('/api/photoguard/imported-tasks', { headers: authHeaders() })
    if (r.ok) importedTasks.value = (await r.json() as { tasks: Record<string, ImportState> }).tasks
  } catch { /* leave what we have */ }
}

async function loadSurveys() {
  surveysLoading.value = true
  try {
    const [w, imp] = await Promise.all([
      fetch(`/api/survey-tasks/window?preset=${surveyPreset.value}`, { headers: authHeaders() }),
      fetch('/api/photoguard/imported-tasks', { headers: authHeaders() }),
    ])
    surveyCards.value = w.ok
      ? (await w.json() as WindowResponse).tasks.map(windowTaskToCard)
      : []
    if (imp.ok) importedTasks.value = (await imp.json() as { tasks: typeof importedTasks.value }).tasks
  } catch {
    surveyCards.value = []
  } finally {
    surveysLoading.value = false
  }
}

function pgState(card: SurveyCard): ImportState | null {
  const id = arrivyTaskIdFrom(card.task_url)
  return id ? importedTasks.value[id] ?? null : null
}

function openAssessment(card: SurveyCard) {
  const st = pgState(card)
  if (!st?.taskRowId) return
  assessmentTask.value = { id: st.taskRowId, title: card.customer_name || 'Survey' }
}

async function pullSurvey(card: SurveyCard) {
  const arrivyId = arrivyTaskIdFrom(card.task_url)
  if (!arrivyId) { flash('That survey has no Arrivy task link'); return }
  pulling.value = arrivyId
  try {
    const res = await fetch(`/api/photoguard/arrivy/import/${arrivyId}`, {
      method: 'POST', headers: authHeaders(),
    })
    const data = await res.json() as { error?: string; photosAdded?: number }
    if (!res.ok) throw new Error(data.error || `Import failed (${res.status})`)
    flash(`${card.customer_name}: ${data.photosAdded ?? 0} photo(s) imported, assessing now`)
    await Promise.all([loadSurveys(), loadAll()])
  } catch (e) {
    flash(e instanceof Error ? e.message : 'Import failed')
  } finally {
    pulling.value = null
  }
}

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

onMounted(() => { loadAll(); loadCoverage(); loadJobs() })

const { connected, onPhotoGuardEvent } = usePhotoGuardLive()
const stopLive = onPhotoGuardEvent(evt => {
  if (evt.type === 'photo_validated' || evt.type === 'photo_reviewed' || evt.type === 'scan_complete') {
    loadAll()
    // Keeps the per-survey "assessing 41/63" counters moving live.
    if (showArrivy.value) refreshImported()
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
          <span
            class="inline-block size-1.5 rounded-full align-middle"
            :class="connected ? 'bg-emerald-500' : 'bg-slate-400'"
            aria-hidden="true"
          />
          <span class="sr-only">Connection:</span>{{ connected ? 'Live' : 'Reconnecting' }}
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

      <!-- Import & assess Arrivy surveys. Browsing reads the Field view's
           cached endpoint, so it costs Arrivy nothing; Arrivy is only touched
           on an explicit import. -->
      <div class="grid gap-2 min-w-0">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            Arrivy surveys
          </p>
          <button
            type="button"
            class="px-2 py-0.5 rounded-full border text-[10px] font-medium bg-card hover:bg-muted cursor-pointer transition-colors"
            :aria-expanded="showArrivy"
            @click="showArrivy = !showArrivy; if (showArrivy && !surveyCards.length) loadSurveys()"
          >{{ showArrivy ? 'Hide' : 'Browse' }}</button>
        </div>

        <template v-if="showArrivy">
          <!-- Date presets: chip sizing per docs/ui-component-specs.md. These
               are filters, not primary actions, so they stay small. -->
          <div class="flex flex-wrap gap-1.5" role="group" aria-label="Survey date range">
            <button
              v-for="p in (['today','yesterday','week'] as SurveyPreset[])" :key="p" type="button"
              class="px-2 py-0.5 rounded-full border text-[10px] font-medium whitespace-nowrap cursor-pointer transition-colors"
              :class="surveyPreset === p ? 'bg-foreground text-background border-foreground' : 'bg-card hover:bg-muted'"
              :aria-pressed="surveyPreset === p"
              @click="surveyPreset = p; loadSurveys()"
            >{{ p === 'today' ? 'Today' : p === 'yesterday' ? 'Yesterday' : 'This week' }}</button>
          </div>

          <p v-if="surveysLoading" class="text-[12px] text-muted-foreground">Loading surveys…</p>
          <p v-else-if="!surveyCards.length" class="text-[12px] text-muted-foreground">
            No surveys in that window.
          </p>

          <div v-else class="grid gap-2 min-w-0">
            <ArrivySurveyRow
              v-for="c in surveyCards" :key="c.rid"
              :card="c"
              :state="pgState(c)"
              :importing="pulling === arrivyTaskIdFrom(c.task_url)"
              @import="pullSurvey(c)"
              @view="openAssessment(c)"
            />
          </div>
        </template>
      </div>

      <!-- Today's jobs: one tap into the right shared checkout -->
      <div class="grid gap-2 min-w-0">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            {{ jobDays === 0 ? 'Today' : `Within ${jobDays}d` }} · {{ jobKind === 'install' ? 'INSTALLS' : 'SURVEYS' }}
          </p>
          <div class="flex items-center gap-1.5">
            <div class="inline-flex rounded-md border overflow-hidden">
              <button type="button" class="px-2 py-1 text-[11px] font-medium"
                :class="jobKind === 'install' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'"
                @click="jobKind = 'install'; loadJobs()">Installs</button>
              <button type="button" class="px-2 py-1 text-[11px] font-medium"
                :class="jobKind === 'survey' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'"
                @click="jobKind = 'survey'; loadJobs()">Surveys</button>
            </div>
            <div class="flex gap-1">
              <button v-for="d in [0, 1, 7]" :key="d" type="button"
                class="px-2 py-0.5 rounded-full border text-[10px] font-medium whitespace-nowrap"
                :class="jobDays === d ? 'bg-foreground text-background border-foreground' : 'bg-card hover:bg-muted'"
                @click="jobDays = d; loadJobs()">{{ d === 0 ? 'Today' : `±${d}d` }}</button>
            </div>
          </div>
        </div>

        <p v-if="jobsLoading" class="text-[12px] text-muted-foreground">Loading jobs…</p>
        <p v-else-if="!jobs.length" class="text-[12px] text-muted-foreground">
          Nothing scheduled in this window. Widen it, or start a blank form above.
        </p>

        <div v-else class="grid gap-2 min-w-0">
          <RouterLink
            v-for="j in jobs" :key="j.projectRid" :to="jobHref(j)"
            class="rounded-xl border bg-card p-3 min-w-0 hover:bg-muted transition-colors"
          >
            <div class="flex items-baseline justify-between gap-2 min-w-0">
              <span class="truncate text-sm font-medium">{{ j.customerName || `Project ${j.projectRid}` }}</span>
              <span class="flex-none text-[10px] font-semibold uppercase tracking-wider"
                :class="j.submission ? 'text-amber-600' : 'text-sky-600'">
                {{ j.submission ? 'Resume' : 'Start' }}
              </span>
            </div>
            <p class="mt-0.5 text-[11px] text-muted-foreground truncate">
              {{ j.customerAddress || 'No address' }}
            </p>
            <p class="mt-0.5 text-[10px] text-muted-foreground">
              {{ j.scheduled }}
              <span v-if="j.submission"> · {{ j.submission.photos }} photo(s)<span
                v-if="j.submission.contributors > 1"> · {{ j.submission.contributors }} people</span></span>
              <span v-if="!j.hasCoords" class="text-amber-600"> · no site coords</span>
            </p>
          </RouterLink>
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
          <div
            v-for="s in submissions" :key="String(s['id'])"
            class="rounded-xl border bg-card min-w-0 overflow-hidden"
          >
          <RouterLink
            :to="`/photoguard/form/${s['form_type']}?submission=${s['id']}`"
            class="block p-3 min-w-0 hover:bg-muted transition-colors"
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
          <button
            type="button"
            class="px-3 pb-2 text-[10px] underline underline-offset-2 text-muted-foreground hover:text-foreground"
            @click="openAudit(Number(s['id']))"
          >Audit trail</button>
          </div>
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

    <!-- Assessment for an imported Arrivy survey -->
    <AssessmentDrawer
      v-if="assessmentTask"
      :task-row-id="assessmentTask.id"
      :title="assessmentTask.title"
      @close="assessmentTask = null"
      @open-photo="p => { openPhoto = p }"
    />

    <!-- Audit trail -->
    <div
      v-if="auditFor"
      class="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      @click.self="auditFor = null"
    >
      <div class="bg-card w-full sm:max-w-2xl rounded-t-2xl sm:rounded-2xl p-4 max-h-[90vh] overflow-y-auto">
        <div class="flex items-start justify-between gap-2">
          <p class="text-sm font-medium">Audit trail · job {{ auditFor }}</p>
          <button type="button" class="text-[11px] text-muted-foreground" @click="auditFor = null">Close</button>
        </div>

        <p v-if="!audit" class="mt-2 text-[12px] text-muted-foreground">Loading…</p>

        <template v-else>
          <p class="mt-1 text-[11px] text-muted-foreground">
            {{ audit.summary['photos'] }} photos · {{ audit.summary['contributors'] }} people ·
            {{ audit.summary['onSite'] }} on site, {{ audit.summary['offSite'] }} off site,
            {{ audit.summary['locationUnknown'] }} unknown ·
            {{ audit.summary['liveCaptures'] }} live / {{ audit.summary['libraryUploads'] }} from library
            <span v-if="audit.summary['medianDelayMinutes'] != null">
              · typically uploaded {{ fmtDelay(audit.summary['medianDelayMinutes']) }}
            </span>
          </p>

          <div class="mt-3 grid gap-1.5">
            <div
              v-for="e in audit.entries" :key="e.photoId"
              class="flex gap-2 items-start rounded-lg border p-2 min-w-0"
            >
              <img
                v-if="e.thumbPath" :src="e.thumbPath"
                :alt="`Photo for ${e.requirement ?? 'unassigned requirement'}`"
                class="flex-none w-10 h-10 rounded object-cover bg-muted"
              />
              <div class="min-w-0 flex-1">
                <p class="text-[12px] font-medium truncate">{{ e.requirement || 'Unassigned' }}</p>
                <p class="text-[11px] text-muted-foreground">
                  {{ e.uploadedBy || 'Unknown' }} ·
                  <span :class="e.captureSource === 'upload' ? 'text-amber-600' : ''">
                    {{ e.captureSource === 'upload' ? 'from library' : e.captureSource === 'video_frame' ? 'video frame' : 'live camera' }}
                  </span>
                </p>
                <p class="text-[10px] text-muted-foreground">
                  Taken {{ fmtTime(e.takenAt) }} · uploaded {{ fmtTime(e.uploadedAt) }}
                  <span :class="(e.delayMinutes ?? 0) > 240 ? 'text-amber-600' : ''">
                    ({{ fmtDelay(e.delayMinutes) }})
                  </span>
                </p>
                <p class="text-[10px]">
                  <span v-if="e.onSite === true" class="text-emerald-600">On site ({{ e.distanceM }}m)</span>
                  <span v-else-if="e.onSite === false" class="text-rose-600">Off site ({{ e.distanceM }}m)</span>
                  <span v-else class="text-muted-foreground">Location unknown</span>
                </p>
              </div>
              <span
                class="flex-none text-[10px] font-bold uppercase tracking-wider"
                :class="e.passed === true ? 'text-emerald-600' : e.passed === false ? 'text-rose-600' : 'text-slate-500'"
              >{{ e.passed === true ? 'Pass' : e.passed === false ? 'Fail' : 'Pending' }}</span>
            </div>
          </div>
        </template>
      </div>
    </div>

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
            class="min-h-11 px-4 rounded-full border text-[11px] font-medium bg-foreground text-background border-foreground cursor-pointer transition-colors"
            @click="review('approved')"
          >Approve</button>
          <button
            type="button"
            class="min-h-11 px-4 rounded-full border text-[11px] font-medium bg-card hover:bg-muted cursor-pointer transition-colors"
            @click="review('resubmit')"
          >Request retake</button>
          <button
            type="button"
            class="min-h-11 px-4 rounded-full border text-[11px] font-medium bg-card hover:bg-muted cursor-pointer transition-colors"
            @click="review('rejected')"
          >Reject</button>
          <button
            type="button"
            class="min-h-11 px-4 rounded-full border text-[11px] font-medium bg-card hover:bg-muted cursor-pointer transition-colors"
            @click="revalidate(openPhoto.id)"
          >Re-run AI</button>
        </div>
      </div>
    </div>
  </div>
</template>
