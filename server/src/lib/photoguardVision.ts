// Vision validation for PhotoGuard.
//
// Speaks the Ollama chat API (`/api/chat`, base64 in `images`), which is what
// the spec pins. Everything is env-driven rather than read off disk — the spec
// suggested pulling the key out of /root/.openclaw/openclaw.json, but that's a
// VPS path that doesn't exist in this deploy and a credential file on disk is
// worse practice than an env var anyway.
//
//   OLLAMA_API_KEY        required to run validation at all
//   OLLAMA_BASE           default https://ollama.com
//   OLLAMA_VISION_MODEL   default kimi-k2.6:cloud
//   OLLAMA_TIMEOUT_MS     default 90000 (cloud vision is ~6s/photo, but cold
//                         starts and big uploads run long)
//
// The network call is deliberately separated from the pure prompt/parse
// helpers so the tricky part — coercing whatever the model returns into a
// verdict — is unit-testable without a live endpoint.

export interface VisionVerdict {
  passed: boolean
  confidence: number
  issues: string[]
  description: string
}

export interface VisionResult extends VisionVerdict {
  model: string
  timeMs: number
}

export function visionBase(): string {
  return (process.env['OLLAMA_BASE'] || 'https://ollama.com').replace(/\/+$/, '')
}

export function visionModel(): string {
  return process.env['OLLAMA_VISION_MODEL'] || 'kimi-k2.6:cloud'
}

/** A daemon on this machine needs no auth, so requiring a key there would
 *  make a perfectly working local Ollama look unconfigured. */
export function isLocalBase(base = visionBase()): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i.test(base)
}

export function visionConfigured(): boolean {
  return !!process.env['OLLAMA_API_KEY'] || isLocalBase()
}

export class VisionNotConfiguredError extends Error {
  constructor() {
    super('Vision model not configured — set OLLAMA_API_KEY')
    this.name = 'VisionNotConfiguredError'
  }
}

/**
 * Prompt from the PhotoGuard spec, verbatim apart from the interpolations.
 *
 * `design` is the system spec pulled from Quickbase. When present it lets the
 * model catch wrong equipment — the wrong inverter model on the wall is
 * invisible to a "does this look like an inverter?" check. It's deliberately
 * scoped to *visible labels only* and told not to fail photos where equipment
 * isn't the subject, otherwise every roof shot would fail for not showing a
 * module sticker.
 */
export interface GroupContext {
  /** True when the requirement can only be met by a set of photos. */
  collective: boolean
  /** Stated count when the label gives one ("(8 Photos)"). */
  expectedCount?: number | null
  /** Where this photo sits in the set, when known. */
  position?: number | null
  total?: number | null
}

export function buildVisionPrompt(
  categoryLabel: string,
  hints: string,
  design?: string,
  group?: GroupContext,
): string {
  const designBlock = design
    ? `

Equipment specified for this job (from the project record):
${design}

If — and only if — this photo shows an equipment label, nameplate or model
marking that clearly contradicts the specification above, FAIL it and say what
you actually see. Do NOT fail a photo merely because equipment is not visible
in it; most photos are not equipment photos.`
    : ''

  // A collective requirement ("Photos of Every Roof Plane", "360 Degree ...
  // (8 Photos)") cannot be satisfied by any single frame. Judging each photo
  // against the whole requirement failed every one of them with objections
  // that were true but useless — "does not capture all roof planes". For these,
  // the question is whether THIS photo is a usable contribution; whether the
  // SET is complete is assessed separately, across all of them.
  const groupBlock = group?.collective
    ? `

IMPORTANT — THIS IS A MULTI-PHOTO REQUIREMENT.
"${categoryLabel}" is satisfied by a SET of photos${group.expectedCount ? ` (about ${group.expectedCount})` : ''}, not by any single one.${group.position && group.total ? ` This is photo ${group.position} of ${group.total} submitted so far.` : ''}

Judge ONLY whether THIS photo is a usable contribution to that set:
- PASS it if it is in focus, adequately lit, and clearly shows part of the
  required subject from a useful angle.
- FAIL it only if it is unusable (blurred, too dark, obstructed) or shows an
  entirely different subject.
- Do NOT fail it for being partial, for showing only one plane/angle/side, for
  not covering the whole area, or for not being comprehensive. Coverage is
  judged across the whole set, not here. Penalising a single photo for not
  showing everything is always wrong on this category.`
    : ''

  return `You are a solar site survey photo validator. A field agent just took this photo for the category: "${categoryLabel}"

Requirements for this photo: ${hints || 'No additional requirements beyond matching the category.'}${designBlock}${groupBlock}

Respond in JSON format ONLY:
{
  "passed": true/false,
  "confidence": 0.0-1.0,
  "issues": ["specific issue 1", "specific issue 2"],
  "description": "brief description of what you see in the photo"
}

A photo PASSES if it meets the requirements. It FAILS if:
- Wrong subject (photo doesn't match the category)
- Too blurry or dark to be useful
- Missing required elements (measuring tape, labels, etc.)
${group?.collective
  ? '- (Not applicable here: partial coverage is expected on a multi-photo requirement)'
  : "- Wrong angle or doesn't show what's needed"}
- Photo appears to be a placeholder, stock image, or not a real site photo`
}

/** Pull JSON out of a model response that may be fenced or prose-wrapped.
 *  Shared by the per-photo verdict parser and the job reviewer. */
export function extractJson(raw: string): unknown {
  if (!raw || !raw.trim()) return null
  let text = raw.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) text = fence[1].trim()
  try { return JSON.parse(text) } catch { /* fall through */ }
  // Outermost object or array span.
  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    const a = text.indexOf(open)
    const b = text.lastIndexOf(close)
    if (a !== -1 && b > a) {
      try { return JSON.parse(text.slice(a, b + 1)) } catch { /* try the other */ }
    }
  }
  return null
}

/**
 * Text-only completion against the same endpoint.
 *
 * Job-level review reasons over the descriptions the vision model already
 * produced per photo, so it needs no images — which keeps a whole-job review
 * to one cheap call instead of re-sending 40 photos.
 */
export async function callModelText(prompt: string, timeoutMs = 60_000): Promise<string> {
  if (!visionConfigured()) throw new VisionNotConfiguredError()
  const key = process.env['OLLAMA_API_KEY']
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (key) headers['Authorization'] = `Bearer ${key}`

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${visionBase()}/api/chat`, {
      method: 'POST', headers, signal: ctrl.signal,
      body: JSON.stringify({
        model: visionModel(), stream: false, format: 'json',
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) throw new Error(`Model API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
    const data = await res.json() as OllamaChatResponse
    if (data.error) throw new Error(`Model API error: ${data.error}`)
    return data.message?.content ?? ''
  } finally {
    clearTimeout(timer)
  }
}

function coerceIssues(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).filter(s => s.trim() !== '')
  }
  if (typeof v === 'string' && v.trim() !== '') return [v.trim()]
  return []
}

function clampConfidence(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return 0
  // Models sometimes answer 0-100 instead of 0-1.
  const scaled = n > 1 && n <= 100 ? n / 100 : n
  return Math.min(1, Math.max(0, scaled))
}

/**
 * Turn a model response into a verdict.
 *
 * Tolerates the three things models actually do wrong here: wrapping the JSON
 * in ```json fences, prefixing it with prose, and returning confidence on a
 * 0-100 scale. Returns null when there's no usable JSON at all — the caller
 * records that as "validation errored" rather than inventing a pass.
 */
export function parseVisionResponse(raw: string): VisionVerdict | null {
  if (!raw || !raw.trim()) return null

  let text = raw.trim()
  // Strip ```json ... ``` fences.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) text = fence[1].trim()

  let obj: unknown = null
  try {
    obj = JSON.parse(text)
  } catch {
    // Fall back to the outermost {...} span if the model added prose.
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end <= start) return null
    try { obj = JSON.parse(text.slice(start, end + 1)) } catch { return null }
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const o = obj as Record<string, unknown>

  // `passed` is the one field we refuse to guess at.
  let passed: boolean
  if (typeof o['passed'] === 'boolean') passed = o['passed']
  else if (typeof o['passed'] === 'string') {
    const s = o['passed'].trim().toLowerCase()
    if (s === 'true' || s === 'yes' || s === 'pass') passed = true
    else if (s === 'false' || s === 'no' || s === 'fail') passed = false
    else return null
  } else return null

  const description = typeof o['description'] === 'string' ? o['description'].trim() : ''
  return {
    passed,
    confidence: clampConfidence(o['confidence']),
    issues: coerceIssues(o['issues']),
    description,
  }
}

interface OllamaChatResponse {
  message?: { content?: string }
  error?: string
}

/**
 * Validate one photo. Throws on transport/config failure — callers treat a
 * throw as "leave this photo pending", never as a failed photo, so an outage
 * can't mass-fail a crew's work.
 */
export async function validatePhotoBuffer(
  buf: Buffer,
  categoryLabel: string,
  hints: string,
  design?: string,
  group?: GroupContext,
): Promise<VisionResult> {
  if (!visionConfigured()) throw new VisionNotConfiguredError()

  const model = visionModel()
  const started = Date.now()
  const timeoutMs = Number(process.env['OLLAMA_TIMEOUT_MS'] || 90_000)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)

  try {
    const key = process.env['OLLAMA_API_KEY']
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    // Only send auth when we have it — a local daemon rejects nothing, but
    // `Bearer undefined` is a confusing thing to put on the wire.
    if (key) headers['Authorization'] = `Bearer ${key}`

    const res = await fetch(`${visionBase()}/api/chat`, {
      method: 'POST',
      headers,
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        messages: [{
          role: 'user',
          content: buildVisionPrompt(categoryLabel, hints, design, group),
          images: [buf.toString('base64')],
        }],
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Vision API ${res.status}: ${body.slice(0, 300)}`)
    }

    const data = await res.json() as OllamaChatResponse
    if (data.error) throw new Error(`Vision API error: ${data.error}`)

    const content = data.message?.content ?? ''
    const verdict = parseVisionResponse(content)
    if (!verdict) {
      throw new Error(`Vision model returned unparseable output: ${content.slice(0, 200)}`)
    }
    return { ...verdict, model, timeMs: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}
