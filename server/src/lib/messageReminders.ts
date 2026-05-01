// Cron worker that fires due dialpad_message_reminders into the notifications
// table. Runs every minute. Idempotent: each reminder row gets fired_at set
// once, so re-running the loop won't duplicate notifications.
import db from '../db'

interface DueRow {
  id: number
  user_id: number
  event_id: number
  external_number: string
  body_excerpt: string | null
  remind_at: string
}

function trim(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function fireDueReminders(): void {
  const due = db.prepare(
    `SELECT id, user_id, event_id, external_number, body_excerpt, remind_at
     FROM dialpad_message_reminders
     WHERE fired_at IS NULL AND remind_at <= datetime('now')
     ORDER BY remind_at ASC
     LIMIT 100`
  ).all() as DueRow[]

  if (due.length === 0) return

  const insertNotification = db.prepare(
    `INSERT INTO notifications (user_id, type, title, body, link)
     VALUES (?, ?, ?, ?, ?)`
  )
  const markFired = db.prepare(
    `UPDATE dialpad_message_reminders SET fired_at = datetime('now') WHERE id = ?`
  )

  // Customer name lookup — best-effort, last-10-digit match against project_cache.
  const onlyDigits = (s: string | null | undefined): string =>
    (s || '').replace(/\D/g, '').slice(-10)

  const tx = db.transaction((rows: DueRow[]) => {
    for (const r of rows) {
      const digits10 = onlyDigits(r.external_number)
      let contactName: string | null = null
      if (digits10.length === 10) {
        // Cheap query — small project_cache, indexed by name not phone.
        const match = db.prepare(
          `SELECT customer_name FROM project_cache
           WHERE customer_name IS NOT NULL AND (
             REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(phone, ''), ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE '%' || ? OR
             REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(mobile_phone, ''), ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE '%' || ? OR
             REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(alt_phone, ''), ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE '%' || ?
           )
           LIMIT 1`
        ).get(digits10, digits10, digits10) as { customer_name: string } | undefined
        contactName = match?.customer_name || null
      }

      const subject = contactName || r.external_number
      const title = `Reminder · ${subject}`
      const bodyText = r.body_excerpt
        ? trim(r.body_excerpt, 240)
        : 'You asked to be reminded about this conversation.'
      // Link routes back to the comms hub with the contact pre-selected so
      // a click drops the user straight into the thread drawer.
      // Route is /comms (not /comms-hub) — see client/src/router/index.ts.
      // Wrong path quietly fails router.push and the user lands nowhere.
      const link = `/comms?open_thread=${encodeURIComponent(r.external_number)}`

      insertNotification.run(r.user_id, 'comms_reminder', title, bodyText, link)
      markFired.run(r.id)
    }
  })

  try {
    tx(due)
    console.log(`[message-reminders] fired ${due.length} reminder(s)`)
  } catch (e) {
    console.error('[message-reminders] fire failed:', e)
  }
}

let timer: ReturnType<typeof setInterval> | null = null

export function startMessageReminders(): void {
  if (timer) return
  // Fire once at startup for any reminders that were due while the server
  // was down, then poll every 60s.
  try { fireDueReminders() } catch (e) { console.error('[message-reminders] initial fire failed:', e) }
  timer = setInterval(fireDueReminders, 60_000)
  console.log('[message-reminders] worker started — polling every 60s')
}

export function stopMessageReminders(): void {
  if (timer) { clearInterval(timer); timer = null }
}
