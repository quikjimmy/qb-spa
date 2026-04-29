<script setup lang="ts">
import { computed } from 'vue'

// Mirror of QB Status Bar formula colors:
//   clawback (net received < 0)               → purple
//   status contains RECEIVED or FULLY FUNDED  → green
//   status contains REJECTED                  → red
//   status contains APPROVED                  → orange
//   status contains PENDING                   → blue/info
//   else                                      → gray (not started)
//
// NTP is special — there's no status text; color comes from dates only.

interface FundingProject {
  lender?: string | null
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
  // DCA — surfaced as a 5th chip when there's a status to show
  dca_status?: string | null
  dca_timer_start?: string | null
  dca_expected_amount?: number | null
  dca_calc_type?: string | null
  dca_expected_deposit?: string | null
  dca_actual_deposit?: string | null
  dca_total_received?: number | null
}

const props = defineProps<{ p: FundingProject }>()

type Tier = 'green' | 'orange' | 'blue' | 'red' | 'purple' | 'gray'

interface Chip {
  id: 'ntp' | 'm1' | 'm2' | 'm3' | 'dca'
  label: string
  tier: Tier
  // Tooltip rows, label → value
  tip: Array<{ k: string; v: string }>
  tipTitle: string
  href?: string  // optional click-through
  clawback: boolean
}

const tierClass: Record<Tier, string> = {
  green:  'bg-emerald-600 text-white',
  orange: 'bg-amber-500  text-white',
  blue:   'bg-sky-500    text-white',
  red:    'bg-rose-600   text-white',
  purple: 'bg-violet-600 text-white',
  gray:   'bg-slate-200  text-slate-500',
}

function has(v: string | null | undefined): boolean {
  return !!(v && String(v).trim() !== '' && v !== '0')
}

function fmt(v: string | null | undefined): string {
  if (!has(v)) return '—'
  const d = new Date(String(v).length === 10 ? `${v}T00:00:00` : String(v))
  if (isNaN(d.getTime())) return String(v)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function colorForStatus(status: string | null | undefined, netReceived?: number | null): Tier {
  if ((netReceived ?? 0) < 0) return 'purple'
  const s = (status ?? '').toUpperCase()
  if (!s) return 'gray'
  if (s.includes('RECEIVED') || s.includes('FULLY FUNDED')) return 'green'
  if (s.includes('REJECTED')) return 'red'
  if (s.includes('APPROVED')) return 'orange'
  if (s.includes('PENDING')) return 'blue'
  return 'gray'
}

const ntpChip = computed<Chip>(() => {
  const p = props.p
  const tier: Tier = has(p.ntp_approved) ? 'green' : has(p.ntp_submitted) ? 'blue' : 'gray'
  const titleStateLabel = has(p.ntp_approved) ? 'NTP Approved' : has(p.ntp_submitted) ? 'NTP Submitted' : 'NTP Not Started'
  return {
    id: 'ntp', label: 'NTP', tier,
    tipTitle: titleStateLabel,
    tip: [
      { k: 'Submitted', v: fmt(p.ntp_submitted) },
      { k: 'Approved',  v: fmt(p.ntp_approved) },
    ],
    clawback: false,
  }
})

function buildMilestoneChip(
  id: 'm1' | 'm2' | 'm3',
  label: 'M1' | 'M2' | 'M3',
  status: string | null | undefined,
  requested: string | null | undefined,
  rejected: string | null | undefined,
  approved: string | null | undefined,
  deposit: string | null | undefined,
  netReceived: number | null | undefined,
  href: string | undefined,
): Chip {
  const clawback = (netReceived ?? 0) < 0
  return {
    id, label,
    tier: colorForStatus(status, netReceived),
    tipTitle: clawback ? '⚠ Clawback' : (status || `${label} Not Started`),
    tip: [
      { k: 'Status',    v: status || '—' },
      { k: 'Requested', v: fmt(requested) },
      { k: 'Rejected',  v: fmt(rejected) },
      { k: 'Approved',  v: fmt(approved) },
      { k: 'Deposited', v: fmt(deposit) },
    ],
    href,
    clawback,
  }
}

const isLightReach = computed(() => /lightreach/i.test(props.p.lender ?? ''))

const m1Chip = computed<Chip>(() => buildMilestoneChip(
  'm1', 'M1',
  props.p.m1_status, props.p.m1_requested_date, props.p.m1_rejected_date,
  props.p.m1_approved_date, props.p.m1_deposit_date, props.p.m1_net_received,
  undefined,
))

// QB code: M2 chip is clickable for LightReach when there's a loan ID and the chip isn't gray.
const m2Chip = computed<Chip>(() => {
  const c = buildMilestoneChip(
    'm2', 'M2',
    props.p.m2_status, props.p.m2_requested_date, props.p.m2_rejected_date,
    props.p.m2_approved_date, props.p.m2_deposit_date, props.p.m2_net_received,
    undefined,
  )
  if (isLightReach.value && props.p.lender_loan_id && c.tier !== 'gray') {
    c.href = `https://palmetto.finance/accounts/${encodeURIComponent(props.p.lender_loan_id)}/installation-package/edit`
  }
  return c
})

const m3Chip = computed<Chip>(() => buildMilestoneChip(
  'm3', 'M3',
  props.p.m3_status, props.p.m3_requested_date, props.p.m3_rejected_date,
  props.p.m3_approved_date, props.p.m3_deposit_date, props.p.m3_net_received,
  undefined,
))

// DCA = ancillary funding event (Distributor / Contractor Cash Advance, etc.).
// Same color rules as M-chips but no Requested/Rejected/Approved trio — just
// timer-start, expected vs actual deposit, total received.
const dcaChip = computed<Chip>(() => {
  const totalReceived = props.p.dca_total_received ?? 0
  const clawback = totalReceived < 0
  const tier = colorForStatus(props.p.dca_status, props.p.dca_total_received)
  return {
    id: 'dca', label: 'DCA',
    tier,
    tipTitle: clawback ? '⚠ DCA Clawback' : (props.p.dca_status || 'DCA Not Started'),
    tip: [
      { k: 'Status',    v: props.p.dca_status || '—' },
      { k: 'Calc type', v: props.p.dca_calc_type || '—' },
      { k: 'Started',   v: fmt(props.p.dca_timer_start) },
      { k: 'Expected',  v: fmt(props.p.dca_expected_deposit) },
      { k: 'Deposited', v: fmt(props.p.dca_actual_deposit) },
    ],
    clawback,
  }
})

// Show DCA only when there's a signal — otherwise the 5th gray chip is noise
const dcaVisible = computed(() => {
  const p = props.p
  return !!(p.dca_status || p.dca_timer_start || p.dca_actual_deposit || (p.dca_total_received ?? 0) !== 0)
})

const chips = computed<Chip[]>(() => {
  const base: Chip[] = [ntpChip.value, m1Chip.value, m2Chip.value, m3Chip.value]
  if (dcaVisible.value) base.push(dcaChip.value)
  return base
})

// Whole strip is hidden if there's nothing to show
const visible = computed(() => {
  // QB convention: show once any M1 status exists OR install is scheduled.
  if (props.p.m1_status) return true
  if (has(props.p.install_scheduled)) return true
  if (has(props.p.ntp_submitted) || has(props.p.ntp_approved)) return true
  return false
})

function tipText(c: Chip): string {
  const head = c.tipTitle
  const lines = c.tip.map(t => `${t.k}: ${t.v}`).join('\n')
  return `${head}\n──────────\n${lines}`
}
</script>

<template>
  <div v-if="visible" class="flex items-center gap-1.5 flex-wrap">
    <template v-for="c in chips" :key="c.id">
      <a
        v-if="c.href"
        :href="c.href"
        target="_blank"
        rel="noopener"
        :title="tipText(c)"
        class="inline-flex items-center gap-1 px-2 py-[2px] rounded text-[10.5px] font-semibold tracking-wide cursor-pointer hover:opacity-90 transition-opacity"
        :class="tierClass[c.tier]"
      >
        <span v-if="c.clawback" aria-hidden="true">⚠</span>
        {{ c.label }}
      </a>
      <span
        v-else
        :title="tipText(c)"
        class="inline-flex items-center gap-1 px-2 py-[2px] rounded text-[10.5px] font-semibold tracking-wide"
        :class="tierClass[c.tier]"
      >
        <span v-if="c.clawback" aria-hidden="true">⚠</span>
        {{ c.label }}
      </span>
    </template>
  </div>
</template>
