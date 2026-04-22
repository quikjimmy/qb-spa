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

export function isPast(d: string): boolean {
  if (!d || d === '0' || d === '-') return false
  return localDateKey(d) < localTodayIso()
}

export function isToday(d: string): boolean {
  if (!d || d === '0' || d === '-') return false
  return localDateKey(d) === localTodayIso()
}

export function daysBetween(d: string): number {
  if (!d || d === '0') return 0
  const dateKey = localDateKey(d)
  if (!dateKey) return 0
  const date = parseLocal(dateKey)
  const now = new Date()
  now.setHours(12, 0, 0, 0)
  return Math.floor((now.getTime() - date.getTime()) / 86400000)
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
