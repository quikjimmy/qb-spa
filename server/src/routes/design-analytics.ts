import { Router, type Request, type Response } from 'express'
import db from '../db'
import { officeTodayIso } from '../lib/officeTime'

const router = Router()

const DESIGN_TABLE = 'bsbhp6zhm'
const DESIGN_CACHE_TTL_MS = 60_000

let designRowsCache: { rows: QbRecord[]; expiresAt: number } | null = null

type QbRecord = Record<string, { value: unknown }>

interface DesignRow {
  record_id: number
  design_record_id: number
  project_rid: number | null
  customer_name: string
  customer_address?: string | null
  status?: string | null
  project_status: string
  state: string
  epc: string
  lender?: string | null
  closer?: string | null
  coordinator?: string | null
  system_size_kw?: number | null
  sales_date?: string | null
  intake_completed?: string | null
  survey_scheduled?: string | null
  survey_submitted: string
  survey_approved: string
  cad_submitted?: string | null
  design_completed?: string | null
  permit_submitted?: string | null
  permit_approved?: string | null
  nem_submitted?: string | null
  nem_approved?: string | null
  install_scheduled?: string | null
  install_completed?: string | null
  inspection_scheduled?: string | null
  inspection_passed?: string | null
  pto_submitted?: string | null
  pto_approved?: string | null
  design_type: string
  design_status: string
  cad_sla_start: string
  cad_started: string
  cad_completed: string
  cad_approved: string
  engineering_submitted: string
  engineering_completed: string
  qa_audit_completed: string
  assigned_designer: string
  requester: string
  engineering_company: string
  layout_change: string
  created_at: string
  modified_at: string
  phase: string
  phase_label: string
  age_days: number
  stale: boolean
  sla_ss_to_cad_days: number | null
  sla_cad_to_design_days: number | null
  sla_ss_to_design_days: number | null
  sla_ss_to_cad_met: boolean | null
  sla_cad_to_design_met: boolean | null
  sla_ss_to_design_met: boolean | null
}

interface QueueDef {
  key: string
  label: string
  description: string
  tone: 'info' | 'success' | 'warning' | 'danger' | 'teal' | 'neutral'
  predicate: (row: DesignRow) => boolean
}

type SlaMetricKey = 'ssToCad' | 'cadToDesign' | 'ssToDesign'
type SlaDaysField = 'sla_ss_to_cad_days' | 'sla_cad_to_design_days' | 'sla_ss_to_design_days'
type SlaMetField = 'sla_ss_to_cad_met' | 'sla_cad_to_design_met' | 'sla_ss_to_design_met'
type SlaEndField = 'cad_completed' | 'design_completed'
type DesignBaseRow = Omit<DesignRow,
  'phase' | 'phase_label' | 'age_days' | 'stale' |
  'sla_ss_to_cad_days' | 'sla_cad_to_design_days' | 'sla_ss_to_design_days' |
  'sla_ss_to_cad_met' | 'sla_cad_to_design_met' | 'sla_ss_to_design_met'
>

interface SlaDef {
  key: SlaMetricKey
  label: string
  shortLabel: string
  target: number
  daysField: SlaDaysField
  metField: SlaMetField
  endField: SlaEndField
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
  if (Array.isArray(raw)) return raw.map(stringValue).filter(Boolean).join(', ')
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

function isSet(v: string | null | undefined): boolean {
  return !!(v && v.trim() !== '' && v !== '0')
}

function cleanDate(v: string | null | undefined): string {
  if (!v) return ''
  return String(v).slice(0, 10)
}

function dayDiff(today: string, start: string | null | undefined, bizFactor: number): number {
  if (!start) return 0
  const s = new Date(`${cleanDate(start)}T12:00:00Z`).getTime()
  const t = new Date(`${today}T12:00:00Z`).getTime()
  if (!Number.isFinite(s) || !Number.isFinite(t)) return 0
  return Math.max(0, Math.round(((t - s) / 86_400_000) * bizFactor))
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
  return /cancel|hold|complete|completed|paid|rejected|lost|arc|ror/i.test(status || '')
}

function terminalDesignStatus(status: string): boolean {
  return /5-rejected|6-completed|7-void|8-cancelled|rejected|void|cancelled/i.test(status || '')
}

function excludedProjectStatusForSla(status: string): boolean {
  return /cancel|hold|rejected|lost|arc|ror/i.test(status || '')
}

function excludedDesignStatusForSla(status: string): boolean {
  return /5-rejected|7-void|8-cancelled|rejected|void|cancelled/i.test(status || '')
}

function isInitialDesign(row: Pick<DesignRow, 'design_type'>): boolean {
  return /initial design/i.test(row.design_type || '')
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

async function fetchDesignRows(): Promise<QbRecord[]> {
  if (designRowsCache && designRowsCache.expiresAt > Date.now()) {
    return designRowsCache.rows
  }

  const { realm, token } = getQbConfig()
  if (!token) throw new Error('QB_USER_TOKEN not configured')

  const select = [
    3, 9, 11, 8, 7, 72, 73, 213, 87, 88, 19, 50, 20, 33, 34, 37, 99,
    435, 439, 285, 323, 339, 326, 462, 1, 2,
  ]
  const all: QbRecord[] = []
  let skip = 0
  const top = 1000

  while (true) {
    const res = await fetch('https://api.quickbase.com/v1/records/query', {
      method: 'POST',
      headers: qbHeaders(realm, token),
      body: JSON.stringify({
        from: DESIGN_TABLE,
        select,
        where: "{'73'.EX.'Kin Home'}AND{'156'.XEX.'1'}",
        sortBy: [{ fieldId: 2, order: 'DESC' }],
        options: { skip, top },
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`QuickBase design query failed (${res.status}): ${text.slice(0, 200)}`)
    }
    const data = await res.json() as { data?: QbRecord[] }
    const records = data.data || []
    all.push(...records)
    if (records.length < top || all.length >= 5000) break
    skip += top
  }

  designRowsCache = { rows: all, expiresAt: Date.now() + DESIGN_CACHE_TTL_MS }
  return all
}

function projectMapFor(projectIds: number[]): Map<number, Record<string, unknown>> {
  const unique = [...new Set(projectIds.filter(n => Number.isFinite(n) && n > 0))]
  const out = new Map<number, Record<string, unknown>>()
  const columns = `
    record_id, customer_name, customer_address, status, state,
    coordinator, closer, lender, epc, system_size_kw,
    sales_date, intake_completed,
    survey_scheduled, survey_submitted, survey_approved,
    cad_submitted, design_completed,
    permit_submitted, permit_approved, permit_rejected,
    nem_submitted, nem_approved, nem_rejected,
    install_scheduled, install_completed,
    inspection_scheduled, inspection_passed,
    pto_submitted, pto_approved
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

function classify(row: DesignBaseRow, today: string, bizFactor: number): Pick<DesignRow, 'phase' | 'phase_label' | 'age_days' | 'stale'> {
  let phase = 'backlog'
  let label = 'Backlog'
  let anchor = row.created_at

  if (isSet(row.engineering_completed) || isSet(row.design_completed) || /6-completed|completed/i.test(row.design_status)) {
    phase = 'complete'
    label = 'Complete'
    anchor = row.design_completed || row.engineering_completed || row.modified_at
  } else if (isSet(row.cad_completed) && !isSet(row.qa_audit_completed) && (row.design_type === 'Initial Design' || row.layout_change === 'Layout Changed')) {
    phase = 'qa_audit'
    label = 'QA Audit'
    anchor = row.cad_completed
  } else if (isSet(row.engineering_submitted) && !isSet(row.engineering_completed)) {
    phase = 'engineering'
    label = 'In Engineering'
    anchor = row.engineering_submitted
  } else if (isSet(row.cad_completed) && !isSet(row.engineering_submitted)) {
    phase = 'pending_eng'
    label = 'Pending ENG'
    anchor = row.cad_completed
  } else if (isSet(row.cad_started) && !isSet(row.cad_completed)) {
    phase = 'cad_work'
    label = 'In CAD'
    anchor = row.cad_started
  } else if (isSet(row.survey_approved) && !isSet(row.cad_started)) {
    phase = 'ready_cad'
    label = 'Ready CAD'
    anchor = row.survey_approved
  } else if (isSet(row.survey_submitted) && !isSet(row.survey_approved)) {
    phase = 'ss_pending'
    label = 'SS Pending'
    anchor = row.survey_submitted
  }

  const age = phase === 'complete' ? 0 : dayDiff(today, anchor, bizFactor)
  return { phase, phase_label: label, age_days: age, stale: phase !== 'complete' && age >= 3 }
}

function computeSlaFields(row: DesignBaseRow, today: string): Pick<DesignRow, 'sla_ss_to_cad_days' | 'sla_cad_to_design_days' | 'sla_ss_to_design_days' | 'sla_ss_to_cad_met' | 'sla_cad_to_design_met' | 'sla_ss_to_design_met'> {
  if (!isInitialDesign(row)) {
    return {
      sla_ss_to_cad_days: null,
      sla_cad_to_design_days: null,
      sla_ss_to_design_days: null,
      sla_ss_to_cad_met: null,
      sla_cad_to_design_met: null,
      sla_ss_to_design_met: null,
    }
  }

  const start = row.cad_sla_start || row.survey_submitted
  const ssToCad = start ? bizDaysBetween(start, row.cad_completed || today) : null
  const cadToDesign = row.cad_completed ? bizDaysBetween(row.cad_completed, row.design_completed || today) : null
  const ssToDesign = start ? bizDaysBetween(start, row.design_completed || today) : null

  return {
    sla_ss_to_cad_days: ssToCad,
    sla_cad_to_design_days: cadToDesign,
    sla_ss_to_design_days: ssToDesign,
    sla_ss_to_cad_met: row.cad_completed && ssToCad !== null ? ssToCad <= 1 : null,
    sla_cad_to_design_met: row.design_completed && cadToDesign !== null ? cadToDesign <= 1 : null,
    sla_ss_to_design_met: row.design_completed && ssToDesign !== null ? ssToDesign <= 2 : null,
  }
}

function normalizeRows(records: QbRecord[], today: string, bizFactor: number): DesignRow[] {
  const projectIds = records.map(r => parseRid(val(r, 9))).filter((n): n is number => n !== null)
  const projects = projectMapFor(projectIds)

  return records.map(record => {
    const projectRid = parseRid(val(record, 9))
    const project = projectRid ? projects.get(projectRid) : undefined
    const base = {
      record_id: parseInt(val(record, 3), 10) || 0,
      design_record_id: parseInt(val(record, 3), 10) || 0,
      project_rid: projectRid,
      customer_name: val(record, 11) || String(project?.['customer_name'] || ''),
      customer_address: String(project?.['customer_address'] || '') || null,
      status: String(project?.['status'] || val(record, 72) || '') || null,
      project_status: val(record, 72) || String(project?.['status'] || ''),
      state: val(record, 213) || String(project?.['state'] || ''),
      epc: val(record, 73) || String(project?.['epc'] || ''),
      lender: String(project?.['lender'] || '') || null,
      closer: String(project?.['closer'] || '') || null,
      coordinator: String(project?.['coordinator'] || '') || null,
      system_size_kw: project?.['system_size_kw'] == null ? null : Number(project['system_size_kw']),
      sales_date: String(project?.['sales_date'] || '') || null,
      intake_completed: String(project?.['intake_completed'] || '') || null,
      survey_scheduled: String(project?.['survey_scheduled'] || '') || null,
      survey_submitted: cleanDate(val(record, 87) || String(project?.['survey_submitted'] || '')),
      survey_approved: cleanDate(val(record, 88) || String(project?.['survey_approved'] || '')),
      cad_submitted: cleanDate(String(project?.['cad_submitted'] || '') || val(record, 19)) || null,
      design_completed: cleanDate(val(record, 37) || String(project?.['design_completed'] || '')) || null,
      permit_submitted: String(project?.['permit_submitted'] || '') || null,
      permit_approved: String(project?.['permit_approved'] || '') || null,
      nem_submitted: String(project?.['nem_submitted'] || '') || null,
      nem_approved: String(project?.['nem_approved'] || '') || null,
      install_scheduled: String(project?.['install_scheduled'] || '') || null,
      install_completed: String(project?.['install_completed'] || '') || null,
      inspection_scheduled: String(project?.['inspection_scheduled'] || '') || null,
      inspection_passed: String(project?.['inspection_passed'] || '') || null,
      pto_submitted: String(project?.['pto_submitted'] || '') || null,
      pto_approved: String(project?.['pto_approved'] || '') || null,
      design_type: val(record, 8) || 'Initial Design',
      design_status: val(record, 7),
      cad_sla_start: cleanDate(val(record, 462)),
      cad_started: cleanDate(val(record, 19)),
      cad_completed: cleanDate(val(record, 50)),
      cad_approved: cleanDate(val(record, 20)),
      engineering_submitted: cleanDate(val(record, 33)),
      engineering_completed: cleanDate(val(record, 34)),
      qa_audit_completed: cleanDate(val(record, 326)),
      assigned_designer: val(record, 439) || val(record, 435) || 'Unassigned',
      requester: val(record, 285),
      engineering_company: val(record, 323),
      layout_change: val(record, 339),
      created_at: cleanDate(val(record, 1)),
      modified_at: cleanDate(val(record, 2)),
    } satisfies DesignBaseRow

    return { ...base, ...computeSlaFields(base, today), ...classify(base, today, bizFactor) }
  }).filter(row => row.record_id > 0)
}

const slaDefs: SlaDef[] = [
  {
    key: 'ssToCad',
    label: 'SS Sub → Initial CAD Complete',
    shortLabel: 'SS→CAD',
    target: 1,
    daysField: 'sla_ss_to_cad_days',
    metField: 'sla_ss_to_cad_met',
    endField: 'cad_completed',
  },
  {
    key: 'cadToDesign',
    label: 'Initial CAD Complete → Design Complete',
    shortLabel: 'CAD→Design',
    target: 1,
    daysField: 'sla_cad_to_design_days',
    metField: 'sla_cad_to_design_met',
    endField: 'design_completed',
  },
  {
    key: 'ssToDesign',
    label: 'SS Sub → Initial Design Complete',
    shortLabel: 'SS→Design',
    target: 2,
    daysField: 'sla_ss_to_design_days',
    metField: 'sla_ss_to_design_met',
    endField: 'design_completed',
  },
]

const queues: QueueDef[] = [
  { key: 'ssPending', label: 'SS Pending', description: 'Survey submitted, awaiting approval', tone: 'warning', predicate: r => r.phase === 'ss_pending' },
  { key: 'readyCad', label: 'Ready CAD', description: 'Approved survey, CAD not started', tone: 'info', predicate: r => r.phase === 'ready_cad' },
  { key: 'inCad', label: 'In CAD', description: 'CAD started, not completed', tone: 'teal', predicate: r => r.phase === 'cad_work' },
  { key: 'pendingEng', label: 'Pending ENG', description: 'CAD complete, engineering not submitted', tone: 'warning', predicate: r => r.phase === 'pending_eng' },
  { key: 'inEng', label: 'In ENG', description: 'Engineering submitted, not completed', tone: 'info', predicate: r => r.phase === 'engineering' },
  { key: 'qaAudit', label: 'QA Audit', description: 'CAD complete, audit still open', tone: 'danger', predicate: r => r.phase === 'qa_audit' },
]

function avg(rows: DesignRow[], field: keyof DesignRow): number {
  if (!rows.length) return 0
  return Math.round(rows.reduce((sum, row) => sum + Number(row[field] || 0), 0) / rows.length)
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

function slaSamples(rows: DesignRow[], def: SlaDef, from?: string, to?: string): DesignRow[] {
  return rows.filter(row => {
    if (!isInitialDesign(row)) return false
    if (!inRange(String(row[def.endField] || ''), from, to)) return false
    return row[def.daysField] !== null && row[def.metField] !== null
  })
}

function slaOpenMisses(openRows: DesignRow[], def: SlaDef): DesignRow[] {
  return openRows.filter(row => {
    if (!isInitialDesign(row)) return false
    const days = row[def.daysField]
    if (days === null || days <= def.target) return false
    if (def.key === 'ssToCad') return !isSet(row.cad_completed)
    if (def.key === 'cadToDesign') return isSet(row.cad_completed) && !isSet(row.design_completed)
    return !isSet(row.design_completed)
  })
}

function summarizeSla(rows: DesignRow[], openRows: DesignRow[], def: SlaDef, from?: string, to?: string) {
  const samples = slaSamples(rows, def, from, to)
  const days = samples.map(row => Number(row[def.daysField] ?? 0))
  const met = samples.filter(row => row[def.metField] === true).length
  const openMisses = slaOpenMisses(openRows, def)
  return {
    key: def.key,
    label: def.label,
    shortLabel: def.shortLabel,
    target: def.target,
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

function groupSlaBoxes(rows: DesignRow[], from?: string, to?: string) {
  const weekly = !!(from && to && (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000 <= 90)
  const out: Record<SlaMetricKey, Array<{
    period: string
    count: number
    met: number
    misses: number
    pctMet: number
    target: number
    p0: number
    p25: number
    p50: number
    p90: number
    p100: number
    mean: number
  }>> = { ssToCad: [], cadToDesign: [], ssToDesign: [] }

  for (const def of slaDefs) {
    const buckets = new Map<string, { days: number[]; met: number }>()
    for (const row of slaSamples(rows, def, from, to)) {
      const endDate = String(row[def.endField] || '')
      const period = bucketPeriod(endDate, weekly)
      if (!period) continue
      let bucket = buckets.get(period)
      if (!bucket) {
        bucket = { days: [], met: 0 }
        buckets.set(period, bucket)
      }
      const days = Number(row[def.daysField] ?? 0)
      bucket.days.push(days)
      if (row[def.metField] === true) bucket.met += 1
    }

    out[def.key] = [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, bucket]) => {
        const count = bucket.days.length
        const met = bucket.met
        return {
          period,
          count,
          met,
          misses: count - met,
          pctMet: count ? Math.round((met / count) * 100) : 0,
          target: def.target,
          p0: round1(percentile(bucket.days, 0)),
          p25: round1(percentile(bucket.days, 25)),
          p50: round1(percentile(bucket.days, 50)),
          p90: round1(percentile(bucket.days, 90)),
          p100: round1(percentile(bucket.days, 100)),
          mean: round1(mean(bucket.days)),
        }
      })
  }

  return out
}

function makeQueueSummary(rows: DesignRow[]) {
  return queues.map(q => {
    const items = rows.filter(q.predicate)
    return {
      key: q.key,
      label: q.label,
      description: q.description,
      tone: q.tone,
      count: items.length,
      oldest: items.reduce((m, row) => Math.max(m, row.age_days), 0),
      avgAge: avg(items, 'age_days'),
      stale: items.filter(row => row.stale).length,
    }
  })
}

function groupThroughput(rows: DesignRow[], from: string | undefined, to: string | undefined) {
  const weekly = !!(from && to && (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000 <= 90)
  const map = new Map<string, { period: string; cadCompleted: number; engCompleted: number; designCompleted: number }>()
  function ensure(period: string) {
    let row = map.get(period)
    if (!row) {
      row = { period, cadCompleted: 0, engCompleted: 0, designCompleted: 0 }
      map.set(period, row)
    }
    return row
  }

  for (const row of rows) {
    if (inRange(row.cad_completed, from, to)) ensure(bucketPeriod(row.cad_completed, weekly)).cadCompleted += 1
    if (inRange(row.engineering_completed, from, to)) ensure(bucketPeriod(row.engineering_completed, weekly)).engCompleted += 1
    const completeDate = row.design_completed || row.engineering_completed
    if (inRange(completeDate || '', from, to)) ensure(bucketPeriod(completeDate || '', weekly)).designCompleted += 1
  }

  return [...map.values()].filter(r => r.period).sort((a, b) => a.period.localeCompare(b.period))
}

function agingSummary(rows: DesignRow[]) {
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
      readyCad: items.filter(row => row.phase === 'ready_cad').length,
      inCad: items.filter(row => row.phase === 'cad_work').length,
      inEng: items.filter(row => row.phase === 'engineering' || row.phase === 'pending_eng').length,
      qaAudit: items.filter(row => row.phase === 'qa_audit').length,
    }
  })
}

function designerPivot(openRows: DesignRow[], allRows: DesignRow[], from?: string, to?: string) {
  const map = new Map<string, {
    name: string
    open: number
    ready: number
    cad: number
    eng: number
    qa: number
    stale: number
    completed: number
    ageTotal: number
    avgAge: number
    cadSlaMet: number
    designSlaMet: number
    endToEndSlaMet: number
    cadSlaDays: number[]
    designSlaDays: number[]
    endToEndSlaDays: number[]
  }>()
  function ensure(name: string) {
    const key = name || 'Unassigned'
    let row = map.get(key)
    if (!row) {
      row = {
        name: key,
        open: 0,
        ready: 0,
        cad: 0,
        eng: 0,
        qa: 0,
        stale: 0,
        completed: 0,
        ageTotal: 0,
        avgAge: 0,
        cadSlaMet: 0,
        designSlaMet: 0,
        endToEndSlaMet: 0,
        cadSlaDays: [],
        designSlaDays: [],
        endToEndSlaDays: [],
      }
      map.set(key, row)
    }
    return row
  }
  for (const row of openRows) {
    const d = ensure(row.assigned_designer)
    d.open += 1
    d.ageTotal += row.age_days
    if (row.phase === 'ready_cad' || row.phase === 'ss_pending') d.ready += 1
    if (row.phase === 'cad_work') d.cad += 1
    if (row.phase === 'pending_eng' || row.phase === 'engineering') d.eng += 1
    if (row.phase === 'qa_audit') d.qa += 1
    if (row.stale) d.stale += 1
  }
  for (const row of allRows) {
    const completeDate = row.design_completed || row.engineering_completed
    if (inRange(completeDate || '', from, to)) ensure(row.assigned_designer).completed += 1
    if (!isInitialDesign(row)) continue
    const d = ensure(row.assigned_designer)
    if (inRange(row.cad_completed, from, to) && row.sla_ss_to_cad_days !== null && row.sla_ss_to_cad_met !== null) {
      d.cadSlaDays.push(row.sla_ss_to_cad_days)
      if (row.sla_ss_to_cad_met) d.cadSlaMet += 1
    }
    if (inRange(row.design_completed || '', from, to) && row.sla_cad_to_design_days !== null && row.sla_cad_to_design_met !== null) {
      d.designSlaDays.push(row.sla_cad_to_design_days)
      if (row.sla_cad_to_design_met) d.designSlaMet += 1
    }
    if (inRange(row.design_completed || '', from, to) && row.sla_ss_to_design_days !== null && row.sla_ss_to_design_met !== null) {
      d.endToEndSlaDays.push(row.sla_ss_to_design_days)
      if (row.sla_ss_to_design_met) d.endToEndSlaMet += 1
    }
  }
  return [...map.values()]
    .map(row => {
      const cadSlaTotal = row.cadSlaDays.length
      const designSlaTotal = row.designSlaDays.length
      const endToEndSlaTotal = row.endToEndSlaDays.length
      const { cadSlaDays, designSlaDays, endToEndSlaDays, ...rest } = row
      return {
        ...rest,
        avgAge: row.open ? Math.round(row.ageTotal / row.open) : 0,
        cadSlaTotal,
        cadSlaPct: cadSlaTotal ? Math.round((row.cadSlaMet / cadSlaTotal) * 100) : 0,
        cadSlaMedian: round1(percentile(row.cadSlaDays, 50)),
        designSlaTotal,
        designSlaPct: designSlaTotal ? Math.round((row.designSlaMet / designSlaTotal) * 100) : 0,
        designSlaMedian: round1(percentile(row.designSlaDays, 50)),
        endToEndSlaTotal,
        endToEndSlaPct: endToEndSlaTotal ? Math.round((row.endToEndSlaMet / endToEndSlaTotal) * 100) : 0,
        endToEndSlaMedian: round1(percentile(row.endToEndSlaDays, 50)),
      }
    })
    .sort((a, b) => b.open - a.open || b.completed - a.completed)
}

function typePivot(openRows: DesignRow[], allRows: DesignRow[], from?: string, to?: string) {
  const map = new Map<string, { designType: string; open: number; stale: number; completed: number; avgAge: number; ageTotal: number }>()
  function ensure(type: string) {
    const key = type || 'Unspecified'
    let row = map.get(key)
    if (!row) {
      row = { designType: key, open: 0, stale: 0, completed: 0, avgAge: 0, ageTotal: 0 }
      map.set(key, row)
    }
    return row
  }
  for (const row of openRows) {
    const type = ensure(row.design_type)
    type.open += 1
    type.ageTotal += row.age_days
    if (row.stale) type.stale += 1
  }
  for (const row of allRows) {
    const completeDate = row.design_completed || row.engineering_completed
    if (inRange(completeDate || '', from, to)) ensure(row.design_type).completed += 1
  }
  return [...map.values()]
    .map(row => ({ ...row, avgAge: row.open ? Math.round(row.ageTotal / row.open) : 0 }))
    .sort((a, b) => b.open - a.open || b.completed - a.completed)
}

function filterRows(rows: DesignRow[], req: Request): DesignRow[] {
  const state = String(req.query['state'] || '')
  const epc = String(req.query['epc'] || '')
  const designer = String(req.query['designer'] || '')
  const designType = String(req.query['design_type'] || '')

  return rows.filter(row => {
    if (state && row.state !== state) return false
    if (epc && row.epc !== epc) return false
    if (designer && row.assigned_designer !== designer) return false
    if (designType && row.design_type !== designType) return false
    return true
  })
}

function optionsFrom(rows: DesignRow[]) {
  const vals = (key: keyof DesignRow) => [...new Set(rows.map(row => String(row[key] || '')).filter(Boolean))].sort()
  return {
    states: vals('state'),
    epcs: vals('epc'),
    designers: vals('assigned_designer'),
    designTypes: vals('design_type'),
  }
}

function listRows(rows: DesignRow[], limit = 200) {
  return [...rows].sort((a, b) => b.age_days - a.age_days || a.customer_name.localeCompare(b.customer_name)).slice(0, limit)
}

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const today = officeTodayIso()
    const from = String(req.query['date_from'] || '') || undefined
    const to = String(req.query['date_to'] || '') || undefined
    const bizFactor = req.query['biz_days'] === '1' ? 5 / 7 : 1

    const rawRows = await fetchDesignRows()
    const normalized = normalizeRows(rawRows, today, bizFactor)
    const filtered = filterRows(normalized, req)

    const openRows = filtered.filter(row => !terminalProjectStatus(row.project_status) && !terminalDesignStatus(row.design_status) && row.phase !== 'complete')
    const slaEligibleRows = filtered.filter(row => !excludedProjectStatusForSla(row.project_status) && !excludedDesignStatusForSla(row.design_status))
    const completedInWindow = filtered.filter(row => inRange((row.design_completed || row.engineering_completed || ''), from, to))
    const stuck = openRows.filter(row => row.stale)
    const q = makeQueueSummary(openRows)
    const lists: Record<string, DesignRow[]> = {
      open: listRows(openRows),
      stuck: listRows(stuck),
    }
    for (const queue of queues) lists[queue.key] = listRows(openRows.filter(queue.predicate))
    for (const def of slaDefs) {
      const misses = [
        ...slaSamples(slaEligibleRows, def, from, to).filter(row => row[def.metField] === false),
        ...slaOpenMisses(openRows, def),
      ].sort((a, b) => Number(b[def.daysField] ?? 0) - Number(a[def.daysField] ?? 0))
      lists[`${def.key}Miss`] = misses.slice(0, 200)
    }

    const byPeriod = groupThroughput(filtered, from, to)
    const periodTotals = byPeriod.reduce((sum, row) => sum + row.designCompleted, 0)

    res.json({
      kpi: {
        open: openRows.length,
        stale: stuck.length,
        completed: completedInWindow.length,
        avgAge: avg(openRows, 'age_days'),
        oldest: openRows.reduce((m, row) => Math.max(m, row.age_days), 0),
        throughput: periodTotals,
        sla: Object.fromEntries(slaDefs.map(def => [def.key, summarizeSla(slaEligibleRows, openRows, def, from, to)])),
      },
      queues: q,
      charts: {
        throughput: byPeriod,
        aging: agingSummary(openRows),
        slaBoxes: groupSlaBoxes(slaEligibleRows, from, to),
      },
      pivot: {
        designers: designerPivot(openRows, slaEligibleRows, from, to),
        designTypes: typePivot(openRows, filtered, from, to),
      },
      lists,
      filters: optionsFrom(normalized),
      meta: {
        source: 'QuickBase Design table',
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
    const today = officeTodayIso()
    const bizFactor = req.query['biz_days'] === '1' ? 5 / 7 : 1
    const rawRows = await fetchDesignRows()
    const filtered = filterRows(normalizeRows(rawRows, today, bizFactor), req)
    const openRows = filtered.filter(row => !terminalProjectStatus(row.project_status) && !terminalDesignStatus(row.design_status) && row.phase !== 'complete')
    const queue = String(req.query['queue'] || '')
    const period = String(req.query['period'] || '')

    let rows: DesignRow[] = []
    const q = queues.find(item => item.key === queue)
    if (q) rows = openRows.filter(q.predicate)
    else if (queue === 'stuck') rows = openRows.filter(row => row.stale)
    else if (/^\d{4}-\d{2}(-\d{2})?$/.test(period)) {
      const { from, to } = periodRange(period)
      rows = filtered.filter(row => inRange((row.design_completed || row.engineering_completed || ''), from, to))
    } else {
      rows = openRows
    }

    res.json({ projects: listRows(rows, 500), total: rows.length })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Re-export the cached design-row fetcher so daily-goals can piggy-
// back without a second QB round-trip. Same 60s cache backing the
// design dashboard.
export { fetchDesignRows }

export { router as designAnalyticsRouter }
