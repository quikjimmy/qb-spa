import { Router, type Request, type Response } from 'express'
import db from '../db'

const router = Router()

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

// QB Intake Events table: bt4a8ypkq
//
//   1   Date Created
//   2   Date Modified
//   3   Record ID#
//   5   Last Modified By (auditor)
//   36  Related Project (numeric → project.record_id)   ← confirmed
//   40  Install Agreement
//   46  Finance
//   48  Utility Bill
//   55  Consumption Audit
//   58  Site Survey
//   61  Welcome Call
//   67  Adders
//   81  Finance Missing Items
//
// Intake decision (Approved / Rejected / Pending) lives on the PROJECT
// (project_cache.intake_status, fid 347) — not on each intake event —
// so the pill is rendered client-side from project data, not from this row.
const INTAKE_TABLE = 'bt4a8ypkq'
const F = {
  recordId: 3,
  dateCreated: 1,
  dateModified: 2,
  lastModifiedBy: 5,
  relatedProject: 36,
  installAgreement: 40,
  finance: 46,
  financeMissingItems: 81,
  utilityBill: 48,
  consumptionAudit: 55,
  siteSurvey: 58,
  welcomeCall: 61,
  adders: 67,
}
const SELECT_FIDS = [
  F.recordId, F.dateCreated, F.dateModified, F.lastModifiedBy,
  F.relatedProject,
  F.installAgreement, F.finance, F.financeMissingItems,
  F.utilityBill, F.consumptionAudit, F.siteSurvey, F.welcomeCall, F.adders,
]

// QB Failed Runs table: bvz67e58s
// This is the operator-facing handoff between the Sale Intake Zap,
// Slack alerting, and the small Retry Zap. The app does not replay the
// intake logic itself; it surfaces the failed-run record and can flip the
// retry trigger fields so Zapier remains the execution layer.
const FAILED_RUNS_TABLE = 'bvz67e58s'
const PROJECTS_TABLE = 'br9kwm8na'
const ORGS_TABLE = 'br9kwm87j'
const CONTACTS_TABLE = 'br9kwm8td'
const FAILED_RUNS_TTL_MS = 60_000
const INTAKE_MANAGER_TTL_MS = 60_000
const FR = {
  dateCreated: 1,
  dateModified: 2,
  recordId: 3,
  customerName: 6,
  enerfloRecordId: 7,
  enerfloInstallId: 8,
  errorSummary: 9,
  zapierRunId: 10,
  orgIdCreated: 11,
  contactIdCreated: 12,
  projectIdCreated: 13,
  junctionIdCreated: 14,
  notes: 15,
  payloadJson: 16,
  retryStatus: 17,
  retryTriggered: 18,
}
const FAILED_RUN_SELECT = [
  FR.dateCreated, FR.dateModified, FR.recordId, FR.customerName,
  FR.enerfloRecordId, FR.enerfloInstallId, FR.errorSummary, FR.zapierRunId,
  FR.orgIdCreated, FR.contactIdCreated, FR.projectIdCreated, FR.junctionIdCreated,
  FR.notes, FR.payloadJson, FR.retryStatus, FR.retryTriggered,
]

const PF = {
  recordId: 3,
  dateModified: 2,
  systemSizeKw: 13,
  customerName: 145,
  state: 189,
  status: 255,
  salesOffice: 339,
  lender: 344,
  intakeStatus: 347,
  closer: 355,
  salesDate: 522,
  epc: 606,
  testProject: 622,
  maxIntakeFinished: 1800,
  intakeProgress: 1828,
  missingItems: 1871,
  firstPassUser: 1861,
  firstPassMissingItems: 1872,
  firstPassDisposition: 1950,
  firstPassComplete: 1951,
  firstPassProcessingTime: 1953,
  firstPassStarted: 1965,
  surrenderReferenceDate: 1966,
}
const PROJECT_INTAKE_SELECT = [
  PF.recordId, PF.dateModified, PF.systemSizeKw, PF.customerName, PF.state, PF.status,
  PF.salesOffice, PF.lender, PF.intakeStatus, PF.closer, PF.salesDate, PF.epc,
  PF.testProject, PF.maxIntakeFinished, PF.intakeProgress, PF.surrenderReferenceDate,
  PF.missingItems, PF.firstPassUser, PF.firstPassMissingItems, PF.firstPassDisposition,
  PF.firstPassComplete, PF.firstPassProcessingTime, PF.firstPassStarted,
]

const PROCESSING_EVENT_SELECT = [
  3, 1, 2, 36, 40, 46, 48, 55, 58, 61, 67, 72, 106, 196, 207, 210,
]

type QbRecord = Record<string, { value: unknown }>

interface FailedRun {
  record_id: number
  customer_name: string
  enerflo_record_id: string
  enerflo_install_id: string
  error_summary: string
  zapier_run_id: string
  org_id_created: string
  contact_id_created: string
  project_id_created: string
  junction_id_created: string
  notes: string
  payload_json: string
  payload_preview: Record<string, string>
  retry_status: string
  retry_triggered: boolean
  date_created: string
  date_modified: string
  age_days: number
  created_count: number
  missing_records: string[]
  partial_create: boolean
  qb_url: string
  org_url: string
  contact_url: string
  project_url: string
  junction_url: string
  enerflo_url: string
  phase: string
  phase_label: string
  retryable: boolean
}

interface IntakeProjectRow {
  record_id: number
  customer_name: string
  state: string
  sales_office: string
  lender: string
  closer: string
  system_size_kw: number
  project_status: string
  intake_status: string
  sales_date: string
  intake_progress: number | null
  missing_items: string
  missing_items_list: string[]
  first_pass_user: string
  first_pass_missing_items: string
  first_pass_missing_items_list: string[]
  first_pass_disposition: string
  first_pass_complete: string
  first_pass_processing_time: string
  first_pass_started: string
  intake_start_hours: number | null
  intake_complete_hours: number | null
  first_pass_success: boolean
  first_pass_rejected: boolean
  max_intake_finished: string
  hours_since_last_event: number | null
  surrender_reference_date: string
  age_days: number
  project_url: string
  phase: string
  phase_label: string
}

interface ProcessingEventRow {
  record_id: number
  project_rid: number | null
  customer_name: string
  project_status: string
  started_processing: string
  date_created: string
  age_hours: number | null
  completion_pct: number
  project_url: string
  intake_event_url: string
}

interface QueueDef {
  key: string
  label: string
  description: string
  tone: 'info' | 'success' | 'warning' | 'danger' | 'teal' | 'neutral'
  predicate: (row: FailedRun) => boolean
}

let failedRunsCache: { rows: QbRecord[]; fetchedAt: string; expiresAt: number } | null = null

// Cache invalidator — used by the QB project-created webhook so a
// freshly-saved project doesn't have to wait for the 60s TTL. Next
// poll from any open intake dashboard hits QB live + warms the cache.
export function invalidateIntakeCaches(reason?: string): void {
  failedRunsCache = null
  intakeManagerCache = null
  if (reason) console.log(`[intake-cache] invalidated: ${reason}`)
}
let intakeManagerCache: {
  projects: QbRecord[]
  processingEvents: QbRecord[]
  from: string
  to: string
  fetchedAt: string
  expiresAt: number
} | null = null

function val(record: Record<string, { value: unknown }>, fid: number): string {
  const v = record[String(fid)]?.value
  if (v === null || v === undefined) return ''
  return String(v)
}
function userName(record: Record<string, { value: unknown }>, fid: number): string {
  const raw = record[String(fid)]?.value
  if (raw && typeof raw === 'object' && 'name' in (raw as Record<string, unknown>)) {
    return String((raw as { name: string }).name ?? '')
  }
  return val(record, fid)
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

function qv(record: QbRecord, fid: number): string {
  return stringValue(record[String(fid)]?.value)
}

function cleanDateTime(v: string | null | undefined): string {
  if (!v) return ''
  return String(v)
}

function dateKey(v: string | null | undefined): string {
  if (!v) return ''
  return String(v).slice(0, 10)
}

function isTruthy(v: string | boolean | number | null | undefined): boolean {
  if (typeof v === 'boolean') return v
  return /^(true|1|yes)$/i.test(String(v || '').trim())
}

function isSet(v: string | null | undefined): boolean {
  return !!(v && String(v).trim() !== '' && String(v).trim() !== '0')
}

function daysSince(today: string, start: string): number {
  const d = dateKey(start)
  if (!d) return 0
  const s = new Date(`${d}T12:00:00Z`).getTime()
  const t = new Date(`${today}T12:00:00Z`).getTime()
  if (!Number.isFinite(s) || !Number.isFinite(t)) return 0
  return Math.max(0, Math.floor((t - s) / 86_400_000))
}

function inRange(v: string, from?: string, to?: string): boolean {
  const d = dateKey(v)
  if (!d) return false
  if (from && d < from) return false
  if (to && d > to) return false
  return true
}

function inOptionalRange(v: string, from?: string, to?: string): boolean {
  if (!from && !to) return isSet(v)
  return inRange(v, from, to)
}

function periodKey(v: string, weekly: boolean): string {
  const d = dateKey(v)
  if (!d) return ''
  if (!weekly) return d.slice(0, 7)
  const date = new Date(`${d}T12:00:00Z`)
  const day = date.getUTCDay()
  const back = day === 0 ? 6 : day - 1
  date.setUTCDate(date.getUTCDate() - back)
  return date.toISOString().slice(0, 10)
}

type IntakeGranularity = 'day' | 'week' | 'month'

function windowDays(from?: string, to?: string): number {
  if (!from || !to) return 999
  const f = new Date(`${from}T12:00:00Z`).getTime()
  const t = new Date(`${to}T12:00:00Z`).getTime()
  if (!Number.isFinite(f) || !Number.isFinite(t)) return 999
  return Math.max(0, Math.round((t - f) / 86_400_000))
}

function intakeGranularity(from?: string, to?: string): IntakeGranularity {
  const days = windowDays(from, to)
  if (days <= 45) return 'day'
  if (days <= 180) return 'week'
  return 'month'
}

function intakePeriodKey(v: string, granularity: IntakeGranularity): string {
  if (granularity === 'day') return dateKey(v)
  return periodKey(v, granularity === 'week')
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function numberValue(raw: string): number {
  if (!raw) return 0
  const n = Number(String(raw).replace(/,/g, '').trim())
  return Number.isFinite(n) ? n : 0
}

function safePct(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : 0
}

function parseDateTimeMs(raw: string | null | undefined): number | null {
  const v = String(raw || '').trim()
  if (!v || v === '0') return null
  const parsed = v.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(v)
    ? new Date(`${v}T12:00:00Z`)
    : new Date(v)
  const t = parsed.getTime()
  return Number.isFinite(t) ? t : null
}

function hoursBetween(start: string | null | undefined, end: string | null | undefined): number | null {
  const s = parseDateTimeMs(start)
  const e = parseDateTimeMs(end)
  if (s === null || e === null || e < s) return null
  return round1((e - s) / 3_600_000)
}

function meanRounded(values: Array<number | null | undefined>, decimals = 1): number {
  const nums = values.filter((v): v is number => Number.isFinite(v as number))
  if (!nums.length) return 0
  const factor = 10 ** decimals
  return Math.round((nums.reduce((sum, n) => sum + n, 0) / nums.length) * factor) / factor
}

function parsePayloadPreview(raw: string): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const keys = [
      'customer_name', 'customerName', 'name',
      'enerflo_install_id', 'install_id', 'installId',
      'email', 'phone', 'state',
      'sales_rep', 'closer', 'setter',
    ]
    const out: Record<string, string> = {}
    for (const key of keys) {
      const v = parsed[key]
      if (v !== null && v !== undefined && String(v) !== '') out[key] = String(v)
    }
    return out
  } catch {
    return {}
  }
}

function qbRecordUrl(tableId: string, recordId: string | number | null | undefined): string {
  const rid = String(recordId || '').trim()
  if (!isSet(rid)) return ''
  return `https://kin.quickbase.com/nav/app/br9kwm8bk/table/${tableId}/action/dr?rid=${encodeURIComponent(rid)}`
}

function enerfloInstallUrl(installId: string | number | null | undefined): string {
  const id = String(installId || '').trim()
  if (!isSet(id)) return ''
  return `https://enerflo.io/installs/${encodeURIComponent(id)}`
}

function statusNorm(status: string): string {
  return (status || 'Pending').trim() || 'Pending'
}

function classifyFailedRun(row: Omit<FailedRun, 'phase' | 'phase_label' | 'retryable'>): Pick<FailedRun, 'phase' | 'phase_label' | 'retryable'> {
  const status = statusNorm(row.retry_status)
  const lower = status.toLowerCase()
  if (lower === 'resolved') return { phase: 'resolved', phase_label: 'Resolved', retryable: false }
  if (lower === 'ignored') return { phase: 'ignored', phase_label: 'Ignored', retryable: false }
  if (lower === 'failed again') return { phase: 'failed_again', phase_label: 'Failed Again', retryable: true }
  if (row.retry_triggered && lower === 'pending') return { phase: 'triggered', phase_label: 'Retry Triggered', retryable: false }
  if (lower === 'retried') return { phase: 'retried', phase_label: 'Retried', retryable: true }
  if (row.partial_create) return { phase: 'partial', phase_label: 'Partial Create', retryable: true }
  return { phase: 'pending', phase_label: 'Pending Retry', retryable: true }
}

function normalizeFailedRun(record: QbRecord, realm: string, today: string): FailedRun | null {
  const recordId = parseInt(qv(record, FR.recordId), 10)
  if (!Number.isFinite(recordId) || recordId <= 0) return null
  const ids = {
    org: qv(record, FR.orgIdCreated),
    contact: qv(record, FR.contactIdCreated),
    project: qv(record, FR.projectIdCreated),
    junction: qv(record, FR.junctionIdCreated),
  }
  const missingRecords = Object.entries(ids)
    .filter(([, value]) => !isSet(value))
    .map(([key]) => key[0]!.toUpperCase() + key.slice(1))
  const createdCount = Object.values(ids).filter(isSet).length
  const partialCreate = createdCount > 0 && missingRecords.length > 0
  const dateCreated = cleanDateTime(qv(record, FR.dateCreated))
  const base = {
    record_id: recordId,
    customer_name: qv(record, FR.customerName) || 'Unknown customer',
    enerflo_record_id: qv(record, FR.enerfloRecordId),
    enerflo_install_id: qv(record, FR.enerfloInstallId),
    error_summary: qv(record, FR.errorSummary),
    zapier_run_id: qv(record, FR.zapierRunId),
    org_id_created: ids.org,
    contact_id_created: ids.contact,
    project_id_created: ids.project,
    junction_id_created: ids.junction,
    notes: qv(record, FR.notes),
    payload_json: qv(record, FR.payloadJson),
    payload_preview: parsePayloadPreview(qv(record, FR.payloadJson)),
    retry_status: statusNorm(qv(record, FR.retryStatus)),
    retry_triggered: isTruthy(record[String(FR.retryTriggered)]?.value as string | boolean | number | null | undefined),
    date_created: dateCreated,
    date_modified: cleanDateTime(qv(record, FR.dateModified)),
    age_days: daysSince(today, dateCreated),
    created_count: createdCount,
    missing_records: missingRecords,
    partial_create: partialCreate,
    qb_url: `https://${realm}/db/${FAILED_RUNS_TABLE}?a=dr&rid=${recordId}`,
    org_url: qbRecordUrl(ORGS_TABLE, ids.org),
    contact_url: qbRecordUrl(CONTACTS_TABLE, ids.contact),
    project_url: qbRecordUrl(PROJECTS_TABLE, ids.project),
    junction_url: '',
    enerflo_url: enerfloInstallUrl(qv(record, FR.enerfloInstallId)),
  } satisfies Omit<FailedRun, 'phase' | 'phase_label' | 'retryable'>
  return { ...base, ...classifyFailedRun(base) }
}

// ── Cache ──
db.exec(`
  CREATE TABLE IF NOT EXISTS intake_event_cache (
    record_id INTEGER PRIMARY KEY,
    project_rid INTEGER,
    date_created TEXT,
    date_modified TEXT,
    last_modified_by TEXT,
    install_agreement TEXT,
    finance TEXT,
    finance_missing_items TEXT,
    utility_bill TEXT,
    consumption_audit TEXT,
    site_survey TEXT,
    welcome_call TEXT,
    adders TEXT,
    cached_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_intake_project ON intake_event_cache(project_rid)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_intake_created ON intake_event_cache(date_created DESC)`)

async function refreshForProject(projectId: number): Promise<{ total: number }> {
  const { realm, token } = getQbConfig()
  if (!token) throw new Error('QB_USER_TOKEN not configured')

  const res = await fetch('https://api.quickbase.com/v1/records/query', {
    method: 'POST',
    headers: {
      'QB-Realm-Hostname': realm,
      'Authorization': `QB-USER-TOKEN ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: INTAKE_TABLE,
      select: SELECT_FIDS,
      where: `{'${F.relatedProject}'.EX.'${projectId}'}`,
      sortBy: [{ fieldId: F.dateCreated, order: 'ASC' }],
      options: { top: 50 },
    }),
  })
  if (!res.ok) {
    throw new Error(`QB intake query failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }
  const data = await res.json() as { data?: Array<Record<string, { value: unknown }>> }
  const records = data.data ?? []

  const tx = db.transaction((rows: typeof records) => {
    db.prepare(`DELETE FROM intake_event_cache WHERE project_rid = ?`).run(projectId)
    const insert = db.prepare(`
      INSERT OR REPLACE INTO intake_event_cache (
        record_id, project_rid, date_created, date_modified, last_modified_by,
        install_agreement, finance, finance_missing_items,
        utility_bill, consumption_audit, site_survey, welcome_call, adders,
        cached_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `)
    for (const r of rows) {
      const rid = parseInt(val(r, F.recordId))
      if (!rid) continue
      const projRid = parseInt(val(r, F.relatedProject)) || projectId
      insert.run(
        rid, projRid,
        val(r, F.dateCreated) || null,
        val(r, F.dateModified) || null,
        userName(r, F.lastModifiedBy) || null,
        val(r, F.installAgreement) || null,
        val(r, F.finance) || null,
        val(r, F.financeMissingItems) || null,
        val(r, F.utilityBill) || null,
        val(r, F.consumptionAudit) || null,
        val(r, F.siteSurvey) || null,
        val(r, F.welcomeCall) || null,
        val(r, F.adders) || null,
      )
    }
  })
  tx(records)

  return { total: records.length }
}

async function fetchFailedRunRecords(force = false): Promise<{ rows: QbRecord[]; fetchedAt: string }> {
  if (!force && failedRunsCache && failedRunsCache.expiresAt > Date.now()) {
    return { rows: failedRunsCache.rows, fetchedAt: failedRunsCache.fetchedAt }
  }

  const { realm, token } = getQbConfig()
  if (!token) throw new Error('QB_USER_TOKEN not configured')

  const all: QbRecord[] = []
  let skip = 0
  const top = 1000
  while (true) {
    const response = await fetch('https://api.quickbase.com/v1/records/query', {
      method: 'POST',
      headers: qbHeaders(realm, token),
      body: JSON.stringify({
        from: FAILED_RUNS_TABLE,
        select: FAILED_RUN_SELECT,
        sortBy: [{ fieldId: FR.dateCreated, order: 'DESC' }],
        options: { skip, top },
      }),
    })
    if (!response.ok) {
      throw new Error(`QB failed-runs query failed (${response.status}): ${(await response.text()).slice(0, 200)}`)
    }
    const data = await response.json() as { data?: QbRecord[] }
    const rows = data.data || []
    all.push(...rows)
    if (rows.length < top || all.length >= 5000) break
    skip += top
  }

  const fetchedAt = new Date().toISOString()
  failedRunsCache = { rows: all, fetchedAt, expiresAt: Date.now() + FAILED_RUNS_TTL_MS }
  return { rows: all, fetchedAt }
}

function dateWindowClause(fid: number, from: string, to: string): string {
  const clauses: string[] = []
  if (from) clauses.push(`{'${fid}'.OAF.'${from}'}`)
  if (to) clauses.push(`{'${fid}'.OBF.'${to}'}`)
  return clauses.length ? `(${clauses.join('AND')})` : ''
}

async function fetchIntakeManagerRecords(force = false, from = '', to = ''): Promise<{ projects: QbRecord[]; processingEvents: QbRecord[]; fetchedAt: string }> {
  if (!force && intakeManagerCache && intakeManagerCache.expiresAt > Date.now() && intakeManagerCache.from === from && intakeManagerCache.to === to) {
    return {
      projects: intakeManagerCache.projects,
      processingEvents: intakeManagerCache.processingEvents,
      fetchedAt: intakeManagerCache.fetchedAt,
    }
  }

  const { realm, token } = getQbConfig()
  if (!token) throw new Error('QB_USER_TOKEN not configured')

  async function queryAll(from: string, select: number[], where: string, sortBy: Array<{ fieldId: number; order: 'ASC' | 'DESC' }>, cap = 5000): Promise<QbRecord[]> {
    const out: QbRecord[] = []
    let skip = 0
    const top = 1000
    while (true) {
      const response = await fetch('https://api.quickbase.com/v1/records/query', {
        method: 'POST',
        headers: qbHeaders(realm, token),
        body: JSON.stringify({
          from,
          select,
          where,
          sortBy,
          options: { skip, top },
        }),
      })
      if (!response.ok) {
        throw new Error(`QB intake manager query failed (${response.status}): ${(await response.text()).slice(0, 200)}`)
      }
      const data = await response.json() as { data?: QbRecord[] }
      const rows = data.data || []
      out.push(...rows)
      if (rows.length < top || out.length >= cap) break
      skip += top
    }
    return out
  }

  const baseFilter = "{'606'.CT.'Kin'}AND{'622'.XEX.'1'}"
  const activeFilter = "({'347'.EX.'In Queue'}OR{'347'.EX.'Processing'}OR{'347'.EX.'Rejected'}OR{'255'.EX.'Rejected'})"
  const windowFilters = [
    dateWindowClause(PF.salesDate, from, to),
    dateWindowClause(PF.firstPassStarted, from, to),
    dateWindowClause(PF.firstPassComplete, from, to),
  ].filter(Boolean)
  const performanceFilter = windowFilters.length ? `(${windowFilters.join('OR')})` : ''
  const projectsWhere = `${baseFilter}AND${performanceFilter ? `(${activeFilter}OR${performanceFilter})` : activeFilter}`
  const [projects, processingEvents] = await Promise.all([
    queryAll(PROJECTS_TABLE, PROJECT_INTAKE_SELECT, projectsWhere, [{ fieldId: PF.dateModified, order: 'DESC' }], 10000),
    queryAll(INTAKE_TABLE, PROCESSING_EVENT_SELECT, "{'196'.EX.'Processing'}", [{ fieldId: 2, order: 'DESC' }], 1000),
  ])

  const fetchedAt = new Date().toISOString()
  intakeManagerCache = {
    projects,
    processingEvents,
    from,
    to,
    fetchedAt,
    expiresAt: Date.now() + INTAKE_MANAGER_TTL_MS,
  }
  return { projects, processingEvents, fetchedAt }
}

function progressPct(raw: string): number | null {
  if (!raw) return null
  const stripped = raw.replace(/<[^>]*>/g, ' ')
  const pctMatch = stripped.match(/(\d+(?:\.\d+)?)\s*%/)
  if (pctMatch?.[1]) return Math.max(0, Math.min(100, Math.round(Number(pctMatch[1]))))
  const n = parseFloat(stripped)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(100, Math.round(n <= 1 ? n * 100 : n)))
}

function splitItems(raw: string): string[] {
  return String(raw || '')
    .replace(/<[^>]*>/g, ' ')
    .split(/\n|;|\|/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 20)
}

function hoursSince(todayIso: string, raw: string): number | null {
  if (!raw) return null
  const parsed = new Date(raw)
  if (!Number.isFinite(parsed.getTime())) return null
  const today = new Date(`${todayIso}T23:59:59Z`)
  const diff = today.getTime() - parsed.getTime()
  if (!Number.isFinite(diff) || diff < 0) return 0
  return round1(diff / 3_600_000)
}

function durationHours(raw: string): number | null {
  const v = String(raw || '').trim().toLowerCase()
  if (!v) return null
  const day = v.match(/(\d+(?:\.\d+)?)\s*d/)
  if (day?.[1]) return round1(Number(day[1]) * 24)
  const hour = v.match(/(\d+(?:\.\d+)?)\s*h/)
  if (hour?.[1]) return round1(Number(hour[1]))
  const minute = v.match(/(\d+(?:\.\d+)?)\s*m/)
  if (minute?.[1]) return round1(Number(minute[1]) / 60)
  const hms = v.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/)
  if (hms?.[1] && hms[2]) {
    return round1(Number(hms[1]) + Number(hms[2]) / 60 + Number(hms[3] || 0) / 3600)
  }
  return null
}

function excludedIntakeStatus(status: string, includePendingCancel = false): boolean {
  const rx = includePendingCancel ? /cancel|pending cancel|ror|lost|arc|hold/i : /cancel|ror|lost|hold/i
  return rx.test(status || '')
}

function olderThan(today: string, date: string, days: number): boolean {
  if (!date) return false
  return daysSince(today, date) >= days
}

function normalizeIntakeProject(record: QbRecord, today: string): IntakeProjectRow | null {
  const recordId = parseInt(qv(record, PF.recordId), 10)
  if (!Number.isFinite(recordId) || recordId <= 0) return null
  const status = qv(record, PF.status)
  const intakeStatus = qv(record, PF.intakeStatus)
  const lastFinished = qv(record, PF.maxIntakeFinished)
  const missing = qv(record, PF.missingItems)
  let phase = 'in_process'
  let phaseLabel = 'In Process'
  if (intakeStatus === 'In Queue') {
    phase = 'ready'
    phaseLabel = 'Ready for Intake'
  } else if (intakeStatus === 'Rejected') {
    phase = status === 'Rejected' ? 'rejected_stale' : 'rejected'
    phaseLabel = status === 'Rejected' ? 'Rejected Intake' : 'Rejected'
  } else if (intakeStatus === 'Processing') {
    phase = 'processing'
    phaseLabel = 'Processing'
  }
  const salesDate = qv(record, PF.salesDate)
  const firstPassStarted = qv(record, PF.firstPassStarted)
  const firstPassComplete = qv(record, PF.firstPassComplete)
  const firstPassDisposition = qv(record, PF.firstPassDisposition)
  const firstPassProcessingTime = qv(record, PF.firstPassProcessingTime)
  const firstPassRejected = /reject/i.test(firstPassDisposition)
  const completeHours = hoursBetween(firstPassStarted, firstPassComplete) ?? durationHours(firstPassProcessingTime)
  const firstPassMissingItems = qv(record, PF.firstPassMissingItems)
  return {
    record_id: recordId,
    customer_name: qv(record, PF.customerName) || 'Unknown customer',
    state: qv(record, PF.state),
    sales_office: qv(record, PF.salesOffice),
    lender: qv(record, PF.lender),
    closer: qv(record, PF.closer),
    system_size_kw: numberValue(qv(record, PF.systemSizeKw)),
    project_status: status,
    intake_status: intakeStatus,
    sales_date: salesDate,
    intake_progress: progressPct(qv(record, PF.intakeProgress)),
    missing_items: missing,
    missing_items_list: splitItems(missing),
    first_pass_user: qv(record, PF.firstPassUser),
    first_pass_missing_items: firstPassMissingItems,
    first_pass_missing_items_list: splitItems(firstPassMissingItems),
    first_pass_disposition: firstPassDisposition,
    first_pass_complete: firstPassComplete,
    first_pass_processing_time: firstPassProcessingTime,
    first_pass_started: firstPassStarted,
    intake_start_hours: hoursBetween(salesDate, firstPassStarted),
    intake_complete_hours: completeHours,
    first_pass_success: isSet(firstPassComplete) && !firstPassRejected,
    first_pass_rejected: firstPassRejected,
    max_intake_finished: lastFinished,
    hours_since_last_event: hoursSince(today, lastFinished),
    surrender_reference_date: qv(record, PF.surrenderReferenceDate),
    age_days: daysSince(today, salesDate),
    project_url: qbRecordUrl(PROJECTS_TABLE, recordId),
    phase,
    phase_label: phaseLabel,
  }
}

function eventCompletionPct(record: QbRecord): number {
  const statusFids = [40, 46, 48, 55, 58, 61, 67]
  const approved = statusFids.filter(fid => /approve/i.test(qv(record, fid))).length
  return Math.round((approved / statusFids.length) * 100)
}

function normalizeProcessingEvent(record: QbRecord, today: string): ProcessingEventRow | null {
  const recordId = parseInt(qv(record, 3), 10)
  if (!Number.isFinite(recordId) || recordId <= 0) return null
  const projectRid = parseInt(qv(record, 36), 10)
  const started = qv(record, 72)
  return {
    record_id: recordId,
    project_rid: Number.isFinite(projectRid) && projectRid > 0 ? projectRid : null,
    customer_name: qv(record, 106) || 'Unknown customer',
    project_status: qv(record, 210),
    started_processing: started,
    date_created: qv(record, 1),
    age_hours: hoursSince(today, started || qv(record, 1)),
    completion_pct: eventCompletionPct(record),
    project_url: Number.isFinite(projectRid) && projectRid > 0 ? qbRecordUrl(PROJECTS_TABLE, projectRid) : '',
    intake_event_url: qbRecordUrl(INTAKE_TABLE, recordId),
  }
}

type IntakeDimension = 'closer' | 'salesOffice' | 'lender' | 'state'

const intakeDimensions: IntakeDimension[] = ['closer', 'salesOffice', 'lender', 'state']

function dimensionValue(row: IntakeProjectRow, dimension: IntakeDimension): string {
  if (dimension === 'salesOffice') return row.sales_office || 'Unknown'
  return (row[dimension] || 'Unknown') as string
}

function isProjectReportable(row: IntakeProjectRow): boolean {
  return !excludedIntakeStatus(row.project_status, true)
}

function firstPassCompleted(row: IntakeProjectRow): boolean {
  return isSet(row.first_pass_complete)
}

function rejectedByIntake(row: IntakeProjectRow): boolean {
  return row.first_pass_rejected || /reject/i.test(row.intake_status) || /reject/i.test(row.project_status)
}

function intakeThroughput(projects: IntakeProjectRow[], from?: string, to?: string) {
  const granularity = intakeGranularity(from, to)
  const map = new Map<string, { period: string; requested: number; processed: number }>()
  function ensure(period: string) {
    let row = map.get(period)
    if (!row) {
      row = { period, requested: 0, processed: 0 }
      map.set(period, row)
    }
    return row
  }
  for (const row of projects.filter(isProjectReportable)) {
    if (inOptionalRange(row.sales_date, from, to)) {
      const period = intakePeriodKey(row.sales_date, granularity)
      if (period) ensure(period).requested += 1
    }
    if (inOptionalRange(row.first_pass_complete, from, to)) {
      const period = intakePeriodKey(row.first_pass_complete, granularity)
      if (period) ensure(period).processed += 1
    }
  }
  return [...map.values()].sort((a, b) => a.period.localeCompare(b.period))
}

function intakePivots(projects: IntakeProjectRow[], from?: string, to?: string) {
  const sold = projects.filter(row => isProjectReportable(row) && inOptionalRange(row.sales_date, from, to))
  const out: Record<IntakeDimension, Array<Record<string, number | string>>> = {
    closer: [],
    salesOffice: [],
    lender: [],
    state: [],
  }
  for (const dimension of intakeDimensions) {
    const map = new Map<string, {
      dimension_value: string
      sold_count: number
      sold_kw: number
      kca_count: number
      kca_kw: number
      first_pass_count: number
    }>()
    for (const row of sold) {
      const key = dimensionValue(row, dimension)
      let agg = map.get(key)
      if (!agg) {
        agg = { dimension_value: key, sold_count: 0, sold_kw: 0, kca_count: 0, kca_kw: 0, first_pass_count: 0 }
        map.set(key, agg)
      }
      agg.sold_count += 1
      agg.sold_kw += row.system_size_kw || 0
      if (firstPassCompleted(row)) {
        agg.kca_count += 1
        agg.kca_kw += row.system_size_kw || 0
        if (row.first_pass_success) agg.first_pass_count += 1
      }
    }
    out[dimension] = [...map.values()]
      .map(row => ({
        ...row,
        sold_kw: round1(row.sold_kw),
        kca_kw: round1(row.kca_kw),
        first_pass_pct: safePct(row.first_pass_count, row.kca_count),
        kca_pct: safePct(row.kca_count, row.sold_count),
      }))
      .sort((a, b) => Number(b.sold_count) - Number(a.sold_count) || String(a.dimension_value).localeCompare(String(b.dimension_value)))
      .slice(0, 75)
  }
  return out
}

function rejectionReasons(projects: IntakeProjectRow[], from?: string, to?: string) {
  const rows = projects.filter(row =>
    isProjectReportable(row) &&
    row.first_pass_rejected &&
    inOptionalRange(row.first_pass_complete || row.sales_date, from, to)
  )
  const map = new Map<string, number>()
  for (const row of rows) {
    const reasons = row.first_pass_missing_items_list.length
      ? row.first_pass_missing_items_list
      : splitItems(row.first_pass_disposition || 'Rejected - reason not recorded')
    for (const reason of reasons.length ? reasons : ['Rejected - reason not recorded']) {
      map.set(reason, (map.get(reason) || 0) + 1)
    }
  }
  return [...map.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 12)
}

function intakePerformanceKpi(projects: IntakeProjectRow[], from?: string, to?: string) {
  const reportable = projects.filter(isProjectReportable)
  const sold = reportable.filter(row => inOptionalRange(row.sales_date, from, to))
  const completedSold = sold.filter(firstPassCompleted)
  const processedWindow = reportable.filter(row => inOptionalRange(row.first_pass_complete, from, to))
  const rejectedSold = sold.filter(rejectedByIntake)
  const uniqueProjects = new Set(sold.map(row => row.record_id)).size
  const avgStartHours = meanRounded(sold.map(row => row.intake_start_hours), 1)
  const avgCompleteHours = meanRounded(completedSold.map(row => row.intake_complete_hours), 1)
  return {
    uniqueProjects,
    requested: sold.length,
    processed: processedWindow.length,
    intakeCompleted: completedSold.length,
    intakeCompletedPct: safePct(completedSold.length, sold.length),
    rejectedStatus: rejectedSold.length,
    avgTimeToStartHours: avgStartHours,
    avgTimeToStartDays: round1(avgStartHours / 24),
    avgStartToCompleteHours: avgCompleteHours,
    avgStartToCompleteDays: round1(avgCompleteHours / 24),
    firstPassPct: safePct(completedSold.filter(row => row.first_pass_success).length, completedSold.length),
    soldKw: round1(sold.reduce((sum, row) => sum + (row.system_size_kw || 0), 0)),
    kcaKw: round1(completedSold.reduce((sum, row) => sum + (row.system_size_kw || 0), 0)),
  }
}

function intakeManagerSummary(projects: IntakeProjectRow[], processingEvents: ProcessingEventRow[], today: string, from?: string, to?: string) {
  const reportable = projects.filter(isProjectReportable)
  const ready = reportable.filter(row => row.intake_status === 'In Queue')
  const inProcess = reportable.filter(row => ['In Queue', 'Processing', 'Rejected'].includes(row.intake_status))
  const rejected = projects.filter(row =>
    row.project_status === 'Rejected' &&
    !['Surrendered', 'Complete'].includes(row.intake_status) &&
    (row.hours_since_last_event ?? 0) > 36
  )
  const surrenderable = projects.filter(row =>
    row.intake_status === 'Rejected' &&
    !excludedIntakeStatus(row.project_status, true) &&
    (olderThan(today, row.surrender_reference_date, 7) || (!row.surrender_reference_date && olderThan(today, row.sales_date, 10)))
  )

  return {
    kpi: {
      ready: ready.length,
      processing: processingEvents.length,
      rejected: rejected.length,
      inProcess: inProcess.length,
      surrenderable: surrenderable.length,
      avgProgress: inProcess.length
        ? Math.round(inProcess.reduce((sum, row) => sum + (row.intake_progress ?? 0), 0) / inProcess.length)
        : 0,
    },
    performanceKpi: intakePerformanceKpi(projects, from, to),
    charts: {
      intakeThroughput: intakeThroughput(projects, from, to),
    },
    pivots: intakePivots(projects, from, to),
    rejectionReasons: rejectionReasons(projects, from, to),
    queues: [
      { key: 'ready', label: 'Ready for Intake', description: 'In Queue, Kin, non-cancel status', tone: 'info', count: ready.length, rows: ready },
      { key: 'processingEvents', label: 'Processing', description: 'Live Intake Events currently processing', tone: 'teal', count: processingEvents.length, rows: processingEvents },
      { key: 'rejected', label: 'Rejected Intake', description: 'Project rejected and idle >36 hours', tone: 'danger', count: rejected.length, rows: rejected },
      { key: 'inProcess', label: 'All In-Process', description: 'In Queue, Processing, or Rejected intake status', tone: 'warning', count: inProcess.length, rows: inProcess },
      { key: 'surrenderable', label: 'Ready for Surrender', description: 'Rejected intake aged past surrender threshold', tone: 'danger', count: surrenderable.length, rows: surrenderable },
    ],
    lists: {
      ready,
      processingEvents,
      rejected,
      inProcess,
      surrenderable,
    },
  }
}

function filterFailedRuns(rows: FailedRun[], req: Request): FailedRun[] {
  const status = String(req.query['retry_status'] || '')
  const phase = String(req.query['phase'] || '')
  const from = String(req.query['date_from'] || '')
  const to = String(req.query['date_to'] || '')
  const search = String(req.query['search'] || '').trim().toLowerCase()

  return rows.filter(row => {
    if (status && row.retry_status !== status) return false
    if (phase && row.phase !== phase) return false
    if ((from || to) && !inRange(row.date_created, from || undefined, to || undefined)) return false
    if (search) {
      const haystack = [
        row.record_id,
        row.customer_name,
        row.enerflo_record_id,
        row.enerflo_install_id,
        row.error_summary,
        row.zapier_run_id,
        row.org_id_created,
        row.contact_id_created,
        row.project_id_created,
        row.junction_id_created,
      ].join(' ').toLowerCase()
      if (!haystack.includes(search)) return false
    }
    return true
  })
}

const failedRunQueues: QueueDef[] = [
  { key: 'pending', label: 'Pending Retry', description: 'Ready for an operator to review and trigger', tone: 'warning', predicate: r => r.phase === 'pending' },
  { key: 'triggered', label: 'Retry Triggered', description: 'Checkbox is set; Zap should pick these up', tone: 'info', predicate: r => r.phase === 'triggered' },
  { key: 'partial', label: 'Partial Create', description: 'Some QB records exist; retry should skip those', tone: 'teal', predicate: r => r.phase === 'partial' },
  { key: 'failedAgain', label: 'Failed Again', description: 'Retried but still has errors', tone: 'danger', predicate: r => r.phase === 'failed_again' },
  { key: 'resolved', label: 'Resolved', description: 'Retry or manual fix completed', tone: 'success', predicate: r => r.phase === 'resolved' },
  { key: 'ignored', label: 'Ignored', description: 'No replay needed', tone: 'neutral', predicate: r => r.phase === 'ignored' },
]

function queueSummary(rows: FailedRun[]) {
  return failedRunQueues.map(q => {
    const items = rows.filter(q.predicate)
    return {
      key: q.key,
      label: q.label,
      description: q.description,
      tone: q.tone,
      count: items.length,
      oldest: items.reduce((max, row) => Math.max(max, row.age_days), 0),
      avgAge: items.length ? round1(items.reduce((sum, row) => sum + row.age_days, 0) / items.length) : 0,
      partial: items.filter(row => row.partial_create).length,
    }
  })
}

function statusCounts(rows: FailedRun[]) {
  const map = new Map<string, number>()
  for (const row of rows) map.set(row.retry_status, (map.get(row.retry_status) || 0) + 1)
  return [...map.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status))
}

function throughputRows(rows: FailedRun[], from?: string, to?: string) {
  const weekly = !!(from && to && (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000 <= 90)
  const map = new Map<string, { period: string; failed: number; triggered: number; resolved: number; failedAgain: number }>()
  function ensure(period: string) {
    let row = map.get(period)
    if (!row) {
      row = { period, failed: 0, triggered: 0, resolved: 0, failedAgain: 0 }
      map.set(period, row)
    }
    return row
  }

  for (const row of rows) {
    if (inRange(row.date_created, from, to)) {
      const period = periodKey(row.date_created, weekly)
      if (period) ensure(period).failed += 1
    }
    if (row.retry_triggered && inRange(row.date_modified || row.date_created, from, to)) {
      const period = periodKey(row.date_modified || row.date_created, weekly)
      if (period) ensure(period).triggered += 1
    }
    if (row.phase === 'resolved' && inRange(row.date_modified || row.date_created, from, to)) {
      const period = periodKey(row.date_modified || row.date_created, weekly)
      if (period) ensure(period).resolved += 1
    }
    if (row.phase === 'failed_again' && inRange(row.date_modified || row.date_created, from, to)) {
      const period = periodKey(row.date_modified || row.date_created, weekly)
      if (period) ensure(period).failedAgain += 1
    }
  }
  return [...map.values()].sort((a, b) => a.period.localeCompare(b.period))
}

function createdRecordMix(rows: FailedRun[]) {
  return [
    { key: 'org', label: 'Org', count: rows.filter(r => isSet(r.org_id_created)).length },
    { key: 'contact', label: 'Contact', count: rows.filter(r => isSet(r.contact_id_created)).length },
    { key: 'project', label: 'Project', count: rows.filter(r => isSet(r.project_id_created)).length },
    { key: 'junction', label: 'Junction', count: rows.filter(r => isSet(r.junction_id_created)).length },
  ]
}

function sampleList(rows: FailedRun[], limit = 250): FailedRun[] {
  return rows
    .slice()
    .sort((a, b) => {
      const phaseWeight: Record<string, number> = {
        failed_again: 0,
        partial: 1,
        pending: 2,
        triggered: 3,
        retried: 4,
        resolved: 5,
        ignored: 6,
      }
      return (phaseWeight[a.phase] ?? 9) - (phaseWeight[b.phase] ?? 9)
        || b.age_days - a.age_days
        || b.record_id - a.record_id
    })
    .slice(0, limit)
}

// GET /api/intake/failed-runs
// Live QB-backed analytics for the Sale Intake Failed Runs table.
router.get('/failed-runs', async (req: Request, res: Response): Promise<void> => {
  try {
    const today = String(req.query['today'] || new Date().toISOString().slice(0, 10))
    const from = String(req.query['date_from'] || '')
    const to = String(req.query['date_to'] || '')
    const force = req.query['fresh'] === '1'
    const { realm } = getQbConfig()
    const [fetched, managerFetched] = await Promise.all([
      fetchFailedRunRecords(force),
      fetchIntakeManagerRecords(force, from, to),
    ])
    const allRows = fetched.rows
      .map(record => normalizeFailedRun(record, realm, today))
      .filter((row): row is FailedRun => row !== null)
    const managerProjects = managerFetched.projects
      .map(record => normalizeIntakeProject(record, today))
      .filter((row): row is IntakeProjectRow => row !== null)
    const processingEvents = managerFetched.processingEvents
      .map(record => normalizeProcessingEvent(record, today))
      .filter((row): row is ProcessingEventRow => row !== null)
    const manager = intakeManagerSummary(managerProjects, processingEvents, today, from || undefined, to || undefined)

    const filtered = filterFailedRuns(allRows, req)
    const inWindow = filtered.filter(row => inRange(row.date_created, from || undefined, to || undefined))
    const activeRows = filtered.filter(row => !['resolved', 'ignored'].includes(row.phase))
    const readyRows = filtered.filter(row => row.retryable && !row.retry_triggered)
    const triggeredRows = filtered.filter(row => row.phase === 'triggered')
    const failedAgainRows = filtered.filter(row => row.phase === 'failed_again')
    const resolvedWindow = filtered.filter(row => row.phase === 'resolved' && inRange(row.date_modified || row.date_created, from || undefined, to || undefined))
    const failedAgainWindow = filtered.filter(row => row.phase === 'failed_again' && inRange(row.date_modified || row.date_created, from || undefined, to || undefined))
    const outcomeTotal = resolvedWindow.length + failedAgainWindow.length

    const retryStatuses = [...new Set(allRows.map(row => row.retry_status).filter(Boolean))].sort()
    const phases = [...new Set(allRows.map(row => row.phase_label).filter(Boolean))].sort()

    res.json({
      kpi: {
        total: allRows.length,
        inWindow: inWindow.length,
        active: activeRows.length,
        ready: readyRows.length,
        triggered: triggeredRows.length,
        failedAgain: failedAgainRows.length,
        partial: activeRows.filter(row => row.partial_create).length,
        resolvedWindow: resolvedWindow.length,
        retrySuccessPct: outcomeTotal ? Math.round((resolvedWindow.length / outcomeTotal) * 100) : 0,
        oldestActive: activeRows.reduce((max, row) => Math.max(max, row.age_days), 0),
      },
      queues: queueSummary(filtered),
      charts: {
        throughput: throughputRows(filtered, from || undefined, to || undefined),
        status: statusCounts(filtered),
        createdRecords: createdRecordMix(filtered),
      },
      intakeManager: manager,
      lists: {
        rows: sampleList(filtered),
        active: sampleList(activeRows),
        pending: sampleList(filtered.filter(row => row.phase === 'pending')),
        triggered: sampleList(triggeredRows),
        partial: sampleList(filtered.filter(row => row.phase === 'partial')),
        failedAgain: sampleList(failedAgainRows),
        resolved: sampleList(filtered.filter(row => row.phase === 'resolved')),
        ignored: sampleList(filtered.filter(row => row.phase === 'ignored')),
      },
      filters: {
        retryStatuses,
        phases,
      },
      meta: {
        source: FAILED_RUNS_TABLE,
        managerSource: PROJECTS_TABLE,
        total: allRows.length,
        filtered: filtered.length,
        fetchedAt: fetched.fetchedAt > managerFetched.fetchedAt ? fetched.fetchedAt : managerFetched.fetchedAt,
        cacheTtlSeconds: Math.round(FAILED_RUNS_TTL_MS / 1000),
      },
    })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

// POST /api/intake/failed-runs/:id/retry
// Sets the two QB fields the Retry Zap watches:
//   Retry Triggered = true, Retry Status = Pending
router.post('/failed-runs/:id/retry', async (req: Request, res: Response): Promise<void> => {
  const recordId = parseInt(String(req.params['id'] || ''), 10)
  if (!Number.isFinite(recordId) || recordId <= 0) {
    res.status(400).json({ error: 'Valid failed-run record id is required' })
    return
  }

  try {
    const { realm, token } = getQbConfig()
    if (!token) throw new Error('QB_USER_TOKEN not configured')

    const current = await fetch('https://api.quickbase.com/v1/records/query', {
      method: 'POST',
      headers: qbHeaders(realm, token),
      body: JSON.stringify({
        from: FAILED_RUNS_TABLE,
        select: FAILED_RUN_SELECT,
        where: `{'${FR.recordId}'.EX.'${recordId}'}`,
        options: { top: 1 },
      }),
    })
    if (!current.ok) {
      throw new Error(`QB failed-run lookup failed (${current.status}): ${(await current.text()).slice(0, 200)}`)
    }
    const currentJson = await current.json() as { data?: QbRecord[] }
    const row = currentJson.data?.[0] ? normalizeFailedRun(currentJson.data[0], realm, new Date().toISOString().slice(0, 10)) : null
    if (!row) {
      res.status(404).json({ error: `Failed run ${recordId} not found` })
      return
    }
    if (['resolved', 'ignored'].includes(row.phase)) {
      res.status(409).json({ error: `Failed run ${recordId} is ${row.retry_status}; retry was not triggered.` })
      return
    }

    const response = await fetch('https://api.quickbase.com/v1/records', {
      method: 'POST',
      headers: qbHeaders(realm, token),
      body: JSON.stringify({
        to: FAILED_RUNS_TABLE,
        mergeFieldId: FR.recordId,
        data: [{
          [String(FR.recordId)]: { value: recordId },
          [String(FR.retryTriggered)]: { value: true },
          [String(FR.retryStatus)]: { value: 'Pending' },
        }],
        fieldsToReturn: [FR.recordId, FR.retryStatus, FR.retryTriggered, FR.dateModified],
      }),
    })
    const qbJson = await response.json()
    if (!response.ok) {
      res.status(response.status).json({ error: 'QB retry update failed', details: qbJson })
      return
    }

    failedRunsCache = null
    res.json({ ok: true, record_id: recordId, qb: qbJson })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

// GET /api/intake?project_id=N
//   ?live=1 (default) refreshes from QB before responding. Same shape as
//   the other per-project caches (notes, adders, attachments).
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const projectId = parseInt(String(req.query['project_id'] || ''), 10)
  if (!Number.isFinite(projectId) || projectId <= 0) {
    res.status(400).json({ error: 'project_id is required' })
    return
  }
  const live = req.query['live'] !== '0'
  try {
    if (live) {
      try { await refreshForProject(projectId) }
      catch (e) {
        console.error('[intake] live refresh failed:', e instanceof Error ? e.message : e)
      }
    }
    const items = db.prepare(`
      SELECT record_id, project_rid, date_created, date_modified, last_modified_by,
             install_agreement, finance, finance_missing_items,
             utility_bill, consumption_audit, site_survey, welcome_call, adders
      FROM intake_event_cache
      WHERE project_rid = ?
      ORDER BY date_created ASC, record_id ASC
    `).all(projectId)
    res.json({ items, count: items.length })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

export { router as intakeRouter }
