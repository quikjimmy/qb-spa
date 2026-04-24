import db from '../db'
import { decryptSecret } from './crypto'

// Dialpad Stats API client.
// Flow is two-step async: POST /api/v2/stats kicks off a job, GET /api/v2/stats/{id}
// polls until status=complete, then fetches the CSV at download_url.
// Rate limits from the docs: 200 POST/hr, 1200 GET/min. Results are cached by
// Dialpad (30 min for is_today, 3 hours for days_ago) so back-to-back identical
// POSTs return the same request_id.

const DIALPAD_BASE = 'https://dialpad.com/api/v2'

export interface DialpadConfig {
  apiKey: string
  officeId: string | null
}

export interface StatsRequestParams {
  // Enum verified against the official Dialpad Python SDK
  // (github.com/dialpad/dialpad-python-sdk): calls | csat | dispositions |
  // onduty | recordings | screenshare | texts | voicemails.
  // NOTE: SMS aggregates are named `texts` here (not `sms`) in the Stats API.
  // Our primary SMS path hits the records endpoint `/api/v2/sms` via
  // fetchSmsRecords — use `texts` here only if you want the pre-aggregated
  // Stats-API route.
  stat_type: 'calls' | 'onduty' | 'csat' | 'dispositions' | 'recordings' | 'screenshare' | 'texts' | 'voicemails'
  export_type: 'records' | 'stats'
  days_ago_start?: number
  days_ago_end?: number
  is_today?: boolean
  office_id?: string | number | null
  target_id?: string | number
  target_type?: 'office' | 'department' | 'callcenter' | 'user' | 'room' | 'staffgroup' | 'coachinggroup' | 'coachingteam' | 'ivrworkflow'
  group_by?: 'date' | 'group' | 'user'
  timezone?: string
  coaching_group?: boolean
  coaching_team?: boolean
}

export interface CsvRow { [col: string]: string }

export class DialpadError extends Error {
  constructor(message: string, public status?: number, public body?: string) {
    super(message)
    this.name = 'DialpadError'
  }
}

export function loadDialpadConfig(): DialpadConfig | null {
  const row = db.prepare(
    `SELECT api_key_encrypted, office_id FROM dialpad_config WHERE id = 1`
  ).get() as { api_key_encrypted: string | null; office_id: string | null } | undefined
  if (!row || !row.api_key_encrypted) return null
  try {
    return { apiKey: decryptSecret(row.api_key_encrypted), officeId: row.office_id || null }
  } catch {
    return null
  }
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
}

export async function initiateStatsExport(
  cfg: DialpadConfig,
  params: StatsRequestParams,
): Promise<{ request_id: string; already_started: boolean }> {
  const body: Record<string, unknown> = {
    stat_type: params.stat_type,
    export_type: params.export_type,
    timezone: params.timezone || 'UTC',
  }
  if (params.is_today) body['is_today'] = true
  else {
    body['days_ago_start'] = params.days_ago_start ?? 1
    body['days_ago_end'] = params.days_ago_end ?? 7
  }
  if (params.group_by) body['group_by'] = params.group_by
  // target overrides office per docs — let the caller decide which to pass
  if (params.target_id && params.target_type) {
    body['target_id'] = params.target_id
    body['target_type'] = params.target_type
  } else if (params.office_id ?? cfg.officeId) {
    body['office_id'] = params.office_id ?? cfg.officeId
  }
  if (params.coaching_group) body['coaching_group'] = true
  if (params.coaching_team) body['coaching_team'] = true

  const res = await fetch(`${DIALPAD_BASE}/stats`, {
    method: 'POST',
    headers: { ...authHeaders(cfg.apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new DialpadError(`POST /stats failed`, res.status, text.slice(0, 800))
  let json: { request_id?: string; already_started?: boolean }
  try { json = JSON.parse(text) } catch { throw new DialpadError('POST /stats returned non-JSON', res.status, text.slice(0, 800)) }
  if (!json.request_id) throw new DialpadError('POST /stats missing request_id', res.status, text.slice(0, 800))
  return { request_id: json.request_id, already_started: !!json.already_started }
}

export async function pollStatsResult(
  cfg: DialpadConfig,
  requestId: string,
  opts: { maxWaitMs?: number; intervalMs?: number } = {},
): Promise<{ download_url: string; file_type: string }> {
  // Docs: wait 15-20s before first GET, then poll every 5-10s. Don't hammer.
  const maxWait = opts.maxWaitMs ?? 180_000 // 3 minutes — fine for a week-wide calls export
  const interval = opts.intervalMs ?? 7_000
  const start = Date.now()
  let firstPoll = true

  while (Date.now() - start < maxWait) {
    if (firstPoll) {
      await sleep(15_000)
      firstPoll = false
    } else {
      await sleep(interval)
    }
    const res = await fetch(`${DIALPAD_BASE}/stats/${encodeURIComponent(requestId)}`, {
      method: 'GET',
      headers: authHeaders(cfg.apiKey),
    })
    const text = await res.text()
    if (!res.ok) throw new DialpadError(`GET /stats/${requestId} failed`, res.status, text.slice(0, 800))
    let json: { status?: string; download_url?: string; file_type?: string }
    try { json = JSON.parse(text) } catch { throw new DialpadError('GET /stats returned non-JSON', res.status, text.slice(0, 800)) }
    if (json.status === 'complete' && json.download_url) {
      return { download_url: json.download_url, file_type: json.file_type || 'csv' }
    }
    if (json.status === 'failed') throw new DialpadError(`Dialpad reported status=failed for ${requestId}`)
  }
  throw new DialpadError(`Polling timed out after ${maxWait}ms for request ${requestId}`)
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }

// Minimal CSV parser that handles quoted fields, escaped quotes, and CRLF/LF.
// Good enough for Dialpad's exports; not a general-purpose parser.
export function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += c; i++; continue
    }
    if (c === '"') { inQuotes = true; i++; continue }
    if (c === ',') { row.push(field); field = ''; i++; continue }
    if (c === '\r') { i++; continue }
    if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; i++; continue }
    field += c; i++
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }

  if (rows.length === 0) return []
  const header = rows[0]!.map(h => h.trim())
  const out: CsvRow[] = []
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!
    if (cells.length === 1 && cells[0] === '') continue // skip blank trailing row
    const obj: CsvRow = {}
    for (let c = 0; c < header.length; c++) obj[header[c]!] = cells[c] ?? ''
    out.push(obj)
  }
  return out
}

export async function fetchCsv(url: string): Promise<CsvRow[]> {
  // Dialpad's download_url is a pre-signed URL — no auth header needed, and
  // adding one sometimes breaks S3-style signed requests.
  const res = await fetch(url)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new DialpadError(`CSV download failed`, res.status, text.slice(0, 500))
  }
  const text = await res.text()
  return parseCsv(text)
}

// Convenience: POST + poll + CSV fetch in one call.
export async function runStatsExport(cfg: DialpadConfig, params: StatsRequestParams): Promise<{
  rows: CsvRow[]
  request_id: string
  already_started: boolean
}> {
  const { request_id, already_started } = await initiateStatsExport(cfg, params)
  const { download_url } = await pollStatsResult(cfg, request_id)
  const rows = await fetchCsv(download_url)
  return { rows, request_id, already_started }
}

// ── SMS records fetch ───────────────────────────────────
// Dialpad's Stats API does NOT expose SMS as a stat_type, so SMS aggregates go
// through the regular records endpoint GET /api/v2/sms. It's paginated via a
// cursor param and returns JSON (not CSV). We normalize the objects into the
// same CsvRow shape the classifier/aggregator expects.
export interface SmsFetchOptions {
  startEpochSec?: number   // inclusive; Dialpad accepts epoch seconds via start_time
  endEpochSec?: number     // inclusive; epoch seconds via end_time
  limit?: number           // page size, cap 1000 per docs
  maxPages?: number        // safety cap so one run can't spin forever
}

export async function fetchSmsRecords(cfg: DialpadConfig, opts: SmsFetchOptions = {}): Promise<CsvRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 500, 25), 1000)
  const maxPages = opts.maxPages ?? 20
  let cursor: string | undefined
  const all: CsvRow[] = []
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams()
    qs.set('limit', String(limit))
    if (opts.startEpochSec) qs.set('start_time', String(opts.startEpochSec))
    if (opts.endEpochSec) qs.set('end_time', String(opts.endEpochSec))
    if (cursor) qs.set('cursor', cursor)
    const res = await fetch(`${DIALPAD_BASE}/sms?${qs}`, { headers: authHeaders(cfg.apiKey) })
    const text = await res.text()
    if (!res.ok) throw new DialpadError(`GET /sms failed`, res.status, text.slice(0, 800))
    let body: { items?: Array<Record<string, unknown>>; cursor?: string }
    try { body = JSON.parse(text) } catch { throw new DialpadError('GET /sms returned non-JSON', res.status, text.slice(0, 500)) }
    const items = body.items || []
    for (const it of items) all.push(flattenSmsRow(it))
    if (!body.cursor || items.length === 0) break
    cursor = body.cursor
  }
  return all
}

// Flatten Dialpad's SMS record into a flat string map matching our CsvRow
// shape. Handles nested user objects with { id, name, email } structure — a
// common Dialpad pattern.
function flattenSmsRow(item: Record<string, unknown>): CsvRow {
  const out: CsvRow = {}
  for (const [k, v] of Object.entries(item)) {
    if (v === null || v === undefined) continue
    if (typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (v2 === null || v2 === undefined) continue
        out[`${k}_${k2}`] = String(v2)
      }
    } else if (Array.isArray(v)) {
      out[k] = v.join(',')
    } else {
      out[k] = String(v)
    }
  }
  return out
}
