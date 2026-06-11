// ─── Scheduling domain ────────────────────────────────────────────────
// Installs / site surveys on the calendar for a given window, with count,
// kW, and a per-state location breakdown. Reads project_cache milestone
// date columns (install_scheduled / survey_scheduled) — i.e. projects
// whose scheduled appointment falls in the window.
//
// NOTE on dates: windows are computed with SQLite date('now') in UTC.
// The scoreboard's daily-goals uses an office-timezone anchor; for a
// digest this is close enough, but near midnight the "today" boundary can
// differ by the UTC offset. If exact office-day alignment matters, pass an
// explicit ISO window instead of a named one (future enhancement).

import db from '../../../db'

type TaskKind = 'install' | 'survey'
const COLUMN: Record<TaskKind, string> = {
  install: 'install_scheduled',
  survey: 'survey_scheduled',
}

// Named window → SQLite date bounds (inclusive from, exclusive to).
function windowBounds(window: string): { from: string; to: string; label: string } {
  switch (window) {
    case 'today':       return { from: `date('now')`,              to: `date('now','+1 day')`,  label: 'today' }
    case 'yesterday':   return { from: `date('now','-1 day')`,     to: `date('now')`,           label: 'yesterday' }
    case 'next_7_days': return { from: `date('now')`,              to: `date('now','+7 days')`, label: 'next 7 days' }
    case 'prev_7_days': return { from: `date('now','-7 days')`,    to: `date('now')`,           label: 'previous 7 days' }
    default:
      throw new Error(`window must be one of: today, yesterday, next_7_days, prev_7_days`)
  }
}

export interface ScheduleResult {
  task: TaskKind
  window: string
  count: number
  kw: number
  by_state: Array<{ state: string; count: number; kw: number }>
}

export function getSchedule(input: { task: string; window?: string }): ScheduleResult {
  const task = input.task as TaskKind
  if (!(task in COLUMN)) throw new Error(`task must be 'install' or 'survey'`)
  const window = input.window ?? 'today'
  const b = windowBounds(window)
  const col = COLUMN[task]

  // substr(col,1,10) normalizes a possible datetime to YYYY-MM-DD before
  // comparing against the date() bounds.
  const dateExpr = `substr(${col},1,10)`
  const whereWindow = `${col} IS NOT NULL AND ${col} != '' AND ${dateExpr} >= ${b.from} AND ${dateExpr} < ${b.to}`

  const totals = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(system_size_kw), 0) AS kw
    FROM project_cache WHERE ${whereWindow}
  `).get() as { count: number; kw: number }

  const byState = db.prepare(`
    SELECT COALESCE(NULLIF(state, ''), '—') AS state, COUNT(*) AS count, COALESCE(SUM(system_size_kw), 0) AS kw
    FROM project_cache WHERE ${whereWindow}
    GROUP BY state ORDER BY count DESC
  `).all() as Array<{ state: string; count: number; kw: number }>

  return {
    task,
    window: b.label,
    count: totals.count,
    kw: Math.round(totals.kw * 10) / 10,
    by_state: byState.map(r => ({ state: r.state, count: r.count, kw: Math.round(r.kw * 10) / 10 })),
  }
}
