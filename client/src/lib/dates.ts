// Parse a date string safely in the user's local timezone.
// QB returns date-only strings like "2026-04-07" which JavaScript
// parses as UTC midnight — shifting the displayed day in US timezones.
// This function appends T12:00:00 to date-only strings so they parse
// as local noon, which never flips the day regardless of timezone.

function parseLocal(d: string): Date {
  if (!d) return new Date(NaN)
  // Date-only: "2026-04-07" (10 chars, no T)
  if (d.length === 10 && !d.includes('T')) {
    return new Date(d + 'T12:00:00')
  }
  // Full ISO with T: parse as-is (browser handles TZ)
  return new Date(d)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function localTodayIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function shiftLocalDays(days: number, base = new Date()): string {
  const d = new Date(base)
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function localDateKey(d: string): string {
  if (!d || d === '0' || d === '-') return ''
  const parsed = parseLocal(d)
  if (isNaN(parsed.getTime())) return ''
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`
}

export function fmtDate(d: string): string {
  if (!d || d === '0' || d === '-') return ''
  try {
    return parseLocal(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch { return '' }
}

export function fmtDateFull(d: string): string {
  if (!d || d === '0' || d === '-') return '—'
  try {
    return parseLocal(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
  } catch { return '—' }
}

export function fmtDateLong(d: string): string {
  if (!d || d === '0' || d === '-') return '—'
  try {
    return parseLocal(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch { return '—' }
}

// Canonical business timezone — must match the server's OFFICE_TZ
// (server/src/lib/officeTime.ts). Day-boundary classification (overdue /
// due today / ages) happens on this calendar so chips agree with server
// KPI counts no matter where the viewer is (issue #29). Rendering of
// individual timestamps stays viewer-local.
export const OFFICE_TZ = 'America/Denver'

// "Today" on the office calendar.
export function officeTodayIso(): string {
  return localDateInTz(new Date(), OFFICE_TZ)
}

// Office-calendar date key for a QB value: date-only strings pass through,
// timestamps project into the office timezone.
export function officeDateKey(d: string): string {
  if (!d || d === '0' || d === '-') return ''
  if (d.length === 10 && !d.includes('T')) return d
  const parsed = new Date(d)
  if (isNaN(parsed.getTime())) return ''
  return localDateInTz(parsed, OFFICE_TZ)
}

export function isPast(d: string): boolean {
  if (!d || d === '0' || d === '-') return false
  return officeDateKey(d) < officeTodayIso()
}

export function isToday(d: string): boolean {
  if (!d || d === '0' || d === '-') return false
  return officeDateKey(d) === officeTodayIso()
}

export function daysBetween(d: string): number {
  if (!d || d === '0') return 0
  const dateKey = officeDateKey(d)
  if (!dateKey) return 0
  const date = parseLocal(dateKey)
  const today = parseLocal(officeTodayIso())
  return Math.floor((today.getTime() - date.getTime()) / 86400000)
}

export function timeAgo(d: string): string {
  if (!d) return ''
  const diff = Date.now() - new Date(d).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return fmtDate(d)
}

// IANA tz of the user's browser, e.g. "America/Denver".
export function userTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

// UTC offset (in minutes, positive = east of UTC) for `at` when projected into `tz`.
function tzOffsetMinutes(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at)
  const m: Record<string, string> = {}
  for (const p of parts) m[p.type] = p.value
  // Intl returns hour "24" for midnight in some locales; normalize.
  const hour = parseInt(m.hour!, 10) % 24
  const wallUtcMs = Date.UTC(
    parseInt(m.year!, 10), parseInt(m.month!, 10) - 1, parseInt(m.day!, 10),
    hour, parseInt(m.minute!, 10), parseInt(m.second!, 10),
  )
  return (wallUtcMs - at.getTime()) / 60_000
}

// Given a YYYY-MM-DD picked in `tz`, return the UTC instants bracketing
// that calendar day (start inclusive, end inclusive of last second). Used
// to filter columns stored as full ISO timestamps (e.g. sales_date) by
// the user's local calendar date.
export function localDayBoundsToUtc(dateStr: string, tz: string = userTz()): { from: string; to: string } {
  const [y, m, d] = dateStr.split('-').map(n => parseInt(n, 10))
  // Sample noon UTC of the date — well clear of any DST transition (those
  // happen at 02:00 local). The offset at noon UTC is the same as at the
  // start/end of the local day for every IANA zone in practice.
  const sample = new Date(Date.UTC(y!, m! - 1, d!, 12, 0, 0))
  const offsetMin = tzOffsetMinutes(sample, tz)
  const startMs = Date.UTC(y!, m! - 1, d!, 0, 0, 0) - offsetMin * 60_000
  const endMs = Date.UTC(y!, m! - 1, d!, 23, 59, 59) - offsetMin * 60_000
  return {
    from: new Date(startMs).toISOString(),
    to: new Date(endMs).toISOString(),
  }
}

// YYYY-MM-DD for `at` projected into `tz`. en-CA formats natively as ISO.
export function localDateInTz(at: Date, tz: string = userTz()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at)
}
