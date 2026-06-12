// Canonical business timezone for all day-boundary logic (issue #29).
//
// The server runs in UTC on Railway, so naive `toISOString().slice(0, 10)`
// returns the UTC calendar date — which after 6pm Mountain has already
// rolled to "tomorrow", shifting "today" filters, overdue counts, and KPI
// windows. Anchoring every "today" derivation to the office timezone means
// all users see the same numbers and they match QuickBase's company-TZ
// reports. Rendering of individual timestamps stays viewer-local on the
// client; only day-boundary *classification* lives here.
//
// SCOREBOARD_TZ is honored for back-compat with the daily-goals scoreboard,
// which introduced the pattern.
export const OFFICE_TZ =
  process.env['OFFICE_TZ']?.trim() ||
  process.env['SCOREBOARD_TZ']?.trim() ||
  'America/Denver'

// en-CA renders as YYYY-MM-DD by spec — the cheapest way to format a date
// in a specific timezone without pulling in a tz library.
const OFFICE_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: OFFICE_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

// Calendar date (YYYY-MM-DD) of an instant in the office timezone.
export function officeDateOf(d: Date): string {
  return OFFICE_DATE_FMT.format(d)
}

// "Today" on the office calendar. `now` is injectable for tests.
export function officeTodayIso(now: Date = new Date()): string {
  return officeDateOf(now)
}

export function officeDaysAgo(n: number, now: Date = new Date()): string {
  return officeDateOf(new Date(now.getTime() - n * 86_400_000))
}

export function officeDaysFromNow(n: number, now: Date = new Date()): string {
  return officeDateOf(new Date(now.getTime() + n * 86_400_000))
}

// Minutes the office zone is ahead of UTC at the given instant (DST-safe).
function officeOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: OFFICE_TZ,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at)
  const get = (t: string): number => parseInt(parts.find(p => p.type === t)?.value || '0', 10)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
  return Math.round((asUtc - at.getTime()) / 60_000)
}

// UTC instants bounding an office-timezone calendar day [00:00:00, 23:59:59].
// Use these when querying UTC-ISO datetime fields (e.g. Arrivy
// scheduledDateTime) for "scheduled today" semantics. Sampling the offset at
// office noon sidesteps the 2am DST transition.
export function officeDayBoundsUtc(dateIso: string): { from: Date; to: Date } {
  const [y, m, d] = dateIso.split('-').map(n => parseInt(n, 10))
  const sample = new Date(Date.UTC(y!, m! - 1, d!, 12, 0, 0))
  const offsetMin = officeOffsetMinutes(sample)
  return {
    from: new Date(Date.UTC(y!, m! - 1, d!, 0, 0, 0) - offsetMin * 60_000),
    to: new Date(Date.UTC(y!, m! - 1, d!, 23, 59, 59) - offsetMin * 60_000),
  }
}

// Calendar-day addition on an ISO string via UTC-midnight math, so DST
// transitions can't shift the result across a day boundary.
export function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const out = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1) + n * 86_400_000)
  const yy = out.getUTCFullYear()
  const mm = String(out.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(out.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}
