// Tiny Web Audio chime for chat-completion notifications. Synthesized (no asset
// files), mirroring the comms 'sms' tone but standalone so importing it doesn't
// drag in the dialpad live-SSE machinery.
//
// Browsers block audio until a user gesture, so call unlockChime() from a click
// once (we do it on send). playChime() is a no-op if the context isn't ready or
// the user muted via the 'chat.notify.sound' preference.

let ctx: AudioContext | null = null

function ac(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    ctx = new Ctor()
  }
  return ctx
}

/** Resume the audio context from a user gesture so later playback is allowed. */
export function unlockChime(): void {
  const c = ac()
  if (c && c.state === 'suspended') void c.resume()
}

/** Whether the completion sound is enabled (persisted, default on). */
export function chimeEnabled(): boolean {
  try { return localStorage.getItem('chat.notify.sound') !== 'off' } catch { return true }
}

export function setChimeEnabled(on: boolean): void {
  try { localStorage.setItem('chat.notify.sound', on ? 'on' : 'off') } catch { /* ignore */ }
}

/** A short rising two-note chime. Safe to call anytime; silently no-ops when
 *  audio isn't available or the user disabled it. */
export function playChime(): void {
  if (!chimeEnabled()) return
  const c = ac()
  if (!c) return
  if (c.state === 'suspended') void c.resume()
  const now = c.currentTime
  const notes = [
    { f: 880, t: 0 },     // A5
    { f: 1318.5, t: 0.12 }, // E6
  ]
  for (const n of notes) {
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.type = 'sine'
    osc.frequency.value = n.f
    const start = now + n.t
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18)
    osc.connect(gain).connect(c.destination)
    osc.start(start)
    osc.stop(start + 0.2)
  }
}
