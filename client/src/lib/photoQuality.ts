// On-device photo checks — tier 1 of the "never go back to site" pipeline.
//
// These run in the browser in a few milliseconds so the field agent gets a
// verdict the instant the shutter closes, long before the upload round-trip
// (tier 2: EXIF/GPS/staleness on the server) or the vision model (tier 3,
// ~6s). Anything catchable from pixels alone belongs here.
//
// Everything is canvas-based — no dependencies, works offline.

export interface LocalIssue {
  code: string
  severity: 'fail' | 'warn'
  message: string
}

export interface LocalCheck {
  width: number
  height: number
  megapixels: number
  /** Variance of the Laplacian — the standard focus proxy. Higher = sharper. */
  sharpness: number
  /** Mean luminance, 0–255. */
  brightness: number
  issues: LocalIssue[]
  blocked: boolean
}

// Tuned against phone camera output. Sharpness especially is scale-dependent,
// so it is always measured on the same 256px-wide working copy.
const MIN_MEGAPIXELS = 1.2
const MIN_DIMENSION = 800
const BLUR_FAIL = 45
const BLUR_WARN = 110
const DARK_FAIL = 32
const DARK_WARN = 55
const BRIGHT_WARN = 232

const WORK_WIDTH = 256

function toGrayscale(data: Uint8ClampedArray, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h)
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    // Rec. 601 luma.
    g[i] = 0.299 * data[p]! + 0.587 * data[p + 1]! + 0.114 * data[p + 2]!
  }
  return g
}

/** Variance of the 4-neighbour Laplacian. Cheap, and reliable enough to tell
 *  "camera shake / out of focus" from "sharp". */
function laplacianVariance(gray: Float32Array, w: number, h: number): number {
  const n = (w - 2) * (h - 2)
  if (n <= 0) return 0
  let sum = 0
  const vals = new Float32Array(n)
  let k = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const v = -4 * gray[i]! + gray[i - 1]! + gray[i + 1]! + gray[i - w]! + gray[i + w]!
      vals[k++] = v
      sum += v
    }
  }
  const mean = sum / n
  let acc = 0
  for (let i = 0; i < n; i++) {
    const d = vals[i]! - mean
    acc += d * d
  }
  return acc / n
}

function meanBrightness(gray: Float32Array): number {
  let s = 0
  for (let i = 0; i < gray.length; i++) s += gray[i]!
  return gray.length ? s / gray.length : 0
}

async function decode(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob)
}

/**
 * Inspect a captured image without uploading it.
 * Never throws — a decode failure is reported as an issue.
 */
export async function checkPhotoLocally(blob: Blob): Promise<LocalCheck> {
  const base: LocalCheck = {
    width: 0, height: 0, megapixels: 0, sharpness: 0, brightness: 0,
    issues: [], blocked: false,
  }

  let bmp: ImageBitmap
  try {
    bmp = await decode(blob)
  } catch {
    base.issues.push({ code: 'unreadable', severity: 'fail', message: "Couldn't read that image — try again." })
    base.blocked = true
    return base
  }

  base.width = bmp.width
  base.height = bmp.height
  base.megapixels = Number(((bmp.width * bmp.height) / 1_000_000).toFixed(2))

  const w = Math.min(WORK_WIDTH, bmp.width)
  const h = Math.max(1, Math.round((bmp.height / bmp.width) * w))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) { bmp.close?.(); return base }
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close?.()

  const { data } = ctx.getImageData(0, 0, w, h)
  const gray = toGrayscale(data, w, h)
  base.sharpness = Math.round(laplacianVariance(gray, w, h))
  base.brightness = Math.round(meanBrightness(gray))

  if (base.megapixels < MIN_MEGAPIXELS) {
    base.issues.push({
      code: 'low_resolution', severity: 'fail',
      message: `Too low resolution (${base.megapixels}MP). Use the rear camera at full quality.`,
    })
  }
  if (Math.min(base.width, base.height) < MIN_DIMENSION) {
    base.issues.push({
      code: 'small_dimension', severity: 'fail',
      message: `Image is only ${Math.min(base.width, base.height)}px on its short side.`,
    })
  }
  if (base.sharpness < BLUR_FAIL) {
    base.issues.push({
      code: 'blurry', severity: 'fail',
      message: 'Photo looks out of focus — hold steady and tap to focus, then retake.',
    })
  } else if (base.sharpness < BLUR_WARN) {
    base.issues.push({
      code: 'soft', severity: 'warn',
      message: 'Slightly soft. Sharper is better if you can retake it.',
    })
  }
  if (base.brightness < DARK_FAIL) {
    base.issues.push({
      code: 'too_dark', severity: 'fail',
      message: 'Too dark to read detail — use the flash or find more light.',
    })
  } else if (base.brightness < DARK_WARN) {
    base.issues.push({
      code: 'dim', severity: 'warn',
      message: 'A bit dark. Consider the flash.',
    })
  } else if (base.brightness > BRIGHT_WARN) {
    base.issues.push({
      code: 'blown_out', severity: 'warn',
      message: 'Very bright — detail may be washed out.',
    })
  }

  base.blocked = base.issues.some(i => i.severity === 'fail')
  return base
}

// ─── Video → HD stills ────────────────────────────────────────────────
//
// Agents can walk a roof or a panel once on video and pull stills out of it,
// instead of stopping to frame each shot. Frames are captured at the video's
// native resolution (a 4K clip yields 4K stills), so quality holds up.
//
// A frame carries no EXIF — it never went through a camera pipeline — so the
// capture session supplies provenance instead (device geolocation + capture
// time + user), and the server gates it as source='video_frame'.

export interface VideoFrame {
  blob: Blob
  timeSeconds: number
  width: number
  height: number
  check: LocalCheck
}

function loadVideo(file: Blob): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const v = document.createElement('video')
    v.preload = 'auto'
    v.muted = true
    v.playsInline = true
    v.src = url
    const done = () => {
      if (v.videoWidth) resolve(v)
      else reject(new Error('Video has no visual track'))
    }
    v.onloadeddata = done
    v.onerror = () => reject(new Error('Could not read that video'))
  })
}

function seekTo(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeek = () => { v.removeEventListener('seeked', onSeek); resolve() }
    v.addEventListener('seeked', onSeek)
    v.onerror = () => reject(new Error('Seek failed'))
    // Nudge off exact boundaries — some encoders won't fire 'seeked' at 0 or duration.
    v.currentTime = Math.min(Math.max(t, 0.01), Math.max(0.01, (v.duration || 0) - 0.05))
  })
}

/** Grab a single still at `timeSeconds`, at the video's native resolution. */
export async function extractFrameAt(file: Blob, timeSeconds: number): Promise<VideoFrame> {
  const v = await loadVideo(file)
  try {
    await seekTo(v, timeSeconds)
    const canvas = document.createElement('canvas')
    canvas.width = v.videoWidth
    canvas.height = v.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas unavailable')
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height)

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Frame encode failed'))), 'image/jpeg', 0.95)
    })
    return {
      blob,
      timeSeconds: v.currentTime,
      width: canvas.width,
      height: canvas.height,
      check: await checkPhotoLocally(blob),
    }
  } finally {
    URL.revokeObjectURL(v.src)
    v.src = ''
  }
}

/**
 * Sample `count` evenly spaced frames and return them sharpest-first.
 * Lets an agent shoot one pass and keep the best still automatically.
 */
export async function extractBestFrames(file: Blob, count = 6): Promise<VideoFrame[]> {
  const v = await loadVideo(file)
  const duration = v.duration || 0
  URL.revokeObjectURL(v.src)
  v.src = ''
  if (!duration || !Number.isFinite(duration)) return []

  const n = Math.max(1, Math.min(count, 12))
  const times = Array.from({ length: n }, (_, i) => ((i + 0.5) / n) * duration)

  const frames: VideoFrame[] = []
  for (const t of times) {
    try { frames.push(await extractFrameAt(file, t)) } catch { /* skip bad seek */ }
  }
  return frames.sort((a, b) => b.check.sharpness - a.check.sharpness)
}

export function videoDuration(file: Blob): Promise<number> {
  return loadVideo(file).then(v => {
    const d = v.duration
    URL.revokeObjectURL(v.src)
    v.src = ''
    return Number.isFinite(d) ? d : 0
  })
}
