import { Router, type Request, type Response } from 'express'
import db from '../db'

const router = Router()

function getQbConfig() {
  return { realm: process.env['QB_REALM_HOSTNAME'] || 'kin.quickbase.com', token: process.env['QB_USER_TOKEN'] || '' }
}

// ── Outreach cache table ─────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS outreach_cache (
    record_id INTEGER PRIMARY KEY,
    project_rid INTEGER,
    touchpoint_name TEXT,
    customer_name TEXT,
    project_status TEXT,
    project_state TEXT,
    project_lender TEXT,
    preferred_outreach TEXT,
    due_date TEXT,
    update_outreach TEXT,
    project_coordinator TEXT,
    coordinator_user TEXT,
    outreach_completed_date TEXT,
    display_order REAL,
    outreach_status TEXT,
    attempts INTEGER DEFAULT 0,
    is_unresponsive TEXT,
    preferred_comms TEXT,
    note TEXT,
    cached_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_outreach_touchpoint ON outreach_cache(touchpoint_name)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_outreach_coordinator ON outreach_cache(coordinator_user)`)

// ── Completed outreach cache (for analytics) ────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS outreach_completed_cache (
    record_id INTEGER PRIMARY KEY,
    project_rid INTEGER,
    touchpoint_name TEXT,
    customer_name TEXT,
    project_coordinator TEXT,
    outreach_completed_date TEXT,
    due_date TEXT,
    preferred_outreach TEXT,
    preferred_comms TEXT,
    cached_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
try { db.exec(`ALTER TABLE outreach_completed_cache ADD COLUMN preferred_outreach TEXT`) } catch { /* already exists */ }
try { db.exec(`ALTER TABLE outreach_completed_cache ADD COLUMN preferred_comms TEXT`) } catch { /* already exists */ }
db.exec(`CREATE INDEX IF NOT EXISTS idx_oc_touchpoint ON outreach_completed_cache(touchpoint_name)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_oc_coordinator ON outreach_completed_cache(project_coordinator)`)

// ── Post-POS adders cache (report 35 on bsaycczmf) ──────
db.exec(`
  CREATE TABLE IF NOT EXISTS adder_notify_cache (
    record_id INTEGER PRIMARY KEY,
    project_rid INTEGER,
    customer_name TEXT,
    product_category TEXT,
    product_name TEXT,
    qty REAL,
    adder_total REAL,
    adder_status TEXT,
    ops_approval_status TEXT,
    whos_paying TEXT,
    project_status TEXT,
    project_closer TEXT,
    project_coordinator TEXT,
    customer_state TEXT,
    date_created TEXT,
    sales_notified_date TEXT,
    sla_start_date TEXT,
    sla_timer_days REAL,
    rep_notified_date TEXT,
    ops_review_note TEXT,
    design_callout_note TEXT,
    cached_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
// Back-fill columns for existing installs (harmless if already present)
try { db.exec(`ALTER TABLE adder_notify_cache ADD COLUMN ops_review_note TEXT`) } catch { /* already exists */ }
try { db.exec(`ALTER TABLE adder_notify_cache ADD COLUMN design_callout_note TEXT`) } catch { /* already exists */ }
db.exec(`CREATE INDEX IF NOT EXISTS idx_adder_coordinator ON adder_notify_cache(project_coordinator)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_adder_closer ON adder_notify_cache(project_closer)`)

// ── Dialpad comms cache (read-only v1 from QB mapped records) ─
db.exec(`
  CREATE TABLE IF NOT EXISTS dialpad_sms_cache (
    dialpad_id TEXT PRIMARY KEY,
    project_rid INTEGER,
    occurred_at TEXT,
    direction TEXT,
    from_number TEXT,
    to_number TEXT,
    body TEXT,
    message_status TEXT,
    delivery_result TEXT,
    contact_name TEXT,
    user_name TEXT,
    user_email TEXT,
    formatted_card TEXT,
    cached_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_dialpad_sms_project ON dialpad_sms_cache(project_rid, occurred_at DESC)`)

db.exec(`
  CREATE TABLE IF NOT EXISTS dialpad_call_cache (
    dialpad_call_id TEXT,
    project_rid INTEGER,
    occurred_at TEXT,
    direction TEXT,
    call_state TEXT,
    duration_ms INTEGER,
    from_number TEXT,
    from_name TEXT,
    to_number TEXT,
    to_name TEXT,
    external_number TEXT,
    target_name TEXT,
    recording_url TEXT,
    voicemail_url TEXT,
    transcription TEXT,
    missed_reason TEXT,
    formatted_card TEXT,
    cached_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (dialpad_call_id, call_state, occurred_at)
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_dialpad_call_project ON dialpad_call_cache(project_rid, occurred_at DESC)`)

db.exec(`
  CREATE TABLE IF NOT EXISTS dialpad_notification_dedupe (
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (source, source_id, user_id)
  )
`)

const OUTREACH_TABLE = 'btvik5kwi'

// Field IDs from actual QB reports
const fMap: Array<{ fid: number; col: string }> = [
  { fid: 3, col: 'record_id' },
  { fid: 10, col: 'project_rid' },
  { fid: 6, col: 'touchpoint_name' },
  { fid: 11, col: 'customer_name' },       // Full Name
  { fid: 56, col: 'project_status' },
  { fid: 63, col: 'project_state' },
  { fid: 65, col: 'project_lender' },
  { fid: 87, col: 'preferred_outreach' },
  { fid: 20, col: 'due_date' },            // Dashboard Visibility Function
  { fid: 33, col: 'update_outreach' },      // Rich-text link
  { fid: 17, col: 'project_coordinator' },
  { fid: 94, col: 'coordinator_user' },     // User field for personal filter
  { fid: 18, col: 'outreach_completed_date' },
  { fid: 36, col: 'display_order' },
  { fid: 43, col: 'outreach_status' },
  { fid: 44, col: 'attempts' },
  { fid: 77, col: 'is_unresponsive' },      // "Project - Is Unresponsive?"
  { fid: 51, col: 'preferred_comms' },       // Welcome Call Preferred Communications
  { fid: 8, col: 'note' },
]

// Status exclusion formula from QB report -1:
// Exclude: ARC, ROR, Cancelled, Rejected, Pending Cancel, Pending KCA, Complete, Completed
// Exception: Rep Cancel touchpoints are always included
const EXCLUDED_STATUSES = ['ARC', 'ROR', 'Cancelled', 'Rejected', 'Pending Cancel', 'Pending KCA', 'Complete', 'Completed']

function passesStatusExclusion(touchpoint: string, projectStatus: string): boolean {
  if (touchpoint.includes('Rep Cancel') || touchpoint.includes('Cancel Reactivation')) return true
  return !EXCLUDED_STATUSES.some(s => projectStatus === s)
}

function val(r: Record<string, { value: unknown }>, fid: number): string {
  const v = r[String(fid)]?.value
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') {
    if ('name' in (v as Record<string, unknown>)) return String((v as { name: string }).name)
    if ('email' in (v as Record<string, unknown>)) return String((v as { email: string }).email)
  }
  if (Array.isArray(v)) return v.join(', ')
  return String(v)
}

function qbHeaders(realm: string, token: string) {
  return {
    'QB-Realm-Hostname': realm,
    'Authorization': `QB-USER-TOKEN ${token}`,
    'Content-Type': 'application/json',
  }
}

function toIsoish(raw: string): string {
  if (!raw) return ''
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) {
    const ms = n > 10_000_000_000 ? n : n * 1000
    return new Date(ms).toISOString()
  }
  return raw
}

function normalizePhone(raw: string): string {
  const digits = (raw || '').replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1)
  return digits.slice(-10)
}

function findProjectByPhone(phoneToProject: Map<string, number>, ...phones: string[]): number | null {
  for (const phone of phones) {
    const normalized = normalizePhone(phone)
    if (normalized && phoneToProject.has(normalized)) return phoneToProject.get(normalized)!
  }
  return null
}

function parseProjectRid(raw: string): number | null {
  const direct = parseInt(raw, 10)
  if (direct) return direct
  const match = (raw || '').match(/\b\d{3,}\b/)
  return match ? parseInt(match[0], 10) || null : null
}

function isoDateFromLocal(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function parseDateParts(date: string): [number, number, number] | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return null
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)]
}

function localDateToUtcIso(date: string, tzOffsetMin: number, plusDays = 0): string {
  const parts = parseDateParts(date)
  if (!parts) return `${date}T00:00:00.000Z`
  const [year, month, day] = parts
  const utcMs = Date.UTC(year, month - 1, day + plusDays, 0, 0, 0) + tzOffsetMin * 60 * 1000
  return new Date(utcMs).toISOString()
}

function toLocalDateKey(raw: string, tzOffsetMin: number): string {
  if (!raw) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const ms = new Date(raw).getTime()
  if (!Number.isFinite(ms)) return raw.slice(0, 10)
  return new Date(ms - tzOffsetMin * 60 * 1000).toISOString().slice(0, 10)
}

function normalizeContactMethod(...values: Array<string | null | undefined>): string {
  const combined = values
    .flatMap(v => String(v || '').split(','))
    .map(v => v.trim().toLowerCase())
    .filter(Boolean)
    .join(' ')
  if (!combined) return 'Unknown'
  if (combined.includes('text') || combined.includes('sms')) return 'Text'
  if (combined.includes('email')) return 'Email'
  if (combined.includes('call') || combined.includes('phone')) return 'Phone'
  return 'Other'
}

interface CommsSummary {
  sms_count_7d: number
  call_count_7d: number
  last_comms_at: string
  last_inbound_sms_at: string
  last_call_direction: string
  has_recent_inbound: number
}

const emptyCommsSummary: CommsSummary = {
  sms_count_7d: 0,
  call_count_7d: 0,
  last_comms_at: '',
  last_inbound_sms_at: '',
  last_call_direction: '',
  has_recent_inbound: 0,
}

function getCommsSummary(projectRid: number): CommsSummary {
  if (!projectRid) return emptyCommsSummary
  const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const since24 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const sms = db.prepare(`
    SELECT
      SUM(CASE WHEN occurred_at >= ? THEN 1 ELSE 0 END) as sms_count_7d,
      MAX(CASE WHEN direction = 'inbound' THEN occurred_at ELSE '' END) as last_inbound_sms_at,
      MAX(occurred_at) as last_sms_at,
      SUM(CASE WHEN direction = 'inbound' AND occurred_at >= ? THEN 1 ELSE 0 END) as recent_inbound_sms
    FROM dialpad_sms_cache
    WHERE project_rid = ?
  `).get(since7, since24, projectRid) as {
    sms_count_7d: number | null
    last_inbound_sms_at: string | null
    last_sms_at: string | null
    recent_inbound_sms: number | null
  } | undefined
  const calls = db.prepare(`
    SELECT
      SUM(CASE WHEN occurred_at >= ? THEN 1 ELSE 0 END) as call_count_7d,
      MAX(occurred_at) as last_call_at,
      (SELECT direction FROM dialpad_call_cache WHERE project_rid = ? ORDER BY occurred_at DESC LIMIT 1) as last_call_direction,
      SUM(CASE WHEN direction = 'inbound' AND call_state IN ('missed','voicemail','voicemail_uploaded') AND occurred_at >= ? THEN 1 ELSE 0 END) as recent_inbound_call
    FROM dialpad_call_cache
    WHERE project_rid = ?
  `).get(since7, projectRid, since24, projectRid) as {
    call_count_7d: number | null
    last_call_at: string | null
    last_call_direction: string | null
    recent_inbound_call: number | null
  } | undefined
  const lastSms = sms?.last_sms_at || ''
  const lastCall = calls?.last_call_at || ''
  return {
    sms_count_7d: sms?.sms_count_7d || 0,
    call_count_7d: calls?.call_count_7d || 0,
    last_comms_at: lastSms > lastCall ? lastSms : lastCall,
    last_inbound_sms_at: sms?.last_inbound_sms_at || '',
    last_call_direction: calls?.last_call_direction || '',
    has_recent_inbound: (sms?.recent_inbound_sms || 0) > 0 || (calls?.recent_inbound_call || 0) > 0 ? 1 : 0,
  }
}

function enrichComms<T extends Record<string, unknown>>(rows: T[], projectKey: string): Array<T & CommsSummary> {
  return rows.map(row => ({
    ...row,
    ...getCommsSummary(Number(row[projectKey]) || 0),
  }))
}

function getRecentInboundComms(coordinator?: string): Array<Record<string, unknown>> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const coordSms = coordinator ? 'AND pc.coordinator = ?' : ''
  const smsParams: unknown[] = coordinator ? [since, coordinator] : [since]
  const sms = db.prepare(`
    SELECT 'sms' as type, s.dialpad_id as source_id, s.project_rid, s.occurred_at,
           s.contact_name, s.body as preview, s.direction,
           pc.customer_name, pc.coordinator, pc.state
    FROM dialpad_sms_cache s
    LEFT JOIN project_cache pc ON pc.record_id = s.project_rid
    WHERE s.direction = 'inbound' AND s.occurred_at >= ? ${coordSms}
  `).all(...smsParams) as Array<Record<string, unknown>>

  const coordCalls = coordinator ? 'AND pc.coordinator = ?' : ''
  const callParams: unknown[] = coordinator ? [since, coordinator] : [since]
  const calls = db.prepare(`
    SELECT 'call' as type, c.dialpad_call_id as source_id, c.project_rid, c.occurred_at,
           COALESCE(NULLIF(c.from_name, ''), NULLIF(c.external_number, ''), c.from_number) as contact_name,
           COALESCE(NULLIF(c.transcription, ''), NULLIF(c.missed_reason, ''), c.call_state) as preview,
           c.direction, c.call_state,
           pc.customer_name, pc.coordinator, pc.state
    FROM dialpad_call_cache c
    LEFT JOIN project_cache pc ON pc.record_id = c.project_rid
    WHERE c.direction = 'inbound'
      AND c.call_state IN ('missed','voicemail','voicemail_uploaded')
      AND c.occurred_at >= ? ${coordCalls}
  `).all(...callParams) as Array<Record<string, unknown>>

  return [...sms, ...calls]
    .sort((a, b) => String(b.occurred_at || '').localeCompare(String(a.occurred_at || '')))
    .reduce((acc, row) => {
      const projectRid = Number(row.project_rid) || 0
      if (!projectRid) return acc
      const existing = acc.find(r => Number(r.project_rid) === projectRid)
      if (existing) {
        existing.sms_count_7d = Number(existing.sms_count_7d || 0) + (row.type === 'sms' ? 1 : 0)
        existing.call_count_7d = Number(existing.call_count_7d || 0) + (row.type === 'call' ? 1 : 0)
        return acc
      }
      acc.push({
        ...row,
        sms_count_7d: row.type === 'sms' ? 1 : 0,
        call_count_7d: row.type === 'call' ? 1 : 0,
      })
      return acc
    }, [] as Array<Record<string, unknown>>)
    .slice(0, 50)
}

// ── Refresh cache ────────────────────────────────────────

async function refreshOutreachCache(): Promise<{ total: number; duration: number }> {
  const start = Date.now()
  const { realm, token } = getQbConfig()

  // Fetch non-completed outreach with due date populated (matches report 64 base filter)
  // {'18'.EX.''} AND {'20'.XEX.''}
  let allRecords: Array<Record<string, { value: unknown }>> = []
  let skip = 0
  const batchSize = 1000

  while (true) {
    const res = await fetch('https://api.quickbase.com/v1/records/query', {
      method: 'POST',
      headers: {
        'QB-Realm-Hostname': realm,
        'Authorization': `QB-USER-TOKEN ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: OUTREACH_TABLE,
        select: fMap.map(f => f.fid),
        where: "{'18'.EX.''}AND{'20'.XEX.''}AND{'20'.OAF.'2024-01-01'}",
        sortBy: [{ fieldId: 36, order: 'ASC' }, { fieldId: 6, order: 'ASC' }],
        options: { skip, top: batchSize },
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`QB outreach query failed (${res.status}): ${text}`)
    }

    const data = await res.json()
    const records = data.data || []
    allRecords = allRecords.concat(records)
    if (records.length < batchSize) break
    skip += batchSize
  }

  db.prepare('DELETE FROM outreach_cache').run()

  const cols = fMap.map(f => f.col).join(', ')
  const placeholders = fMap.map(() => '?').join(', ')
  const insert = db.prepare(
    `INSERT OR REPLACE INTO outreach_cache (${cols}, cached_at) VALUES (${placeholders}, datetime('now'))`
  )

  db.transaction(() => {
    for (const record of allRecords) {
      const values = fMap.map(f => {
        if (f.col === 'attempts' || f.col === 'display_order') return parseFloat(val(record, f.fid)) || 0
        return val(record, f.fid)
      })
      insert.run(...values)
    }
  })()

  return { total: allRecords.length, duration: Date.now() - start }
}

// ── API Routes ───────────────────────────────────────────

router.post('/refresh', async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await refreshOutreachCache()
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

async function refreshCommsCache(): Promise<{ sms: number; calls: number; notifications: number; duration: number }> {
  const start = Date.now()
  const { realm, token } = getQbConfig()
  if (!token) throw new Error('QB_USER_TOKEN not configured')

  const smsFields = [6, 8, 9, 10, 11, 12, 13, 14, 23, 29, 34, 40, 51, 53, 58]
  const callFields = [6, 10, 11, 12, 13, 15, 16, 18, 19, 20, 21, 22, 24, 40, 48, 51, 52, 57, 60, 93, 97, 109, 119]

  async function queryAll(tableId: string, select: number[], where: string) {
    let all: Array<Record<string, { value: unknown }>> = []
    let skip = 0
    const top = 1000
    while (true) {
      const response = await fetch('https://api.quickbase.com/v1/records/query', {
        method: 'POST',
        headers: qbHeaders(realm, token),
        body: JSON.stringify({
          from: tableId,
          select,
          ...(where ? { where } : {}),
          sortBy: [{ fieldId: tableId === 'bvjf44d7d' ? 40 : 93, order: 'DESC' }],
          options: { skip, top },
        }),
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(`QB comms query failed (${response.status}): ${text}`)
      }
      const data = await response.json()
      const records = data.data || []
      all = all.concat(records)
      if (records.length < top) break
      skip += top
    }
    return all
  }

  const smsRecords = await queryAll('bvjf44d7d', smsFields, "{'58'.XEX.''}")
  const callRecords = await queryAll('bvjf2i36u', callFields, '')
  const projectPhones = db.prepare(`
    SELECT record_id, phone FROM project_cache
    WHERE phone IS NOT NULL AND phone != ''
  `).all() as Array<{ record_id: number; phone: string }>
  const phoneToProject = new Map<string, number>()
  for (const p of projectPhones) {
    const normalized = normalizePhone(p.phone)
    if (normalized && !phoneToProject.has(normalized)) phoneToProject.set(normalized, p.record_id)
  }

  db.prepare('DELETE FROM dialpad_sms_cache').run()
  db.prepare('DELETE FROM dialpad_call_cache').run()

  const insertSms = db.prepare(`
    INSERT OR REPLACE INTO dialpad_sms_cache
      (dialpad_id, project_rid, occurred_at, direction, from_number, to_number, body,
       message_status, delivery_result, contact_name, user_name, user_email, formatted_card, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `)
  const insertCall = db.prepare(`
    INSERT OR REPLACE INTO dialpad_call_cache
      (dialpad_call_id, project_rid, occurred_at, direction, call_state, duration_ms,
       from_number, from_name, to_number, to_name, external_number, target_name,
       recording_url, voicemail_url, transcription, missed_reason, formatted_card, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `)

  db.transaction(() => {
    for (const r of smsRecords) {
      const id = val(r, 6)
      const projectRid = parseProjectRid(val(r, 58)) || findProjectByPhone(phoneToProject, val(r, 10), val(r, 11))
      if (!id || !projectRid) continue
      insertSms.run(
        id,
        projectRid,
        toIsoish(val(r, 40) || val(r, 8)),
        val(r, 9),
        val(r, 10),
        val(r, 11),
        val(r, 12),
        val(r, 13),
        val(r, 14),
        val(r, 51) || val(r, 23),
        val(r, 29),
        val(r, 34),
        val(r, 53),
      )
    }
    for (const r of callRecords) {
      const id = val(r, 6)
      const projectRid = parseProjectRid(val(r, 119)) || findProjectByPhone(phoneToProject, val(r, 24), val(r, 19), val(r, 21))
      if (!id || !projectRid) continue
      const transcription = val(r, 60) || val(r, 52)
      insertCall.run(
        id,
        projectRid,
        toIsoish(val(r, 93) || val(r, 97) || val(r, 15) || val(r, 13) || val(r, 12) || val(r, 11)),
        val(r, 18),
        val(r, 10),
        parseInt(val(r, 16)) || 0,
        val(r, 19),
        val(r, 20),
        val(r, 21),
        val(r, 22),
        val(r, 24),
        val(r, 40),
        val(r, 48),
        val(r, 51),
        transcription,
        val(r, 57),
        val(r, 109),
      )
    }
  })()

  const notifications = createCommsNotifications()
  return { sms: smsRecords.length, calls: callRecords.length, notifications, duration: Date.now() - start }
}

function createCommsNotifications(): number {
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  const usersByName = db.prepare(`
    SELECT u.id, u.name
    FROM users u
    WHERE u.is_active = 1
  `).all() as Array<{ id: number; name: string }>
  const userMap = new Map(usersByName.map(u => [u.name.toLowerCase(), u.id]))

  const insertDedupe = db.prepare(`
    INSERT OR IGNORE INTO dialpad_notification_dedupe (source, source_id, user_id)
    VALUES (?, ?, ?)
  `)
  const insertNotification = db.prepare(`
    INSERT INTO notifications (user_id, type, title, body, link)
    VALUES (?, ?, ?, ?, ?)
  `)

  let created = 0
  const smsRows = db.prepare(`
    SELECT s.dialpad_id, s.project_rid, s.body, s.contact_name, s.occurred_at,
           pc.customer_name, pc.coordinator
    FROM dialpad_sms_cache s
    LEFT JOIN project_cache pc ON pc.record_id = s.project_rid
    WHERE s.direction = 'inbound' AND s.occurred_at >= ?
  `).all(since) as Array<{ dialpad_id: string; project_rid: number; body: string; contact_name: string; customer_name: string; coordinator: string }>

  for (const row of smsRows) {
    const userId = userMap.get((row.coordinator || '').toLowerCase())
    if (!userId) continue
    const result = insertDedupe.run('dialpad_sms', row.dialpad_id, userId)
    if (result.changes === 0) continue
    insertNotification.run(
      userId,
      'info',
      `New SMS from ${row.customer_name || row.contact_name || 'customer'}`,
      row.body ? row.body.slice(0, 180) : 'Inbound customer message',
      `/projects/pc?commsProject=${row.project_rid}`,
    )
    created++
  }

  const callRows = db.prepare(`
    SELECT c.dialpad_call_id, c.project_rid, c.call_state, c.missed_reason, c.transcription,
           pc.customer_name, pc.coordinator
    FROM dialpad_call_cache c
    LEFT JOIN project_cache pc ON pc.record_id = c.project_rid
    WHERE c.direction = 'inbound'
      AND c.call_state IN ('missed','voicemail','voicemail_uploaded')
      AND c.occurred_at >= ?
  `).all(since) as Array<{ dialpad_call_id: string; project_rid: number; call_state: string; missed_reason: string; transcription: string; customer_name: string; coordinator: string }>

  for (const row of callRows) {
    const userId = userMap.get((row.coordinator || '').toLowerCase())
    if (!userId) continue
    const sourceId = `${row.dialpad_call_id}:${row.call_state}`
    const result = insertDedupe.run('dialpad_call', sourceId, userId)
    if (result.changes === 0) continue
    insertNotification.run(
      userId,
      row.call_state === 'missed' ? 'warning' : 'info',
      `${row.call_state === 'missed' ? 'Missed call' : 'Voicemail'} from ${row.customer_name || 'customer'}`,
      row.transcription ? row.transcription.slice(0, 180) : row.missed_reason || 'Inbound customer call',
      `/projects/pc?commsProject=${row.project_rid}`,
    )
    created++
  }

  return created
}

router.post('/refresh-comms', async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await refreshCommsCache()
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Touchpoint stage order (matches QB KPI report layout)
// Ordered by project milestone lifecycle
const STAGE_ORDER = [
  'Initial Outreach', 'Check-In', 'Design Approval',
  'Permit Submitted', 'Permit Received',
  'Install Complete',
  'Inspection Scheduled', 'Inspection Complete',
  'PTO Approval',
  'Cancel Reactivation', 'Rep Cancel Request',
]

// Dashboard data
router.get('/', (req: Request, res: Response): void => {
  const coordinator = req.query['coordinator'] as string | undefined
  const state = req.query['state'] as string | undefined
  const lender = req.query['lender'] as string | undefined
  const clientToday = req.query['today'] as string | undefined
  const today = (clientToday && /^\d{4}-\d{2}-\d{2}$/.test(clientToday)) ? clientToday : isoDateFromLocal()

  // Get all non-completed outreach where due_date <= today
  let allRows = db.prepare(
    `SELECT * FROM outreach_cache WHERE due_date <= ? ORDER BY display_order ASC, due_date ASC`
  ).all(today) as Array<Record<string, unknown>>

  // Apply status exclusion formula (matches QB formula field -1)
  allRows = allRows.filter(r =>
    passesStatusExclusion(String(r.touchpoint_name || ''), String(r.project_status || ''))
  )

  // Split into main list vs unresponsive
  // Report logic: main list shows non-unresponsive (PLUS Rep Cancel unresponsive)
  // Unresponsive panel shows unresponsive records (excluding ARC/ROR/Cancelled/Rejected/Pending Cancel/Sales Aid)
  const isUnresponsive = (r: Record<string, unknown>) => String(r.is_unresponsive || '').includes('Unresponsive')
  const UNRESPONSIVE_EXCLUDED = ['ARC', 'ROR', 'Cancelled', 'Rejected', 'Pending Cancel', 'Sales Aid']

  let mainRows = allRows.filter(r => {
    if (isUnresponsive(r)) {
      // Unresponsive records only show in main list if touchpoint is Rep Cancel Request
      return String(r.touchpoint_name) === 'Rep Cancel Request'
    }
    return true
  })

  const unresponsiveRows = allRows.filter(r =>
    isUnresponsive(r) && !UNRESPONSIVE_EXCLUDED.some(s => String(r.project_status) === s)
  )

  // Apply user filters
  if (coordinator) {
    mainRows = mainRows.filter(r => String(r.project_coordinator || '') === coordinator)
  }
  if (state) mainRows = mainRows.filter(r => String(r.project_state) === state)
  if (lender) mainRows = mainRows.filter(r => String(r.project_lender) === lender)

  // KPI counts per stage
  const kpi: Record<string, number> = {}
  for (const s of STAGE_ORDER) kpi[s] = 0
  for (const r of mainRows) {
    const tp = String(r.touchpoint_name)
    if (kpi[tp] !== undefined) kpi[tp]++
    else kpi[tp] = 1
  }

  const mainRowsWithComms = enrichComms(mainRows, 'project_rid')

  // Group records by touchpoint
  const groups: Record<string, Array<Record<string, unknown>>> = {}
  for (const s of STAGE_ORDER) groups[s] = []
  for (const r of mainRowsWithComms) {
    const tp = String(r.touchpoint_name)
    if (!groups[tp]) groups[tp] = []
    groups[tp].push(r)
  }

  // Statuses that close/pause a project — excluded from Blocked NEM/PTO panels
  // so reps don't see dead accounts cluttering blocker lists.
  const DEAD_STATUSES = ['Cancelled', 'Pending Cancel', 'Lost', 'ROR']
  const deadPlaceholders = DEAD_STATUSES.map(() => '?').join(',')

  // Blocked NEM from project_cache
  const blockedNemParams: unknown[] = [...DEAD_STATUSES]
  let blockedNemWhere = ''
  if (coordinator) { blockedNemWhere = `AND pc.coordinator = ?`; blockedNemParams.push(coordinator) }
  const blockedNem = db.prepare(
    `SELECT pc.record_id, pc.customer_name, pc.coordinator, pc.state, pc.nem_submitted, pc.nem_approved,
            pc.nem_rejected, pc.status
     FROM project_cache pc
     WHERE pc.nem_submitted != '' AND pc.nem_submitted IS NOT NULL
       AND (pc.nem_approved = '' OR pc.nem_approved IS NULL)
       AND (pc.nem_rejected = '' OR pc.nem_rejected IS NULL)
       AND pc.status NOT IN (${deadPlaceholders})
       ${blockedNemWhere}
     ORDER BY pc.nem_submitted ASC`
  ).all(...blockedNemParams) as Array<Record<string, unknown>>

  // Blocked PTO — projects with PTO blockers that haven't approved/closed yet
  // Source: pto_cache (table bsc9kt8n5). Excludes dead statuses so reps only see
  // live accounts. Sorted by inspection_passed asc so oldest-waiting floats up.
  const blockedPto = (() => {
    try {
      const params: unknown[] = [...DEAD_STATUSES]
      let coordJoin = ''
      let coordFilter = ''
      if (coordinator) {
        coordJoin = 'JOIN project_cache pc ON pc.record_id = p.project_rid'
        coordFilter = 'AND pc.coordinator = ?'
        params.push(coordinator)
      } else {
        coordJoin = 'LEFT JOIN project_cache pc ON pc.record_id = p.project_rid'
      }
      return db.prepare(
        `SELECT p.record_id, p.project_rid,
                p.project_name AS customer_name,
                COALESCE(pc.coordinator, p.assigned_user, '') AS coordinator,
                p.state, p.pto_status, p.pto_submitted, p.pto_approved,
                p.inspection_passed, p.blockers, p.blocker_tickets, p.open_tickets,
                COALESCE(NULLIF(pc.status, ''), p.project_status) AS status
         FROM pto_cache p
         ${coordJoin}
         WHERE p.blockers IS NOT NULL AND p.blockers != '' AND p.blockers != '[]'
           AND (p.pto_approved IS NULL OR p.pto_approved = '')
           AND COALESCE(NULLIF(pc.status, ''), p.project_status) NOT IN (${deadPlaceholders})
           ${coordFilter}
         ORDER BY COALESCE(p.inspection_passed, '') ASC, p.record_id DESC`
      ).all(...params) as Array<Record<string, unknown>>
    } catch {
      // pto_cache might not exist yet
      return []
    }
  })()

  // PTO records whose blocker reason mentions "unresponsive customer(s)" —
  // surface them inside the Unresponsive Customers panel.
  const ptoUnresponsiveRows = (() => {
    try {
      const coordClause = coordinator ? `AND pc.coordinator = ?` : ''
      const params: unknown[] = coordinator ? [coordinator] : []
      return db.prepare(
        `SELECT p.record_id, p.project_rid, p.project_name AS customer_name,
                COALESCE(pc.coordinator, '') AS project_coordinator,
                p.state AS project_state, p.blockers, p.pto_status
         FROM pto_cache p
         LEFT JOIN project_cache pc ON pc.record_id = p.project_rid
         WHERE LOWER(p.blockers) LIKE '%unresponsive customer%'
           ${coordClause}
         ORDER BY p.record_id DESC`
      ).all(...params) as Array<Record<string, unknown>>
    } catch {
      // pto_cache might not exist yet
      return []
    }
  })()

  // Filter options
  const coordRows = db.prepare(`SELECT DISTINCT project_coordinator AS v FROM outreach_cache WHERE project_coordinator != '' ORDER BY v`).all() as Array<{ v: string }>
  const stateRows = db.prepare(`SELECT DISTINCT project_state AS v FROM outreach_cache WHERE project_state != '' ORDER BY v`).all() as Array<{ v: string }>
  const lenderRows = db.prepare(`SELECT DISTINCT project_lender AS v FROM outreach_cache WHERE project_lender != '' ORDER BY v`).all() as Array<{ v: string }>

  const cacheRow = db.prepare('SELECT COUNT(*) AS total, MAX(cached_at) AS last_refresh FROM outreach_cache').get() as { total: number; last_refresh: string }

  const outreachUnresponsive = (coordinator
    ? unresponsiveRows.filter(r => String(r.project_coordinator || '') === coordinator)
    : unresponsiveRows
  ).map(r => ({ ...r, source: 'outreach' as const }))

  const ptoUnresponsive = ptoUnresponsiveRows.map(r => ({
    record_id: Number(r.record_id) || 0,
    project_rid: Number(r.project_rid) || 0,
    customer_name: String(r.customer_name || ''),
    project_coordinator: String(r.project_coordinator || ''),
    project_state: String(r.project_state || ''),
    touchpoint_name: 'PTO Blocker',
    blockers: String(r.blockers || ''),
    pto_status: String(r.pto_status || ''),
    source: 'pto_blocker' as const,
  }))
  const recentInbound = getRecentInboundComms(coordinator)

  res.json({
    kpi,
    groups,
    exceptions: {
      unresponsive: enrichComms([...outreachUnresponsive, ...ptoUnresponsive], 'project_rid'),
      blockedNem: enrichComms(blockedNem, 'record_id'),
      blockedPto: enrichComms(blockedPto, 'project_rid'),
      recentInbound,
    },
    filters: {
      coordinators: coordRows.map(r => r.v),
      states: stateRows.map(r => r.v),
      lenders: lenderRows.map(r => r.v),
    },
    cache: cacheRow,
    stageOrder: STAGE_ORDER,
  })
})

router.get('/comms', (req: Request, res: Response): void => {
  const projectId = parseInt(String(req.query['project_id'] || ''), 10)
  const limit = Math.min(parseInt(String(req.query['limit'] || '100'), 10) || 100, 300)
  if (!projectId) { res.status(400).json({ error: 'project_id is required' }); return }

  const project = db.prepare(`
    SELECT record_id, customer_name, coordinator, state, status, phone, email
    FROM project_cache
    WHERE record_id = ?
  `).get(projectId) as Record<string, unknown> | undefined

  const sms = db.prepare(`
    SELECT
      'sms' as type,
      dialpad_id as id,
      project_rid,
      occurred_at,
      direction,
      from_number,
      to_number,
      body,
      message_status,
      delivery_result,
      contact_name,
      user_name,
      user_email,
      NULL as call_state,
      NULL as duration_ms,
      NULL as recording_url,
      NULL as voicemail_url,
      NULL as transcription,
      NULL as missed_reason
    FROM dialpad_sms_cache
    WHERE project_rid = ?
  `).all(projectId) as Array<Record<string, unknown>>

  const calls = db.prepare(`
    SELECT
      'call' as type,
      dialpad_call_id as id,
      project_rid,
      occurred_at,
      direction,
      from_number,
      to_number,
      NULL as body,
      NULL as message_status,
      NULL as delivery_result,
      COALESCE(NULLIF(from_name, ''), NULLIF(to_name, ''), NULLIF(external_number, '')) as contact_name,
      target_name as user_name,
      NULL as user_email,
      call_state,
      duration_ms,
      recording_url,
      voicemail_url,
      transcription,
      missed_reason
    FROM dialpad_call_cache
    WHERE project_rid = ?
  `).all(projectId) as Array<Record<string, unknown>>

  const items = [...sms, ...calls]
    .filter(i => i.occurred_at)
    .sort((a, b) => String(b.occurred_at || '').localeCompare(String(a.occurred_at || '')))
    .slice(0, limit)
    .reverse()

  res.json({
    project: project || { record_id: projectId },
    summary: getCommsSummary(projectId),
    items,
  })
})

// ── Analytics: completed outreach for performance metrics ──

async function refreshCompletedCache(): Promise<{ total: number; duration: number }> {
  const start = Date.now()
  const { realm, token } = getQbConfig()

  // Fetch completed outreach for Initial Outreach + Design Approval from last 6 months
  const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  const analyticsFields = [3, 10, 6, 11, 17, 18, 20, 51, 87]

  let allRecords: Array<Record<string, { value: unknown }>> = []
  let skip = 0
  const batchSize = 1000

  while (true) {
    const res = await fetch('https://api.quickbase.com/v1/records/query', {
      method: 'POST',
      headers: {
        'QB-Realm-Hostname': realm,
        'Authorization': `QB-USER-TOKEN ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: OUTREACH_TABLE,
        select: analyticsFields,
        where: `{'18'.XEX.''}AND{'18'.OAF.'${sixMonthsAgo}'}`,
        sortBy: [{ fieldId: 18, order: 'DESC' }],
        options: { skip, top: batchSize },
      }),
    })

    if (!res.ok) break
    const data = await res.json()
    const records = data.data || []
    allRecords = allRecords.concat(records)
    if (records.length < batchSize) break
    skip += batchSize
  }

  db.prepare('DELETE FROM outreach_completed_cache').run()
  const insert = db.prepare(
    `INSERT OR REPLACE INTO outreach_completed_cache (record_id, project_rid, touchpoint_name, customer_name, project_coordinator, outreach_completed_date, due_date, preferred_outreach, preferred_comms, cached_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  )

  db.transaction(() => {
    for (const r of allRecords) {
      insert.run(
        parseInt(val(r, 3)) || 0,
        parseInt(val(r, 10)) || 0,
        val(r, 6),
        val(r, 11),
        val(r, 17),
        val(r, 18),
        val(r, 20),
        val(r, 87),
        val(r, 51),
      )
    }
  })()

  return { total: allRecords.length, duration: Date.now() - start }
}

router.post('/refresh-analytics', async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await refreshCompletedCache()
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Touchpoint → project milestone field mapping for time-to-event calculation
const TOUCHPOINT_MILESTONE: Record<string, string> = {
  'Initial Outreach': 'sales_date',
  'Design Approval': 'design_completed',
  'Permit Submitted': 'permit_submitted',
  'Permit Received': 'permit_approved',
  'Install Complete': 'install_completed',
  'Inspection Scheduled': 'inspection_scheduled',
  'Inspection Complete': 'inspection_passed',
  'PTO Approval': 'pto_submitted',
  'Check-In': 'sales_date',
}

router.get('/analytics', (req: Request, res: Response): void => {
  const coordinator = req.query['coordinator'] as string | undefined
  const touchpoint = req.query['touchpoint'] as string || 'Initial Outreach'
  const dateFrom = req.query['date_from'] as string | undefined
  const dateTo = req.query['date_to'] as string | undefined
  const tzOffsetMin = parseInt(req.query['tz_offset_min'] as string, 10)
  const useBizDays = req.query['biz_days'] === '1'
  const bizFactor = useBizDays ? 5 / 7 : 1
  const safeTzOffsetMin = Number.isFinite(tzOffsetMin) ? tzOffsetMin : 0

  const milestoneCol = TOUCHPOINT_MILESTONE[touchpoint] || 'sales_date'

  const where: string[] = [`oc.touchpoint_name = ?`]
  const params: unknown[] = [touchpoint]
  if (coordinator) { where.push('oc.project_coordinator = ?'); params.push(coordinator) }
  if (dateFrom) { where.push('oc.outreach_completed_date >= ?'); params.push(localDateToUtcIso(dateFrom, safeTzOffsetMin)) }
  if (dateTo) { where.push('oc.outreach_completed_date < ?'); params.push(localDateToUtcIso(dateTo, safeTzOffsetMin, 1)) }

  const rows = db.prepare(`
    SELECT oc.record_id, oc.project_rid, oc.project_coordinator AS coordinator, oc.customer_name,
           oc.outreach_completed_date, oc.preferred_outreach, oc.preferred_comms,
           pc.${milestoneCol} AS milestone_date,
           pc.status, pc.state, pc.system_size_kw, pc.lender,
           CAST(julianday(oc.outreach_completed_date) - julianday(pc.${milestoneCol}) AS INTEGER) AS days_raw
    FROM outreach_completed_cache oc
    JOIN project_cache pc ON oc.project_rid = pc.record_id
    WHERE ${where.join(' AND ')}
      AND pc.${milestoneCol} != '' AND pc.${milestoneCol} IS NOT NULL
    ORDER BY oc.outreach_completed_date DESC
  `).all(...params) as Array<{
    record_id: number; project_rid: number; coordinator: string; customer_name: string
    outreach_completed_date: string; preferred_outreach: string; preferred_comms: string
    milestone_date: string; status: string; state: string
    system_size_kw: number | null; lender: string; days_raw: number
  }>

  const valid = rows.filter(r => r.days_raw >= 0 && r.days_raw <= 365)
  const withBiz = valid.map(r => ({
    ...r,
    days: Math.round(r.days_raw * bizFactor),
    contact_method: normalizeContactMethod(r.preferred_outreach, r.preferred_comms),
  }))

  // By coordinator
  const coordMap = new Map<string, number[]>()
  for (const r of withBiz) {
    const arr = coordMap.get(r.coordinator) || []
    arr.push(r.days)
    coordMap.set(r.coordinator, arr)
  }
  const byCoordinator = [...coordMap].map(([coord, days]) => {
    days.sort((a, b) => a - b)
    return {
      coordinator: coord, count: days.length,
      avg: Math.round(days.reduce((a, b) => a + b, 0) / days.length * 10) / 10,
      median: days[Math.floor(days.length / 2)] || 0,
      p90: days[Math.floor(days.length * 0.9)] || 0,
    }
  }).sort((a, b) => a.avg - b.avg)

  // Volume + metrics by week or month (auto-select: ≤3 months → weekly, else monthly)
  const dateSpanDays = dateFrom && dateTo
    ? Math.round((new Date(dateTo).getTime() - new Date(dateFrom).getTime()) / (1000 * 60 * 60 * 24))
    : 90
  const useWeekly = dateSpanDays <= 93

  const volumeMap = new Map<string, number[]>()
  for (const r of withBiz) {
    let bucket: string
    if (useWeekly) {
      const localDate = toLocalDateKey(r.outreach_completed_date, safeTzOffsetMin)
      const d = new Date(`${localDate}T12:00:00`)
      const day = d.getDay()
      const monday = new Date(d)
      monday.setDate(d.getDate() - ((day + 6) % 7))
      bucket = isoDateFromLocal(monday)
    } else {
      bucket = toLocalDateKey(r.outreach_completed_date, safeTzOffsetMin).slice(0, 7)
    }
    const arr = volumeMap.get(bucket) || []
    arr.push(r.days)
    volumeMap.set(bucket, arr)
  }

  const volume = [...volumeMap].sort(([a], [b]) => a.localeCompare(b)).map(([period, days]) => {
    days.sort((a, b) => a - b)
    return {
      period,
      count: days.length,
      avg: Math.round(days.reduce((a, b) => a + b, 0) / days.length * 10) / 10,
      p90: days[Math.floor(days.length * 0.9)] || 0,
    }
  })

  const methodMap = new Map<string, number[]>()
  for (const r of withBiz) {
    const arr = methodMap.get(r.contact_method) || []
    arr.push(r.days)
    methodMap.set(r.contact_method, arr)
  }
  const methodOrder: Record<string, number> = { Text: 0, Email: 1, Phone: 2, Other: 3, Unknown: 4 }
  const byContactMethod = [...methodMap].map(([method, days]) => {
    days.sort((a, b) => a - b)
    return {
      method,
      count: days.length,
      avg: Math.round(days.reduce((a, b) => a + b, 0) / days.length * 10) / 10,
      p90: days[Math.floor(days.length * 0.9)] || 0,
    }
  }).sort((a, b) => (methodOrder[a.method] ?? 99) - (methodOrder[b.method] ?? 99) || b.count - a.count)

  // Drill data (for clicking chart bars) — top 100 most recent
  const drillData = withBiz.slice(0, 100).map(r => ({
    record_id: r.record_id,
    project_rid: r.project_rid,
    customer_name: r.customer_name,
    coordinator: r.coordinator,
    outreach_completed_date: r.outreach_completed_date,
    milestone_date: r.milestone_date,
    days: r.days,
    status: r.status,
    state: r.state,
    lender: r.lender,
    contact_method: r.contact_method,
  }))

  res.json({
    touchpoint,
    milestoneField: milestoneCol,
    binning: useWeekly ? 'weekly' : 'monthly',
    total: withBiz.length,
    byCoordinator,
    byContactMethod,
    volume,
    drillData,
  })
})

// ── Adders: Pending Rep Notification — table bsaycczmf ──
// Filter mirrors QB report 35 ("Adder Review: Pending Rep Notification") verbatim.
// Using a direct records/query (not the report-run endpoint) so the filter is explicit,
// debuggable, and doesn't silently drift when the QB-side report definition changes.
//
// Filter decoded:
//   149 (Needs Operations Review?) = true
//   AND 142 (Sales Notified Date) empty
//   AND 140 (Ops Adder Plan Complete Date) empty
//   AND 39  (Project Status) in (Active | *Hold statuses*)
//   AND 42  (Project Sales Date) within last 365 days
//   AND 17  (Product Category) != 'Sales Promise'
//   AND 56  (Product Name) != 'sales aid'
//   AND 209 (Rep Notified Date - Call-out) empty
//   AND 217 != '1'
const ADDERS_TABLE = 'bsaycczmf'
const ADDERS_WHERE =
  "{'149'.EX.'1'}AND{'142'.EX.''}AND{'140'.EX.''}" +
  "AND({'39'.EX.'Active'}OR{'39'.EX.'Intake Hold'}OR{'39'.EX.'Design Hold'}" +
  "OR{'39'.EX.'Finance Hold'}OR{'39'.EX.'HOA Hold'}OR{'39'.EX.'Roof Hold'}" +
  "OR{'39'.EX.'On Hold'}OR{'39'.EX.'Customer Hold'})" +
  "AND{'42'.AF.'365 days ago'}" +
  "AND{'17'.XEX.'Sales Promise'}" +
  "AND{'56'.XEX.'sales aid'}" +
  "AND{'209'.EX.''}" +
  "AND{'217'.XEX.'1'}"

// Field IDs verified against assets/Milestone Dashboard Examples/Adders/adder_tbl.json
const adderFMap: Array<{ fid: number; col: string }> = [
  { fid: 3, col: 'record_id' },
  { fid: 10, col: 'project_rid' },          // Related Project
  { fid: 31, col: 'customer_name' },
  { fid: 17, col: 'product_category' },
  { fid: 56, col: 'product_name' },
  { fid: 7, col: 'qty' },
  { fid: 9, col: 'adder_total' },           // Adder Total
  { fid: 20, col: 'adder_status' },
  { fid: 23, col: 'ops_approval_status' },
  { fid: 14, col: 'whos_paying' },
  { fid: 39, col: 'project_status' },
  { fid: 52, col: 'project_closer' },
  { fid: 171, col: 'project_coordinator' },
  { fid: 72, col: 'customer_state' },
  { fid: 1, col: 'date_created' },
  { fid: 142, col: 'sales_notified_date' },
  { fid: 167, col: 'sla_start_date' },
  { fid: 170, col: 'sla_timer_days' },
  { fid: 209, col: 'rep_notified_date' },
  { fid: 141, col: 'ops_review_note' },     // Ops Review Note — displayed on card
  { fid: 125, col: 'design_callout_note' }, // Design Adder Callout Note
]

async function refreshAddersCache(): Promise<{ total: number; duration: number; fetched: number }> {
  const start = Date.now()
  const { realm, token } = getQbConfig()

  let allRecords: Array<Record<string, { value: unknown }>> = []
  let skip = 0
  const batchSize = 1000

  while (true) {
    const res = await fetch('https://api.quickbase.com/v1/records/query', {
      method: 'POST',
      headers: {
        'QB-Realm-Hostname': realm,
        'Authorization': `QB-USER-TOKEN ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: ADDERS_TABLE,
        select: adderFMap.map(f => f.fid),
        where: ADDERS_WHERE,
        sortBy: [{ fieldId: 1, order: 'DESC' }],
        options: { skip, top: batchSize },
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`QB adders query failed (${res.status}): ${text}`)
    }

    const data = await res.json()
    const records = data.data || []
    allRecords = allRecords.concat(records)
    if (records.length < batchSize) break
    skip += batchSize
  }

  db.prepare('DELETE FROM adder_notify_cache').run()

  const cols = adderFMap.map(f => f.col).join(', ')
  const placeholders = adderFMap.map(() => '?').join(', ')
  const insert = db.prepare(
    `INSERT OR REPLACE INTO adder_notify_cache (${cols}, cached_at) VALUES (${placeholders}, datetime('now'))`
  )

  let written = 0
  db.transaction(() => {
    for (const record of allRecords) {
      const rid = parseInt(val(record, 3))
      if (!rid) continue
      const values = adderFMap.map(f => {
        if (f.col === 'record_id' || f.col === 'project_rid') return parseInt(val(record, f.fid)) || null
        if (f.col === 'qty' || f.col === 'adder_total' || f.col === 'sla_timer_days') return parseFloat(val(record, f.fid)) || null
        return val(record, f.fid)
      })
      insert.run(...values)
      written++
    }
  })()

  return { total: written, fetched: allRecords.length, duration: Date.now() - start }
}

router.post('/refresh-adders', async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await refreshAddersCache()
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.get('/adders', (req: Request, res: Response): void => {
  const coordinator = req.query['coordinator'] as string | undefined
  const params: unknown[] = []
  let where = ''
  if (coordinator) { where = 'WHERE project_coordinator = ?'; params.push(coordinator) }
  const rows = db.prepare(
    `SELECT * FROM adder_notify_cache ${where} ORDER BY sla_timer_days DESC, date_created ASC`
  ).all(...params)
  const cache = db.prepare(
    `SELECT COUNT(*) AS total, MAX(cached_at) AS last_refresh FROM adder_notify_cache`
  ).get() as { total: number; last_refresh: string }
  res.json({ rows, cache })
})

export { router as pcDashboardRouter }
