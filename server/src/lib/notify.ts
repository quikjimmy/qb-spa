// Notification helpers — wraps inserts into the `notifications` table
// with deduplication by (user_id, type, link). Used by background
// detectors (e.g. survey-cancel scan) so we don't spam users every
// time the same event is re-observed.

import db from '../db'

interface UserRow { id: number }
interface ProjectCacheRow { coordinator: string | null }

interface NotifyArgs {
  userId: number
  type: string
  title: string
  body?: string | null
  link?: string | null
}

/** Insert a notification only if no row already exists for the same
 *  (user_id, type, link) triple. Returns the inserted id, or null if
 *  the dedup gate matched. */
export function insertIfNew(a: NotifyArgs): number | null {
  const existing = db.prepare(
    'SELECT id FROM notifications WHERE user_id = ? AND type = ? AND COALESCE(link, "") = COALESCE(?, "") LIMIT 1'
  ).get(a.userId, a.type, a.link ?? null) as { id: number } | undefined
  if (existing) return null
  const res = db.prepare(
    'INSERT INTO notifications (user_id, type, title, body, link, is_read, created_at) VALUES (?, ?, ?, ?, ?, 0, datetime("now"))'
  ).run(a.userId, a.type, a.title, a.body ?? null, a.link ?? null)
  return Number(res.lastInsertRowid) || null
}

/** Notify a user that their async chat answer is ready. Unlike insertIfNew,
 *  this re-notifies across turns — but collapses onto an existing UNREAD
 *  chat_complete row for the same thread, so the bell shows one entry per
 *  thread refreshed to the latest answer (rather than stacking). Once the
 *  user reads/acks it, the next completion creates a fresh row. */
export function notifyChatComplete(a: { userId: number; threadId: number; title: string; body?: string | null }): number {
  const link = `/chat?thread=${a.threadId}`
  const existing = db.prepare(
    `SELECT id FROM notifications WHERE user_id = ? AND type = 'chat_complete' AND link = ? AND is_read = 0 ORDER BY id DESC LIMIT 1`
  ).get(a.userId, link) as { id: number } | undefined
  if (existing) {
    db.prepare(
      'UPDATE notifications SET title = ?, body = ?, created_at = datetime("now") WHERE id = ?'
    ).run(a.title, a.body ?? null, existing.id)
    return existing.id
  }
  const res = db.prepare(
    'INSERT INTO notifications (user_id, type, title, body, link, is_read, created_at) VALUES (?, "chat_complete", ?, ?, ?, 0, datetime("now"))'
  ).run(a.userId, a.title, a.body ?? null, link)
  return Number(res.lastInsertRowid)
}

/** Resolve the project coordinator for a given QB project record id by
 *  cross-referencing project_cache.coordinator (a name string) against
 *  users.name. (Schema column is `name`, not `full_name` — earlier
 *  `full_name` reference threw `no such column` at every call site.) */
export function pcUserIdForProject(projectRid: number): number | null {
  const row = db.prepare(
    'SELECT coordinator FROM project_cache WHERE record_id = ? LIMIT 1'
  ).get(projectRid) as ProjectCacheRow | undefined
  if (!row?.coordinator) return null
  const u = db.prepare(
    'SELECT id FROM users WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND is_active = 1 LIMIT 1'
  ).get(row.coordinator) as UserRow | undefined
  return u?.id ?? null
}

/** Notify the project's coordinator that a Site Survey task was cancelled.
 *  Dedup key combines task RID + project RID into the link, so the same
 *  cancellation for the same project notifies once. Subsequent cancels
 *  for the SAME project but a re-scheduled survey will dedup-bypass
 *  since the new task RID differs. */
export function notifyPcOfSurveyCancel(opts: {
  projectRid: number
  taskRid: string
  customerName?: string | null
  cancelledAt?: string | null
  cancelledBy?: string | null
  phase?: 'onsite' | 'enroute' | 'scheduled' | null
}): { notified: boolean; userId: number | null; reason?: string } {
  const userId = pcUserIdForProject(opts.projectRid)
  if (!userId) return { notified: false, userId: null, reason: 'no PC user resolved' }
  const phaseText = opts.phase === 'onsite'   ? 'while crew was on-site'
                  : opts.phase === 'enroute'  ? 'while crew was en-route'
                  : opts.phase === 'scheduled' ? 'before arrival'
                  : ''
  const who  = opts.cancelledBy ? ` by ${opts.cancelledBy}` : ''
  const cust = opts.customerName ? ` for ${opts.customerName}` : ''
  const id = insertIfNew({
    userId,
    type: 'survey_cancelled',
    title: `Site Survey cancelled${cust}`,
    body: `${phaseText ? phaseText + ' ' : ''}${who}`.trim() || null,
    // Link uniqueness includes the task RID so a re-scheduled survey's
    // cancellation creates a fresh row.
    link: `/projects/${opts.projectRid}#schedule?taskRid=${opts.taskRid}`,
  })
  return { notified: id !== null, userId }
}
