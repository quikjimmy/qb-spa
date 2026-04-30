// Tracks user activity at two levels:
//   1. App-wide: an in-memory ms counter for the most recent
//      authenticated request from any user. Schedulers gate on this
//      so off-hours don't burn API budget.
//   2. Per-user: a last_active_at column on the users table, written
//      via a debounced INSERT-OR-UPDATE. Surfaces in the admin user
//      list as "active 4 min ago" so admins can see who's actually
//      using the app.

import db from '../db'

let lastActivityMs = 0

// Per-user write debounce so we don't fsync on every authenticated
// request. We trust an in-memory map for "did I write recently?",
// fall back to the DB on cold start.
const lastWriteByUser = new Map<number, number>()
const PER_USER_WRITE_DEBOUNCE_MS = 60_000

const updateLastActiveStmt = (() => {
  try {
    return db.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`)
  } catch { return null }
})()

export function noteUserActivity(userId?: number): void {
  lastActivityMs = Date.now()
  if (!userId || !updateLastActiveStmt) return
  const last = lastWriteByUser.get(userId) ?? 0
  if (Date.now() - last < PER_USER_WRITE_DEBOUNCE_MS) return
  lastWriteByUser.set(userId, Date.now())
  try {
    updateLastActiveStmt.run(new Date().toISOString().replace('T', ' ').slice(0, 19), userId)
  } catch { /* swallow — user table missing the column on cold prod */ }
}

export function lastUserActivityMs(): number {
  return lastActivityMs
}

// Returns true if any authenticated request landed in the last
// `windowMs`. Default window: 30 minutes — covers normal user idle
// during a session and gives a buffer after a deliberate refresh.
export function isAppActive(windowMs = 30 * 60_000): boolean {
  if (lastActivityMs === 0) return false
  return Date.now() - lastActivityMs <= windowMs
}
