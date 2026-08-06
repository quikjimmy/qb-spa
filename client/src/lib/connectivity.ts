// Connectivity evidence.
//
// "There was no signal on site" is a claim nobody can check after the fact.
// This records what the network was actually doing, where and when, so the
// question becomes answerable in either direction — it protects a crew that
// genuinely had no bars just as much as it catches one that did.
//
// The obvious API (navigator.connection / effectiveType / downlink) is
// Chromium-only — iOS Safari does not implement it, and most field phones are
// iPhones. So it's recorded opportunistically as a bonus, and the load-bearing
// signals are measured directly instead, which works on every browser:
//
//   rtt        — round trip to our own /ping endpoint
//   throughput — bytes/second observed on the real photo uploads we're
//                already doing, which is the number that actually matters
//   online     — navigator.onLine plus the online/offline transitions
//
// A sample is cheap and taken rarely; this is evidence, not telemetry.
import { ref } from 'vue'
import { authHeaders } from '@/lib/photoguard'

export interface ConnectivitySample {
  at: string
  kind: 'ping' | 'upload' | 'online' | 'offline'
  online: boolean
  rttMs: number | null
  /** Measured from a real upload; null for plain pings. */
  throughputKbps: number | null
  /** Chromium-only extras — null on iOS. */
  effectiveType: string | null
  downlinkMbps: number | null
  lat: number | null
  lng: number | null
  bytes: number | null
}

interface NetworkInformationLike {
  effectiveType?: string
  downlink?: number
  rtt?: number
}

function connectionInfo(): NetworkInformationLike | null {
  const n = navigator as Navigator & { connection?: NetworkInformationLike }
  return n.connection ?? null
}

export const isOnline = ref(typeof navigator === 'undefined' ? true : navigator.onLine)

function baseSample(kind: ConnectivitySample['kind']): ConnectivitySample {
  const c = connectionInfo()
  return {
    at: new Date().toISOString(),
    kind,
    online: navigator.onLine,
    rttMs: null,
    throughputKbps: null,
    effectiveType: c?.effectiveType ?? null,
    downlinkMbps: c?.downlink ?? null,
    lat: null,
    lng: null,
    bytes: null,
  }
}

/** Round-trip time to our own server. Cheap, and works everywhere. */
export async function measureRtt(timeoutMs = 8000): Promise<number | null> {
  if (!navigator.onLine) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const t0 = performance.now()
  try {
    const res = await fetch('/api/photoguard/ping', {
      headers: authHeaders(), cache: 'no-store', signal: ctrl.signal,
    })
    if (!res.ok) return null
    await res.arrayBuffer()
    return Math.round(performance.now() - t0)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function pingSample(
  geo?: { lat: number; lng: number } | null,
): Promise<ConnectivitySample> {
  const s = baseSample('ping')
  s.rttMs = await measureRtt()
  s.online = navigator.onLine && s.rttMs != null
  if (geo) { s.lat = geo.lat; s.lng = geo.lng }
  return s
}

/** Derived from a real photo upload — the most honest throughput number we
 *  can get, because it's the exact work the crew is trying to do. */
export function uploadSample(
  bytes: number,
  durationMs: number,
  geo?: { lat: number; lng: number } | null,
): ConnectivitySample {
  const s = baseSample('upload')
  s.bytes = bytes
  s.rttMs = null
  s.throughputKbps = durationMs > 0 ? Math.round((bytes * 8) / durationMs) : null // bits/ms == kbps
  if (geo) { s.lat = geo.lat; s.lng = geo.lng }
  return s
}

export function transitionSample(kind: 'online' | 'offline'): ConnectivitySample {
  const s = baseSample(kind)
  s.online = kind === 'online'
  return s
}

// ─── Reporting ────────────────────────────────────────────────────────
//
// Samples are buffered and flushed in batches: reporting connectivity one
// request at a time over a bad connection is self-defeating.

const buffer: ConnectivitySample[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

export function recordSample(submissionId: number | null, s: ConnectivitySample): void {
  if (!submissionId) return
  buffer.push(s)
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => void flushSamples(submissionId), 3000)
}

export async function flushSamples(submissionId: number | null): Promise<void> {
  if (!submissionId || !buffer.length || !navigator.onLine) return
  const batch = buffer.splice(0, buffer.length)
  try {
    await fetch(`/api/photoguard/submissions/${submissionId}/connectivity`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ samples: batch }),
    })
  } catch {
    // Put them back — losing the evidence because the network was bad would
    // be exactly the wrong failure mode for this feature.
    buffer.unshift(...batch)
  }
}

let listenersBound = false

/** Track online/offline transitions for the life of the page. */
export function bindConnectivityListeners(onChange?: (online: boolean) => void): () => void {
  const on = () => { isOnline.value = true; onChange?.(true) }
  const off = () => { isOnline.value = false; onChange?.(false) }
  if (!listenersBound) listenersBound = true
  window.addEventListener('online', on)
  window.addEventListener('offline', off)
  return () => {
    window.removeEventListener('online', on)
    window.removeEventListener('offline', off)
  }
}

/** Human summary of a sample, for the UI. */
export function describeSample(s: ConnectivitySample): string {
  if (!s.online) return 'Offline'
  if (s.throughputKbps != null) {
    const mbps = s.throughputKbps / 1000
    return mbps >= 1 ? `${mbps.toFixed(1)} Mbps up` : `${s.throughputKbps} kbps up`
  }
  if (s.rttMs != null) return `${s.rttMs}ms round trip`
  return 'Unknown'
}
