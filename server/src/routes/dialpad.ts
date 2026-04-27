import { Router, type Request, type Response } from 'express'
import crypto from 'crypto'
import db from '../db'
import { encryptSecret, decryptSecret, previewSecret } from '../lib/crypto'
import { loadDialpadConfig, runStatsExport, fetchSmsRecords, DialpadError, type CsvRow } from '../lib/dialpad'
import { attachSseStream, type DialpadEvent } from '../lib/dialpadEvents'

const router = Router()

interface ConfigRow {
  api_key_encrypted: string | null
  office_id: string | null
  last_tested_at: string | null
  last_test_ok: number | null
  last_test_error: string | null
  updated_at: string
}

function getConfigRow(): ConfigRow {
  return db.prepare(`SELECT * FROM dialpad_config WHERE id = 1`).get() as ConfigRow
}

function publicConfigShape(row: ConfigRow) {
  const plain = row.api_key_encrypted ? (() => { try { return decryptSecret(row.api_key_encrypted!) } catch { return '' } })() : ''
  return {
    connected: !!row.api_key_encrypted,
    office_id: row.office_id || '',
    key_preview: plain ? previewSecret(plain) : null,
    last_tested_at: row.last_tested_at,
    last_test_ok: row.last_test_ok === 1 ? true : row.last_test_ok === 0 ? false : null,
    last_test_error: row.last_test_error,
    updated_at: row.updated_at,
  }
}

// ── Config: GET / PUT / DELETE / test ───────────────────

router.get('/config', (_req: Request, res: Response): void => {
  res.json(publicConfigShape(getConfigRow()))
})

router.put('/config', (req: Request, res: Response): void => {
  const { api_key, office_id } = req.body as { api_key?: string; office_id?: string }
  const sets: string[] = []
  const params: unknown[] = []
  if (api_key !== undefined) {
    if (typeof api_key !== 'string') { res.status(400).json({ error: 'api_key must be a string' }); return }
    const trimmed = api_key.trim()
    if (trimmed === '') { sets.push('api_key_encrypted = NULL') }
    else { sets.push('api_key_encrypted = ?'); params.push(encryptSecret(trimmed)) }
  }
  if (office_id !== undefined) {
    sets.push('office_id = ?')
    params.push(String(office_id || '').trim() || null)
  }
  if (sets.length === 0) { res.status(400).json({ error: 'nothing to update' }); return }
  sets.push(`updated_at = datetime('now')`)
  db.prepare(`UPDATE dialpad_config SET ${sets.join(', ')} WHERE id = 1`).run(...params)
  res.json(publicConfigShape(getConfigRow()))
})

router.delete('/config', (_req: Request, res: Response): void => {
  db.prepare(`UPDATE dialpad_config SET api_key_encrypted = NULL, updated_at = datetime('now') WHERE id = 1`).run()
  res.json(publicConfigShape(getConfigRow()))
})

router.post('/config/test', async (_req: Request, res: Response): Promise<void> => {
  const cfg = loadDialpadConfig()
  if (!cfg) { res.status(400).json({ ok: false, error: 'No Dialpad API key configured' }); return }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10_000)
    const r = await fetch('https://dialpad.com/api/v2/users?limit=1', {
      headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: 'application/json' },
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!r.ok) {
      const text = (await r.text()).slice(0, 400)
      const err = `HTTP ${r.status}: ${text || r.statusText}`
      db.prepare(`UPDATE dialpad_config SET last_tested_at = datetime('now'), last_test_ok = 0, last_test_error = ? WHERE id = 1`).run(err)
      res.json({ ok: false, error: err })
      return
    }
    db.prepare(`UPDATE dialpad_config SET last_tested_at = datetime('now'), last_test_ok = 1, last_test_error = NULL WHERE id = 1`).run()
    res.json({ ok: true })
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    db.prepare(`UPDATE dialpad_config SET last_tested_at = datetime('now'), last_test_ok = 0, last_test_error = ? WHERE id = 1`).run(err)
    res.json({ ok: false, error: err })
  }
})

// ── CSV column helpers ──────────────────────────────────
// Dialpad's column naming varies by export type/plan, so every access goes
// through these helpers with a list of plausible aliases.

function pick(row: CsvRow, keys: string[]): string {
  const lowerRow: Record<string, string> = {}
  for (const k of Object.keys(row)) lowerRow[k.toLowerCase()] = row[k] ?? ''
  for (const k of keys) {
    const v = lowerRow[k.toLowerCase()]
    if (v !== undefined && v !== '') return v
  }
  return ''
}
function parseIntSafe(v: string): number {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : 0
}
function toDateOnly(v: string): string {
  if (!v) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v
  const m = v.match(/^(\d{4}-\d{2}-\d{2})/)
  if (m) return m[1]!
  const d = new Date(v)
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  return ''
}

// ── Call classification ─────────────────────────────────

export type CallBucket =
  | 'in_answered' | 'in_missed' | 'in_abandoned' | 'in_voicemail'
  | 'in_transfer_unanswered' | 'in_callback_requested'
  | 'out_connected' | 'out_cancelled' | 'out_callback_attempt'
  | 'other'

// Classify a single call row into exactly one leaf bucket. All rollups
// (inbound_total, outbound_total, unanswered, user_initiated, etc.) are sums
// of leaves, so a call never double-counts.
//
// Real Dialpad CSV shape (verified against an export):
//   direction     = 'inbound' | 'outbound'
//   category      = 'incoming' | 'outgoing' | 'missed' (singular, lower granularity)
//   categories    = comma-separated granular tags, e.g.:
//     inbound answered:          "answered,human_agent,inbound"
//     inbound missed (ring out): "inbound,missed,ring_no_answer,unanswered"
//     inbound missed (hangup):   "inbound,missed,unanswered"
//     inbound voicemail:         "direct_to_voicemail,inbound,missed,unanswered,voicemail"
//     outbound connected:        "human_agent,outbound,outbound_connected,user_initiated"
//   talk_duration = MINUTES (decimal), not seconds
function classifyCall(row: CsvRow): { bucket: CallBucket; direction: 'inbound' | 'outbound' | 'internal' | 'unknown' } {
  const direction = (() => {
    const d = pick(row, ['direction', 'call_direction']).toLowerCase()
    if (d.includes('outbound') || d === 'out') return 'outbound' as const
    if (d.includes('inbound') || d === 'in') return 'inbound' as const
    if (d.includes('internal')) return 'internal' as const
    return 'unknown' as const
  })()

  const tagStr = pick(row, ['categories'])
  const tags = new Set(tagStr.toLowerCase().split(/[,\s]+/).map(s => s.trim()).filter(Boolean))
  const has = (t: string) => tags.has(t)

  // Outbound branch
  if (direction === 'outbound' || has('outbound')) {
    if (has('callback_attempt') || has('callback')) return { bucket: 'out_callback_attempt', direction: 'outbound' }
    if (has('outbound_connected')) return { bucket: 'out_connected', direction: 'outbound' }
    if (has('outbound_cancelled') || has('cancelled') || has('canceled')) return { bucket: 'out_cancelled', direction: 'outbound' }
    // user_initiated without an outbound_connected tag means the call dialed
    // but never connected — still counts as user_initiated, so cancelled bucket.
    if (has('user_initiated')) return { bucket: 'out_cancelled', direction: 'outbound' }
    // Final fallback: talk_duration > 0 means someone answered.
    const talkMin = parseFloat(pick(row, ['talk_duration']))
    return { bucket: talkMin > 0 ? 'out_connected' : 'out_cancelled', direction: 'outbound' }
  }

  // Inbound branch
  if (direction === 'inbound' || has('inbound')) {
    if (has('callback_requested')) return { bucket: 'in_callback_requested', direction: 'inbound' }
    if (has('answered')) return { bucket: 'in_answered', direction: 'inbound' }
    if (has('voicemail') || has('direct_to_voicemail')) return { bucket: 'in_voicemail', direction: 'inbound' }
    if (has('abandoned')) return { bucket: 'in_abandoned', direction: 'inbound' }
    // Transfer-related (auto_transfer, forward_transfer, router_transfer, etc.)
    // Any tag containing "transfer" on an unanswered inbound = transfer bucket.
    for (const t of tags) if (t.includes('transfer')) return { bucket: 'in_transfer_unanswered', direction: 'inbound' }
    if (has('missed') || has('unanswered') || has('ring_no_answer')) return { bucket: 'in_missed', direction: 'inbound' }
    // No classifying tag — treat as answered (safe fallback for incoming with no tags set).
    return { bucket: 'in_answered', direction: 'inbound' }
  }

  return { bucket: 'other', direction }
}

// ── Aggregation: CSV → (email, date, bucket) rows ──────

interface CallAgg { count: number; talkSec: number; name: string }
// Column name order is deliberate: Dialpad's records CSV uses `email`/`name`/
// `date_started` as the primary fields; legacy/alternate names are kept as
// fallbacks so earlier aggregated rows don't break.
//
// Talk time is stored as seconds. Dialpad CSV gives `talk_duration` in MINUTES
// (decimal), so we multiply by 60. An explicit *_seconds field wins if
// present.
function aggregateCalls(rows: CsvRow[]): Map<string, { email: string; name: string; date: string; bucket: CallBucket; agg: CallAgg }> {
  const bucket = new Map<string, { email: string; name: string; date: string; bucket: CallBucket; agg: CallAgg }>()
  for (const row of rows) {
    const email = pick(row, ['email', 'user_email', 'operator_email', 'agent_email']).toLowerCase().trim()
    if (!email) continue
    const name = pick(row, ['name', 'user_name', 'operator_name', 'agent_name'])
    const date = toDateOnly(pick(row, ['date_started', 'date', 'call_date', 'date_connected', 'date_rang', 'start_time', 'initiated_at']))
    if (!date) continue
    const { bucket: leaf } = classifyCall(row)

    // Seconds variants first (win if present), then minute-denominated Dialpad field.
    const talkSeconds = parseFloat(pick(row, ['talk_duration_seconds', 'duration_seconds']))
    const talkMinutes = parseFloat(pick(row, ['talk_duration', 'talk_time', 'duration']))
    const talk = Number.isFinite(talkSeconds) && talkSeconds > 0
      ? Math.round(talkSeconds)
      : Number.isFinite(talkMinutes) && talkMinutes > 0
        ? Math.round(talkMinutes * 60)
        : 0

    const key = `${email}|${date}|${leaf}`
    let entry = bucket.get(key)
    if (!entry) {
      entry = { email, name, date, bucket: leaf, agg: { count: 0, talkSec: 0, name } }
      bucket.set(key, entry)
    }
    entry.agg.count += 1
    entry.agg.talkSec += talk
    if (name && !entry.agg.name) entry.agg.name = name
  }
  return bucket
}

interface CallRecord {
  call_id: string
  user_email: string
  user_name: string
  direction: 'inbound' | 'outbound' | 'internal' | 'unknown'
  bucket: CallBucket
  external_number: string
  started_at: string    // ISO "YYYY-MM-DD HH:MM:SS.sss" — kept as-is from Dialpad
  connected_at: string
  ended_at: string
  talk_time_sec: number
  ring_time_sec: number
  was_voicemail: boolean
  was_recorded: boolean
  was_transfer: boolean
  entry_point_target_kind: string
}

// Convert CSV rows into per-call records for the Activity Feed. One row in = one
// row out. Drops rows missing email/call_id/start_time. Same minutes→seconds
// conversion applied to talk/ring durations.
function aggregateCallRecords(rows: CsvRow[]): CallRecord[] {
  const out: CallRecord[] = []
  for (const row of rows) {
    const email = pick(row, ['email', 'user_email', 'operator_email']).toLowerCase().trim()
    if (!email) continue
    const callId = pick(row, ['call_id', 'master_call_id', 'id'])
    if (!callId) continue
    const startedAt = pick(row, ['date_started', 'date', 'start_time', 'initiated_at'])
    if (!startedAt) continue

    const { bucket, direction } = classifyCall(row)
    const tags = new Set(pick(row, ['categories']).toLowerCase().split(/[,\s]+/).filter(Boolean))
    const talkMinutes = parseFloat(pick(row, ['talk_duration', 'talk_time', 'duration'])) || 0
    const ringMinutes = parseFloat(pick(row, ['ringing_duration'])) || 0
    const talkSeconds = parseFloat(pick(row, ['talk_duration_seconds', 'duration_seconds'])) || 0

    const recordedRaw = pick(row, ['was_recorded', 'recorded', 'is_recorded']).toLowerCase()
    const wasRecorded = recordedRaw === 'true' || recordedRaw === '1' || recordedRaw === 'yes'

    out.push({
      call_id: callId,
      user_email: email,
      user_name: pick(row, ['name', 'user_name']),
      direction,
      bucket,
      external_number: pick(row, ['external_number']),
      started_at: startedAt,
      connected_at: pick(row, ['date_connected']),
      ended_at: pick(row, ['date_ended']),
      talk_time_sec: talkSeconds > 0 ? Math.round(talkSeconds) : Math.round(talkMinutes * 60),
      ring_time_sec: Math.round(ringMinutes * 60),
      was_voicemail: tags.has('voicemail') || tags.has('direct_to_voicemail'),
      was_recorded: wasRecorded,
      was_transfer: [...tags].some(t => t.includes('transfer')),
      entry_point_target_kind: pick(row, ['entry_point_target_kind']),
    })
  }
  return out
}

interface SmsAgg { count: number; name: string }
// Handles both the CSV records export from stat_type=texts AND the JSON
// records shape from /api/v2/sms. A single universal `email` column is the
// first-choice lookup; direction-specific nested fields (to_user_email /
// from_user_email) fall through second. Dates accept ISO, YYYY-MM-DD, and
// epoch sec/ms.
function aggregateSms(rows: CsvRow[]): Map<string, { email: string; name: string; date: string; direction: 'incoming' | 'outgoing' | 'unknown'; agg: SmsAgg }> {
  const bucket = new Map<string, { email: string; name: string; date: string; direction: 'incoming' | 'outgoing' | 'unknown'; agg: SmsAgg }>()
  for (const row of rows) {
    const dirRaw = pick(row, ['direction', 'sms_direction', 'message_direction']).toLowerCase()
    const direction: 'incoming' | 'outgoing' | 'unknown' =
      dirRaw.includes('in') ? 'incoming' : dirRaw.includes('out') ? 'outgoing' : 'unknown'

    // Universal `email` first (CSV exports usually have one email col for the
    // Dialpad operator), then direction-specific fields for JSON payloads.
    const emailCandidates = direction === 'incoming'
      ? ['email', 'user_email', 'operator_email', 'to_user_email', 'to_email', 'recipient_email']
      : ['email', 'user_email', 'operator_email', 'from_user_email', 'from_email', 'sender_email']
    const nameCandidates = direction === 'incoming'
      ? ['name', 'user_name', 'operator_name', 'to_user_name', 'recipient_name']
      : ['name', 'user_name', 'operator_name', 'from_user_name', 'sender_name']

    const email = pick(row, emailCandidates).toLowerCase().trim()
    if (!email) continue
    const name = pick(row, nameCandidates)
    const dateRaw = pick(row, ['date_sent', 'sent_at', 'sent_date', 'date_started', 'date', 'timestamp', 'created_at'])
    // Epoch ms arrives as a numeric string; convert before toDateOnly.
    const date = /^\d{13}$/.test(dateRaw)
      ? new Date(parseInt(dateRaw, 10)).toISOString().slice(0, 10)
      : /^\d{10}$/.test(dateRaw)
        ? new Date(parseInt(dateRaw, 10) * 1000).toISOString().slice(0, 10)
        : toDateOnly(dateRaw)
    if (!date) continue

    const key = `${email}|${date}|${direction}`
    let entry = bucket.get(key)
    if (!entry) {
      entry = { email, name, date, direction, agg: { count: 0, name } }
      bucket.set(key, entry)
    }
    entry.agg.count += 1
    if (name && !entry.agg.name) entry.agg.name = name
  }
  return bucket
}

// ── Refresh: calls + (best-effort) SMS ─────────────────

function clampDays(v: unknown, fallback = 7, max = 90): number {
  return Math.min(Math.max(parseInt(String(v ?? ''), 10) || fallback, 1), max)
}

async function refreshCallStats(daysBack: number): Promise<{ rowsFetched: number; rowsAggregated: number; recordsStored: number; requestId: string }> {
  const cfg = loadDialpadConfig()
  if (!cfg) throw new DialpadError('No Dialpad API key configured')
  const logId = Number(db.prepare(
    `INSERT INTO dialpad_sync_log (stat_type, days_ago_start, days_ago_end, target_type, target_id, status)
     VALUES ('calls', 1, ?, ?, ?, 'running')`
  ).run(daysBack, cfg.officeId ? 'office' : null, cfg.officeId || null).lastInsertRowid)

  try {
    const { rows, request_id } = await runStatsExport(cfg, {
      stat_type: 'calls',
      export_type: 'records',
      days_ago_start: 1,
      days_ago_end: daysBack,
      office_id: cfg.officeId ?? null,
      timezone: 'America/Los_Angeles',
    })
    const agg = aggregateCalls(rows)
    const records = aggregateCallRecords(rows)
    const insert = db.prepare(
      `INSERT OR REPLACE INTO dialpad_call_daily
         (user_email, user_name, call_date, bucket, call_count, talk_time_sec, cached_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    const insertRecord = db.prepare(
      `INSERT OR REPLACE INTO dialpad_call_records
         (call_id, user_email, user_name, direction, bucket, external_number, started_at, connected_at, ended_at,
          talk_time_sec, ring_time_sec, was_voicemail, was_recorded, was_transfer, entry_point_target_kind, cached_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    const dropWindow = db.prepare(
      `DELETE FROM dialpad_call_daily WHERE call_date >= date('now', ?) AND call_date <= date('now', '-1 day')`
    )
    const dropRecordWindow = db.prepare(
      `DELETE FROM dialpad_call_records WHERE substr(started_at, 1, 10) >= date('now', ?) AND substr(started_at, 1, 10) <= date('now', '-1 day')`
    )
    db.transaction(() => {
      dropWindow.run(`-${daysBack} days`)
      dropRecordWindow.run(`-${daysBack} days`)
      for (const { email, date, bucket: leaf, agg: a } of agg.values()) {
        insert.run(email, a.name || null, date, leaf, a.count, a.talkSec)
      }
      for (const r of records) {
        insertRecord.run(
          r.call_id, r.user_email, r.user_name || null, r.direction, r.bucket,
          r.external_number || null, r.started_at, r.connected_at || null, r.ended_at || null,
          r.talk_time_sec, r.ring_time_sec,
          r.was_voicemail ? 1 : 0, r.was_recorded ? 1 : 0, r.was_transfer ? 1 : 0,
          r.entry_point_target_kind || null,
        )
      }
    })()
    db.prepare(
      `UPDATE dialpad_sync_log SET status = 'complete', request_id = ?, rows_ingested = ?, finished_at = datetime('now') WHERE id = ?`
    ).run(request_id, records.length, logId)
    return { rowsFetched: rows.length, rowsAggregated: agg.size, recordsStored: records.length, requestId: request_id }
  } catch (e) {
    const msg = formatError(e)
    db.prepare(`UPDATE dialpad_sync_log SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?`).run(msg, logId)
    throw e
  }
}

// SMS historical aggregates go through the Stats API with stat_type=texts,
// export_type=records (per the official Dialpad Python SDK enum). We tried
// the GET /api/v2/sms records endpoint first but it returns 404 on many
// plans; stat_type=texts is the supported path.
async function refreshSmsStats(daysBack: number): Promise<{ rowsFetched: number; rowsAggregated: number; requestId?: string }> {
  const cfg = loadDialpadConfig()
  if (!cfg) throw new DialpadError('No Dialpad API key configured')
  const logId = Number(db.prepare(
    `INSERT INTO dialpad_sync_log (stat_type, days_ago_start, days_ago_end, target_type, target_id, status)
     VALUES ('sms', 1, ?, ?, ?, 'running')`
  ).run(daysBack, cfg.officeId ? 'office' : null, cfg.officeId || null).lastInsertRowid)

  try {
    const { rows, request_id } = await runStatsExport(cfg, {
      stat_type: 'texts',
      export_type: 'records',
      days_ago_start: 1,
      days_ago_end: daysBack,
      office_id: cfg.officeId ?? null,
      timezone: 'America/Los_Angeles',
    })

    const agg = aggregateSms(rows)
    const insert = db.prepare(
      `INSERT OR REPLACE INTO dialpad_sms_daily
         (user_email, user_name, sms_date, direction, message_count, cached_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    )
    const dropWindow = db.prepare(
      `DELETE FROM dialpad_sms_daily WHERE sms_date >= date('now', ?) AND sms_date <= date('now', '-1 day')`
    )
    db.transaction(() => {
      dropWindow.run(`-${daysBack} days`)
      for (const { email, date, direction, agg: a } of agg.values()) {
        insert.run(email, a.name || null, date, direction, a.count)
      }
    })()
    db.prepare(
      `UPDATE dialpad_sync_log SET status = 'complete', request_id = ?, rows_ingested = ?, finished_at = datetime('now') WHERE id = ?`
    ).run(request_id, agg.size, logId)
    return { rowsFetched: rows.length, rowsAggregated: agg.size, requestId: request_id }
  } catch (e) {
    const msg = formatError(e)
    db.prepare(`UPDATE dialpad_sync_log SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?`).run(msg, logId)
    throw e
  }
}

function formatError(e: unknown): string {
  if (e instanceof DialpadError) return `${e.message}${e.status ? ` (${e.status})` : ''}${e.body ? `: ${e.body}` : ''}`
  return e instanceof Error ? e.message : String(e)
}

router.post('/refresh-call-stats', async (req: Request, res: Response): Promise<void> => {
  const daysBack = clampDays(req.body?.days, 7, 30)
  try {
    const result = await refreshCallStats(daysBack)
    res.json({ ok: true, days: daysBack, ...result })
  } catch (e) { res.status(500).json({ error: formatError(e) }) }
})

router.post('/refresh-sms-stats', async (req: Request, res: Response): Promise<void> => {
  const daysBack = clampDays(req.body?.days, 7, 30)
  try {
    const result = await refreshSmsStats(daysBack)
    res.json({ ok: true, days: daysBack, ...result })
  } catch (e) { res.status(500).json({ error: formatError(e), note: 'SMS stats may not be supported on this Dialpad plan' }) }
})

// "Sync All" single call — grabs calls, then tries SMS. SMS failure is soft.
router.post('/refresh-all', async (req: Request, res: Response): Promise<void> => {
  const daysBack = clampDays(req.body?.days, 7, 30)
  const out: Record<string, unknown> = { days: daysBack }
  try { out['calls'] = await refreshCallStats(daysBack) }
  catch (e) { out['calls'] = { error: formatError(e) } }
  try { out['sms'] = await refreshSmsStats(daysBack) }
  catch (e) { out['sms'] = { error: formatError(e), skipped: true } }
  res.json(out)
})

// ── Query: hierarchical summary ─────────────────────────
// The shape matches the Comms Hub drill-down. Frontend computes percentages
// from these absolute values.

interface CallTotals {
  total_calls: number
  inbound_total: number
  outbound_total: number
  inbound_answered: number
  inbound_unanswered: number
  inbound_callback_requested: number
  in_missed: number
  in_abandoned: number
  in_voicemail: number
  in_transfer_unanswered: number
  outbound_user_initiated: number
  outbound_callback_attempt: number
  out_connected: number
  out_cancelled: number
  total_talk_time_sec: number
  outbound_talk_time_sec: number
}
interface SmsTotals { sms_total: number; sms_incoming: number; sms_outgoing: number }

const EMPTY_CALL_TOTALS: CallTotals = {
  total_calls: 0, inbound_total: 0, outbound_total: 0,
  inbound_answered: 0, inbound_unanswered: 0, inbound_callback_requested: 0,
  in_missed: 0, in_abandoned: 0, in_voicemail: 0, in_transfer_unanswered: 0,
  outbound_user_initiated: 0, outbound_callback_attempt: 0,
  out_connected: 0, out_cancelled: 0,
  total_talk_time_sec: 0, outbound_talk_time_sec: 0,
}

// Convert leaf-bucket rows into the hierarchical totals the UI wants.
function foldTotals(leafRows: Array<{ bucket: string; call_count: number; talk_time_sec: number }>): CallTotals {
  const t: CallTotals = { ...EMPTY_CALL_TOTALS }
  for (const r of leafRows) {
    const n = Number(r.call_count) || 0
    const talk = Number(r.talk_time_sec) || 0
    t.total_calls += n
    t.total_talk_time_sec += talk
    switch (r.bucket) {
      case 'in_answered': t.inbound_total += n; t.inbound_answered += n; break
      case 'in_missed': t.inbound_total += n; t.inbound_unanswered += n; t.in_missed += n; break
      case 'in_abandoned': t.inbound_total += n; t.inbound_unanswered += n; t.in_abandoned += n; break
      case 'in_voicemail': t.inbound_total += n; t.inbound_unanswered += n; t.in_voicemail += n; break
      case 'in_transfer_unanswered': t.inbound_total += n; t.inbound_unanswered += n; t.in_transfer_unanswered += n; break
      case 'in_callback_requested': t.inbound_total += n; t.inbound_callback_requested += n; break
      case 'out_connected': t.outbound_total += n; t.outbound_user_initiated += n; t.out_connected += n; t.outbound_talk_time_sec += talk; break
      case 'out_cancelled': t.outbound_total += n; t.outbound_user_initiated += n; t.out_cancelled += n; break
      case 'out_callback_attempt': t.outbound_total += n; t.outbound_callback_attempt += n; t.outbound_talk_time_sec += talk; break
      default: break
    }
  }
  return t
}

// Resolve a Dialpad user to a portal user using the same email convention used
// elsewhere (agent-org listPcDigestRecipients): LOWER(TRIM(email)) exact match.
// We select through the portal users table first so the display name is the
// portal name (matching the QB coordinator convention) when available.
interface CoordRow {
  coordinator: string
  portal_user_id: number | null
  portal_email: string
  dialpad_email: string
  bucket: string
  call_count: number
  talk_time_sec: number
}

router.get('/summary', (req: Request, res: Response): void => {
  const from = (req.query['from'] as string | undefined)?.trim()
  const to = (req.query['to'] as string | undefined)?.trim()
  const days = clampDays(req.query['days'], 7, 90)
  const coordinator = (req.query['coordinator'] as string | undefined)?.trim() || ''
  // Date window: explicit from/to beats days-back
  const dateFrom = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : ''
  const dateTo = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : ''

  const callWhere: string[] = []
  const callParams: unknown[] = []
  if (dateFrom) { callWhere.push(`dcd.call_date >= ?`); callParams.push(dateFrom) }
  if (dateTo)   { callWhere.push(`dcd.call_date <= ?`); callParams.push(dateTo) }
  if (!dateFrom && !dateTo) { callWhere.push(`dcd.call_date >= date('now', ?)`); callParams.push(`-${days} days`) }
  if (coordinator) { callWhere.push(`COALESCE(u.name, dcd.user_name, dcd.user_email) = ?`); callParams.push(coordinator) }

  const callRowsForCoord = db.prepare(`
    SELECT dcd.bucket,
           COALESCE(u.name, dcd.user_name, dcd.user_email) AS coordinator,
           u.id AS portal_user_id,
           LOWER(TRIM(COALESCE(u.email, ''))) AS portal_email,
           dcd.user_email AS dialpad_email,
           SUM(dcd.call_count) AS call_count,
           SUM(dcd.talk_time_sec) AS talk_time_sec
    FROM dialpad_call_daily dcd
    LEFT JOIN user_email_lookup uel
      ON uel.email = dcd.user_email AND uel.system IN ('', 'dialpad')
    LEFT JOIN users u ON u.id = uel.user_id
    ${callWhere.length ? 'WHERE ' + callWhere.join(' AND ') : ''}
    GROUP BY COALESCE(u.name, dcd.user_name, dcd.user_email), dcd.bucket
    ORDER BY coordinator
  `).all(...callParams) as CoordRow[]

  // Overall totals — across everyone in the window (or filtered coordinator)
  const overallLeafRows = callRowsForCoord.map(r => ({ bucket: r.bucket, call_count: Number(r.call_count) || 0, talk_time_sec: Number(r.talk_time_sec) || 0 }))
  const totals = foldTotals(overallLeafRows)

  // Per-coordinator rollup
  const byCoord = new Map<string, {
    coordinator: string; portal_user_id: number | null; portal_email: string; dialpad_email: string; matched: boolean
    leaves: Array<{ bucket: string; call_count: number; talk_time_sec: number }>
  }>()
  for (const r of callRowsForCoord) {
    let entry = byCoord.get(r.coordinator)
    if (!entry) {
      entry = {
        coordinator: r.coordinator,
        portal_user_id: r.portal_user_id,
        portal_email: r.portal_email || '',
        dialpad_email: r.dialpad_email || '',
        matched: r.portal_user_id != null,
        leaves: [],
      }
      byCoord.set(r.coordinator, entry)
    }
    entry.leaves.push({ bucket: r.bucket, call_count: Number(r.call_count) || 0, talk_time_sec: Number(r.talk_time_sec) || 0 })
  }
  const byCoordinator = [...byCoord.values()]
    .map(e => ({
      coordinator: e.coordinator,
      portal_user_id: e.portal_user_id,
      portal_email: e.portal_email,
      dialpad_email: e.dialpad_email,
      matched: e.matched,
      totals: foldTotals(e.leaves),
    }))
    .sort((a, b) => b.totals.total_calls - a.totals.total_calls || a.coordinator.localeCompare(b.coordinator))

  // SMS totals
  const smsWhere: string[] = []
  const smsParams: unknown[] = []
  if (dateFrom) { smsWhere.push(`dsd.sms_date >= ?`); smsParams.push(dateFrom) }
  if (dateTo)   { smsWhere.push(`dsd.sms_date <= ?`); smsParams.push(dateTo) }
  if (!dateFrom && !dateTo) { smsWhere.push(`dsd.sms_date >= date('now', ?)`); smsParams.push(`-${days} days`) }
  if (coordinator) { smsWhere.push(`COALESCE(u.name, dsd.user_name, dsd.user_email) = ?`); smsParams.push(coordinator) }

  const smsRowsAll = db.prepare(`
    SELECT dsd.direction,
           COALESCE(u.name, dsd.user_name, dsd.user_email) AS coordinator,
           u.id AS portal_user_id,
           SUM(dsd.message_count) AS message_count
    FROM dialpad_sms_daily dsd
    LEFT JOIN users u ON LOWER(TRIM(u.email)) = dsd.user_email
    ${smsWhere.length ? 'WHERE ' + smsWhere.join(' AND ') : ''}
    GROUP BY COALESCE(u.name, dsd.user_name, dsd.user_email), dsd.direction
  `).all(...smsParams) as Array<{ direction: string; coordinator: string; portal_user_id: number | null; message_count: number }>

  const smsTotals: SmsTotals = { sms_total: 0, sms_incoming: 0, sms_outgoing: 0 }
  const smsByCoord = new Map<string, SmsTotals>()
  for (const r of smsRowsAll) {
    const n = Number(r.message_count) || 0
    smsTotals.sms_total += n
    if (r.direction === 'incoming') smsTotals.sms_incoming += n
    else if (r.direction === 'outgoing') smsTotals.sms_outgoing += n
    let t = smsByCoord.get(r.coordinator)
    if (!t) { t = { sms_total: 0, sms_incoming: 0, sms_outgoing: 0 }; smsByCoord.set(r.coordinator, t) }
    t.sms_total += n
    if (r.direction === 'incoming') t.sms_incoming += n
    else if (r.direction === 'outgoing') t.sms_outgoing += n
  }

  // Merge SMS totals onto per-coordinator rows (ensures SMS-only users show up too)
  const byCoordMap = new Map(byCoordinator.map(c => [c.coordinator, c]))
  for (const [coord, t] of smsByCoord) {
    const existing = byCoordMap.get(coord)
    if (existing) (existing as { sms?: SmsTotals }).sms = t
    else {
      byCoordinator.push({
        coordinator: coord,
        portal_user_id: null,
        portal_email: '',
        dialpad_email: '',
        matched: false,
        totals: { ...EMPTY_CALL_TOTALS },
        ...{ sms: t },
      } as typeof byCoordinator[number] & { sms: SmsTotals })
    }
  }
  for (const c of byCoordinator) {
    if (!('sms' in c)) (c as { sms?: SmsTotals }).sms = { sms_total: 0, sms_incoming: 0, sms_outgoing: 0 }
  }

  // Matching stats — how many Dialpad users are linked to a portal user
  const emailsSeen = new Set<string>()
  let matchedUsers = 0
  for (const r of callRowsForCoord) {
    if (emailsSeen.has(r.dialpad_email)) continue
    emailsSeen.add(r.dialpad_email)
    if (r.portal_user_id != null) matchedUsers++
  }

  const lastCallsSync = db.prepare(
    `SELECT status, rows_ingested, error, started_at, finished_at FROM dialpad_sync_log WHERE stat_type = 'calls' ORDER BY id DESC LIMIT 1`
  ).get() || null
  const lastSmsSync = db.prepare(
    `SELECT status, rows_ingested, error, started_at, finished_at FROM dialpad_sync_log WHERE stat_type = 'sms' ORDER BY id DESC LIMIT 1`
  ).get() || null

  res.json({
    window: { from: dateFrom || null, to: dateTo || null, days: dateFrom && dateTo ? null : days },
    totals,
    sms: smsTotals,
    byCoordinator,
    matching: { total_dialpad_users: emailsSeen.size, matched_to_portal: matchedUsers, unmatched: emailsSeen.size - matchedUsers },
    lastSync: { calls: lastCallsSync, sms: lastSmsSync },
    filters: {
      coordinators: [...new Set(callRowsForCoord.map(r => r.coordinator))].sort(),
    },
  })
})

// Per-call activity feed. One row per call with classified leaf bucket — the
// UI maps bucket → icon and renders them as a dialer-style log. Filterable by
// portal coordinator name (resolves via user_email_lookup), date window, or a
// specific bucket.
router.get('/call-records', (req: Request, res: Response): void => {
  const coordinator = (req.query['coordinator'] as string | undefined)?.trim()
  const bucket = (req.query['bucket'] as string | undefined)?.trim() || ''
  const from = (req.query['from'] as string | undefined)?.trim()
  const to = (req.query['to'] as string | undefined)?.trim()
  const days = clampDays(req.query['days'], 7, 90)
  const limit = Math.min(Math.max(parseInt(String(req.query['limit'] ?? '100'), 10) || 100, 1), 500)

  const where: string[] = []
  const params: unknown[] = []
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) { where.push(`substr(r.started_at, 1, 10) >= ?`); params.push(from) }
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) { where.push(`substr(r.started_at, 1, 10) <= ?`); params.push(to) }
  if (!from && !to) { where.push(`substr(r.started_at, 1, 10) >= date('now', ?)`); params.push(`-${days} days`) }
  if (bucket) { where.push(`r.bucket = ?`); params.push(bucket) }
  if (coordinator) {
    where.push(`EXISTS (
      SELECT 1 FROM user_email_lookup uel
      JOIN users u2 ON u2.id = uel.user_id
      WHERE uel.email = r.user_email
        AND uel.system IN ('', 'dialpad')
        AND u2.name = ?
    )`)
    params.push(coordinator)
  }

  const rows = db.prepare(`
    SELECT r.call_id, r.user_email, r.user_name, r.direction, r.bucket,
           r.external_number, r.started_at, r.connected_at, r.ended_at,
           r.talk_time_sec, r.ring_time_sec, r.was_voicemail, r.was_transfer,
           r.entry_point_target_kind,
           COALESCE(u.name, r.user_name, r.user_email) AS coordinator
    FROM dialpad_call_records r
    LEFT JOIN user_email_lookup uel ON uel.email = r.user_email AND uel.system IN ('', 'dialpad')
    LEFT JOIN users u ON u.id = uel.user_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY r.started_at DESC
    LIMIT ?
  `).all(...params, limit)

  res.json({ rows, limit })
})

// ── Webhook config (admin only; SSE stream auth'd by query token) ───────

// Small public shape; never returns the secret in full, only whether one
// exists plus a short preview. Clients that need the full secret must call
// the rotate endpoint (which returns it exactly once).
// Prefer an explicit PUBLIC_BASE_URL env var (set on Railway) so we don't
// depend on Express's request-derived host. Falls back to request-derived
// `X-Forwarded-Proto`-aware host when the env var isn't set. Dialpad requires
// https, so if we resolve to http:// we flag it upfront.
function resolvePublicBaseUrl(req: Request): string {
  const env = (process.env['PUBLIC_BASE_URL'] || '').trim().replace(/\/+$/, '')
  if (env) return env
  const forwardedProto = (req.header('x-forwarded-proto') || '').split(',')[0]!.trim()
  const proto = forwardedProto || req.protocol
  return `${proto}://${req.get('host')}`
}

router.get('/webhook-config', (req: Request, res: Response): void => {
  const row = db.prepare(`SELECT webhook_secret_encrypted FROM dialpad_config WHERE id = 1`).get() as { webhook_secret_encrypted: string | null } | undefined
  const host = resolvePublicBaseUrl(req)
  let preview: string | null = null
  if (row?.webhook_secret_encrypted) {
    try { preview = previewSecret(decryptSecret(row.webhook_secret_encrypted)) } catch { preview = null }
  }
  res.json({
    configured: !!row?.webhook_secret_encrypted,
    secret_preview: preview,
    webhook_urls: {
      call: `${host}/api/webhooks/dialpad/call`,
      sms: `${host}/api/webhooks/dialpad/sms`,
      generic: `${host}/api/webhooks/dialpad`,
    },
    is_https: host.startsWith('https://'),
  })
})

// Rotate or create the signing secret. Returns the plaintext secret ONCE so
// the admin can paste it into Dialpad's subscription; we never expose it
// again via the config endpoint.
router.post('/webhook-secret/rotate', (_req: Request, res: Response): void => {
  const secret = crypto.randomBytes(32).toString('base64url')
  db.prepare(
    `UPDATE dialpad_config SET webhook_secret_encrypted = ?, updated_at = datetime('now') WHERE id = 1`
  ).run(encryptSecret(secret))
  res.json({ secret, note: 'Save this now — it will not be shown again.' })
})

router.delete('/webhook-secret', (_req: Request, res: Response): void => {
  db.prepare(
    `UPDATE dialpad_config SET webhook_secret_encrypted = NULL, updated_at = datetime('now') WHERE id = 1`
  ).run()
  res.json({ ok: true })
})

// ── Auto-subscribe: register webhook + subscriptions in Dialpad ──────────
//
// Dialpad flow is two-step:
//   1. POST /api/v2/webhooks  { hook_url, secret }  →  returns { id }
//   2. POST /api/v2/subscriptions/call  { webhook_id, call_states: ["all"] }  →  returns { id }
//      POST /api/v2/subscriptions/sms   { webhook_id, target_type: "company" }  →  returns { id }
//
// If Dialpad's schema has drifted, errors surface verbatim (body returned to
// the client) so an admin can still register manually via their UI / curl.

interface DialpadSubscriptionRow {
  webhook_id: string | null
  call_subscription_id: string | null
  sms_subscription_id: string | null
  call_subscription_error: string | null
  sms_subscription_error: string | null
}

// Dialpad's SMS subscription requires a `direction` field (proven by
// production 400 response: "Message POST_PARAMS is missing required field
// direction"). We try "all" first; if that isn't a valid enum value on this
// plan, fall back to "inbound" as the minimum viable (receiving customer
// replies is the main value add — outbound texts a PC sends they already
// know about).
async function createSmsSubscription(cfg: { apiKey: string; officeId: string | null }, webhookId: string): Promise<{ ok: boolean; id: string | null; status: number; body: string }> {
  const candidates: Array<Record<string, unknown>> = [
    { webhook_id: webhookId, direction: 'all' },
    { webhook_id: webhookId, direction: 'all', enabled: true },
    ...(cfg.officeId ? [{ webhook_id: webhookId, direction: 'all', target_type: 'office', target_id: Number(cfg.officeId) }] : []),
    { webhook_id: webhookId, direction: 'inbound' },
    { webhook_id: webhookId, direction: 'outbound' },
  ]
  let lastStatus = 0
  let lastBody = ''
  for (const body of candidates) {
    const r = await dialpadApi(cfg, 'POST', '/subscriptions/sms', body)
    if (r.ok) {
      return { ok: true, id: String(r.data['id'] ?? '') || null, status: r.status, body: r.text }
    }
    lastStatus = r.status
    lastBody = r.text
    // Only keep trying when the error looks like a shape problem — auth or
    // not-found errors won't improve with a different body.
    if (r.status !== 400 && r.status !== 422) break
  }
  return { ok: false, id: null, status: lastStatus, body: lastBody }
}

async function dialpadApi(cfg: { apiKey: string }, method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown>; text: string }> {
  const res = await fetch(`https://dialpad.com/api/v2${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data: Record<string, unknown> = {}
  try { data = text ? JSON.parse(text) : {} } catch { /* keep text fallback */ }
  return { ok: res.ok, status: res.status, data, text }
}

router.get('/webhook-subscription', (req: Request, res: Response): void => {
  const row = db.prepare(
    `SELECT webhook_id, call_subscription_id, sms_subscription_id, call_subscription_error, sms_subscription_error FROM dialpad_config WHERE id = 1`
  ).get() as DialpadSubscriptionRow
  const host = resolvePublicBaseUrl(req)
  res.json({
    webhook_id: row.webhook_id,
    call_subscription_id: row.call_subscription_id,
    sms_subscription_id: row.sms_subscription_id,
    call_subscription_error: row.call_subscription_error,
    sms_subscription_error: row.sms_subscription_error,
    subscribed: !!(row.webhook_id && (row.call_subscription_id || row.sms_subscription_id)),
    webhook_url: `${host}/api/webhooks/dialpad`,
    is_https: host.startsWith('https://'),
  })
})

// Retry just the SMS subscription using the shape-variant ladder. Useful
// when the initial activate failed on SMS but calls succeeded.
router.post('/webhook-subscription/retry-sms', async (_req: Request, res: Response): Promise<void> => {
  const cfg = loadDialpadConfig()
  if (!cfg) { res.status(400).json({ error: 'Dialpad API key not configured' }); return }
  const row = db.prepare(`SELECT webhook_id FROM dialpad_config WHERE id = 1`).get() as { webhook_id: string | null } | undefined
  if (!row?.webhook_id) { res.status(400).json({ error: 'No webhook registered — run Activate first' }); return }
  const attempt = await createSmsSubscription(cfg, row.webhook_id)
  const error = attempt.ok ? null : `HTTP ${attempt.status}: ${attempt.body.slice(0, 500)}`
  db.prepare(
    `UPDATE dialpad_config SET sms_subscription_id = ?, sms_subscription_error = ?, updated_at = datetime('now') WHERE id = 1`
  ).run(attempt.id, error)
  if (attempt.ok) res.json({ ok: true, id: attempt.id })
  else res.status(200).json({ ok: false, error, status: attempt.status, note: 'If Dialpad keeps rejecting, SMS subscriptions likely aren\'t enabled for this plan — check with Dialpad support.' })
})

// Recent webhook deliveries — helps distinguish "Dialpad isn't firing"
// from "Dialpad fires but we reject". Admin-only; logs are short and
// capped server-side so this is cheap.
router.get('/webhook-deliveries', (req: Request, res: Response): void => {
  if (!req.user?.roles.includes('admin')) { res.status(403).json({ error: 'Admin only' }); return }
  const limit = Math.min(Math.max(parseInt(String(req.query['limit'] || '50'), 10) || 50, 1), 500)
  const rows = db.prepare(
    `SELECT id, path, method, content_type, body_preview, signature_ok, inferred_kind, status_code, error, stored_event_id, received_at
     FROM dialpad_webhook_deliveries
     ORDER BY id DESC
     LIMIT ?`
  ).all(limit)
  res.json({ rows, limit })
})

// Probe the current subscription states at Dialpad to see if they're live.
// Helps distinguish "we never created it" from "Dialpad has it but isn't
// firing events".
router.get('/webhook-subscription/probe', async (_req: Request, res: Response): Promise<void> => {
  const cfg = loadDialpadConfig()
  if (!cfg) { res.status(400).json({ error: 'Dialpad API key not configured' }); return }
  const row = db.prepare(
    `SELECT webhook_id, call_subscription_id, sms_subscription_id FROM dialpad_config WHERE id = 1`
  ).get() as DialpadSubscriptionRow
  const out: Record<string, unknown> = { webhook_id: row.webhook_id, call: null, sms: null, webhook: null }
  if (row.webhook_id) {
    const r = await dialpadApi(cfg, 'GET', `/webhooks/${encodeURIComponent(row.webhook_id)}`)
    out['webhook'] = { ok: r.ok, status: r.status, body: r.text.slice(0, 400) }
  }
  if (row.call_subscription_id) {
    const r = await dialpadApi(cfg, 'GET', `/subscriptions/call/${encodeURIComponent(row.call_subscription_id)}`)
    out['call'] = { ok: r.ok, status: r.status, body: r.text.slice(0, 400) }
  }
  if (row.sms_subscription_id) {
    const r = await dialpadApi(cfg, 'GET', `/subscriptions/sms/${encodeURIComponent(row.sms_subscription_id)}`)
    out['sms'] = { ok: r.ok, status: r.status, body: r.text.slice(0, 400) }
  }
  res.json(out)
})

router.post('/webhook-subscription', async (req: Request, res: Response): Promise<void> => {
  const cfg = loadDialpadConfig()
  if (!cfg) { res.status(400).json({ error: 'Dialpad API key not configured' }); return }
  const secretRow = db.prepare(`SELECT webhook_secret_encrypted FROM dialpad_config WHERE id = 1`).get() as { webhook_secret_encrypted: string | null } | undefined
  if (!secretRow?.webhook_secret_encrypted) { res.status(400).json({ error: 'Generate a webhook secret first' }); return }
  let secret: string
  try { secret = decryptSecret(secretRow.webhook_secret_encrypted) }
  catch { res.status(500).json({ error: 'Could not decrypt stored secret — rotate it' }); return }

  const host = resolvePublicBaseUrl(req)
  const webhookUrl = `${host}/api/webhooks/dialpad`

  // Dialpad rejects http URLs — fail fast with an actionable message instead
  // of letting Dialpad bounce us with a generic 400.
  if (!webhookUrl.startsWith('https://')) {
    res.status(400).json({
      error: `Webhook URL must be https. Derived "${webhookUrl}". Set PUBLIC_BASE_URL to your public https origin (e.g. https://qb-spa.up.railway.app) and retry.`,
    })
    return
  }

  try {
    // Step 1: register the webhook
    const whRes = await dialpadApi(cfg, 'POST', '/webhooks', { hook_url: webhookUrl, secret })
    if (!whRes.ok) {
      res.status(whRes.status).json({ error: 'Dialpad /webhooks rejected', dialpad_status: whRes.status, dialpad_body: whRes.text.slice(0, 600) })
      return
    }
    const webhookId = String(whRes.data['id'] ?? '')
    if (!webhookId) {
      res.status(502).json({ error: 'Dialpad /webhooks returned no id', dialpad_body: whRes.text.slice(0, 600) })
      return
    }

    // Step 2a: call subscription (all states)
    const callRes = await dialpadApi(cfg, 'POST', '/subscriptions/call', { webhook_id: webhookId, call_states: ['all'] })
    const callSubId = callRes.ok ? String(callRes.data['id'] ?? '') : null
    const callError = callRes.ok ? null : `HTTP ${callRes.status}: ${callRes.text.slice(0, 500)}`

    // Step 2b: SMS subscription — try known body shapes, keep the error
    // verbatim for display so admins can see why Dialpad rejected it.
    const smsAttempt = await createSmsSubscription(cfg, webhookId)
    const smsSubId = smsAttempt.id
    const smsError = smsAttempt.ok ? null : `HTTP ${smsAttempt.status}: ${smsAttempt.body.slice(0, 500)}`

    db.prepare(
      `UPDATE dialpad_config
       SET webhook_id = ?,
           call_subscription_id = ?, call_subscription_error = ?,
           sms_subscription_id = ?, sms_subscription_error = ?,
           updated_at = datetime('now')
       WHERE id = 1`
    ).run(webhookId, callSubId, callError, smsSubId, smsError)

    res.json({
      ok: true,
      webhook_id: webhookId,
      call: callRes.ok ? { id: callSubId } : { error: callError, status: callRes.status },
      sms: smsAttempt.ok ? { id: smsSubId } : { error: smsError, status: smsAttempt.status, note: 'See /webhook-subscription for last recorded error' },
    })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

router.delete('/webhook-subscription', async (_req: Request, res: Response): Promise<void> => {
  const cfg = loadDialpadConfig()
  if (!cfg) { res.status(400).json({ error: 'Dialpad API key not configured' }); return }
  const row = db.prepare(
    `SELECT webhook_id, call_subscription_id, sms_subscription_id FROM dialpad_config WHERE id = 1`
  ).get() as DialpadSubscriptionRow
  const results: Record<string, unknown> = {}
  try {
    if (row.call_subscription_id) {
      const r = await dialpadApi(cfg, 'DELETE', `/subscriptions/call/${encodeURIComponent(row.call_subscription_id)}`)
      results['call'] = { ok: r.ok, status: r.status }
    }
    if (row.sms_subscription_id) {
      const r = await dialpadApi(cfg, 'DELETE', `/subscriptions/sms/${encodeURIComponent(row.sms_subscription_id)}`)
      results['sms'] = { ok: r.ok, status: r.status }
    }
    if (row.webhook_id) {
      const r = await dialpadApi(cfg, 'DELETE', `/webhooks/${encodeURIComponent(row.webhook_id)}`)
      results['webhook'] = { ok: r.ok, status: r.status }
    }
    db.prepare(
      `UPDATE dialpad_config SET webhook_id = NULL, call_subscription_id = NULL, sms_subscription_id = NULL, updated_at = datetime('now') WHERE id = 1`
    ).run()
    res.json({ ok: true, dialpad_responses: results })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

// ── Dev mirror token ────────────────────────────────────
// Mints a long-lived JWT the admin can paste into their local .env as
// DIALPAD_MIRROR_TOKEN so the local server can poll prod's /events/recent
// endpoint and replay webhook data into the local Comms Hub. 30-day expiry
// keeps risk of compromise bounded without requiring weekly rotation.
// Admin-only caller; we reuse the authenticated user's identity so the token
// has the same role set as whoever clicked the button.
import jwt from 'jsonwebtoken'
router.post('/dev-mirror-token', (req: Request, res: Response): void => {
  if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return }
  if (!req.user.roles.includes('admin')) { res.status(403).json({ error: 'Admin only' }); return }
  const secret = process.env['JWT_SECRET'] || 'dev-secret-change-me'
  const token = jwt.sign(
    { userId: req.user.userId, email: req.user.email, roles: req.user.roles },
    secret,
    { expiresIn: '30d' },
  )
  res.json({
    token,
    expires_in_days: 30,
    mirror_url: req.protocol + '://' + req.get('host'),
    note: 'Set DIALPAD_MIRROR_URL and DIALPAD_MIRROR_TOKEN in your local .env and restart the local server.',
  })
})

// ── Events: SSE live stream + REST recent list ──────────

// SSE requires auth via query token (EventSource can't set headers). The auth
// middleware mounted at /api/dialpad already reads req.query.token if the
// Authorization header is absent — not in this repo by default, so we accept
// the token here explicitly.
router.get('/events/stream', (req: Request, res: Response): void => {
  // `req.user` is populated by the authenticate middleware once it reads
  // either the Authorization header OR a ?token= query param. Confirm below.
  if (!req.user) { res.status(401).end(); return }
  attachSseStream(res)
})

// REST fallback — recent N events. Useful for reconnect/backfill.
router.get('/events/recent', (req: Request, res: Response): void => {
  const limit = Math.min(Math.max(parseInt(String(req.query['limit'] ?? '50'), 10) || 50, 1), 500)
  const sinceId = parseInt(String(req.query['since_id'] ?? '0'), 10) || 0
  const rows = db.prepare(
    `SELECT id, event_kind, event_state, call_id, user_email, user_name, external_number, direction, raw_json, received_at
     FROM dialpad_events
     WHERE id > ?
     ORDER BY id DESC
     LIMIT ?`
  ).all(sinceId, limit) as DialpadEvent[]
  res.json({ rows, limit, since_id: sinceId })
})

// ── SMS thread (iOS-style conversation view) ───────────
// Returns every SMS event between this Dialpad user and the given external
// number, ordered oldest→newest, with the message body extracted from the
// raw_json blob so the client doesn't have to parse it itself. Optional
// scope=me|all controls whether to limit to the requesting user's emails.
router.get('/sms/thread', (req: Request, res: Response): void => {
  if (!req.user) { res.status(401).end(); return }
  const externalNumber = String(req.query['external_number'] || '').trim()
  if (!externalNumber) { res.status(400).json({ error: 'external_number required' }); return }
  const limit = Math.min(Math.max(parseInt(String(req.query['limit'] || '30'), 10) || 30, 1), 100)
  // Cursor — fetch messages strictly older than this id. dialpad_events.id
  // is monotonic (INTEGER PRIMARY KEY AUTOINCREMENT) so it sorts cleanly
  // even when received_at ties on bulk ingest.
  const beforeIdRaw = req.query['before_id']
  const beforeId = beforeIdRaw ? parseInt(String(beforeIdRaw), 10) : null

  // Match digits-only on both sides so "+14077459738" and "(407) 745-9738"
  // resolve to the same conversation. Last 10 digits is the canonical match
  // (same convention we use for project lookup).
  const digits = externalNumber.replace(/\D/g, '')
  const last10 = digits.slice(-10)

  // Pull `limit + 1` rows DESC and trim to compute has_more without a
  // second query. Ordered DESC so we get the most recent slice first;
  // the response is reversed to ASC before returning so the client can
  // append/prepend chronologically.
  // No user filter — a thread is a shared conversation with the contact.
  // If two agents have texted the same customer, the user looking at this
  // thread wants to see the full back-and-forth, not just their slice.
  const where: string[] = [
    `e.event_kind = 'sms'`,
    `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(e.external_number, ''), ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE '%' || ?`,
  ]
  const params: unknown[] = [req.user.userId, last10]
  if (beforeId && beforeId > 0) {
    where.push(`e.id < ?`)
    params.push(beforeId)
  }
  params.push(limit + 1)
  const fetched = db.prepare(`
    SELECT e.id, e.user_email, e.user_name, e.direction, e.external_number,
           e.received_at, e.raw_json,
           CASE WHEN sr.event_id IS NOT NULL THEN 1 ELSE 0 END AS is_read
    FROM dialpad_events e
    LEFT JOIN dialpad_sms_reads sr ON sr.user_id = ? AND sr.event_id = e.id
    WHERE ${where.join(' AND ')}
    ORDER BY e.id DESC
    LIMIT ?
  `).all(...params) as Array<Record<string, unknown>>

  const hasMore = fetched.length > limit
  const rows = (hasMore ? fetched.slice(0, limit) : fetched).reverse()

  // Try several Dialpad payload shapes for the SMS body. New webhook
  // schemas occasionally nest the text inside "data" or "sms" so we walk
  // those before giving up.
  function extractBody(payload: Record<string, unknown>): string | null {
    const direct = payload['text'] || payload['message'] || payload['body'] || payload['message_body'] || payload['content']
    if (typeof direct === 'string' && direct.trim()) return direct
    for (const key of ['data', 'sms', 'message_object', 'event']) {
      const nested = payload[key]
      if (nested && typeof nested === 'object') {
        const inner = extractBody(nested as Record<string, unknown>)
        if (inner) return inner
      }
    }
    return null
  }

  // Surface every SMS-flagged event for this number. Text-bearing rows
  // become real chat bubbles in the UI; status-only rows (delivery
  // confirmations, read receipts) are returned with body=null and a
  // status hint so the client can render a compact pill instead of
  // pretending nothing happened. This makes "no body" debuggable from
  // the UI rather than appearing as an empty thread.
  function classifyStatus(payload: Record<string, unknown>): string {
    const fields = ['event_type', 'type', 'state', 'event_state', 'status']
    for (const f of fields) {
      const v = payload[f]
      if (typeof v === 'string' && v) return v
    }
    return 'status'
  }
  const isAdmin = req.user.roles.includes('admin')
  const messages = rows.map(r => {
    let body: string | null = null
    let status: string | null = null
    let rawPreview: string | null = null
    try {
      const p = JSON.parse(String(r.raw_json || '{}')) as Record<string, unknown>
      body = extractBody(p)
      if (!body) status = classifyStatus(p)
    } catch { /* leave null */ }
    // Admin-only diagnostic — when no body could be extracted, ship the
    // raw JSON (truncated) so the operator can see exactly which keys
    // Dialpad sent. Lets us identify mis-named body fields without an
    // SSH session.
    if (isAdmin && !body) {
      const raw = String(r.raw_json || '')
      rawPreview = raw.length > 1500 ? raw.slice(0, 1500) + '…' : raw
    }
    return {
      id: r.id, direction: r.direction, body, status,
      user_email: r.user_email, user_name: r.user_name,
      external_number: r.external_number,
      received_at: r.received_at, is_read: r.is_read,
      raw_preview: rawPreview,
    }
  })

  res.json({
    external_number: externalNumber,
    messages,
    count: messages.length,
    has_more: hasMore,
    oldest_id: messages.length ? Number(messages[0]!.id) : null,
    newest_id: messages.length ? Number(messages[messages.length - 1]!.id) : null,
    // Counts so the UI can say "12 events, 3 with text" if needed for
    // debugging, instead of rendering "no messages" when there's data.
    text_count: messages.filter(m => m.body).length,
  })
})

// ── Call timeline (state journey for one call_id) ───────
// Returns every webhook event we received for this call_id, in order,
// with derived per-step duration so the UI can render a vertical
// timeline that shows the path through ringing / queued / connected /
// transferred / hangup etc.
router.get('/call/:callId/timeline', (req: Request, res: Response): void => {
  if (!req.user) { res.status(401).end(); return }
  const callId = String(req.params['callId'] || '').trim()
  if (!callId) { res.status(400).json({ error: 'callId required' }); return }
  try {
    // entry_point_target_kind lives on dialpad_call_records, not dialpad_events.
    // The entry-point info we need for the timeline is already inside the
    // raw_json blob (entry_point / entry_point_target), so just read it from
    // there.
    const rows = db.prepare(`
      SELECT id, event_state, user_email, user_name, direction, external_number,
             raw_json, received_at
      FROM dialpad_events
      WHERE call_id = ?
      ORDER BY received_at ASC, id ASC
    `).all(callId) as Array<Record<string, unknown>>

    // Compute duration since the previous event so the UI can show "+12s"
    // labels next to each state. Also pull the entry-point target name from
    // the raw payload when available so we can render the IVR/Office leg.
    let prevTs: number | null = null
    const events = rows.map((r, idx) => {
      const recvStr = r.received_at == null ? '' : String(r.received_at)
      const ts = recvStr ? new Date(recvStr.replace(' ', 'T') + (recvStr.endsWith('Z') ? '' : 'Z')).getTime() : NaN
      const sincePrev = prevTs && Number.isFinite(ts) ? Math.max(0, Math.round((ts - prevTs) / 1000)) : 0
      if (Number.isFinite(ts)) prevTs = ts
      let entryPointName: string | null = null
      let target: string | null = null
      try {
        const raw = JSON.parse(String(r.raw_json || '{}')) as Record<string, unknown>
        const ep = (raw['entry_point'] || raw['entry_point_target']) as Record<string, unknown> | undefined
        entryPointName = ep ? (String(ep['name'] || ep['type'] || '') || null) : null
        const t = raw['target'] as Record<string, unknown> | undefined
        target = t ? String(t['name'] || t['email'] || '') : null
      } catch { /* leave nulls */ }
      return {
        id: r.id, state: r.event_state || 'unknown',
        direction: r.direction, external_number: r.external_number,
        user_email: r.user_email, user_name: r.user_name,
        entry_point: entryPointName, target,
        received_at: r.received_at,
        step_index: idx, sec_since_prev: sincePrev,
      }
    })
    // Pull the call record (if we have one) so the UI can render a
    // "Listen" button without making a second round-trip just to check.
    // Falls back to nulls if no record exists yet — webhooks for live
    // events arrive before the historical sync writes the record row.
    const record = db.prepare(`
      SELECT was_recorded, was_voicemail, talk_time_sec, started_at, bucket
      FROM dialpad_call_records
      WHERE call_id = ?
      LIMIT 1
    `).get(callId) as { was_recorded?: number; was_voicemail?: number; talk_time_sec?: number; started_at?: string; bucket?: string } | undefined

    res.json({
      call_id: callId,
      events,
      count: events.length,
      has_recording: !!(record && record.was_recorded),
      has_voicemail: !!(record && record.was_voicemail),
      talk_time_sec: record?.talk_time_sec ?? null,
      started_at: record?.started_at ?? null,
      bucket: record?.bucket ?? null,
    })
  } catch (e) {
    console.error('[dialpad/timeline] error for callId', callId, e)
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

// ── Audio proxy for recordings + voicemails ────────────
// Dialpad stores recording/voicemail audio behind auth'd URLs. We fetch the
// call detail from Dialpad, extract any audio URL present (recording first,
// voicemail fallback), and stream the audio to the browser's <audio> tag.
//
// The <audio> element can't set headers, so this route accepts a JWT via
// ?token= (the authenticate middleware already supports that). Kept as a
// full arraybuffer proxy — voicemails are seconds long, recordings max out
// around a few MB each; fine for the short-term. Swap to chunked Node
// streams if we ever serve long-form audio.
function findAudioUrlFromCall(call: Record<string, unknown>): { url: string; kind: 'recording' | 'voicemail' } | null {
  // Dialpad's call detail response varies by plan; try the obvious
  // locations first and fall back to a generic recursive search.
  const candidates: Array<{ keys: Array<string | number>; kind: 'recording' | 'voicemail' }> = [
    { keys: ['recording_details', 'url'], kind: 'recording' },
    { keys: ['recording_url'], kind: 'recording' },
    { keys: ['recordings', 0, 'url'], kind: 'recording' },
    { keys: ['voicemail_details', 'url'], kind: 'voicemail' },
    { keys: ['voicemail_url'], kind: 'voicemail' },
    { keys: ['voicemail', 'url'], kind: 'voicemail' },
  ]
  for (const { keys, kind } of candidates) {
    let cur: unknown = call
    for (const k of keys) {
      if (cur == null) break
      cur = (cur as Record<string | number, unknown>)[k]
    }
    if (typeof cur === 'string' && /^https?:\/\//.test(cur)) return { url: cur, kind }
  }
  // Last resort — walk the object looking for any https URL that smells
  // audio-ish. Keeps us robust if Dialpad shifts naming on a future API rev.
  function walk(obj: unknown): { url: string; kind: 'recording' | 'voicemail' } | null {
    if (!obj || typeof obj !== 'object') return null
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === 'string' && /^https?:\/\//.test(v) && /\.(mp3|wav|m4a|ogg)/i.test(v)) {
        return { url: v, kind: /voicemail/i.test(k) ? 'voicemail' : 'recording' }
      }
      if (typeof v === 'object') {
        const hit = walk(v); if (hit) return hit
      }
    }
    return null
  }
  return walk(call)
}

router.get('/call/:callId/audio', async (req: Request, res: Response): Promise<void> => {
  if (!req.user) { res.status(401).end(); return }
  const callId = String(req.params['callId'] || '').trim()
  if (!callId) { res.status(400).json({ error: 'callId required' }); return }
  const cfg = loadDialpadConfig()
  if (!cfg) { res.status(400).json({ error: 'Dialpad not configured' }); return }

  try {
    const detail = await dialpadApi(cfg, 'GET', `/call/${encodeURIComponent(callId)}`)
    if (!detail.ok) { res.status(detail.status).json({ error: 'Dialpad call detail failed', body: detail.text.slice(0, 400) }); return }
    const hit = findAudioUrlFromCall(detail.data)
    if (!hit) { res.status(404).json({ error: 'No recording or voicemail found for this call' }); return }

    // Fetch the audio. Dialpad's recording URLs sometimes need Bearer auth
    // (our org token) — try with the token first; if the server rejects
    // the Authorization header (pre-signed URLs do this) retry bare.
    let audioRes = await fetch(hit.url, { headers: { Authorization: `Bearer ${cfg.apiKey}` } })
    if (!audioRes.ok && (audioRes.status === 400 || audioRes.status === 401 || audioRes.status === 403)) {
      audioRes = await fetch(hit.url)
    }
    if (!audioRes.ok) {
      const body = await audioRes.text().catch(() => '')
      res.status(audioRes.status).json({ error: 'Upstream audio fetch failed', body: body.slice(0, 400) })
      return
    }

    const ct = audioRes.headers.get('content-type') || (hit.url.includes('.wav') ? 'audio/wav' : 'audio/mpeg')
    const cl = audioRes.headers.get('content-length')
    res.setHeader('Content-Type', ct)
    if (cl) res.setHeader('Content-Length', cl)
    res.setHeader('X-Audio-Kind', hit.kind)
    // Buffer-then-send is fine for short clips. Swap to chunked streaming
    // if we start serving long-form recordings.
    const buf = Buffer.from(await audioRes.arrayBuffer())
    res.end(buf)
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

// ── Inbox: personal + actionable view of call records ────
// Tabs:
//   unread     = records in window without a dialpad_inbox_reads row for this user
//   all        = any direction/state
//   missed     = bucket = 'in_missed' (includes ring_no_answer)
//   vms        = bucket = 'in_voicemail' OR was_voicemail = 1
//   recordings = future — requires fetching from Dialpad stat_type=recordings;
//                currently returns empty with a flag so the UI can show a
//                "coming soon" state instead of "no data".
//
// Matching: defaults to the current user via user_email_lookup so primary
// and alternate emails both resolve. `scope=all` lets admins see everyone.
// Unified inbox — calls (dialpad_call_records) + SMS (dialpad_events where
// event_kind='sms'). Each row carries item_kind so the UI can render them
// distinctly. Tabs unread/all mix both sources; missed/vms/recordings are
// call-only; texts is SMS-only.
router.get('/inbox', (req: Request, res: Response): void => {
  if (!req.user) { res.status(401).end(); return }
  const tab = String(req.query['tab'] || 'unread').toLowerCase()
  const limit = Math.min(Math.max(parseInt(String(req.query['limit'] || '100'), 10) || 100, 1), 500)
  const days = Math.min(Math.max(parseInt(String(req.query['days'] || '14'), 10) || 14, 1), 90)
  const scopeAll = req.query['scope'] === 'all' && req.user.roles.includes('admin')

  const wantCalls = tab === 'unread' || tab === 'all' || tab === 'missed' || tab === 'vms' || tab === 'recordings'
  const wantSms = tab === 'unread' || tab === 'all' || tab === 'texts'

  // ── Calls query ──
  let callRows: Array<Record<string, unknown>> = []
  if (wantCalls) {
    const where: string[] = [`substr(r.started_at, 1, 10) >= date('now', ?)`]
    const params: unknown[] = [`-${days} days`]
    if (!scopeAll) {
      where.push(`r.user_email IN (SELECT uel.email FROM user_email_lookup uel WHERE uel.user_id = ? AND uel.system IN ('', 'dialpad'))`)
      params.push(req.user.userId)
    }
    if (tab === 'missed') where.push(`r.bucket = 'in_missed'`)
    else if (tab === 'vms') where.push(`(r.bucket = 'in_voicemail' OR r.was_voicemail = 1)`)
    else if (tab === 'recordings') where.push(`r.was_recorded = 1`)
    else if (tab === 'unread') {
      where.push(`NOT EXISTS (SELECT 1 FROM dialpad_inbox_reads ir WHERE ir.user_id = ? AND ir.call_id = r.call_id)`)
      params.push(req.user.userId)
    }

    callRows = db.prepare(`
      SELECT 'call' AS item_kind, r.call_id AS item_id,
             r.call_id, r.user_email, r.user_name, r.direction, r.bucket,
             r.external_number, r.started_at AS sort_at, r.started_at, r.connected_at, r.ended_at,
             r.talk_time_sec, r.ring_time_sec, r.was_voicemail, r.was_recorded, r.was_transfer,
             r.entry_point_target_kind,
             NULL AS message_body,
             COALESCE(u.name, r.user_name, r.user_email) AS coordinator,
             CASE WHEN ir.call_id IS NOT NULL THEN 1 ELSE 0 END AS is_read,
             ir.read_at
      FROM dialpad_call_records r
      LEFT JOIN user_email_lookup uel ON uel.email = r.user_email AND uel.system IN ('', 'dialpad')
      LEFT JOIN users u ON u.id = uel.user_id
      LEFT JOIN dialpad_inbox_reads ir ON ir.user_id = ? AND ir.call_id = r.call_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.started_at DESC
      LIMIT ?
    `).all(req.user.userId, ...params, limit) as Array<Record<string, unknown>>
  }

  // ── SMS query ──
  let smsRows: Array<Record<string, unknown>> = []
  if (wantSms) {
    const where: string[] = [`e.event_kind = 'sms'`, `substr(e.received_at, 1, 10) >= date('now', ?)`]
    const params: unknown[] = [`-${days} days`]
    if (!scopeAll) {
      where.push(`LOWER(TRIM(COALESCE(e.user_email, ''))) IN (SELECT uel.email FROM user_email_lookup uel WHERE uel.user_id = ? AND uel.system IN ('', 'dialpad'))`)
      params.push(req.user.userId)
    }
    if (tab === 'unread') {
      where.push(`NOT EXISTS (SELECT 1 FROM dialpad_sms_reads sr WHERE sr.user_id = ? AND sr.event_id = e.id)`)
      params.push(req.user.userId)
    }
    const raw = db.prepare(`
      SELECT e.id, e.call_id, e.user_email, e.user_name, e.direction,
             e.external_number, e.received_at, e.raw_json,
             COALESCE(u.name, e.user_name, e.user_email) AS coordinator,
             CASE WHEN sr.event_id IS NOT NULL THEN 1 ELSE 0 END AS is_read,
             sr.read_at
      FROM dialpad_events e
      LEFT JOIN user_email_lookup uel ON uel.email = LOWER(TRIM(COALESCE(e.user_email, ''))) AND uel.system IN ('', 'dialpad')
      LEFT JOIN users u ON u.id = uel.user_id
      LEFT JOIN dialpad_sms_reads sr ON sr.user_id = ? AND sr.event_id = e.id
      WHERE ${where.join(' AND ')}
      ORDER BY e.received_at DESC
      LIMIT ?
    `).all(req.user.userId, ...params, limit) as Array<Record<string, unknown>>
    smsRows = raw.map(r => {
      let body: string | null = null
      try {
        const p = JSON.parse(String(r.raw_json || '{}')) as Record<string, unknown>
        const s = String(p['text'] || p['message'] || p['body'] || p['message_body'] || '')
        body = s || null
      } catch { /* leave null */ }
      return {
        item_kind: 'sms', item_id: String(r.id),
        call_id: r.call_id, user_email: r.user_email, user_name: r.user_name,
        direction: r.direction,
        bucket: r.direction === 'outgoing' ? 'sms_outgoing' : 'sms_incoming',
        external_number: r.external_number,
        sort_at: r.received_at, started_at: r.received_at,
        message_body: body, coordinator: r.coordinator,
        is_read: r.is_read, read_at: r.read_at,
        talk_time_sec: 0, ring_time_sec: 0,
        was_voicemail: 0, was_recorded: 0, was_transfer: 0,
      }
    })
  }

  // Merge + sort desc by sort_at, respecting the overall limit.
  const rows = [...callRows, ...smsRows]
    .sort((a, b) => String(b.sort_at || b.started_at).localeCompare(String(a.sort_at || a.started_at)))
    .slice(0, limit)

  // Counts per tab so the UI can render badges without extra round-trips.
  // Uses the same scope filter as the main query.
  const scopeClause = scopeAll ? '1=1' : `r.user_email IN (SELECT uel.email FROM user_email_lookup uel WHERE uel.user_id = ? AND uel.system IN ('', 'dialpad'))`
  const scopeParams: unknown[] = scopeAll ? [] : [req.user.userId]
  const windowClause = `substr(r.started_at, 1, 10) >= date('now', ?)`
  const baseWhere = `${scopeClause} AND ${windowClause}`
  const baseParams = [...scopeParams, `-${days} days`]

  const counts = {
    unread: (db.prepare(
      `SELECT COUNT(*) AS c FROM dialpad_call_records r
       WHERE ${baseWhere}
         AND NOT EXISTS (SELECT 1 FROM dialpad_inbox_reads ir WHERE ir.user_id = ? AND ir.call_id = r.call_id)`
    ).get(...baseParams, req.user.userId) as { c: number }).c,
    all: (db.prepare(
      `SELECT COUNT(*) AS c FROM dialpad_call_records r WHERE ${baseWhere}`
    ).get(...baseParams) as { c: number }).c,
    missed: (db.prepare(
      `SELECT COUNT(*) AS c FROM dialpad_call_records r WHERE ${baseWhere} AND r.bucket = 'in_missed'`
    ).get(...baseParams) as { c: number }).c,
    vms: (db.prepare(
      `SELECT COUNT(*) AS c FROM dialpad_call_records r WHERE ${baseWhere} AND (r.bucket = 'in_voicemail' OR r.was_voicemail = 1)`
    ).get(...baseParams) as { c: number }).c,
    recordings: (db.prepare(
      `SELECT COUNT(*) AS c FROM dialpad_call_records r WHERE ${baseWhere} AND r.was_recorded = 1`
    ).get(...baseParams) as { c: number }).c,
    // SMS count draws from dialpad_events (webhook-delivered). If webhooks
    // aren't firing, this sits at 0 — expected, not a bug.
    texts: (db.prepare(
      `SELECT COUNT(*) AS c FROM dialpad_events e
       WHERE e.event_kind = 'sms'
         AND substr(e.received_at, 1, 10) >= date('now', ?)
         ${scopeAll ? '' : `AND LOWER(TRIM(COALESCE(e.user_email, ''))) IN (SELECT uel.email FROM user_email_lookup uel WHERE uel.user_id = ? AND uel.system IN ('', 'dialpad'))`}`
    ).get(...(scopeAll ? [`-${days} days`] : [`-${days} days`, req.user.userId])) as { c: number }).c,
  }

  res.json({ tab, rows, counts, days, scope: scopeAll ? 'all' : 'me' })
})

router.post('/inbox/read-all', (req: Request, res: Response): void => {
  if (!req.user) { res.status(401).end(); return }
  // Marks every currently-visible call AND sms item in the last 14 days as
  // read for this user. Idempotent via INSERT OR IGNORE.
  const days = 14
  db.prepare(
    `INSERT OR IGNORE INTO dialpad_inbox_reads (user_id, call_id, read_at)
     SELECT ?, r.call_id, datetime('now')
     FROM dialpad_call_records r
     WHERE substr(r.started_at, 1, 10) >= date('now', ?)
       AND r.call_id IS NOT NULL
       AND r.user_email IN (
         SELECT uel.email FROM user_email_lookup uel
         WHERE uel.user_id = ? AND uel.system IN ('', 'dialpad')
       )`
  ).run(req.user.userId, `-${days} days`, req.user.userId)
  db.prepare(
    `INSERT OR IGNORE INTO dialpad_sms_reads (user_id, event_id, read_at)
     SELECT ?, e.id, datetime('now')
     FROM dialpad_events e
     WHERE e.event_kind = 'sms'
       AND substr(e.received_at, 1, 10) >= date('now', ?)
       AND LOWER(TRIM(COALESCE(e.user_email, ''))) IN (
         SELECT uel.email FROM user_email_lookup uel
         WHERE uel.user_id = ? AND uel.system IN ('', 'dialpad')
       )`
  ).run(req.user.userId, `-${days} days`, req.user.userId)
  res.json({ ok: true })
})

// Mark/unmark a SINGLE inbox item. Accepts ?kind=call|sms so the client can
// toggle either type. Defaults to 'call' to preserve the existing API.
router.post('/inbox/:itemId/read', (req: Request, res: Response): void => {
  if (!req.user) { res.status(401).end(); return }
  const itemId = String(req.params['itemId'] || '').trim()
  const kind = String(req.query['kind'] || 'call')
  if (!itemId) { res.status(400).json({ error: 'itemId required' }); return }
  if (kind === 'sms') {
    const eventId = parseInt(itemId, 10)
    if (!eventId) { res.status(400).json({ error: 'sms itemId must be numeric event id' }); return }
    db.prepare(`INSERT OR IGNORE INTO dialpad_sms_reads (user_id, event_id) VALUES (?, ?)`).run(req.user.userId, eventId)
  } else {
    db.prepare(`INSERT OR IGNORE INTO dialpad_inbox_reads (user_id, call_id) VALUES (?, ?)`).run(req.user.userId, itemId)
  }
  res.json({ ok: true })
})

router.delete('/inbox/:itemId/read', (req: Request, res: Response): void => {
  if (!req.user) { res.status(401).end(); return }
  const itemId = String(req.params['itemId'] || '').trim()
  const kind = String(req.query['kind'] || 'call')
  if (kind === 'sms') {
    const eventId = parseInt(itemId, 10)
    if (eventId) db.prepare(`DELETE FROM dialpad_sms_reads WHERE user_id = ? AND event_id = ?`).run(req.user.userId, eventId)
  } else {
    db.prepare(`DELETE FROM dialpad_inbox_reads WHERE user_id = ? AND call_id = ?`).run(req.user.userId, itemId)
  }
  res.json({ ok: true })
})

// List coordinator names from Dialpad data for filter dropdowns
router.get('/coordinators', (_req: Request, res: Response): void => {
  const rows = db.prepare(`
    SELECT DISTINCT COALESCE(u.name, dcd.user_name, dcd.user_email) AS coordinator,
           u.id AS portal_user_id,
           dcd.user_email AS dialpad_email
    FROM dialpad_call_daily dcd
    LEFT JOIN user_email_lookup uel
      ON uel.email = dcd.user_email AND uel.system IN ('', 'dialpad')
    LEFT JOIN users u ON u.id = uel.user_id
    WHERE dcd.call_date >= date('now', '-90 days')
    ORDER BY coordinator
  `).all() as Array<{ coordinator: string; portal_user_id: number | null; dialpad_email: string }>
  res.json({ coordinators: rows })
})

export { router as dialpadRouter }
