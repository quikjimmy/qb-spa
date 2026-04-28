// Tracks the timestamp of the last authenticated request.
// Used by background schedulers to skip work during off-hours so we
// don't burn QB / Dialpad / etc API budget when nobody is using the
// app. Single in-memory ms counter; survives nothing across restarts
// but the next authenticated request immediately re-arms it.

let lastActivityMs = 0

export function noteUserActivity(): void {
  lastActivityMs = Date.now()
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
