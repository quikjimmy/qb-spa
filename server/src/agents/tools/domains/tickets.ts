// ─── Ticket management domain ─────────────────────────────────────────
// Past-due / due-today backlog and the top offenders by assignee or
// category. Mirrors the KPI + pivot SQL in routes/tickets.ts (the GET /
// handler, ~lines 240-283) against the same ticket_cache. Kept as a thin
// re-implementation because that logic lives inline in the route handler;
// the date semantics (open = not Completed/Closed/Complete; overdue =
// due_date < today) are copied verbatim so the numbers match the UI.

import db from '../../../db'

const OPEN_WHERE = `status NOT IN ('Completed','Closed','Complete')`

function todayIso(): string {
  return new Date().toISOString().split('T')[0]!
}

export interface TicketsResult {
  today: string
  kpi: { open: number; overdue: number; due_today: number; future_due: number }
  by_assignee: Array<{ name: string; past_due: number; today: number; future: number; total: number }>
  by_category: Array<{ name: string; past_due: number; today: number; future: number; total: number }>
}

function pivot(col: 'assigned_to' | 'category', today: string, limit: number): TicketsResult['by_assignee'] {
  return db.prepare(`
    SELECT ${col} AS name,
      SUM(CASE WHEN due_date < ? AND due_date != '' AND due_date != '0' THEN 1 ELSE 0 END) AS past_due,
      SUM(CASE WHEN due_date >= ? AND due_date < ? THEN 1 ELSE 0 END) AS today,
      SUM(CASE WHEN due_date > ? THEN 1 ELSE 0 END) AS future,
      COUNT(*) AS total
    FROM ticket_cache
    WHERE ${OPEN_WHERE} AND ${col} != ''
    GROUP BY ${col}
    ORDER BY past_due DESC, total DESC
    LIMIT ?
  `).all(today, today, today + 'T23:59:59', today + 'T23:59:59', limit) as TicketsResult['by_assignee']
}

export function getTickets(input: { top?: number }): TicketsResult {
  const today = todayIso()
  const top = Math.max(1, Math.min(input.top ?? 5, 25))

  const count = (extra: string, ...params: unknown[]): number =>
    (db.prepare(`SELECT COUNT(*) AS c FROM ticket_cache WHERE ${OPEN_WHERE}${extra}`).get(...params) as { c: number }).c

  return {
    today,
    kpi: {
      open: count(''),
      overdue: count(` AND due_date < ? AND due_date != '' AND due_date != '0'`, today),
      due_today: count(` AND due_date >= ? AND due_date < ?`, today, today + 'T23:59:59'),
      future_due: count(` AND due_date > ?`, today + 'T23:59:59'),
    },
    by_assignee: pivot('assigned_to', today, top),
    by_category: pivot('category', today, top),
  }
}
