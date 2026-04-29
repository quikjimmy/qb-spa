<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'

interface BreakdownProject {
  record_id: number
  customer_name?: string | null
  system_size_kw?: number | null
  sales_office?: string | null
  closer?: string | null
  setter?: string | null
  area_director?: string | null
  coordinator?: string | null
  utility_company?: string | null
  ahj_name?: string | null
  lender?: string | null
  state?: string | null
  sales_date?: string | null
  epc?: string | null
  // Equipment
  estimated_production?: number | null
  module_brand?: string | null
  module?: string | null
  panel_count?: number | null
  inverter_brand?: string | null
  inverter?: string | null
  inverter_count?: number | null
  existing_system?: string | null
  // Costs
  system_price?: number | null
  gross_ppw?: number | null
  dealer_fees_pct?: number | null
  dealer_fee_ppw?: number | null
  net_cost?: number | null
  net_ppw?: number | null
  // Finance
  finance_term?: string | null
  finance_rate?: string | null
  credit_expiration_date?: string | null
}

const props = defineProps<{ p: BreakdownProject }>()
const auth = useAuthStore()

const open = ref<Record<string, boolean>>({
  snapshot: true,
  team: false,
  financing: true,
  equipment: false,
  costs: false,
  adders: false,
  rebates: false,
})

function toggle(key: string) {
  open.value[key] = !open.value[key]
}

function fmtDate(s?: string | null): string {
  if (!s) return '—'
  const d = new Date(s.length === 10 ? `${s}T00:00:00` : s)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
function fmtMoney(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return moneyFmt.format(n)
}
function fmtPpw(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `$${n.toFixed(2)}/W`
}
function fmtPct(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${n}%`
}
function fmtNum(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US')
}

const lenderLink = computed(() => {
  const n = (props.p.lender ?? '').toLowerCase()
  if (n.includes('lightreach') || n.includes('palmetto')) return { href: 'https://palmetto.finance/', label: 'Palmetto Finance' }
  if (n.includes('goodleap')) return { href: 'https://origin.goodleap.com/', label: 'GoodLeap' }
  if (n.includes('skylight')) return { href: 'https://installer.skylightlending.com/', label: 'Skylight' }
  return null
})

const utilityShort = computed(() => {
  const s = props.p.utility_company ?? ''
  const m = s.match(/\(([^)]+)\)/)
  return m?.[1] ?? s
})

interface Row { label: string; value: string | null | undefined }
function rows(items: Array<Row>): Array<Row> { return items.filter(r => !!r.value && r.value !== '—') }

// ── Adders (fetched lazily; needed for Costs math + own section) ──
interface Adder { record_id: number; product_name: string; total_cost: number | null }
const adders = ref<Adder[]>([])
const addersLoaded = ref(false)
const addersLoading = ref(false)
const addersTotal = ref<number>(0)

async function loadAdders() {
  if (addersLoading.value) return
  addersLoading.value = true
  try {
    const res = await fetch(`/api/adders?project_id=${props.p.record_id}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    if (!res.ok) return
    const data = await res.json() as { items: Adder[]; total_cost: number }
    adders.value = data.items ?? []
    addersTotal.value = data.total_cost ?? 0
    addersLoaded.value = true
  } finally {
    addersLoading.value = false
  }
}
watch(() => open.value['adders'], (isOpen) => { if (isOpen && !addersLoaded.value) loadAdders() })
onMounted(() => { loadAdders() })

// ── Equipment summary header line ──
const moduleLine = computed(() => {
  const parts = [props.p.module_brand, props.p.module].filter(Boolean) as string[]
  return parts.join(' · ')
})
const inverterLine = computed(() => {
  const parts = [props.p.inverter_brand, props.p.inverter].filter(Boolean) as string[]
  return parts.join(' · ')
})
const equipmentHeader = computed(() => {
  const parts = [props.p.module_brand, props.p.inverter_brand].filter(Boolean) as string[]
  return parts.join(' · ')
})

// ── Costs math (drives both header summary and the line items) ──
const kw = computed(() => Number(props.p.system_size_kw ?? 0))
const grossCostV = computed(() => props.p.system_price ?? null)
const grossPpwV = computed(() => props.p.gross_ppw ?? null)
const dealerFeesV = computed<number | null>(() => {
  // Prefer dealer_fee_ppw × kW if we have it; else system_price × dealer_fees_pct/100
  if (props.p.dealer_fee_ppw != null && kw.value > 0) return props.p.dealer_fee_ppw * kw.value * 1000
  if (props.p.dealer_fees_pct != null && props.p.system_price != null) {
    return props.p.system_price * (props.p.dealer_fees_pct / 100)
  }
  return null
})
const dealerFeesPpwV = computed(() => props.p.dealer_fee_ppw ?? null)
const dealerFeesPctLabel = computed(() => {
  if (props.p.dealer_fees_pct == null) return ''
  return ` (${fmtPct(props.p.dealer_fees_pct)})`
})
const netCostV = computed(() => props.p.net_cost ?? null)
const netPpwV = computed(() => props.p.net_ppw ?? null)
const addersTotalV = computed<number>(() => addersTotal.value || 0)
const addersPpwV = computed<number | null>(() => {
  if (kw.value <= 0) return null
  return addersTotalV.value / (kw.value * 1000)
})
// Net Cost w/Adders = bare Net Cost + Adders Total (matches Install Tracker screenshot)
const netCostWithAddersV = computed<number | null>(() => {
  if (netCostV.value == null && addersTotalV.value === 0) return null
  return (netCostV.value ?? 0) + addersTotalV.value
})
const netCostWithAddersPpwV = computed<number | null>(() => {
  if (netCostWithAddersV.value == null || kw.value <= 0) return null
  return netCostWithAddersV.value / (kw.value * 1000)
})

const hasEquipment = computed(() => !!(props.p.module || props.p.inverter || props.p.panel_count || props.p.estimated_production))
const hasFinanceTerms = computed(() => !!(props.p.finance_term || props.p.finance_rate || props.p.credit_expiration_date))
</script>

<template>
  <div
    class="bg-white rounded-2xl overflow-hidden"
    style="box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 1px 0 rgba(15,23,42,0.03);"
  >
    <!-- Card title -->
    <div class="flex items-center gap-2 px-4 pt-3.5 pb-2.5">
      <div class="text-[11px] font-medium text-slate-500 tracking-[0.08em] uppercase">Deal Breakdown</div>
      <div class="flex-1" />
      <div class="text-[13px] text-slate-700 tabular-nums">
        <span v-if="p.system_size_kw">{{ p.system_size_kw }} kW</span>
      </div>
    </div>

    <!-- ─── Snapshot ─── -->
    <button
      type="button"
      class="w-full flex items-center gap-3 px-4 py-2 hover:bg-slate-50 transition-colors cursor-pointer border-t border-slate-100 text-left"
      :aria-expanded="open.snapshot"
      @click="toggle('snapshot')"
    >
      <span class="text-[13px] text-slate-700 font-medium shrink-0">Snapshot</span>
      <span class="text-[12px] text-slate-500 truncate">
        {{ p.system_size_kw ? `${p.system_size_kw} kW` : '' }}
        <template v-if="p.estimated_production"> · {{ fmtNum(p.estimated_production) }} kWh/yr</template>
      </span>
      <span class="ml-auto text-slate-400 text-xs shrink-0">{{ open.snapshot ? '▾' : '▸' }}</span>
    </button>
    <div v-if="open.snapshot" class="px-4 pb-3">
      <dl class="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-[12.5px] text-left">
        <template v-for="r in rows([
          { label: 'System Size', value: p.system_size_kw ? `${p.system_size_kw} kW` : null },
          { label: 'Est. Prod.',  value: p.estimated_production ? `${fmtNum(p.estimated_production)} kWh/yr` : null },
          { label: 'Sale Date',   value: fmtDate(p.sales_date) },
          { label: 'Utility',     value: utilityShort },
          { label: 'AHJ',         value: p.ahj_name },
          { label: 'State',       value: p.state },
          { label: 'EPC',         value: p.epc },
        ])" :key="r.label">
          <dt class="text-slate-500">{{ r.label }}</dt>
          <dd class="text-slate-800 truncate" :title="r.value ?? ''">{{ r.value }}</dd>
        </template>
      </dl>
    </div>

    <!-- ─── Team ─── -->
    <button
      type="button"
      class="w-full flex items-center gap-3 px-4 py-2 hover:bg-slate-50 transition-colors cursor-pointer border-t border-slate-100 text-left"
      :aria-expanded="open.team"
      @click="toggle('team')"
    >
      <span class="text-[13px] text-slate-700 font-medium shrink-0">Team</span>
      <span class="text-[12px] text-slate-500 truncate">{{ p.coordinator || '—' }}</span>
      <span class="ml-auto text-slate-400 text-xs shrink-0">{{ open.team ? '▾' : '▸' }}</span>
    </button>
    <div v-if="open.team" class="px-4 pb-3">
      <dl class="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-[12.5px] text-left">
        <template v-for="r in rows([
          { label: 'Coordinator',   value: p.coordinator },
          { label: 'Closer',        value: p.closer },
          { label: 'Setter',        value: p.setter },
          { label: 'Area Director', value: p.area_director },
          { label: 'Sales Office',  value: p.sales_office },
        ])" :key="r.label">
          <dt class="text-slate-500">{{ r.label }}</dt>
          <dd class="text-slate-800 truncate" :title="r.value ?? ''">{{ r.value }}</dd>
        </template>
      </dl>
    </div>

    <!-- ─── Financing ─── -->
    <button
      type="button"
      class="w-full flex items-center gap-3 px-4 py-2 hover:bg-slate-50 transition-colors cursor-pointer border-t border-slate-100 text-left"
      :aria-expanded="open.financing"
      @click="toggle('financing')"
    >
      <span class="text-[13px] text-slate-700 font-medium shrink-0">Financing</span>
      <span class="text-[12px] text-slate-500 truncate">{{ p.lender || '—' }}</span>
      <span class="ml-auto text-slate-400 text-xs shrink-0">{{ open.financing ? '▾' : '▸' }}</span>
    </button>
    <div v-if="open.financing" class="px-4 pb-3">
      <dl class="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-[12.5px] text-left">
        <dt class="text-slate-500">Lender</dt>
        <dd class="text-slate-800 truncate flex items-center gap-1.5">
          <a
            v-if="lenderLink"
            :href="lenderLink.href"
            target="_blank"
            rel="noopener"
            class="text-teal-700 hover:underline cursor-pointer truncate"
            :title="`Open ${lenderLink.label} portal`"
          >{{ p.lender }}</a>
          <span v-else class="truncate">{{ p.lender || '—' }}</span>
          <svg v-if="lenderLink" width="11" height="11" viewBox="0 0 24 24" fill="none" class="text-teal-700 shrink-0">
            <path d="M14 4H20V10M20 4L10 14M19 14V19C19 19.6 18.6 20 18 20H5C4.4 20 4 19.6 4 19V6C4 5.4 4.4 5 5 5H10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </dd>
        <template v-if="hasFinanceTerms">
          <template v-if="p.finance_term">
            <dt class="text-slate-500">Term</dt>
            <dd class="text-slate-800">{{ p.finance_term }}{{ /^\d+$/.test(String(p.finance_term)) ? ' yr' : '' }}</dd>
          </template>
          <template v-if="p.finance_rate">
            <dt class="text-slate-500">Rate</dt>
            <dd class="text-slate-800">{{ p.finance_rate }}{{ /^[\d.]+$/.test(String(p.finance_rate)) ? '%' : '' }}</dd>
          </template>
          <template v-if="p.credit_expiration_date">
            <dt class="text-slate-500">Credit exp.</dt>
            <dd class="text-slate-800">{{ fmtDate(p.credit_expiration_date) }}</dd>
          </template>
        </template>
      </dl>
      <div v-if="!hasFinanceTerms" class="mt-2 text-[11px] text-slate-400">
        Term, rate &amp; credit expiration not on file.
      </div>
    </div>

    <!-- ─── Equipment ─── -->
    <button
      type="button"
      class="w-full flex items-center gap-3 px-4 py-2 hover:bg-slate-50 transition-colors cursor-pointer border-t border-slate-100 text-left"
      :aria-expanded="open.equipment"
      @click="toggle('equipment')"
    >
      <span class="text-[13px] text-slate-700 font-medium shrink-0">Equipment</span>
      <span class="text-[12px] text-slate-500 truncate">{{ equipmentHeader || '—' }}</span>
      <span class="ml-auto text-slate-400 text-xs shrink-0">{{ open.equipment ? '▾' : '▸' }}</span>
    </button>
    <div v-if="open.equipment" class="px-4 pb-3">
      <dl class="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-[12.5px] text-left">
        <template v-if="moduleLine || p.panel_count">
          <dt class="text-slate-500">Module</dt>
          <dd class="text-slate-800 truncate" :title="moduleLine">
            {{ moduleLine || '—' }}
            <span v-if="p.panel_count" class="text-slate-500"> · ×{{ p.panel_count }}</span>
          </dd>
        </template>
        <template v-if="inverterLine || p.inverter_count">
          <dt class="text-slate-500">Inverter</dt>
          <dd class="text-slate-800 truncate" :title="inverterLine">
            {{ inverterLine || '—' }}
            <span v-if="p.inverter_count" class="text-slate-500"> · ×{{ p.inverter_count }}</span>
          </dd>
        </template>
        <template v-if="p.estimated_production">
          <dt class="text-slate-500">Est. Prod.</dt>
          <dd class="text-slate-800 tabular-nums">{{ fmtNum(p.estimated_production) }} kWh/yr</dd>
        </template>
        <template v-if="p.existing_system">
          <dt class="text-slate-500">Existing</dt>
          <dd class="text-slate-800 truncate" :title="p.existing_system">{{ p.existing_system }}</dd>
        </template>
      </dl>
      <div v-if="!hasEquipment" class="text-[11px] text-slate-400">No equipment data on file.</div>
    </div>

    <!-- ─── Costs ─── -->
    <button
      type="button"
      class="w-full flex items-center gap-3 px-4 py-2 hover:bg-slate-50 transition-colors cursor-pointer border-t border-slate-100 text-left"
      :aria-expanded="open.costs"
      @click="toggle('costs')"
    >
      <span class="text-[13px] text-slate-700 font-medium shrink-0">Costs</span>
      <span class="text-[12px] text-slate-500 truncate tabular-nums">{{ netPpwV != null ? fmtPpw(netPpwV) : '—' }}</span>
      <span class="ml-auto text-slate-400 text-xs shrink-0">{{ open.costs ? '▾' : '▸' }}</span>
    </button>
    <div v-if="open.costs" class="px-4 pb-3">
      <ul class="space-y-1.5 text-[12.5px] text-left">
        <li class="flex items-baseline gap-2">
          <span class="text-slate-500 flex-1">Gross Cost</span>
          <span class="text-slate-800 tabular-nums">{{ fmtMoney(grossCostV) }}</span>
          <span class="text-slate-400 tabular-nums w-[78px] text-right">· {{ fmtPpw(grossPpwV) }}</span>
        </li>
        <li class="flex items-baseline gap-2">
          <span class="text-slate-500 flex-1">Dealer Fees<span class="text-slate-400">{{ dealerFeesPctLabel }}</span></span>
          <span class="text-slate-800 tabular-nums">{{ fmtMoney(dealerFeesV) }}</span>
          <span class="text-slate-400 tabular-nums w-[78px] text-right">· {{ fmtPpw(dealerFeesPpwV) }}</span>
        </li>
        <li class="flex items-baseline gap-2">
          <span class="text-slate-500 flex-1">Net Cost w/Adders</span>
          <span class="text-slate-800 tabular-nums">{{ fmtMoney(netCostWithAddersV) }}</span>
          <span class="text-slate-400 tabular-nums w-[78px] text-right">· {{ fmtPpw(netCostWithAddersPpwV) }}</span>
        </li>
        <li class="flex items-baseline gap-2">
          <span class="text-slate-500 flex-1">Adders Ttl</span>
          <span class="text-slate-800 tabular-nums">{{ fmtMoney(addersTotalV) }}</span>
          <span class="text-slate-400 tabular-nums w-[78px] text-right">· {{ fmtPpw(addersPpwV) }}</span>
        </li>
        <li class="flex items-baseline gap-2 pt-1.5 mt-1 border-t border-slate-100">
          <span class="text-slate-700 flex-1 font-medium">Net Cost</span>
          <span class="text-slate-900 font-medium tabular-nums">{{ fmtMoney(netCostV) }}</span>
          <span class="text-slate-500 tabular-nums w-[78px] text-right">· {{ fmtPpw(netPpwV) }}</span>
        </li>
      </ul>
    </div>

    <!-- ─── Adders ─── -->
    <button
      type="button"
      class="w-full flex items-center gap-3 px-4 py-2 hover:bg-slate-50 transition-colors cursor-pointer border-t border-slate-100 text-left"
      :aria-expanded="open.adders"
      @click="toggle('adders')"
    >
      <span class="text-[13px] text-slate-700 font-medium shrink-0">Adders</span>
      <span class="text-[12px] text-slate-500 truncate tabular-nums">
        <template v-if="adders.length > 0">{{ adders.length }} · {{ fmtMoney(addersTotal) }}</template>
        <template v-else>—</template>
      </span>
      <span class="ml-auto text-slate-400 text-xs shrink-0">{{ open.adders ? '▾' : '▸' }}</span>
    </button>
    <div v-if="open.adders" class="px-4 pb-3">
      <div v-if="addersLoading" class="text-[12px] text-slate-400">Loading…</div>
      <ul v-else-if="adders.length" class="space-y-1.5">
        <li v-for="a in adders" :key="a.record_id" class="flex items-baseline gap-3 text-[12.5px]">
          <span class="text-slate-700 truncate flex-1" :title="a.product_name">{{ a.product_name || `Adder #${a.record_id}` }}</span>
          <span class="text-slate-800 tabular-nums shrink-0">{{ fmtMoney(a.total_cost) }}</span>
        </li>
        <li class="flex items-baseline gap-3 text-[12.5px] pt-1.5 mt-1.5 border-t border-slate-100">
          <span class="text-slate-500 flex-1">Total</span>
          <span class="text-slate-900 font-medium tabular-nums shrink-0">{{ fmtMoney(addersTotal) }}</span>
        </li>
      </ul>
      <div v-else class="text-[11px] text-slate-400">No adders on this project.</div>
    </div>

    <!-- ─── Rebates ─── -->
    <button
      type="button"
      class="w-full flex items-center gap-3 px-4 py-2 hover:bg-slate-50 transition-colors cursor-pointer border-t border-slate-100 text-left"
      :aria-expanded="open.rebates"
      @click="toggle('rebates')"
    >
      <span class="text-[13px] text-slate-700 font-medium shrink-0">Rebates</span>
      <span class="text-[12px] text-slate-400 truncate">—</span>
      <span class="ml-auto text-slate-400 text-xs shrink-0">{{ open.rebates ? '▾' : '▸' }}</span>
    </button>
    <div v-if="open.rebates" class="px-4 pb-3 text-[12px] text-slate-400">
      Rebate fields not yet wired.
    </div>
  </div>
</template>
