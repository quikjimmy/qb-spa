<script setup lang="ts">
// Site Survey — surveys only, two data sources, ONE record format:
//   1. "Survey Tasks" — /api/survey-tasks/window: Arrivy survey tasks in
//      an office-calendar window (preset or custom range), project meta
//      joined server-side for the standard filters.
//   2. "Floating" — /api/survey-tasks/floating: survey tasks on
//      signed-but-unsubmitted Enerflo deals (joined by Enerflo V2 deal
//      ID), plus survey tasks with no project and no matched deal.
// Every KPI slice renders the identical SurveyTaskCard so records read
// the same regardless of which tile is active. State/Lender/EPC filters
// apply to every section AND every tile count.
import { computed, onMounted, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import MilestoneShell from '@/components/milestone/MilestoneShell.vue'
import MilestoneFilterBar, { type FilterDef } from '@/components/milestone/MilestoneFilterBar.vue'
import ProjectDetailDialog from '@/components/milestone/ProjectDetailDialog.vue'
import DealPeekSheet from '@/components/survey/DealPeekSheet.vue'
import SurveyTaskCard from '@/components/survey/SurveyTaskCard.vue'
import {
  floatingTaskToCard, windowTaskToCard,
  type FloatingDeal, type FloatingResponse, type FloatingTask,
  type SurveyCard, type WindowResponse,
} from '@/lib/surveyTasks'
import { fmtDateFull, timeAgo } from '@/lib/dates'

const auth = useAuthStore()
function hdrs() { return { Authorization: `Bearer ${auth.token}` } }

// ─── Date window (presets resolve server-side on the office calendar) ──
type Preset = 'today' | 'yesterday' | 'week' | 'month' | '30days' | 'custom'
const PRESETS: Array<{ k: Preset; l: string }> = [
  { k: 'today', l: 'Today' },
  { k: 'yesterday', l: 'Yesterday' },
  { k: 'week', l: 'This Week' },
  { k: 'month', l: 'This Month' },
  { k: '30days', l: 'Last 30' },
  { k: 'custom', l: 'Custom' },
]
const preset = ref<Preset>('today')
const customFrom = ref('')
const customTo = ref('')
const windowLabel = computed(() => {
  if (preset.value !== 'custom') return PRESETS.find(p => p.k === preset.value)?.l ?? ''
  if (customFrom.value && customTo.value) return `${fmtDateFull(customFrom.value)} – ${fmtDateFull(customTo.value)}`
  return 'Custom'
})

const windowCards = ref<SurveyCard[]>([])
const windowLoading = ref(true)
const windowError = ref('')

async function loadWindow() {
  if (preset.value === 'custom' && !(customFrom.value && customTo.value)) return
  windowLoading.value = true
  windowError.value = ''
  try {
    const params = preset.value === 'custom'
      ? `from=${customFrom.value}&to=${customTo.value}`
      : `preset=${preset.value}`
    const res = await fetch(`/api/survey-tasks/window?${params}`, { headers: hdrs() })
    if (!res.ok) throw new Error(`Survey window failed (${res.status})`)
    const data = await res.json() as WindowResponse
    windowCards.value = data.tasks.map(windowTaskToCard).sort(descCardSort)
  } catch (e) {
    windowError.value = e instanceof Error ? e.message : 'Failed to load'
  } finally {
    windowLoading.value = false
  }
}
watch(preset, () => { if (preset.value !== 'custom') loadWindow() })
watch([customFrom, customTo], () => { if (preset.value === 'custom') loadWindow() })

// ─── Floating (unsubmitted deals + unassigned) — surveys only ──
const floating = ref<FloatingResponse | null>(null)
const floatingLoading = ref(true)
const floatingError = ref('')
const showHidden = ref(false)
const showZeroTaskDeals = ref(false)

async function loadFloating() {
  floatingError.value = ''
  try {
    const res = await fetch('/api/survey-tasks/floating', { headers: hdrs() })
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      throw new Error(body.error || `Failed to load (${res.status})`)
    }
    floating.value = await res.json()
  } catch (e) {
    floatingError.value = e instanceof Error ? e.message : 'Failed to load'
  } finally {
    floatingLoading.value = false
  }
}

onMounted(() => { loadWindow(); loadFloating() })

// ─── Standard filters (state / lender / EPC) — apply everywhere ──
const fState = ref('')
const fLender = ref('')
const fEpc = ref('')

function matchesFilters(c: { state: string; lender: string; epc: string }): boolean {
  if (fState.value && c.state !== fState.value) return false
  if (fLender.value && c.lender !== fLender.value) return false
  if (fEpc.value && c.epc !== fEpc.value) return false
  return true
}

// Newest survey date first, unscheduled last — every section sorts this way.
function descCardSort(a: { scheduled_at: string }, b: { scheduled_at: string }): number {
  if (!a.scheduled_at && !b.scheduled_at) return 0
  if (!a.scheduled_at) return 1
  if (!b.scheduled_at) return -1
  return b.scheduled_at.localeCompare(a.scheduled_at)
}

const filteredWindowCards = computed(() => windowCards.value.filter(matchesFilters))

// Deals with ≥1 survey task; test-named deals stay hidden until toggled.
const allSurveyDeals = computed(() => {
  if (!floating.value) return []
  return floating.value.deals
    .map(d => ({ deal: d, tasks: d.tasks.filter(t => t.task_type_key === 'survey') }))
    .filter(x => x.tasks.length > 0)
    .filter(x => matchesFilters({ state: x.deal.state, lender: x.deal.lender_name, epc: x.deal.epc_name }))
})
const surveyDeals = computed(() => allSurveyDeals.value.filter(x => !x.deal.is_probable_test))
const hiddenDeals = computed(() => allSurveyDeals.value.filter(x => x.deal.is_probable_test))

// The money split: a survey that was performed ('submitted', or Arrivy
// complete without the form = 'notsubmitted') has been paid for — if the
// deal still isn't in Projects, that's spend waiting on a submission.
// Everything else on an unsubmitted deal is an upcoming survey.
function surveyPerformed(t: { status: string }): boolean {
  return t.status === 'submitted' || t.status === 'notsubmitted'
}
const paidDeals = computed(() => surveyDeals.value.filter(x => x.tasks.some(surveyPerformed)))
const upcomingDeals = computed(() => surveyDeals.value.filter(x => !x.tasks.some(surveyPerformed)))

// Flatten deal groups into uniform cards, newest survey date first.
function toCards(list: Array<{ deal: FloatingDeal; tasks: FloatingTask[] }>): SurveyCard[] {
  return list.flatMap(x => x.tasks.map(t => floatingTaskToCard(t, x.deal))).sort(descCardSort)
}
const paidCards = computed(() => toCards(paidDeals.value))
const upcomingCards = computed(() => toCards(upcomingDeals.value))
const hiddenDealCards = computed(() => toCards(hiddenDeals.value))

// Unassigned tasks carry no state/lender/EPC (no project, no deal), so
// they only show when no filter is active — a filtered view can't verify
// they match.
const surveyUnassigned = computed(() => {
  if (!floating.value) return []
  if (fState.value || fLender.value || fEpc.value) return []
  return floating.value.unassignedTasks.filter(t => t.task_type_key === 'survey')
})
// Test-named and stale rows hidden until toggled so the list opens on
// what's actionable.
const unassignedCards = computed(() =>
  surveyUnassigned.value.filter(t => !t.is_probable_test && !t.is_stale).map(t => floatingTaskToCard(t)).sort(descCardSort))
const hiddenUnassignedCards = computed(() =>
  surveyUnassigned.value.filter(t => t.is_probable_test || t.is_stale).map(t => floatingTaskToCard(t)).sort(descCardSort))

// Filter dropdown options — union of everything currently loaded.
function optionsOf(pick: (c: { state: string; lender: string; epc: string }) => string): string[] {
  const vals = new Set<string>()
  for (const c of windowCards.value) { const v = pick(c); if (v) vals.add(v) }
  for (const d of floating.value?.deals ?? []) {
    const v = pick({ state: d.state, lender: d.lender_name, epc: d.epc_name })
    if (v) vals.add(v)
  }
  return [...vals].sort()
}
const filterDefs = computed<FilterDef[]>(() => [
  { key: 'state',  placeholder: 'State',  options: optionsOf(c => c.state),  value: fState.value },
  { key: 'lender', placeholder: 'Lender', options: optionsOf(c => c.lender), value: fLender.value },
  { key: 'epc',    placeholder: 'EPC',    options: optionsOf(c => c.epc),    value: fEpc.value },
])
function onFilterUpdate(key: string, value: string) {
  if (key === 'state') fState.value = value
  else if (key === 'lender') fLender.value = value
  else if (key === 'epc') fEpc.value = value
}
function resetFilters() { fState.value = ''; fLender.value = ''; fEpc.value = '' }

// Filters live behind the standard funnel toggle (same pattern as
// ProjectsView): icon button with an active-count badge, drawer below.
const showDrawer = ref(false)
const drawerFilterCount = computed(() => {
  let c = 0
  if (fState.value) c++
  if (fLender.value) c++
  if (fEpc.value) c++
  return c
})

// ─── KPI strip — surveys only, window + floating combined ──
// Every tile is a drill toggle: clicking filters the sections below to
// that slice; clicking again (or the clear chip) restores everything.
type KpiKey = '' | 'window' | 'submitted' | 'overdue' | 'cancelled' | 'paid' | 'upcoming' | 'unassigned'
const activeKpi = ref<KpiKey>('')
function onDrill(key: string) {
  activeKpi.value = activeKpi.value === key ? '' : key as KpiKey
}

// Standard app-wide KPI tile format (docs/ui-component-specs.md, canonical
// implementation: ProjectsView.vue top strip). color = big number,
// bar = 3px accent strip. The sub names each tile's time scope: the
// first three follow the selected window; the floating three are the
// CURRENT backlog regardless of window.
const tiles = computed(() => {
  const w = filteredWindowCards.value
  const submitted = w.filter(t => t.status === 'submitted').length
  const overdue = w.filter(t => t.status === 'overdue').length
  const cancelled = w.filter(t => t.status === 'cancelled').length
  const wl = windowLabel.value
  return [
    { key: 'window',     label: 'Surveys',         value: windowLoading.value ? '—' : w.length, sub: wl, color: 'text-blue-600', bar: 'bg-blue-500' },
    { key: 'submitted',  label: 'Submitted',       value: windowLoading.value ? '—' : submitted, sub: wl, color: 'text-emerald-600', bar: 'bg-emerald-500' },
    { key: 'overdue',    label: 'Overdue',         value: windowLoading.value ? '—' : overdue, sub: wl, color: 'text-red-600', bar: 'bg-red-500' },
    { key: 'cancelled',  label: 'Cancelled',       value: windowLoading.value ? '—' : cancelled, sub: wl, color: 'text-rose-600', bar: 'bg-rose-500' },
    // Deal still not in Projects, split by whether the survey already
    // happened (paid for) or is only booked (coming up).
    { key: 'paid',       label: 'SS Comp Not Sub', value: floatingLoading.value ? '—' : paidDeals.value.length, sub: 'current', color: 'text-orange-600', bar: 'bg-orange-500' },
    { key: 'upcoming',   label: 'Future Not Sub',  value: floatingLoading.value ? '—' : upcomingDeals.value.length, sub: 'current', color: 'text-amber-600', bar: 'bg-amber-400' },
    { key: 'unassigned', label: 'Unassigned',      value: floatingLoading.value ? '—' : unassignedCards.value.length, sub: 'current', color: 'text-violet-600', bar: 'bg-violet-500' },
  ]
})
const activeTileLabel = computed(() => tiles.value.find(t => t.key === activeKpi.value)?.label ?? '')

// Which sections/slices each drill key reveals.
const showWindowSection = computed(() => ['', 'window', 'submitted', 'overdue', 'cancelled'].includes(activeKpi.value))
const shownWindowCards = computed(() => {
  if (activeKpi.value === 'submitted') return filteredWindowCards.value.filter(t => t.status === 'submitted')
  if (activeKpi.value === 'overdue') return filteredWindowCards.value.filter(t => t.status === 'overdue')
  if (activeKpi.value === 'cancelled') return filteredWindowCards.value.filter(t => t.status === 'cancelled')
  return filteredWindowCards.value
})
const showPaidGroup = computed(() => activeKpi.value === '' || activeKpi.value === 'paid')
const showUpcomingGroup = computed(() => activeKpi.value === '' || activeKpi.value === 'upcoming')
const showDealsSection = computed(() =>
  (showPaidGroup.value && paidCards.value.length > 0)
  || (showUpcomingGroup.value && upcomingCards.value.length > 0)
  || (activeKpi.value === '' && hiddenDealCards.value.length > 0))
const shownDealCount = computed(() =>
  (showPaidGroup.value ? paidDeals.value.length : 0) + (showUpcomingGroup.value ? upcomingDeals.value.length : 0))
const shownDealCardCount = computed(() =>
  (showPaidGroup.value ? paidCards.value.length : 0) + (showUpcomingGroup.value ? upcomingCards.value.length : 0))
const showUnassignedSection = computed(() => activeKpi.value === '' || activeKpi.value === 'unassigned')
const showExtras = computed(() => activeKpi.value === '')   // zero-task row + hidden toggles

// ─── Bump-outs ──
// Every card opens a right-side peek first: QB-linked tasks get the
// standard ProjectDetailDialog (same as Feed / Funding / Design), tasks
// with no QB project get the lighter DealPeekSheet (closer / office /
// press-on context). Full /projects/<rid> view stays one tap away
// inside the project dialog.
interface PeekProject { record_id: number; customer_name: string; [k: string]: unknown }
const peekProject = ref<PeekProject | null>(null)
const peekLoadingId = ref<string | null>(null)
const peekCard = ref<SurveyCard | null>(null)

async function onCardOpen(card: SurveyCard) {
  if (!card.project_rid) { peekCard.value = card; return }
  if (peekLoadingId.value === card.project_rid) return
  peekLoadingId.value = card.project_rid
  try {
    const res = await fetch(`/api/projects/${card.project_rid}`, { headers: hdrs() })
    if (!res.ok) return
    const data = await res.json()
    if (data.project?.record_id) peekProject.value = data.project as PeekProject
  } catch { /* peek is best-effort */ } finally {
    peekLoadingId.value = null
  }
}
</script>

<template>
  <MilestoneShell title="Site Survey" :show-freshness="false">
    <template #header-actions>
      <span v-if="floating" class="hidden sm:inline text-[10px] text-muted-foreground">as of {{ timeAgo(floating.fetchedAt) }}</span>
    </template>

    <template #filters>
      <div class="grid gap-1.5">
        <div class="flex items-center gap-2 min-w-0">
          <div class="flex gap-1 items-center overflow-x-auto no-scrollbar min-w-0 flex-1">
            <button
              v-for="p in PRESETS"
              :key="p.k"
              type="button"
              class="px-2 py-0.5 rounded-full text-[9px] font-semibold border whitespace-nowrap shrink-0 cursor-pointer transition-colors"
              :class="preset === p.k
                ? 'bg-foreground text-background border-foreground'
                : 'bg-card border-border text-muted-foreground hover:text-foreground'"
              @click="preset = p.k"
            >{{ p.l }}</button>
            <template v-if="preset === 'custom'">
              <input
                v-model="customFrom"
                type="date"
                class="h-6 px-1.5 rounded-md border bg-card text-[11px] text-foreground shrink-0"
                aria-label="From date"
              />
              <span class="text-[10px] text-muted-foreground shrink-0">→</span>
              <input
                v-model="customTo"
                type="date"
                class="h-6 px-1.5 rounded-md border bg-card text-[11px] text-foreground shrink-0"
                aria-label="To date"
              />
            </template>
          </div>
          <button
            type="button"
            class="relative inline-flex items-center justify-center rounded-md border size-6 shrink-0 transition-colors cursor-pointer"
            :class="showDrawer ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'"
            title="Filters"
            @click="showDrawer = !showDrawer"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
            <span v-if="drawerFilterCount > 0" class="absolute -top-1 -right-1 size-3.5 rounded-full bg-red-500 text-white text-[8px] flex items-center justify-center font-bold">{{ drawerFilterCount }}</span>
          </button>
        </div>
        <div v-if="showDrawer" class="rounded-xl border bg-card p-3">
          <MilestoneFilterBar
            :filters="filterDefs"
            @update="onFilterUpdate"
            @reset="resetFilters"
          />
        </div>
      </div>
    </template>

    <template #kpis>
      <div class="grid gap-1.5">
        <!-- Standard KPI strip — markup mirrors ProjectsView.vue top strip.
             Label block reserves two lines so bars + numbers align across
             tiles regardless of label length. -->
        <div class="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1">
          <button
            v-for="t in tiles"
            :key="t.key"
            type="button"
            class="flex-none rounded-xl px-3 py-2 w-[105px] sm:w-[115px] text-left transition-all active:scale-[0.97]"
            :class="activeKpi === t.key ? 'bg-card shadow-md' : 'bg-card/60 hover:bg-card'"
            @click="onDrill(t.key)"
          >
            <div class="h-[3px] rounded-full -mt-0.5 mb-1" :class="t.bar" />
            <p class="text-[9px] sm:text-[10px] font-semibold uppercase tracking-wider text-muted-foreground leading-tight min-h-[23px] sm:min-h-[25px]">{{ t.label }}</p>
            <p class="mt-0.5 flex items-baseline gap-1 min-w-0">
              <span class="text-lg sm:text-xl font-extrabold tabular-nums leading-none" :class="t.color">{{ t.value }}</span>
              <span v-if="t.sub" class="text-[10px] font-semibold text-muted-foreground truncate">{{ t.sub }}</span>
            </p>
          </button>
        </div>
        <button
          v-if="activeKpi"
          type="button"
          class="justify-self-start inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-foreground text-background text-[10px] font-semibold cursor-pointer"
          @click="activeKpi = ''"
        >
          Filtered: {{ activeTileLabel }}
          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>
        </button>
      </div>
    </template>

    <!-- ─── Survey tasks in the selected window ─── -->
    <section v-if="showWindowSection" class="grid gap-2">
      <div class="flex items-baseline justify-between gap-2">
        <h2 class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          Survey Tasks · {{ windowLabel }}<template v-if="activeKpi === 'submitted'"> · Submitted</template><template v-else-if="activeKpi === 'overdue'"> · Overdue</template><template v-else-if="activeKpi === 'cancelled'"> · Cancelled</template>
        </h2>
        <span class="text-[11px] text-muted-foreground tabular-nums">{{ windowLoading ? '' : shownWindowCards.length }}</span>
      </div>
      <div v-if="preset === 'custom' && !(customFrom && customTo)" class="rounded-lg bg-card px-4 py-4 text-center text-[12px] text-slate-500" style="box-shadow: 0 1px 2px rgba(15,23,42,0.04);">
        Pick a from and to date above.
      </div>
      <div v-else-if="windowLoading" class="grid gap-2">
        <div v-for="i in 3" :key="i" class="rounded-xl bg-card h-20 animate-pulse" style="box-shadow: 0 1px 2px rgba(15,23,42,0.04);" />
      </div>
      <div v-else-if="windowError" class="rounded-xl bg-rose-50 px-4 py-3 text-[13px] text-rose-700">
        {{ windowError }}
        <button type="button" class="ml-2 underline font-medium cursor-pointer" @click="loadWindow">Retry</button>
      </div>
      <div v-else-if="!shownWindowCards.length" class="rounded-lg bg-card px-4 py-4 text-center text-[12px] text-slate-500" style="box-shadow: 0 1px 2px rgba(15,23,42,0.04);">
        No {{ activeKpi === 'submitted' ? 'submitted surveys' : activeKpi === 'overdue' ? 'overdue surveys' : activeKpi === 'cancelled' ? 'cancelled surveys' : 'surveys' }} in this window{{ fState || fLender || fEpc ? ' with these filters' : '' }}.
      </div>
      <div v-else class="grid grid-cols-1 lg:grid-cols-2 gap-1.5 min-w-0">
        <SurveyTaskCard v-for="t in shownWindowCards" :key="t.rid" :task="t" @open="onCardOpen(t)" />
      </div>
    </section>

    <!-- ─── Floating surveys ─── -->
    <div v-if="floatingLoading" class="grid gap-2">
      <div v-for="i in 2" :key="i" class="rounded-xl bg-card h-24 animate-pulse" style="box-shadow: 0 1px 2px rgba(15,23,42,0.04);" />
    </div>
    <div v-else-if="floatingError" class="rounded-xl bg-rose-50 px-4 py-3 text-[13px] text-rose-700">
      {{ floatingError }}
      <button type="button" class="ml-2 underline font-medium cursor-pointer" @click="loadFloating()">Retry</button>
    </div>

    <template v-else-if="floating">
      <!-- Signed, no QB project yet, with survey tasks -->
      <section v-if="showDealsSection" class="grid gap-2">
        <div class="flex items-baseline justify-between gap-2">
          <h2 class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Signed · No QB Project</h2>
          <span class="text-[11px] text-muted-foreground tabular-nums">{{ shownDealCount }} deals · {{ shownDealCardCount }} surveys</span>
        </div>
        <template v-if="showPaidGroup && paidCards.length">
          <p class="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span class="size-1.5 rounded-full bg-orange-500" aria-hidden="true" />
            SS complete · no QB project ({{ paidDeals.length }})
          </p>
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-1.5 min-w-0">
            <SurveyTaskCard v-for="t in paidCards" :key="t.rid" :task="t" @open="onCardOpen(t)" />
          </div>
        </template>
        <template v-if="showUpcomingGroup && upcomingCards.length">
          <p class="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground" :class="showPaidGroup && paidCards.length ? 'mt-1' : ''">
            <span class="size-1.5 rounded-full bg-amber-400" aria-hidden="true" />
            Future surveys · no QB project ({{ upcomingDeals.length }})
          </p>
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-1.5 min-w-0">
            <SurveyTaskCard v-for="t in upcomingCards" :key="t.rid" :task="t" @open="onCardOpen(t)" />
          </div>
        </template>
        <template v-if="showExtras">
          <div v-if="showHidden && hiddenDealCards.length" class="grid grid-cols-1 lg:grid-cols-2 gap-1.5 min-w-0">
            <SurveyTaskCard v-for="t in hiddenDealCards" :key="t.rid" :task="t" class="opacity-50" @open="onCardOpen(t)" />
          </div>
          <button
            v-if="hiddenDealCards.length"
            type="button"
            class="justify-self-start text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            @click="showHidden = !showHidden"
          >{{ showHidden ? 'Hide' : 'Show' }} {{ hiddenDealCards.length }} test-looking {{ hiddenDealCards.length === 1 ? 'deal' : 'deals' }}</button>
        </template>
      </section>

      <!-- Signed deals with no field tasks yet (collapsed) -->
      <section v-if="showExtras && floating.zeroTaskDeals.length">
        <button
          type="button"
          class="w-full text-left rounded-lg bg-card px-2.5 py-1.5 text-[12px] text-slate-600 hover:text-slate-900 transition-colors cursor-pointer"
          style="box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 1px 0 rgba(15,23,42,0.03);"
          @click="showZeroTaskDeals = !showZeroTaskDeals"
        >
          <span class="inline-block transition-transform" :class="showZeroTaskDeals ? 'rotate-90' : ''">▸</span>
          {{ floating.zeroTaskDeals.length }} signed deals with no field tasks yet
        </button>
        <div
          v-if="showZeroTaskDeals"
          class="mt-1 rounded-lg bg-card px-2.5 py-1 max-h-72 overflow-y-auto divide-y divide-slate-100"
          style="box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 1px 0 rgba(15,23,42,0.03);"
        >
          <div
            v-for="d in floating.zeroTaskDeals"
            :key="d.enerflo_deal_id"
            class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 py-1 min-w-0"
          >
            <span class="text-[12px] font-medium text-slate-800 truncate min-w-0">{{ d.customer_name || '—' }}</span>
            <span v-if="d.state" class="px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600 text-[10px] shrink-0">{{ d.state }}</span>
            <span v-if="d.system_size_kw" class="text-[11px] text-slate-500 tabular-nums shrink-0">{{ d.system_size_kw }} kW</span>
            <span class="text-[11px] text-slate-400 shrink-0">Signed {{ fmtDateFull(d.signed_at) }}</span>
            <a
              v-if="d.deal_url" :href="d.deal_url" target="_blank" rel="noopener"
              class="ml-auto shrink-0 text-slate-400 hover:text-slate-600"
              :aria-label="`Open Enerflo deal for ${d.customer_name || 'customer'}`"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
            </a>
          </div>
        </div>
      </section>

      <!-- Unassigned survey tasks -->
      <section v-if="showUnassignedSection && (unassignedCards.length || hiddenUnassignedCards.length)" class="grid gap-2">
        <div class="flex items-baseline justify-between gap-2">
          <h2 class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Unassigned Surveys · No Project, No Matched Deal</h2>
          <span class="text-[11px] text-muted-foreground tabular-nums">{{ unassignedCards.length }}</span>
        </div>
        <div v-if="unassignedCards.length" class="grid grid-cols-1 lg:grid-cols-2 gap-1.5 min-w-0">
          <SurveyTaskCard v-for="t in unassignedCards" :key="t.rid" :task="t" @open="onCardOpen(t)" />
        </div>
        <p v-else class="text-[12px] text-slate-500">
          Nothing current — all remaining unassigned surveys are test records or older than 90 days.
        </p>
        <div v-if="showHidden && hiddenUnassignedCards.length" class="grid grid-cols-1 lg:grid-cols-2 gap-1.5 min-w-0">
          <SurveyTaskCard v-for="t in hiddenUnassignedCards" :key="t.rid" :task="t" class="opacity-50" @open="onCardOpen(t)" />
        </div>
        <button
          v-if="hiddenUnassignedCards.length"
          type="button"
          class="justify-self-start text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          @click="showHidden = !showHidden"
        >{{ showHidden ? 'Hide' : 'Show' }} {{ hiddenUnassignedCards.length }} hidden (test / older than 90 days)</button>
      </section>
    </template>

    <!-- Bump-outs: standard project peek for QB-linked tasks, deal peek
         for floating ones. -->
    <ProjectDetailDialog
      :project="peekProject"
      @update:open="(v: boolean) => { if (!v) peekProject = null }"
    />
    <DealPeekSheet
      :card="peekCard"
      @update:open="(v: boolean) => { if (!v) peekCard = null }"
    />
  </MilestoneShell>
</template>

<style scoped>
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
.no-scrollbar::-webkit-scrollbar { display: none; }
</style>
