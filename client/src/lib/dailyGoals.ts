// Shared types + pace logic for the Daily Goals scoreboard and admin
// editor. Targets are "locked in" per day: the API returns today's
// target alongside the per-day target on each history point so the
// sparkline + pace bar always compare against the target that was
// active on the day in question.

export type GoalKind = 'count' | 'empty_bucket'

export interface ScoreboardGoal {
  id: number
  slug: string
  department: string
  label: string
  target: number
  kind: GoalKind
  current: number
  history: Array<{ date: string; value: number; target: number }>
  dayOverDayDelta: number | null
  // ISO timestamp of the moment the server first observed this goal
  // 'met' today, or null if it hasn't hit yet. Used by the scoreboard
  // to decide whether to celebrate independently of poll timing.
  firstHitAt: string | null
}

export interface ScoreboardSummary {
  date: string
  dayProgress: number
  dayName: string
  generatedAt: string
  goals: ScoreboardGoal[]
}

export type PaceStatus = 'on_pace' | 'at_risk' | 'behind' | 'critical' | 'met'

export interface PaceResult {
  status: PaceStatus
  fraction: number
  expectedFraction: number
  label: string
}

// Pace = actuals vs an idealized linear ramp across the workday
// (8am→6pm, computed server-side and passed in as `dayProgress`).
export function paceFor(goal: ScoreboardGoal, dayProgress: number): PaceResult {
  if (goal.kind === 'empty_bucket') {
    if (goal.current === 0) return { status: 'met', fraction: 1, expectedFraction: 1, label: 'Clear' }
    return { status: 'critical', fraction: 0, expectedFraction: 1, label: `${goal.current} pending` }
  }
  const target = Math.max(1, goal.target)
  const fraction = goal.current / target
  const expected = Math.max(0, Math.min(1, dayProgress))
  if (fraction >= 1) return { status: 'met', fraction, expectedFraction: expected, label: 'Goal hit' }
  // Before the workday starts, expected = 0 — don't flag anyone as
  // "behind" at 7am because they haven't started yet.
  if (expected === 0) return { status: 'on_pace', fraction, expectedFraction: expected, label: 'On pace' }
  if (fraction >= expected) return { status: 'on_pace', fraction, expectedFraction: expected, label: 'On pace' }
  if (fraction >= expected * 0.85) return { status: 'at_risk', fraction, expectedFraction: expected, label: 'At risk' }
  return { status: 'behind', fraction, expectedFraction: expected, label: 'Behind' }
}

export function groupByDepartment(goals: ScoreboardGoal[]): Array<{ department: string; goals: ScoreboardGoal[] }> {
  const map = new Map<string, ScoreboardGoal[]>()
  for (const g of goals) {
    const arr = map.get(g.department) ?? []
    arr.push(g)
    map.set(g.department, arr)
  }
  return Array.from(map.entries()).map(([department, goals]) => ({ department, goals }))
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function formatLongDate(dateIso: string): string {
  // "May 20" — Nike-style minimal.
  const d = new Date(`${dateIso}T00:00:00`)
  return `${months[d.getMonth()]} ${d.getDate()}`
}
