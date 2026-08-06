// Photo provenance + quality gates.
//
// The point of PhotoGuard is that a field agent never has to drive back for a
// photo. That means every problem we can detect must be detected while they're
// still standing there — so gates run in two tiers:
//
//   tier 1 (instant, client-side): resolution, blur, brightness, framing.
//     Runs on-device in milliseconds; see client/src/lib/photoQuality.ts.
//   tier 2 (fast, server-side, this file): EXIF, GPS, capture time, device,
//     duplicate detection. Runs on upload, well before the vision model.
//   tier 3 (slow, ~6s): the vision model's subject check.
//
// Tiers 1 and 2 are deterministic and cheap, so the agent gets an answer
// immediately and the AI verdict lands moments later over SSE.
//
// Provenance matters as much as quality: we record WHO captured it, WHERE,
// WHEN, and whether the pixels came from a live capture or a file picker.
import sharp from 'sharp'
import crypto from 'crypto'
import exifReader from 'exif-reader'

export type CaptureSource = 'camera' | 'upload' | 'video_frame' | 'arrivy_import'

export interface PhotoMetadata {
  width: number
  height: number
  megapixels: number
  fileSize: number
  format: string
  hasExif: boolean
  hasGps: boolean
  gpsLat: number | null
  gpsLng: number | null
  cameraMake: string | null
  cameraModel: string | null
  photoTimestamp: string | null
  orientation: number | null
  /** sha256 of the pixel bytes — catches the same photo submitted twice. */
  contentHash: string
}

export interface GateIssue {
  code: string
  severity: 'fail' | 'warn'
  message: string
}

// Thresholds. Deliberately env-tunable — the right radius for a rural ground
// mount is not the right radius for a townhouse.
export const MIN_MEGAPIXELS = Number(process.env['PHOTOGUARD_MIN_MP'] || 1.2)
export const MIN_DIMENSION = Number(process.env['PHOTOGUARD_MIN_DIM'] || 800)
export const GEOFENCE_METERS = Number(process.env['PHOTOGUARD_GEOFENCE_M'] || 300)
export const MAX_AGE_HOURS = Number(process.env['PHOTOGUARD_MAX_AGE_H'] || 24)

/** Great-circle distance in metres. */
export function haversineMeters(
  lat1: number, lng1: number, lat2: number, lng2: number,
): number {
  const R = 6_371_000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** EXIF GPS stores degrees/minutes/seconds plus a N/S/E/W reference. */
export function dmsToDecimal(dms: number[] | undefined, ref: string | undefined): number | null {
  if (!Array.isArray(dms) || dms.length < 2) return null
  const [d = 0, m = 0, s = 0] = dms
  if (!Number.isFinite(d) || !Number.isFinite(m) || !Number.isFinite(s)) return null
  let dec = Math.abs(d) + m / 60 + s / 3600
  const r = (ref || '').trim().toUpperCase()
  if (r === 'S' || r === 'W') dec = -dec
  return Number.isFinite(dec) ? dec : null
}

function toIso(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString()
  if (typeof v === 'string') {
    // EXIF classic format: "2026:08:05 14:03:21"
    const m = v.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
    if (m) {
      const [, Y, M, D, h, mi, s] = m
      const d = new Date(`${Y}-${M}-${D}T${h}:${mi}:${s}`)
      return Number.isNaN(d.getTime()) ? null : d.toISOString()
    }
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  return null
}

interface ExifShape {
  Image?: Record<string, unknown>
  Photo?: Record<string, unknown>
  GPSInfo?: Record<string, unknown>
}

/** Read dimensions + EXIF from image bytes. Never throws — a photo with
 *  unreadable metadata is a finding, not a crash. */
export async function extractMetadata(buf: Buffer): Promise<PhotoMetadata> {
  const contentHash = crypto.createHash('sha256').update(buf).digest('hex')
  const base: PhotoMetadata = {
    width: 0, height: 0, megapixels: 0, fileSize: buf.length, format: '',
    hasExif: false, hasGps: false, gpsLat: null, gpsLng: null,
    cameraMake: null, cameraModel: null, photoTimestamp: null,
    orientation: null, contentHash,
  }

  let meta: sharp.Metadata
  try {
    meta = await sharp(buf).metadata()
  } catch {
    return base
  }

  base.width = meta.width ?? 0
  base.height = meta.height ?? 0
  base.megapixels = Number(((base.width * base.height) / 1_000_000).toFixed(2))
  base.format = meta.format ?? ''
  base.orientation = meta.orientation ?? null

  if (!meta.exif) return base

  try {
    const exif = exifReader(meta.exif) as ExifShape
    base.hasExif = true

    const image = exif.Image ?? {}
    const photo = exif.Photo ?? {}
    const gps = exif.GPSInfo ?? {}

    const make = image['Make']
    const model = image['Model']
    base.cameraMake = typeof make === 'string' ? make.trim() : null
    base.cameraModel = typeof model === 'string' ? model.trim() : null

    base.photoTimestamp =
      toIso(photo['DateTimeOriginal']) ??
      toIso(photo['DateTimeDigitized']) ??
      toIso(image['DateTime'])

    const lat = dmsToDecimal(gps['GPSLatitude'] as number[], gps['GPSLatitudeRef'] as string)
    const lng = dmsToDecimal(gps['GPSLongitude'] as number[], gps['GPSLongitudeRef'] as string)
    if (lat != null && lng != null && !(lat === 0 && lng === 0)) {
      base.hasGps = true
      base.gpsLat = lat
      base.gpsLng = lng
    }
  } catch {
    // EXIF block present but unparseable — leave hasExif false.
  }

  return base
}

export interface GateContext {
  source: CaptureSource
  /** Device geolocation captured alongside the shot, when the browser gave it. */
  deviceLat?: number | null
  deviceLng?: number | null
  /** Site coordinates to geofence against, when the project has them. */
  siteLat?: number | null
  siteLng?: number | null
  /** When the capture session says the photo was taken. */
  capturedAt?: string | null
  /** Content hashes already stored on this submission. */
  knownHashes?: Set<string>
  now?: Date
}

/**
 * Deterministic gates over metadata + capture context.
 *
 * Returns findings, not a verdict — the caller decides what blocks submission.
 * Video frames are held to a different standard: they can't carry EXIF, so
 * their provenance comes from the capture session instead, and demanding EXIF
 * of them would be a guaranteed false failure.
 */
export function runQualityGates(meta: PhotoMetadata, ctx: GateContext): GateIssue[] {
  const issues: GateIssue[] = []
  const now = ctx.now ?? new Date()
  const fromLiveCapture = ctx.source === 'camera' || ctx.source === 'video_frame'

  // ── Resolution ──
  if (meta.width === 0 || meta.height === 0) {
    issues.push({ code: 'unreadable', severity: 'fail', message: 'Image could not be decoded.' })
    return issues
  }
  if (meta.megapixels < MIN_MEGAPIXELS) {
    issues.push({
      code: 'low_resolution', severity: 'fail',
      message: `Only ${meta.megapixels}MP — needs at least ${MIN_MEGAPIXELS}MP to read detail.`,
    })
  }
  if (Math.min(meta.width, meta.height) < MIN_DIMENSION) {
    issues.push({
      code: 'small_dimension', severity: 'fail',
      message: `Shortest side is ${Math.min(meta.width, meta.height)}px — needs ${MIN_DIMENSION}px.`,
    })
  }

  // ── Duplicate ──
  if (ctx.knownHashes?.has(meta.contentHash)) {
    issues.push({
      code: 'duplicate', severity: 'fail',
      message: 'This exact image was already submitted for this form.',
    })
  }

  // ── EXIF / provenance ──
  if (!meta.hasExif && !fromLiveCapture) {
    issues.push({
      code: 'no_exif', severity: 'warn',
      message: 'No EXIF metadata — image may have been edited, screenshotted, or re-saved.',
    })
  }

  // ── Location ──
  const lat = meta.gpsLat ?? ctx.deviceLat ?? null
  const lng = meta.gpsLng ?? ctx.deviceLng ?? null
  if (lat == null || lng == null) {
    issues.push({
      code: 'no_gps', severity: 'warn',
      message: 'No location recorded. Enable location access so the photo can be tied to the site.',
    })
  } else if (ctx.siteLat != null && ctx.siteLng != null) {
    const dist = haversineMeters(lat, lng, ctx.siteLat, ctx.siteLng)
    if (dist > GEOFENCE_METERS) {
      issues.push({
        code: 'off_site', severity: 'fail',
        message: `Captured ${Math.round(dist)}m from the site address (limit ${GEOFENCE_METERS}m).`,
      })
    }
  }

  // ── Time ──
  const stamp = meta.photoTimestamp ?? ctx.capturedAt ?? null
  if (!stamp) {
    issues.push({
      code: 'no_timestamp', severity: 'warn',
      message: 'No capture time recorded on the photo.',
    })
  } else {
    const t = new Date(stamp)
    if (Number.isNaN(t.getTime())) {
      issues.push({ code: 'bad_timestamp', severity: 'warn', message: 'Capture time is unreadable.' })
    } else {
      const ageH = (now.getTime() - t.getTime()) / 3_600_000
      if (ageH > MAX_AGE_HOURS) {
        issues.push({
          code: 'stale', severity: 'fail',
          message: `Taken ${Math.round(ageH)}h ago — older than the ${MAX_AGE_HOURS}h limit for this visit.`,
        })
      } else if (ageH < -1) {
        issues.push({
          code: 'future_timestamp', severity: 'warn',
          message: 'Capture time is in the future — check the device clock.',
        })
      }
    }
  }

  return issues
}

export function gatesBlock(issues: GateIssue[]): boolean {
  return issues.some(i => i.severity === 'fail')
}
