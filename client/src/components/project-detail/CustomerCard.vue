<script setup lang="ts">
import { computed } from 'vue'
import ProjectStatusBadge from './ProjectStatusBadge.vue'
import FundingChips from './FundingChips.vue'

interface Project {
  record_id: number
  customer_name: string
  customer_address: string
  phone: string | null
  email: string | null
  status: string
  // surfaced inline
  system_size_kw?: number | null
  utility_company?: string | null
  ahj_name?: string | null
  coordinator?: string | null
  lender?: string | null
  daysInStatus?: number | null
  // ── Funding (NTP / M1 / M2 / M3) — passed straight through to FundingChips
  lender_loan_id?: string | null
  ntp_submitted?: string | null
  ntp_approved?: string | null
  m1_status?: string | null
  m1_requested_date?: string | null
  m1_rejected_date?: string | null
  m1_approved_date?: string | null
  m1_deposit_date?: string | null
  m1_net_received?: number | null
  m2_status?: string | null
  m2_requested_date?: string | null
  m2_rejected_date?: string | null
  m2_approved_date?: string | null
  m2_deposit_date?: string | null
  m2_net_received?: number | null
  m3_status?: string | null
  m3_requested_date?: string | null
  m3_rejected_date?: string | null
  m3_approved_date?: string | null
  m3_deposit_date?: string | null
  m3_net_received?: number | null
  install_scheduled?: string | null
  dca_status?: string | null
  dca_timer_start?: string | null
  dca_calc_type?: string | null
  dca_expected_deposit?: string | null
  dca_actual_deposit?: string | null
  dca_total_received?: number | null
  // Integrations
  google_drive_link?: string | null
  project_number?: number | null  // Project ID# (Kin's customer-facing number, drives Enerflo URL)
  max_arrivy_task_id?: number | null
}

const props = defineProps<{
  p: Project
  starred?: boolean
}>()

const emit = defineEmits<{
  toggleStar: []
  text: []
}>()

const phoneHref = computed(() => props.p.phone ? `tel:${String(props.p.phone).replace(/[^\d+]/g, '')}` : '')
const mailHref = computed(() => props.p.email ? `mailto:${props.p.email}` : '')
const mapHref = computed(() => {
  const a = props.p.customer_address || ''
  return a ? `https://maps.google.com/?q=${encodeURIComponent(a)}` : ''
})
const qbHref = computed(() => `https://kin.quickbase.com/db/br9kwm8na?a=dr&rid=${props.p.record_id}`)
const driveHref = computed(() => props.p.google_drive_link || '')
const enerfloHref = computed(() => props.p.project_number ? `https://enerflo.io/installs/${props.p.project_number}` : '')
const arrivyHref = computed(() => props.p.max_arrivy_task_id ? `https://app.arrivy.com/tasks/${props.p.max_arrivy_task_id}` : '')

const utilityShort = computed(() => {
  const s = props.p.utility_company ?? ''
  const m = s.match(/\(([^)]+)\)/)
  return m?.[1] ?? s
})

// Lender link mapping — same brands as the QB Status Bar formula
const lenderLink = computed(() => {
  const n = (props.p.lender ?? '').toLowerCase()
  if (!n) return null
  if (n.includes('lightreach') || n.includes('palmetto')) return { href: 'https://palmetto.finance/', label: 'Palmetto' }
  if (n.includes('goodleap')) return { href: 'https://origin.goodleap.com/', label: 'GoodLeap' }
  if (n.includes('skylight')) return { href: 'https://installer.skylightlending.com/', label: 'Skylight' }
  return null
})
const isTPO = computed(() => /lightreach|goodleap \(tpo\)/i.test(props.p.lender ?? ''))
</script>

<template>
  <header
    class="bg-white rounded-2xl overflow-hidden"
    style="box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 1px 0 rgba(15,23,42,0.03);"
  >
    <!-- Row 1: Customer name + integration icons · Status -->
    <div class="flex items-center justify-between gap-3 px-4 sm:px-5 py-3">
      <div class="flex items-center gap-2.5 min-w-0 flex-1">
        <button
          type="button"
          class="text-[18px] leading-none transition-transform hover:scale-110 cursor-pointer shrink-0"
          :class="starred ? 'text-amber-400' : 'text-slate-300'"
          :aria-label="starred ? 'Unstar project' : 'Star project'"
          @click="emit('toggleStar')"
        >{{ starred ? '★' : '☆' }}</button>

        <h1 class="text-[18px] sm:text-[20px] font-semibold text-slate-900 leading-tight truncate">
          {{ p.customer_name || '—' }}
        </h1>

        <!-- Integration icon strip — small, pipe-separated, mirrors QB Status Bar.
             Only renders icons whose data is present so the row never has dead links. -->
        <div class="flex items-center gap-1.5 ml-1 shrink-0 text-slate-400">
          <a
            v-if="qbHref"
            :href="qbHref"
            target="_blank"
            rel="noopener"
            class="size-6 rounded-md flex items-center justify-center hover:text-slate-900 hover:bg-slate-100 transition-colors cursor-pointer"
            title="Open in Quickbase"
            aria-label="Open in Quickbase"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M14 4H20V10M20 4L10 14M19 14V19C19 19.6 18.6 20 18 20H5C4.4 20 4 19.6 4 19V6C4 5.4 4.4 5 5 5H10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </a>
          <span v-if="driveHref || enerfloHref || arrivyHref" class="text-slate-200" aria-hidden="true">|</span>
          <a
            v-if="driveHref"
            :href="driveHref"
            target="_blank"
            rel="noopener"
            class="size-6 rounded-md flex items-center justify-center hover:text-emerald-600 hover:bg-emerald-50 transition-colors cursor-pointer"
            title="Open Google Drive folder"
            aria-label="Open Google Drive"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M8 4L4 12L8 20H16L20 12L16 4H8Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M8 4L12 12L16 4M4 12H20M16 20L12 12L8 20" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>
          </a>
          <span v-if="driveHref && (enerfloHref || arrivyHref)" class="text-slate-200" aria-hidden="true">|</span>
          <a
            v-if="enerfloHref"
            :href="enerfloHref"
            target="_blank"
            rel="noopener"
            class="size-6 rounded-md flex items-center justify-center hover:text-orange-600 hover:bg-orange-50 transition-colors cursor-pointer"
            title="Open in Enerflo"
            aria-label="Open in Enerflo"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M3 12L12 4L21 12L12 20L3 12Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9 12L12 9L15 12L12 15L9 12Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>
          </a>
          <span v-if="enerfloHref && arrivyHref" class="text-slate-200" aria-hidden="true">|</span>
          <a
            v-if="arrivyHref"
            :href="arrivyHref"
            target="_blank"
            rel="noopener"
            class="size-6 rounded-md flex items-center justify-center hover:text-blue-600 hover:bg-blue-50 transition-colors cursor-pointer"
            title="Open in Arrivy"
            aria-label="Open in Arrivy"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M3 9H21M8 3V7M16 3V7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
          </a>
        </div>
      </div>

      <div class="flex items-center gap-2 shrink-0">
        <ProjectStatusBadge :status="p.status" dot />
        <span v-if="p.daysInStatus != null && p.daysInStatus > 0" class="text-[10.5px] text-slate-400 tabular-nums">({{ p.daysInStatus }}d)</span>
      </div>
    </div>

    <!-- Row 2: Address + contact pill row (always visible, high contrast) -->
    <div class="px-4 sm:px-5 py-2.5 border-t border-slate-100">
      <a
        :href="mapHref || undefined"
        target="_blank"
        rel="noopener"
        class="flex items-center gap-1.5 text-[13px] text-slate-600 hover:text-slate-900 transition-colors min-w-0 mb-2.5"
        :class="mapHref ? 'cursor-pointer' : 'pointer-events-none'"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" class="text-slate-400 shrink-0">
          <path d="M12 22S5 14 5 9C5 5.1 8.1 2 12 2C15.9 2 19 5.1 19 9C19 14 12 22 12 22Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
          <circle cx="12" cy="9" r="2.5" stroke="currentColor" stroke-width="1.6"/>
        </svg>
        <span class="truncate">{{ p.customer_address || '—' }}</span>
      </a>

      <!-- Contact pill row — high contrast, always visible. Customer-facing
           contact methods only; internal-tool links live in the icon strip
           up by the customer name. -->
      <div class="grid grid-cols-4 gap-1.5">
        <a :href="phoneHref || undefined"
           class="h-8 rounded-md text-[11px] font-medium flex items-center justify-center gap-1 transition-colors"
           :class="phoneHref ? 'bg-slate-100 text-slate-700 hover:bg-emerald-100 hover:text-emerald-700 cursor-pointer' : 'bg-slate-100/60 text-slate-300 pointer-events-none'"
           :title="p.phone ? `Call ${p.phone}` : 'No phone on file'">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M5 4H9L11 9L8.5 10.5C9.6 12.7 11.3 14.4 13.5 15.5L15 13L20 15V19C20 19.6 19.6 20 19 20C12.4 20 4 11.6 4 5C4 4.4 4.4 4 5 4Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>
          Call
        </a>
        <button type="button"
                class="h-8 rounded-md text-[11px] font-medium flex items-center justify-center gap-1 transition-colors"
                :class="p.phone ? 'bg-slate-100 text-slate-700 hover:bg-blue-100 hover:text-blue-700 cursor-pointer' : 'bg-slate-100/60 text-slate-300 pointer-events-none'"
                :disabled="!p.phone"
                @click="emit('text')"
                :title="p.phone ? `Text ${p.phone}` : 'No phone on file'">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M5 4H19C20.1 4 21 4.9 21 6V15C21 16.1 20.1 17 19 17H8L4 21V6C4 4.9 4.9 4 5 4Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>
          Text
        </button>
        <a :href="mailHref || undefined"
           class="h-8 rounded-md text-[11px] font-medium flex items-center justify-center gap-1 transition-colors"
           :class="mailHref ? 'bg-slate-100 text-slate-700 hover:bg-amber-100 hover:text-amber-700 cursor-pointer' : 'bg-slate-100/60 text-slate-300 pointer-events-none'"
           :title="p.email ? `Email ${p.email}` : 'No email on file'">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="3" y="6" width="18" height="13" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M3 8L12 14L21 8" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>
          Email
        </a>
        <a :href="mapHref || undefined" target="_blank" rel="noopener"
           class="h-8 rounded-md text-[11px] font-medium flex items-center justify-center gap-1 transition-colors"
           :class="mapHref ? 'bg-slate-100 text-slate-700 hover:bg-rose-100 hover:text-rose-700 cursor-pointer' : 'bg-slate-100/60 text-slate-300 pointer-events-none'"
           title="Open in Google Maps">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M12 22S5 14 5 9C5 5.1 8.1 2 12 2C15.9 2 19 5.1 19 9C19 14 12 22 12 22Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="9" r="2.5" stroke="currentColor" stroke-width="1.7"/></svg>
          Map
        </a>
      </div>
    </div>

    <!-- Row 3: Financing — own row with lender link + TPO badge + funding chips (NTP/M1/M2/M3) -->
    <div v-if="p.lender" class="flex items-center gap-2 flex-wrap px-4 sm:px-5 py-2 border-t border-slate-100 bg-slate-50/40">
      <div class="text-[10px] font-medium text-slate-500 uppercase tracking-wider shrink-0">Financing</div>
      <a
        v-if="lenderLink"
        :href="lenderLink.href"
        target="_blank"
        rel="noopener"
        class="text-[13px] text-teal-700 hover:underline cursor-pointer truncate flex items-center gap-1"
        :title="`Open ${lenderLink.label} portal`"
      >
        {{ p.lender }}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" class="text-teal-700 shrink-0">
          <path d="M14 4H20V10M20 4L10 14M19 14V19C19 19.6 18.6 20 18 20H5C4.4 20 4 19.6 4 19V6C4 5.4 4.4 5 5 5H10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </a>
      <span v-else class="text-[13px] text-slate-700 truncate">{{ p.lender }}</span>
      <span v-if="isTPO" class="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-rose-100 text-rose-700">TPO</span>
      <div class="flex-1 min-w-0" />
      <FundingChips :p="p" />
    </div>

    <!-- Row 4: Specs strip — System Size · Utility · AHJ · Coordinator (mobile-friendly) -->
    <div class="grid grid-cols-2 sm:grid-cols-4 bg-slate-100/70 border-t border-slate-200">
      <div class="px-3 sm:px-5 py-2 sm:border-r border-slate-200">
        <div class="text-[10px] font-medium text-slate-500 uppercase tracking-wider leading-none">System</div>
        <div class="text-[12px] text-slate-800 mt-1 truncate" :title="p.system_size_kw ? `${p.system_size_kw} kW` : ''">
          {{ p.system_size_kw ? `${p.system_size_kw} kW` : '—' }}
        </div>
      </div>
      <div class="px-3 sm:px-5 py-2 border-l sm:border-l-0 sm:border-r border-slate-200">
        <div class="text-[10px] font-medium text-slate-500 uppercase tracking-wider leading-none">Coordinator</div>
        <div class="text-[12px] text-slate-800 mt-1 truncate" :title="p.coordinator ?? ''">
          {{ p.coordinator || '—' }}
        </div>
      </div>
      <div class="px-3 sm:px-5 py-2 border-t sm:border-t-0 sm:border-r border-slate-200">
        <div class="text-[10px] font-medium text-slate-500 uppercase tracking-wider leading-none">Utility</div>
        <div class="text-[12px] text-slate-800 mt-1 truncate" :title="p.utility_company ?? ''">
          {{ utilityShort || '—' }}
        </div>
      </div>
      <div class="px-3 sm:px-5 py-2 border-t border-l sm:border-t-0 sm:border-l-0 border-slate-200">
        <div class="text-[10px] font-medium text-slate-500 uppercase tracking-wider leading-none">AHJ</div>
        <div class="text-[12px] text-slate-800 mt-1 truncate" :title="p.ahj_name ?? ''">
          {{ p.ahj_name || '—' }}
        </div>
      </div>
    </div>
  </header>
</template>
