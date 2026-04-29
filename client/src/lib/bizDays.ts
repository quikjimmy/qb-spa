// Business-day math (Mon–Fri, no holiday calendar) for SLA durations
// shown on the milestone strip and detail panels. Mirrors QB's WeekdaySub.

function startOfDayUtc(s: string): number {
  const v = String(s)
  const d = new Date(v.length === 10 ? `${v}T00:00:00` : v)
  if (isNaN(d.getTime())) return NaN
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// Inclusive weekday count between two dates (b - a). Negative if b < a.
// Matches QB's WeekdaySub by counting whole weekdays from a (exclusive) to b
// (exclusive)? QB convention is: WeekdaySub(later, earlier) = whole biz days
// elapsed. We use the same convention: 0 if same day, 1 if Mon→Tue, etc.
export function weekdaysBetween(aStr: string | null | undefined, bStr: string | null | undefined): number | null {
  if (!aStr || !bStr) return null
  const a = startOfDayUtc(String(aStr))
  const b = startOfDayUtc(String(bStr))
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  if (b < a) return -weekdaysBetween(bStr, aStr)!

  const ONE_DAY = 24 * 60 * 60 * 1000
  let count = 0
  for (let t = a + ONE_DAY; t <= b; t += ONE_DAY) {
    const day = new Date(t).getDay()
    if (day !== 0 && day !== 6) count++
  }
  return count
}

export function weekdaysSinceToday(aStr: string | null | undefined): number | null {
  if (!aStr) return null
  const today = new Date()
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  return weekdaysBetween(aStr, iso)
}
