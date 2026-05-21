import { Router, type Request, type Response } from 'express'
import db from '../db'

const router = Router()

const PERMIT_TABLE = 'bscs3z866'
const PERMIT_CACHE_TTL_MS = 60_000
const PRIMARY_SLA_TARGET = 1

let permitRowsCache: { rows: QbRecord[]; expiresAt: number } | null = null

type QbRecord = Record<string, { value: unknown }>

interface PermitRow {
  record_id: number
  permit_record_id: number
  project_rid: number | null
  customer_name: string
  customer_address?: string | null
  status?: string | null
  project_status: string
  state: string
  epc: string
  ahj_name: string
  lender?: string | null
  closer?: string | null
  coordinator?: string | null
  system_size_kw?: number | null
  permit_status: string
  ahj_required: string
  permit_user: string
  permit_runner: string
  permit_team: string
  permit_todo: string
  permit_missing_items: string
  rejection_reasons: string
  rejection_count: number
  recent_note: string
  design_completed: string
  initial_design_completed: string
  permit_sla_start: string
  permitting_start: string
  permit_submitted: string
  permit_resubmitted: string
  permit_rejected: string
  permit_paid: string
  permit_approved: string
  electrical_submitted: string
  electrical_approved: string
  zoning_submitted: string
  zoning_approved: string
  building_submitted: string
  building_approved: string
  max_submission_date: string
  max_approval_date: string
  noc_required: boolean
  noc_received: string
  noc_submitted: string
  noc_recorded: string
  revision_requested: string
  redesign_completed: string
  revision_resubmitted: string
  revision_approved: string
  follow_up_due: string
  install_completed: string
  created_at: string
  modified_at: string
  phase: string
  phase_label: string
  age_days: number
  stale: boolean
  permit_submit_sla_days: number | null
  permit_submit_sla_met: boolean | null
  permit_approval_days: number | null
  building_turnaround_days: number | null
  electrical_turnaround_days: number | null
  zoning_turnaround_days: number | null
}

interface QueueDef {
  key: string
  label: string
  description: string
  tone: 'info' | 'success' | 'warning' | 'danger' | 'teal' | 'neutral'
  predicate: (row: PermitRow) => boolean
}

function getQbConfig() {
  return {
    realm: process.env['QB_REALM_HOSTNAME'] || 'kin.quickbase.com',
    token: process.env['QB_USER_TOKEN'] || '',
  }
}

function qbHeaders(realm: string, token: string) {
  return {
    'QB-Realm-Hostname': realm,
    'Authorization': `QB-USER-TOKEN ${token}`,
    'Content-Type': 'application/json',
  }
}

function stringValue(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  if (Array.isArray(raw)) return raw.map(stringValue).filter(Boolean).join('; ')
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    if (obj['name']) return String(obj['name'])
    if (obj['email']) return String(obj['email'])
    if (obj['value']) return stringValue(obj['value'])
    return ''
  }
  return String(raw)
}

function val(record: QbRecord, fid: number): string {
  return stringValue(record[String(fid)]?.value)
}

function parseRid(v: string): number | null {
  const n = parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

function parseNum(v: string): number | null {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : null
}

function parseBool(v: string): boolean {
  return /^(true|1|yes)$/i.test(String(v || '').trim())
}

function isSet(v: string | null | undefined): boolean {
  return !!(v && v.trim() !== '' && v !== '0')
}

function cleanDate(v: string | null | undefined): string {
  if (!v) return ''
  return String(v).slice(0, 10)
}

function hasText(haystack: string | null | undefined, pattern: RegExp): boolean {
  return pattern.test(String(haystack || ''))
}

function dayDiff(today: string, start: string | null | undefined, bizFactor: number): number {
  if (!start) return 0
  const s = new Date(`${cleanDate(start)}T12:00:00Z`).getTime()
  const t = new Date(`${today}T12:00:00Z`).getTime()
  if (!Number.isFinite(s) || !Number.isFinite(t)) return 0
  return Math.max(0, Math.round(((t - s) / 86_400_000) * bizFactor))
}

function calDaysBetween(startStr: string | null | undefined, endStr: string | null | undefined): number | null {
  if (!startStr || !endStr) return null
  const start = new Date(`${cleanDate(startStr)}T00:00:00`)
  const end = new Date(`${cleanDate(endStr)}T00:00:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return null
  return Math.floor((end.getTime() - start.getTime()) / 86_400_000)
}

function bizDaysBetween(startStr: string | null | undefined, endStr: string | null | undefined): number | null {
  if (!startStr || !endStr) return null
  const start = new Date(`${cleanDate(startStr)}T00:00:00`)
  const end = new Date(`${cleanDate(endStr)}T00:00:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return null

  let count = 0
  const cur = new Date(start)
  while (cur <= end) {
    const dow = cur.getDay()
    if (dow !== 0 && dow !== 6) count += 1
    cur.setDate(cur.getDate() + 1)
  }
  return Math.max(0, count - 1)
}

function terminalProjectStatus(status: string): boolean {
  return /cancel|pending cancel|hold|complete|completed|paid|rejected|lost|arc|ror/i.test(status || '')
}

function excludedProjectStatusForPerformance(status: string): boolean {
  return /cancel|pending cancel|hold|rejected|lost|arc|ror/i.test(status || '')
}

function bucketPeriod(date: string, weekly: boolean): string {
  const d = new Date(`${cleanDate(date)}T12:00:00Z`)
  if (!Number.isFinite(d.getTime())) return ''
  if (!weekly) return cleanDate(date).slice(0, 7)
  const day = d.getUTCDay()
  const back = day === 0 ? 6 : day - 1
  d.setUTCDate(d.getUTCDate() - back)
  return d.toISOString().slice(0, 10)
}

function periodRange(period: string): { from: string; to: string } {
  if (period.length === 7) {
    const [yRaw, mRaw] = period.split('-')
    const y = Number(yRaw)
    const m = Number(mRaw)
    const last = new Date(y, m, 0).getDate()
    return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}` }
  }
  const d = new Date(`${period}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 6)
  return { from: period, to: d.toISOString().slice(0, 10) }
}

function inRange(date: string, from?: string, to?: string): boolean {
  const d = cleanDate(date)
  if (!d) return false
  if (from && d < from) return false
  if (to && d > to) return false
  return true
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function percentile(values: number[], p: number): number {
  const sorted = values.filter(n => Number.isFinite(n) && n >= 0).sort((a, b) => a - b)
  if (!sorted.length) return 0
  if (sorted.length === 1) return sorted[0]!
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo)
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : 0
}

async function fetchPermitRows(): Promise<QbRecord[]> {
  if (permitRowsCache && permitRowsCache.expiresAt > Date.now()) {
    return permitRowsCache.rows
  }

  const { realm, token } = getQbConfig()
  if (!token) throw new Error('QB_USER_TOKEN not configured')

  const select = [
    1, 2, 3, 6, 7, 8, 11, 12, 14, 16, 17, 18, 20, 23, 25, 29, 32, 61, 66,
    67, 68, 70, 76, 130, 134, 135, 137, 160, 161, 168, 169, 170, 171, 172,
    175, 180, 181, 182, 183, 195, 214, 219, 220, 221, 222, 226, 228, 233,
    234, 235, 237, 238, 239, 240, 246, 251, 258, 278, 279, 280, 285, 286, 287,
  ]
  const all: QbRecord[] = []
  let skip = 0
  const top = 1000

  while (true) {
    const res = await fetch('https://api.quickbase.com/v1/records/query', {
      method: 'POST',
      headers: qbHeaders(realm, token),
      body: JSON.stringify({
        from: PERMIT_TABLE,
        select,
        where: "({'67'.XEX.''}OR{'246'.XEX.''}OR{'14'.XEX.''}OR{'20'.XEX.''})AND{'214'.XEX.'1'}",
        sortBy: [{ fieldId: 2, order: 'DESC' }],
        options: { skip, top },
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`QuickBase permit query failed (${res.status}): ${text.slice(0, 200)}`)
    }
    const data = await res.json() as { data?: QbRecord[] }
    const records = data.data || []
    all.push(...records)
    if (records.length < top || all.length >= 10000) break
    skip += top
  }

  permitRowsCache = { rows: all, expiresAt: Date.now() + PERMIT_CACHE_TTL_MS }
  return all
}

function projectMapFor(projectIds: number[]): Map<number, Record<string, unknown>> {
  const unique = [...new Set(projectIds.filter(n => Number.isFinite(n) && n > 0))]
  const out = new Map<number, Record<string, unknown>>()
  const columns = `
    record_id, customer_name, customer_address, status, state,
    coordinator, closer, lender, epc, system_size_kw,
    sales_date, design_completed, permit_submitted, permit_approved,
    permit_rejected, install_completed, ahj_name
  `

  for (let i = 0; i < unique.length; i += 400) {
    const chunk = unique.slice(i, i + 400)
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = db.prepare(`
      SELECT ${columns}
      FROM project_cache
      WHERE record_id IN (${placeholders})
    `).all(...chunk) as Array<Record<string, unknown>>
    for (const row of rows) out.set(Number(row['record_id']), row)
  }
  return out
}

function classify(row: Omit<PermitRow, 'phase' | 'phase_label' | 'age_days' | 'stale'>, today: string, bizFactor: number): Pick<PermitRow, 'phase' | 'phase_label' | 'age_days' | 'stale'> {
  let phase = 'not_ready'
  let label = 'Not Ready'
  let anchor = row.permit_sla_start || row.design_completed || row.created_at

  if (isSet(row.permit_approved) || hasText(row.permit_todo, /permit approved/i)) {
    phase = 'complete'
    label = 'Complete'
    anchor = row.permit_approved || row.max_approval_date || row.modified_at
  } else if (/not required/i.test(row.ahj_required) && !isSet(row.permit_submitted)) {
    phase = 'not_required'
    label = 'AHJ Not Required'
  } else if (!isSet(row.permit_sla_start) && !isSet(row.design_completed) && !isSet(row.initial_design_completed)) {
    phase = 'not_ready'
    label = 'Not Ready'
  } else if (isSet(row.install_completed) && !isSet(row.permit_approved)) {
    phase = 'installed_no_permit'
    label = 'Installed, No Permit'
    anchor = row.install_completed
  } else if (isSet(row.permit_missing_items) || hasText(row.permit_todo, /pending noc|pending design revision|pending survey noc/i)) {
    phase = 'blocked'
    label = isSet(row.permit_missing_items) ? 'Blocked' : 'NOC / Design Blocked'
    anchor = row.follow_up_due || row.max_submission_date || row.permit_sla_start
  } else if (!isSet(row.permit_user) || row.permit_user === 'Unassigned') {
    phase = 'unassigned'
    label = 'Unassigned'
    anchor = row.permit_sla_start
  } else if (hasText(row.permit_todo, /submit/i) || (!isSet(row.permit_submitted) && !isSet(row.max_submission_date))) {
    phase = 'need_submit'
    label = 'Need Submit'
    anchor = row.redesign_completed || row.permit_sla_start
  } else if (isSet(row.revision_requested) && !isSet(row.revision_approved)) {
    phase = 'revision'
    label = hasText(row.permit_todo, /submit revision/i) ? 'Submit Revision' : 'Revision'
    anchor = row.redesign_completed || row.revision_requested
  } else if (isSet(row.follow_up_due) && row.follow_up_due <= today) {
    phase = 'follow_up'
    label = 'Follow Up'
    anchor = row.follow_up_due
  } else if (isSet(row.permit_submitted) || isSet(row.permit_resubmitted) || isSet(row.max_submission_date)) {
    phase = 'pending_approval'
    label = 'Pending Approval'
    anchor = row.permit_resubmitted || row.max_submission_date || row.permit_submitted
  } else {
    phase = 'ready'
    label = 'Ready'
    anchor = row.permit_sla_start
  }

  const age = phase === 'complete' || phase === 'not_required' || phase === 'not_ready' ? 0 : dayDiff(today, anchor, bizFactor)
  return { phase, phase_label: label, age_days: age, stale: phase !== 'complete' && phase !== 'not_ready' && phase !== 'not_required' && age >= 3 }
}

function normalizeRows(records: QbRecord[], today: string, bizFactor: number): PermitRow[] {
  const projectIds = records.map(r => parseRid(val(r, 23))).filter((n): n is number => n !== null)
  const projects = projectMapFor(projectIds)

  return records.map(record => {
    const projectRid = parseRid(val(record, 23))
    const project = projectRid ? projects.get(projectRid) : undefined
    const permitSubmitted = cleanDate(val(record, 14) || String(project?.['permit_submitted'] || ''))
    const permitApproved = cleanDate(val(record, 20) || String(project?.['permit_approved'] || ''))
    const permitSlaStart = cleanDate(val(record, 278) || val(record, 246) || val(record, 67) || String(project?.['design_completed'] || ''))
    const permitSubmitSlaDays = permitSlaStart ? bizDaysBetween(permitSlaStart, permitSubmitted || today) : null

    const base = {
      record_id: parseInt(val(record, 3), 10) || 0,
      permit_record_id: parseInt(val(record, 3), 10) || 0,
      project_rid: projectRid,
      customer_name: val(record, 25) || String(project?.['customer_name'] || ''),
      customer_address: String(project?.['customer_address'] || '') || null,
      status: String(project?.['status'] || val(record, 68) || val(record, 134) || '') || null,
      project_status: val(record, 68) || val(record, 134) || String(project?.['status'] || ''),
      state: val(record, 130) || String(project?.['state'] || ''),
      epc: val(record, 70) || String(project?.['epc'] || ''),
      ahj_name: val(record, 32) || val(record, 135) || val(record, 61) || String(project?.['ahj_name'] || ''),
      lender: String(project?.['lender'] || '') || null,
      closer: val(record, 76) || String(project?.['closer'] || '') || null,
      coordinator: val(record, 195) || String(project?.['coordinator'] || '') || null,
      system_size_kw: project?.['system_size_kw'] == null ? null : Number(project['system_size_kw']),
      permit_status: val(record, 6),
      ahj_required: val(record, 66),
      permit_user: val(record, 233) || val(record, 161) || val(record, 160) || 'Unassigned',
      permit_runner: val(record, 29),
      permit_team: val(record, 72),
      permit_todo: val(record, 175),
      permit_missing_items: val(record, 168),
      rejection_reasons: val(record, 280) || val(record, 287),
      rejection_count: parseInt(val(record, 285), 10) || 0,
      recent_note: val(record, 226),
      design_completed: cleanDate(val(record, 67) || String(project?.['design_completed'] || '')),
      initial_design_completed: cleanDate(val(record, 246) || val(record, 67) || String(project?.['design_completed'] || '')),
      permit_sla_start: permitSlaStart,
      permitting_start: cleanDate(val(record, 7)),
      permit_submitted: permitSubmitted,
      permit_resubmitted: cleanDate(val(record, 17)),
      permit_rejected: cleanDate(val(record, 16) || String(project?.['permit_rejected'] || '')),
      permit_paid: cleanDate(val(record, 18)),
      permit_approved: permitApproved,
      electrical_submitted: cleanDate(val(record, 169)),
      electrical_approved: cleanDate(val(record, 170)),
      zoning_submitted: cleanDate(val(record, 171)),
      zoning_approved: cleanDate(val(record, 172)),
      building_submitted: cleanDate(val(record, 180)),
      building_approved: cleanDate(val(record, 181)),
      max_submission_date: cleanDate(val(record, 182)),
      max_approval_date: cleanDate(val(record, 183)),
      noc_required: parseBool(val(record, 258)),
      noc_received: cleanDate(val(record, 8)),
      noc_submitted: cleanDate(val(record, 11)),
      noc_recorded: cleanDate(val(record, 12)),
      revision_requested: cleanDate(val(record, 235) || val(record, 219)),
      redesign_completed: cleanDate(val(record, 220)),
      revision_resubmitted: cleanDate(val(record, 221)),
      revision_approved: cleanDate(val(record, 222)),
      follow_up_due: cleanDate(val(record, 228)),
      install_completed: cleanDate(val(record, 234) || String(project?.['install_completed'] || '')),
      created_at: cleanDate(val(record, 1)),
      modified_at: cleanDate(val(record, 2)),
      permit_submit_sla_days: permitSubmitSlaDays,
      permit_submit_sla_met: permitSubmitted && permitSubmitSlaDays !== null ? permitSubmitSlaDays <= PRIMARY_SLA_TARGET : null,
      permit_approval_days: bizDaysBetween(permitSubmitted, permitApproved),
      building_turnaround_days: parseNum(val(record, 239)) ?? calDaysBetween(cleanDate(val(record, 180)), cleanDate(val(record, 181))),
      electrical_turnaround_days: parseNum(val(record, 237)) ?? calDaysBetween(cleanDate(val(record, 169)), cleanDate(val(record, 170))),
      zoning_turnaround_days: parseNum(val(record, 238)) ?? calDaysBetween(cleanDate(val(record, 171)), cleanDate(val(record, 172))),
    } satisfies Omit<PermitRow, 'phase' | 'phase_label' | 'age_days' | 'stale'>

    return { ...base, ...classify(base, today, bizFactor) }
  }).filter(row => row.record_id > 0)
}

const queues: QueueDef[] = [
  { key: 'unassigned', label: 'Unassigned', description: 'Design complete, permit owner missing', tone: 'warning', predicate: r => r.phase === 'unassigned' },
  { key: 'needSubmit', label: 'Need Submit', description: 'Ready to submit AHJ package', tone: 'danger', predicate: r => r.phase === 'need_submit' || r.phase === 'ready' },
  { key: 'pendingApproval', label: 'Pending Approval', description: 'Submitted, waiting on AHJ', tone: 'info', predicate: r => r.phase === 'pending_approval' },
  { key: 'blocked', label: 'Blocked', description: 'Missing items, NOC, or design dependency', tone: 'danger', predicate: r => r.phase === 'blocked' },
  { key: 'followUp', label: 'Follow Up', description: 'Follow-up date is due', tone: 'warning', predicate: r => r.phase === 'follow_up' },
  { key: 'revisions', label: 'Revisions', description: 'Revision requested, not approved', tone: 'teal', predicate: r => r.phase === 'revision' },
  { key: 'installedNoPermit', label: 'Installed, No Permit', description: 'Install complete before permit approval', tone: 'danger', predicate: r => r.phase === 'installed_no_permit' },
]

function activePermitRows(rows: PermitRow[]): PermitRow[] {
  return rows.filter(row => !excludedProjectStatusForPerformance(row.project_status) && (isSet(row.permit_sla_start) || isSet(row.permit_submitted) || isSet(row.permit_approved)))
}

function openPermitRows(rows: PermitRow[]): PermitRow[] {
  return activePermitRows(rows).filter(row => !terminalProjectStatus(row.project_status) && row.phase !== 'complete' && row.phase !== 'not_ready' && row.phase !== 'not_required')
}

function avgAge(rows: PermitRow[]): number {
  return rows.length ? Math.round(rows.reduce((sum, row) => sum + row.age_days, 0) / rows.length) : 0
}

function makeQueueSummary(rows: PermitRow[]) {
  return queues.map(q => {
    const items = rows.filter(q.predicate)
    return {
      key: q.key,
      label: q.label,
      description: q.description,
      tone: q.tone,
      count: items.length,
      oldest: items.reduce((m, row) => Math.max(m, row.age_days), 0),
      avgAge: avgAge(items),
      stale: items.filter(row => row.stale).length,
    }
  })
}

function slaSamples(rows: PermitRow[], from?: string, to?: string): PermitRow[] {
  return activePermitRows(rows).filter(row => {
    if (!isSet(row.permit_sla_start) || !isSet(row.permit_submitted)) return false
    if (!inRange(row.permit_submitted, from, to)) return false
    return row.permit_submit_sla_days !== null && row.permit_submit_sla_met !== null
  })
}

function openSlaMisses(rows: PermitRow[]): PermitRow[] {
  return openPermitRows(rows).filter(row => !isSet(row.permit_submitted) && row.permit_submit_sla_days !== null && row.permit_submit_sla_days > PRIMARY_SLA_TARGET)
}

function summarizeSla(rows: PermitRow[], from?: string, to?: string) {
  const samples = slaSamples(rows, from, to)
  const days = samples.map(row => Number(row.permit_submit_sla_days ?? 0))
  const met = samples.filter(row => row.permit_submit_sla_met === true).length
  const openMisses = openSlaMisses(rows)
  return {
    target: PRIMARY_SLA_TARGET,
    count: samples.length,
    met,
    misses: samples.length - met,
    pctMet: samples.length ? Math.round((met / samples.length) * 100) : 0,
    median: round1(percentile(days, 50)),
    mean: round1(mean(days)),
    p90: round1(percentile(days, 90)),
    openMisses: openMisses.length,
  }
}

function groupSlaBoxes(rows: PermitRow[], from?: string, to?: string) {
  const weekly = !!(from && to && (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000 <= 90)
  const buckets = new Map<string, { days: number[]; met: number }>()
  for (const row of slaSamples(rows, from, to)) {
    const period = bucketPeriod(row.permit_submitted, weekly)
    if (!period) continue
    let bucket = buckets.get(period)
    if (!bucket) {
      bucket = { days: [], met: 0 }
      buckets.set(period, bucket)
    }
    bucket.days.push(Number(row.permit_submit_sla_days ?? 0))
    if (row.permit_submit_sla_met) bucket.met += 1
  }
  return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, bucket]) => {
    const count = bucket.days.length
    return {
      period,
      count,
      met: bucket.met,
      misses: count - bucket.met,
      pctMet: count ? Math.round((bucket.met / count) * 100) : 0,
      target: PRIMARY_SLA_TARGET,
      p0: round1(percentile(bucket.days, 0)),
      p25: round1(percentile(bucket.days, 25)),
      p50: round1(percentile(bucket.days, 50)),
      p90: round1(percentile(bucket.days, 90)),
      p100: round1(percentile(bucket.days, 100)),
      mean: round1(mean(bucket.days)),
    }
  })
}

function groupThroughput(rows: PermitRow[], from?: string, to?: string) {
  const weekly = !!(from && to && (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000 <= 90)
  const map = new Map<string, { period: string; permitSubmitted: number; permitApproved: number; revisionsSubmitted: number; revisionsApproved: number }>()
  function ensure(period: string) {
    let row = map.get(period)
    if (!row) {
      row = { period, permitSubmitted: 0, permitApproved: 0, revisionsSubmitted: 0, revisionsApproved: 0 }
      map.set(period, row)
    }
    return row
  }

  for (const row of rows) {
    if (inRange(row.permit_submitted, from, to)) ensure(bucketPeriod(row.permit_submitted, weekly)).permitSubmitted += 1
    if (inRange(row.permit_approved, from, to)) ensure(bucketPeriod(row.permit_approved, weekly)).permitApproved += 1
    if (inRange(row.revision_resubmitted, from, to)) ensure(bucketPeriod(row.revision_resubmitted, weekly)).revisionsSubmitted += 1
    if (inRange(row.revision_approved, from, to)) ensure(bucketPeriod(row.revision_approved, weekly)).revisionsApproved += 1
  }

  return [...map.values()].filter(r => r.period).sort((a, b) => a.period.localeCompare(b.period))
}

function approvalBoxes(rows: PermitRow[], from?: string, to?: string) {
  const weekly = !!(from && to && (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000 <= 90)
  const buckets = new Map<string, number[]>()
  for (const row of rows) {
    if (!inRange(row.permit_approved, from, to) || row.permit_approval_days === null) continue
    const period = bucketPeriod(row.permit_approved, weekly)
    if (!period) continue
    const arr = buckets.get(period) ?? []
    arr.push(row.permit_approval_days)
    buckets.set(period, arr)
  }
  return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, days]) => ({
    period,
    count: days.length,
    p0: round1(percentile(days, 0)),
    p25: round1(percentile(days, 25)),
    p50: round1(percentile(days, 50)),
    p90: round1(percentile(days, 90)),
    p100: round1(percentile(days, 100)),
    mean: round1(mean(days)),
  }))
}

function agingSummary(rows: PermitRow[]) {
  const buckets = [
    { label: '0-1', min: 0, max: 1 },
    { label: '2-3', min: 2, max: 3 },
    { label: '4-7', min: 4, max: 7 },
    { label: '8-14', min: 8, max: 14 },
    { label: '15+', min: 15, max: 99999 },
  ]
  return buckets.map(bucket => {
    const items = rows.filter(row => row.age_days >= bucket.min && row.age_days <= bucket.max)
    return {
      label: bucket.label,
      count: items.length,
      needSubmit: items.filter(row => row.phase === 'need_submit' || row.phase === 'ready' || row.phase === 'unassigned').length,
      pending: items.filter(row => row.phase === 'pending_approval').length,
      blocked: items.filter(row => row.phase === 'blocked').length,
      followUp: items.filter(row => row.phase === 'follow_up').length,
      revisions: items.filter(row => row.phase === 'revision').length,
    }
  })
}

function userPivot(openRows: PermitRow[], allRows: PermitRow[], from?: string, to?: string) {
  const map = new Map<string, {
    name: string
    open: number
    need: number
    pending: number
    blocked: number
    followUp: number
    revisions: number
    stale: number
    approved: number
    slaMet: number
    slaDays: number[]
    approvalDays: number[]
    ageTotal: number
  }>()
  function ensure(name: string) {
    const key = name || 'Unassigned'
    let row = map.get(key)
    if (!row) {
      row = { name: key, open: 0, need: 0, pending: 0, blocked: 0, followUp: 0, revisions: 0, stale: 0, approved: 0, slaMet: 0, slaDays: [], approvalDays: [], ageTotal: 0 }
      map.set(key, row)
    }
    return row
  }
  for (const row of openRows) {
    const user = ensure(row.permit_user)
    user.open += 1
    user.ageTotal += row.age_days
    if (row.phase === 'need_submit' || row.phase === 'ready' || row.phase === 'unassigned') user.need += 1
    if (row.phase === 'pending_approval') user.pending += 1
    if (row.phase === 'blocked' || row.phase === 'installed_no_permit') user.blocked += 1
    if (row.phase === 'follow_up') user.followUp += 1
    if (row.phase === 'revision') user.revisions += 1
    if (row.stale) user.stale += 1
  }
  for (const row of allRows) {
    const user = ensure(row.permit_user)
    if (inRange(row.permit_approved, from, to)) user.approved += 1
    if (inRange(row.permit_submitted, from, to) && row.permit_submit_sla_days !== null && row.permit_submit_sla_met !== null) {
      user.slaDays.push(row.permit_submit_sla_days)
      if (row.permit_submit_sla_met) user.slaMet += 1
    }
    if (inRange(row.permit_approved, from, to) && row.permit_approval_days !== null) {
      user.approvalDays.push(row.permit_approval_days)
    }
  }
  return [...map.values()]
    .map(row => {
      const slaTotal = row.slaDays.length
      const approvalTotal = row.approvalDays.length
      const { slaDays, approvalDays, ...rest } = row
      return {
        ...rest,
        avgAge: row.open ? Math.round(row.ageTotal / row.open) : 0,
        slaTotal,
        slaPct: slaTotal ? Math.round((row.slaMet / slaTotal) * 100) : 0,
        slaMedian: round1(percentile(slaDays, 50)),
        approvalTotal,
        approvalMedian: round1(percentile(approvalDays, 50)),
        approvalP90: round1(percentile(approvalDays, 90)),
      }
    })
    .sort((a, b) => b.open - a.open || b.approved - a.approved)
}

function ahjPivot(openRows: PermitRow[], allRows: PermitRow[], from?: string, to?: string) {
  const map = new Map<string, { ahj: string; state: string; open: number; pending: number; blocked: number; approved: number; approvalDays: number[]; slaDays: number[]; slaMet: number }>()
  function ensure(row: PermitRow) {
    const key = row.ahj_name || 'Unassigned AHJ'
    let item = map.get(key)
    if (!item) {
      item = { ahj: key, state: row.state || '', open: 0, pending: 0, blocked: 0, approved: 0, approvalDays: [], slaDays: [], slaMet: 0 }
      map.set(key, item)
    }
    if (!item.state && row.state) item.state = row.state
    return item
  }
  for (const row of openRows) {
    const item = ensure(row)
    item.open += 1
    if (row.phase === 'pending_approval') item.pending += 1
    if (row.phase === 'blocked' || row.phase === 'installed_no_permit') item.blocked += 1
  }
  for (const row of allRows) {
    const item = ensure(row)
    if (inRange(row.permit_approved, from, to)) item.approved += 1
    if (inRange(row.permit_approved, from, to) && row.permit_approval_days !== null) item.approvalDays.push(row.permit_approval_days)
    if (inRange(row.permit_submitted, from, to) && row.permit_submit_sla_days !== null && row.permit_submit_sla_met !== null) {
      item.slaDays.push(row.permit_submit_sla_days)
      if (row.permit_submit_sla_met) item.slaMet += 1
    }
  }
  return [...map.values()]
    .map(row => {
      const slaTotal = row.slaDays.length
      const { approvalDays, slaDays, ...rest } = row
      return {
        ...rest,
        approvalMedian: round1(percentile(approvalDays, 50)),
        approvalP90: round1(percentile(approvalDays, 90)),
        approvalMean: round1(mean(approvalDays)),
        slaPct: slaTotal ? Math.round((row.slaMet / slaTotal) * 100) : 0,
        slaTotal,
      }
    })
    .filter(row => row.open || row.approved || row.slaTotal)
    .sort((a, b) => b.open - a.open || b.approved - a.approved)
    .slice(0, 80)
}

function filterRows(rows: PermitRow[], req: Request): PermitRow[] {
  const state = String(req.query['state'] || '')
  const epc = String(req.query['epc'] || '')
  const user = String(req.query['permit_user'] || '')
  const ahj = String(req.query['ahj'] || '')

  return rows.filter(row => {
    if (state && row.state !== state) return false
    if (epc && row.epc !== epc) return false
    if (user && row.permit_user !== user) return false
    if (ahj && row.ahj_name !== ahj) return false
    return true
  })
}

function optionsFrom(rows: PermitRow[]) {
  const vals = (key: keyof PermitRow) => [...new Set(rows.map(row => String(row[key] || '')).filter(Boolean))].sort()
  return {
    states: vals('state'),
    epcs: vals('epc'),
    permitUsers: vals('permit_user'),
    ahjs: vals('ahj_name'),
  }
}

function listRows(rows: PermitRow[], limit = 200) {
  return [...rows]
    .sort((a, b) => b.age_days - a.age_days || a.customer_name.localeCompare(b.customer_name))
    .slice(0, limit)
}

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const clientToday = String(req.query['today'] || '')
    const today = /^\d{4}-\d{2}-\d{2}$/.test(clientToday) ? clientToday : new Date().toISOString().slice(0, 10)
    const from = String(req.query['date_from'] || '') || undefined
    const to = String(req.query['date_to'] || '') || undefined
    const bizFactor = req.query['biz_days'] === '1' ? 5 / 7 : 1

    const rawRows = await fetchPermitRows()
    const normalized = normalizeRows(rawRows, today, bizFactor)
    const filtered = filterRows(normalized, req)
    const activeRows = activePermitRows(filtered)
    const openRows = openPermitRows(filtered)
    const completedInWindow = activeRows.filter(row => inRange(row.permit_approved, from, to))
    const submittedInWindow = activeRows.filter(row => inRange(row.permit_submitted, from, to))
    const stuck = openRows.filter(row => row.stale)
    const sla = summarizeSla(filtered, from, to)

    const lists: Record<string, PermitRow[]> = {
      open: listRows(openRows),
      stuck: listRows(stuck),
      slaMiss: listRows([
        ...slaSamples(filtered, from, to).filter(row => row.permit_submit_sla_met === false),
        ...openSlaMisses(filtered),
      ], 300),
      missingNoc: listRows(openRows.filter(row => row.noc_required && (!isSet(row.noc_received) || !isSet(row.noc_recorded))), 200),
    }
    for (const queue of queues) lists[queue.key] = listRows(openRows.filter(queue.predicate))

    const byPeriod = groupThroughput(activeRows, from, to)

    res.json({
      kpi: {
        open: openRows.length,
        stale: stuck.length,
        submitted: submittedInWindow.length,
        approved: completedInWindow.length,
        avgAge: avgAge(openRows),
        oldest: openRows.reduce((m, row) => Math.max(m, row.age_days), 0),
        sla,
        missingNoc: lists['missingNoc']?.length || 0,
        installedNoPermit: lists['installedNoPermit']?.length || 0,
      },
      queues: makeQueueSummary(openRows),
      charts: {
        throughput: byPeriod,
        aging: agingSummary(openRows),
        slaBoxes: groupSlaBoxes(filtered, from, to),
        approvalBoxes: approvalBoxes(activeRows, from, to),
      },
      pivot: {
        users: userPivot(openRows, activeRows, from, to),
        ahjs: ahjPivot(openRows, activeRows, from, to),
      },
      lists,
      filters: optionsFrom(normalized),
      meta: {
        source: 'QuickBase Permit table',
        fetchedAt: new Date().toISOString(),
        total: normalized.length,
        filtered: filtered.length,
        dateFrom: from || '',
        dateTo: to || '',
      },
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.get('/drill', async (req: Request, res: Response): Promise<void> => {
  try {
    const clientToday = String(req.query['today'] || '')
    const today = /^\d{4}-\d{2}-\d{2}$/.test(clientToday) ? clientToday : new Date().toISOString().slice(0, 10)
    const bizFactor = req.query['biz_days'] === '1' ? 5 / 7 : 1
    const rawRows = await fetchPermitRows()
    const filtered = filterRows(normalizeRows(rawRows, today, bizFactor), req)
    const openRows = openPermitRows(filtered)
    const activeRows = activePermitRows(filtered)
    const queue = String(req.query['queue'] || '')
    const period = String(req.query['period'] || '')
    const metric = String(req.query['metric'] || '')

    let rows: PermitRow[] = []
    const q = queues.find(item => item.key === queue)
    if (q) rows = openRows.filter(q.predicate)
    else if (queue === 'open') rows = openRows
    else if (queue === 'stuck') rows = openRows.filter(row => row.stale)
    else if (queue === 'slaMiss') rows = [
      ...slaSamples(filtered).filter(row => row.permit_submit_sla_met === false),
      ...openSlaMisses(filtered),
    ]
    else if (queue === 'missingNoc') rows = openRows.filter(row => row.noc_required && (!isSet(row.noc_received) || !isSet(row.noc_recorded)))
    else if (/^\d{4}-\d{2}(-\d{2})?$/.test(period)) {
      const { from, to } = periodRange(period)
      if (metric === 'permitApproved') rows = activeRows.filter(row => inRange(row.permit_approved, from, to))
      else if (metric === 'revisionSubmitted') rows = activeRows.filter(row => inRange(row.revision_resubmitted, from, to))
      else if (metric === 'revisionApproved') rows = activeRows.filter(row => inRange(row.revision_approved, from, to))
      else rows = activeRows.filter(row => inRange(row.permit_submitted, from, to))
    } else {
      rows = openRows
    }

    res.json({ projects: listRows(rows, 500), total: rows.length })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Re-export the shared QB permit fetch + lightweight value helpers so
// other routes (notably daily-goals' "Need to Submit" source) can
// piggy-back on the same 60s-cached round-trip instead of re-querying
// QuickBase from scratch.
export { fetchPermitRows, val as permitFieldValue, isSet as permitIsSet }
export type { QbRecord }

export { router as permitAnalyticsRouter }
