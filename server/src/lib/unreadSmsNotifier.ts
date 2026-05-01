// Cron worker that pings users via the notifications system when an inbound
// SMS addressed to them goes unread. Lets people walk away from the live
// panel and still get a nudge when something needs a reply. Idempotent —
// each (user, event) pair gets at most one notification ever.
//
// Window: SMS received >= 10 minutes ago (gives the live panel a chance to
// surface it first) and <= 24 hours ago (after that, the user will see it
// in the inbox / recent threads, no extra prod needed).
import db from '../db'

interface DueRow {
  event_id: number
  user_id: number
  external_number: string
  text_body: string | null
  raw_json: string
  received_at: string
}

function trim(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

// Same body extraction shape used by /sms/thread + /contact-timeline.
function extractBody(payload: Record<string, unknown>): string | null {
  const direct = payload['text'] || payload['message'] || payload['body'] || payload['message_body']
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

function fireUnreadNotifications(): void {
  // Find candidate inbound SMS rows — addressed to a known portal user
  // (user_email_lookup match), received within the window, not yet read
  // by that user, not yet notified.
  const rows = db.prepare(
    `SELECT
       e.id AS event_id,
       uel.user_id AS user_id,
       e.external_number,
       e.text_body,
       e.raw_json,
       e.received_at
     FROM dialpad_events e
     JOIN user_email_lookup uel
       ON uel.email = LOWER(TRIM(COALESCE(e.user_email, '')))
       AND uel.system IN ('', 'dialpad')
     WHERE e.event_kind = 'sms'
       AND e.direction = 'incoming'
       AND e.external_number IS NOT NULL
       AND e.external_number != ''
       AND e.received_at <= datetime('now', '-10 minutes')
       AND e.received_at >= datetime('now', '-24 hours')
       AND NOT EXISTS (
         SELECT 1 FROM dialpad_sms_reads sr
         WHERE sr.user_id = uel.user_id AND sr.event_id = e.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM dialpad_sms_unread_notifications un
         WHERE un.user_id = uel.user_id AND un.event_id = e.id
       )
     LIMIT 200`
  ).all() as DueRow[]

  if (rows.length === 0) return

  const insertNotification = db.prepare(
    `INSERT INTO notifications (user_id, type, title, body, link)
     VALUES (?, ?, ?, ?, ?)`
  )
  const markNotified = db.prepare(
    `INSERT OR IGNORE INTO dialpad_sms_unread_notifications (user_id, event_id)
     VALUES (?, ?)`
  )

  // Customer name lookup — best-effort, last-10-digit match against
  // project_cache. Mirrors the messageReminders worker.
  const onlyDigits = (s: string | null | undefined): string =>
    (s || '').replace(/\D/g, '').slice(-10)
  const customerLookup = db.prepare(
    `SELECT customer_name FROM project_cache
     WHERE customer_name IS NOT NULL AND (
       REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(phone, ''), ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE '%' || ? OR
       REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(mobile_phone, ''), ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE '%' || ? OR
       REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(alt_phone, ''), ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE '%' || ?
     )
     LIMIT 1`
  )

  const tx = db.transaction((entries: DueRow[]) => {
    for (const r of entries) {
      let body: string | null = r.text_body || null
      if (!body && r.raw_json) {
        try { body = extractBody(JSON.parse(r.raw_json) as Record<string, unknown>) }
        catch { /* leave null */ }
      }
      const digits10 = onlyDigits(r.external_number)
      const customer = digits10.length === 10
        ? customerLookup.get(digits10, digits10, digits10) as { customer_name: string } | undefined
        : undefined
      const subject = customer?.customer_name || r.external_number
      const title = `Unread text · ${subject}`
      const bodyText = body
        ? trim(body.trim(), 240)
        : 'Tap to open the conversation.'
      const link = `/comms-hub?open_thread=${encodeURIComponent(r.external_number)}`

      insertNotification.run(r.user_id, 'comms_unread_sms', title, bodyText, link)
      markNotified.run(r.user_id, r.event_id)
    }
  })

  try {
    tx(rows)
    console.log(`[unread-sms] notified ${rows.length} unread SMS for ${new Set(rows.map(r => r.user_id)).size} user(s)`)
  } catch (e) {
    console.error('[unread-sms] notify failed:', e)
  }
}

let timer: ReturnType<typeof setInterval> | null = null

export function startUnreadSmsNotifier(): void {
  if (timer) return
  // Initial pass at startup catches anything that came in while the server
  // was down. Then every 5 min — the same cadence the message-reminders
  // worker uses, so we keep cron pressure predictable.
  try { fireUnreadNotifications() } catch (e) { console.error('[unread-sms] initial pass failed:', e) }
  timer = setInterval(fireUnreadNotifications, 5 * 60_000)
  console.log('[unread-sms] notifier started — sweeping every 5 min')
}

export function stopUnreadSmsNotifier(): void {
  if (timer) { clearInterval(timer); timer = null }
}
