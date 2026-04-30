<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'

// Direct port of the QB Retention Dashboard "Formatted Card" formula
// (context-files/Retention/retention-card-sample). Renders inside
// MilestoneDetail when the Retention step is selected. Multiple retention
// rows surface as a stacked list, newest first.

interface Props { projectRid: number }
const props = defineProps<Props>()

interface Retention {
  record_id: number
  project_rid: number
  date_created: string | null
  cancel_requested_by: string | null
  cancel_request_at: string | null
  cancel_note: string | null
  cancel_reason: string | null
  official_requested_date: string | null
  is_ror: number
  request_status: string | null
  recent_attempt_note: string | null
  total_outreaches: number | null
  successful_contacts: number | null
  attempted_contacts: number | null
  attempts_since_last_contact: number | null
  last_outreach_at: string | null
  last_contact_at: string | null
  next_outreach_due: string | null
  resolution_type: string | null
  resolved_at: string | null
  closeout_cancel_reason: string | null
  resolution_note: string | null
  cancel_fee: number | null
  cancel_fee_adjustment: number | null
  waive_cancel_fee: number
  pre_cancel_status: string | null
  max_project_progress: string | null
}

const auth = useAuthStore()
const items = ref<Retention[]>([])
const loading = ref(true)
const errorMsg = ref('')

async function load() {
  loading.value = true
  errorMsg.value = ''
  try {
    const res = await fetch(`/api/retention?project_id=${props.projectRid}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    items.value = (data.items as Retention[]) ?? []
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(() => props.projectRid, load)

function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
function fmtDateTime(s: string | null | undefined): string {
  if (!s) return '—'
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}
const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
function fmtMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return moneyFmt.format(n)
}

// ── Visual rules (mirroring the QB formula) ──
//   New Request  → blue
//   Working      → amber
//   Saved        → green
//   Cancelled    → rose
function statusPill(r: Retention): { bg: string; fg: string; label: string } {
  const s = (r.request_status ?? '').toLowerCase()
  if (s.includes('new request'))  return { bg: 'bg-sky-100',     fg: 'text-sky-700',     label: r.request_status ?? 'New Request' }
  if (s.includes('working'))      return { bg: 'bg-amber-100',   fg: 'text-amber-800',   label: r.request_status ?? 'Working' }
  if (s.includes('saved'))        return { bg: 'bg-emerald-100', fg: 'text-emerald-700', label: r.request_status ?? 'Saved' }
  if (s.includes('cancel'))       return { bg: 'bg-rose-100',    fg: 'text-rose-700',    label: r.request_status ?? 'Cancelled' }
  return { bg: 'bg-slate-100', fg: 'text-slate-600', label: r.request_status || '—' }
}

function isCloseout(r: Retention): boolean { return !!r.resolved_at }
function reasonBlockClass(r: Retention): string {
  if (!isCloseout(r)) return 'bg-amber-50 text-amber-800'
  const t = (r.resolution_type ?? '').toLowerCase()
  if (t === 'cancel') return 'bg-rose-50 text-rose-800'
  if (t.includes('saved')) return 'bg-emerald-50 text-emerald-800'
  return 'bg-amber-50 text-amber-800'
}
function resolvedColor(r: Retention): string {
  const t = (r.resolution_type ?? '').toLowerCase()
  if (t === 'cancel') return 'text-rose-700'
  if (t.includes('saved')) return 'text-emerald-700'
  return 'text-slate-700'
}
function leftRailColor(r: Retention): string {
  if (!isCloseout(r)) return 'border-l-slate-300'
  const t = (r.resolution_type ?? '').toLowerCase()
  if (t === 'cancel') return 'border-l-rose-500'
  if (t.includes('saved')) return 'border-l-emerald-500'
  return 'border-l-slate-300'
}
</script>

<template>
  <div>
    <div v-if="loading" class="text-[12px] text-slate-400">Loading retention…</div>
    <div v-else-if="errorMsg" class="text-[12px] text-rose-600">{{ errorMsg }}</div>
    <div v-else-if="!items.length" class="text-[12px] text-slate-400">No retention activity on this project.</div>

    <div v-else class="flex flex-col gap-3">
      <article
        v-for="r in items"
        :key="r.record_id"
        class="rounded-lg bg-white ring-1 ring-slate-200 shadow-sm border-l-[4px] px-3 py-3"
        :class="leftRailColor(r)"
      >
        <!-- Header: title + status pill -->
        <div class="flex items-start justify-between gap-2 mb-2">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="text-[13px] font-semibold text-slate-900">
                Retention #{{ r.record_id }}
              </span>
              <span v-if="r.is_ror" class="text-[10px] uppercase tracking-wider px-1.5 py-px rounded bg-violet-100 text-violet-700 font-medium">ROR</span>
            </div>
            <div v-if="r.max_project_progress || r.pre_cancel_status" class="text-[11px] text-slate-500 mt-0.5">
              <span v-if="r.max_project_progress">{{ r.max_project_progress }}</span>
              <template v-if="r.max_project_progress && r.pre_cancel_status"> · </template>
              <span v-if="r.pre_cancel_status">Pre-cancel: {{ r.pre_cancel_status }}</span>
            </div>
          </div>
          <span
            class="inline-flex items-center px-2 py-[2px] rounded text-[10px] font-medium uppercase tracking-wider whitespace-nowrap shrink-0"
            :class="[statusPill(r).bg, statusPill(r).fg]"
          >{{ statusPill(r).label }}</span>
        </div>

        <!-- Requested / Resolved one-liner -->
        <div class="text-[11px] text-slate-600 leading-snug mb-2">
          <span class="text-slate-400">Requested:</span> {{ fmtDate(r.cancel_request_at || r.official_requested_date) }}
          <template v-if="r.cancel_requested_by">
            <span class="text-slate-400"> by</span> {{ r.cancel_requested_by }}
          </template>
          <template v-if="isCloseout(r)">
            <span class="text-slate-400"> · Resolved:</span>
            <span class="ml-1 font-medium" :class="resolvedColor(r)">{{ fmtDateTime(r.resolved_at) }}</span>
          </template>
        </div>

        <!-- Reason / Resolution banner -->
        <div
          class="rounded text-[11px] font-medium px-2.5 py-1.5 mb-2"
          :class="reasonBlockClass(r)"
        >
          <template v-if="isCloseout(r)">
            Resolution: {{ r.resolution_type || '—' }}
            <template v-if="r.closeout_cancel_reason">
              <span class="opacity-60"> · Reason:</span> {{ r.closeout_cancel_reason }}
            </template>
          </template>
          <template v-else>
            Reason: {{ r.cancel_reason || '—' }}
          </template>
        </div>

        <!-- Note block (resolution note when resolved, cancel note otherwise) -->
        <div v-if="(isCloseout(r) ? r.resolution_note : r.cancel_note) || !r.recent_attempt_note">
          <div class="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
            {{ isCloseout(r) ? 'Resolution note' : 'Cancel note' }}
          </div>
          <div class="bg-slate-50 rounded px-2.5 py-1.5 text-[11.5px] text-slate-700 leading-relaxed max-h-24 overflow-y-auto whitespace-pre-line">
            {{ (isCloseout(r) ? r.resolution_note : r.cancel_note) || '—' }}
          </div>
        </div>

        <hr class="border-0 border-t border-slate-100 my-2" />

        <!-- Outreach summary -->
        <div class="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
          {{ isCloseout(r) ? 'Outreach summary' : 'Outreach activity' }}
        </div>
        <dl class="text-[12px]">
          <div class="flex items-baseline justify-between py-px">
            <dt class="text-slate-500">Total outreaches</dt>
            <dd class="text-slate-800 font-medium tabular-nums">{{ r.total_outreaches ?? 0 }}</dd>
          </div>
          <div class="flex items-baseline justify-between py-px">
            <dt class="text-slate-500">Successful contacts</dt>
            <dd
              class="font-medium tabular-nums"
              :class="(r.successful_contacts ?? 0) > 0 ? 'text-emerald-700' : 'text-slate-800'"
            >{{ r.successful_contacts ?? 0 }}</dd>
          </div>
          <template v-if="!isCloseout(r)">
            <div class="flex items-baseline justify-between py-px">
              <dt class="text-slate-500">Attempted (no contact)</dt>
              <dd class="text-slate-800 font-medium tabular-nums">{{ r.attempted_contacts ?? 0 }}</dd>
            </div>
            <div class="flex items-baseline justify-between py-px">
              <dt class="text-slate-500">Attempts since last contact</dt>
              <dd class="text-slate-800 font-medium tabular-nums">
                {{ (r.attempts_since_last_contact ?? 0) > 0 ? r.attempts_since_last_contact : '—' }}
              </dd>
            </div>
            <div v-if="r.last_outreach_at" class="flex items-baseline justify-between py-px">
              <dt class="text-slate-500">Last outreach</dt>
              <dd class="text-slate-800 font-medium tabular-nums">{{ fmtDateTime(r.last_outreach_at) }}</dd>
            </div>
            <div v-if="r.last_contact_at" class="flex items-baseline justify-between py-px">
              <dt class="text-slate-500">Last contact</dt>
              <dd class="text-slate-800 font-medium tabular-nums">{{ fmtDateTime(r.last_contact_at) }}</dd>
            </div>
            <div v-if="r.next_outreach_due" class="flex items-baseline justify-between py-px">
              <dt class="text-slate-500">Next outreach due</dt>
              <dd class="text-slate-800 font-medium tabular-nums">{{ fmtDateTime(r.next_outreach_due) }}</dd>
            </div>
          </template>
        </dl>

        <!-- Cancel fee surfacing — only when there's something to show -->
        <template v-if="r.cancel_fee != null || r.waive_cancel_fee">
          <hr class="border-0 border-t border-slate-100 my-2" />
          <dl class="text-[12px]">
            <div v-if="r.cancel_fee != null" class="flex items-baseline justify-between py-px">
              <dt class="text-slate-500">Cancel fee</dt>
              <dd class="text-slate-800 font-medium tabular-nums">{{ fmtMoney(r.cancel_fee) }}</dd>
            </div>
            <div v-if="r.cancel_fee_adjustment != null && r.cancel_fee_adjustment !== 0" class="flex items-baseline justify-between py-px">
              <dt class="text-slate-500">Adjustment</dt>
              <dd class="text-slate-800 font-medium tabular-nums">{{ fmtMoney(r.cancel_fee_adjustment) }}</dd>
            </div>
            <div v-if="r.waive_cancel_fee" class="flex items-baseline justify-between py-px">
              <dt class="text-slate-500">Waived</dt>
              <dd class="text-emerald-700 font-medium">Yes</dd>
            </div>
          </dl>
        </template>
      </article>
    </div>
  </div>
</template>
