// Dev-only: polls a remote deployment's /api/dialpad/events/recent endpoint,
// inserts new rows into the LOCAL dialpad_events table, and re-publishes
// them through the local pub/sub so the local Comms Hub sees prod traffic.
//
// Activated by two env vars set only in local .env:
//   DIALPAD_MIRROR_URL    e.g. https://qb-spa.up.railway.app
//   DIALPAD_MIRROR_TOKEN  a long-lived JWT issued by prod for this user
//
// Polls every 3s. No retry complexity needed — transient failures are
// logged and the next tick retries naturally. Tracks the highest seen id
// in memory so restarts redo the last 50 (harmless thanks to dedupe).
import db from '../db'
import { publish, type DialpadEvent } from './dialpadEvents'

const POLL_MS = 3_000
const PAGE_LIMIT = 100

let running = false
let lastSeenId = 0

interface RemoteRow {
  id: number
  event_kind: string
  event_state: string | null
  call_id: string | null
  user_email: string | null
  user_name: string | null
  external_number: string | null
  direction: string | null
  raw_json: string
  received_at: string
}

function dedupeKey(row: RemoteRow): string {
  return [row.call_id || '', row.event_kind, row.event_state || '', row.received_at].join('|')
}

async function pollOnce(url: string, token: string): Promise<void> {
  const target = `${url.replace(/\/+$/, '')}/api/dialpad/events/recent?limit=${PAGE_LIMIT}&since_id=${lastSeenId}`
  let res: Response
  try {
    res = await fetch(target, { headers: { Authorization: `Bearer ${token}` } })
  } catch (e) {
    console.warn(`[dialpad-mirror] fetch failed: ${e instanceof Error ? e.message : String(e)}`)
    return
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.warn(`[dialpad-mirror] ${target} → HTTP ${res.status}: ${text.slice(0, 200)}`)
    return
  }
  const body = await res.json().catch(() => null) as { rows?: RemoteRow[] } | null
  const rows = (body?.rows || []).slice().sort((a, b) => a.id - b.id)
  if (rows.length === 0) return

  // Insert-or-skip based on a composite dedupe key. Using a lookup table
  // keeps this resilient across dev DB resets: if local already has the row
  // (same call/state/time) we skip, otherwise insert and publish.
  const insert = db.prepare(
    `INSERT INTO dialpad_events
       (event_kind, event_state, call_id, user_email, user_name, external_number, direction, raw_json, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const checkDupe = db.prepare(
    `SELECT id FROM dialpad_events
      WHERE COALESCE(call_id, '') = ?
        AND event_kind = ?
        AND COALESCE(event_state, '') = ?
        AND received_at = ?
      LIMIT 1`
  )

  for (const row of rows) {
    const existing = checkDupe.get(row.call_id || '', row.event_kind, row.event_state || '', row.received_at) as { id: number } | undefined
    if (!existing) {
      const result = insert.run(
        row.event_kind, row.event_state, row.call_id, row.user_email, row.user_name,
        row.external_number, row.direction, row.raw_json, row.received_at,
      )
      const localRow = db.prepare(
        `SELECT id, event_kind, event_state, call_id, user_email, user_name, external_number, direction, raw_json, received_at
         FROM dialpad_events WHERE id = ?`
      ).get(Number(result.lastInsertRowid)) as DialpadEvent
      publish(localRow)
    }
    if (row.id > lastSeenId) lastSeenId = row.id
    void dedupeKey  // reference to keep function tree-shakeable
  }
}

export function startDialpadEventMirror(): void {
  const url = (process.env['DIALPAD_MIRROR_URL'] || '').trim()
  const token = (process.env['DIALPAD_MIRROR_TOKEN'] || '').trim()
  if (!url || !token) return
  if (running) return
  running = true
  console.log(`[dialpad-mirror] polling ${url} every ${POLL_MS}ms`)
  const tick = async () => {
    try { await pollOnce(url, token) }
    catch (e) { console.warn(`[dialpad-mirror] tick error: ${e instanceof Error ? e.message : String(e)}`) }
    finally { setTimeout(tick, POLL_MS) }
  }
  tick()
}
