// Live job review — the AI inspector.
//
// Per-photo validation answers "is this photo of the right thing?". That
// misses everything that only shows up across a whole job: an array photographed
// but no rapid-shutdown label, a panel that doesn't match the design, a battery
// section untouched on a job that sold storage, conduit shown entering a wall
// with nothing shown on the other side.
//
// This reviews the JOB. It reasons over the descriptions the vision model has
// already written for each photo, plus the design from Quickbase and the form
// answers — so a whole-job review is one cheap text call rather than 40 more
// image calls.
//
// Reliability is the hard part, not capability. A reviewer that invents
// plausible-sounding problems trains crews to ignore it within a week, so the
// prompt is built to make silence the easy answer: it is told to report only
// what the supplied evidence supports, to cite the photos behind each finding,
// and that an empty list is the correct output for a clean job.
import db from '../db'
import { callModelText, extractJson, visionConfigured } from './photoguardVision'
import { getForm, describeDesign, resolveRequirements } from './photoguardForms'
import { publishPhotoGuardEvent } from './photoguardEvents'

// 'other' is the landing pad for a kind the model invents — better to keep the
// finding with an honest label than to drop it or mislabel it as a safety item.
export type FindingKind = 'gap' | 'mismatch' | 'quality' | 'sequence' | 'safety' | 'other'
export type FindingSeverity = 'blocker' | 'warning' | 'note'
export type FindingStatus = 'open' | 'resolved' | 'dismissed' | 'escalated'

export interface ReviewFinding {
  kind: FindingKind
  severity: FindingSeverity
  title: string
  detail: string
  requirementHash: string | null
  photoIds: number[]
}

const KINDS: FindingKind[] = ['gap', 'mismatch', 'quality', 'sequence', 'safety', 'other']
const SEVERITIES: FindingSeverity[] = ['blocker', 'warning', 'note']

export function ensureReviewSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS photoguard_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id INTEGER NOT NULL REFERENCES photoguard_submissions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      requirement_hash TEXT,
      photo_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'open',
      -- Stable identity for a finding so repeated reviews update rather than
      -- pile up duplicates of the same complaint.
      fingerprint TEXT NOT NULL,
      resolved_by TEXT,
      resolved_at TEXT,
      escalated_by TEXT,
      escalated_note TEXT,
      model TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (submission_id, fingerprint)
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pg_findings_sub ON photoguard_findings(submission_id, status)`)
}

// ─── Context ──────────────────────────────────────────────────────────

export interface ReviewContext {
  formTitle: string
  design: string | null
  sections: Array<{ title: string; required: number; satisfied: number }>
  captured: Array<{
    photoId: number
    requirement: string
    section: string
    passed: boolean | null
    description: string
    issues: string[]
  }>
  missing: Array<{ hash: string; label: string; section: string }>
  answers: Array<{ label: string; value: string }>
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}

export function buildReviewContext(submissionId: number): ReviewContext | null {
  const sub = db.prepare(`SELECT * FROM photoguard_submissions WHERE id = ?`).get(submissionId) as
    | Record<string, unknown> | undefined
  if (!sub) return null

  const formType = String(sub['form_type'])
  const form = getForm(formType)
  if (!form) return null

  const project = sub['project_rid']
    ? db.prepare(`SELECT * FROM project_cache WHERE record_id = ?`).get(sub['project_rid']) as Record<string, unknown> | undefined
    : undefined
  const resolved = resolveRequirements(formType, project ?? null)

  const photos = db.prepare(`
    SELECT id, category_hash, category_label, category_section, validation_passed,
           validation_status, validation_description, validation_issues,
           gate_status, review_status
    FROM photoguard_photos WHERE submission_id = ? ORDER BY created_at
  `).all(submissionId) as Array<Record<string, unknown>>

  const sectionTitles = new Map(form.sections.map(s => [s.key, s.title]))

  const usableByHash = new Set(
    photos
      .filter(p => p['gate_status'] !== 'blocked' && p['review_status'] !== 'rejected')
      .map(p => String(p['category_hash'] ?? '')),
  )

  const captured = photos
    .filter(p => p['gate_status'] !== 'blocked')
    .map(p => ({
      photoId: Number(p['id']),
      requirement: String(p['category_label'] ?? 'Unassigned'),
      section: sectionTitles.get(String(p['category_section'] ?? '')) ?? '',
      passed: p['validation_status'] === 'done' ? p['validation_passed'] === 1 : null,
      description: String(p['validation_description'] ?? '').trim(),
      issues: safeParse<string[]>(p['validation_issues'] as string | null, []),
    }))
    // A photo with no description tells the reviewer nothing.
    .filter(c => c.description !== '')

  const missing = form.fields
    .filter(f => f.fieldType === 'photo')
    .filter(f => (resolved.get(f.hash)?.required ?? f.required))
    .filter(f => !usableByHash.has(f.hash))
    .map(f => ({ hash: f.hash, label: f.label, section: sectionTitles.get(f.sectionKey) ?? '' }))

  const sections = form.sections.map(s => {
    const req = form.fields.filter(f =>
      f.fieldType === 'photo' && f.sectionKey === s.key &&
      (resolved.get(f.hash)?.required ?? f.required))
    return {
      title: s.title,
      required: req.length,
      satisfied: req.filter(f => usableByHash.has(f.hash)).length,
    }
  }).filter(s => s.required > 0)

  const answerRows = db.prepare(`
    SELECT field_hash, value FROM photoguard_answers WHERE submission_id = ?
  `).all(submissionId) as Array<{ field_hash: string; value: string | null }>
  const labels = new Map(form.fields.map(f => [f.hash, f.label]))
  const answers = answerRows
    .map(a => ({
      label: labels.get(a.field_hash) ?? a.field_hash,
      value: (() => {
        const v = safeParse<unknown>(a.value, a.value)
        return Array.isArray(v) ? v.join(', ') : String(v ?? '')
      })(),
    }))
    .filter(a => a.value.trim() !== '' && !a.label.startsWith('<'))

  return {
    formTitle: form.title,
    design: describeDesign(project ?? null)?.text ?? null,
    sections,
    captured,
    missing,
    answers,
  }
}

// ─── Prompt ───────────────────────────────────────────────────────────

export function buildReviewPrompt(ctx: ReviewContext): string {
  const photoLines = ctx.captured.map(c =>
    `- [photo ${c.photoId}] ${c.section} / ${c.requirement}: ${c.description}` +
    (c.issues.length ? ` (flagged: ${c.issues.join('; ')})` : '') +
    (c.passed === false ? ' [FAILED its own check]' : ''),
  ).join('\n') || '- (nothing captured yet)'

  const missingLines = ctx.missing.length
    ? ctx.missing.map(m => `- ${m.section} / ${m.label} [hash ${m.hash}]`).join('\n')
    : '- (none outstanding)'

  const sectionLines = ctx.sections
    .map(s => `- ${s.title}: ${s.satisfied}/${s.required} required photos captured`).join('\n')

  const answerLines = ctx.answers.length
    ? ctx.answers.map(a => `- ${a.label}: ${a.value}`).join('\n')
    : '- (no answers recorded)'

  return `You are an experienced solar and battery installation inspector reviewing a job in progress from the field crew's photos.

FORM: ${ctx.formTitle}
${ctx.design ? `SYSTEM SOLD (from the project record): ${ctx.design}` : 'SYSTEM SOLD: not recorded'}

SECTION PROGRESS:
${sectionLines}

WHAT THE CREW HAS PHOTOGRAPHED (each line is another inspector's description of one photo):
${photoLines}

FORM ANSWERS:
${answerLines}

REQUIRED PHOTOS NOT YET CAPTURED:
${missingLines}

Your job is to find problems that only become visible ACROSS the job — not to
re-check individual photos, which has already been done. Look for:
- equipment that contradicts the system sold
- work shown in one photo with its necessary counterpart missing (e.g. conduit
  entering a wall with nothing shown on the other side)
- safety or code items that the captured work implies should exist
- answers that disagree with what the photos show
- a section that looks finished but whose evidence is thin

CRITICAL RULES:
- Report ONLY what the descriptions above actually support. You cannot see the
  photos; you are reasoning over other people's descriptions of them.
- Do NOT report a required photo as missing just because it is on the
  outstanding list — the crew already knows, and the form already tells them.
  Only mention an omission if it is genuinely notable given what IS captured.
- If nothing is wrong, return an empty array. An empty array is a correct and
  expected answer, and is much better than a speculative finding.
- Every finding must cite the photo ids it is based on.

Respond with JSON ONLY, in this exact shape:
{
  "findings": [
    {
      "kind": "gap|mismatch|quality|sequence|safety",
      "severity": "blocker|warning|note",
      "title": "short phrase",
      "detail": "one or two sentences of specifics, referencing what you saw",
      "requirementHash": "hash if it maps to one outstanding item, else null",
      "photoIds": [123, 124]
    }
  ]
}`
}

// ─── Parsing ──────────────────────────────────────────────────────────

export function parseReviewFindings(raw: string): ReviewFinding[] | null {
  const obj = extractJson(raw)
  if (obj == null) return null

  const list = Array.isArray(obj)
    ? obj
    : Array.isArray((obj as Record<string, unknown>)['findings'])
      ? (obj as Record<string, unknown>)['findings'] as unknown[]
      : null
  if (!list) return null

  const out: ReviewFinding[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const title = typeof o['title'] === 'string' ? o['title'].trim() : ''
    if (!title) continue

    const kind: FindingKind = KINDS.includes(o['kind'] as FindingKind)
      ? (o['kind'] as FindingKind) : 'other'
    const severity = SEVERITIES.includes(o['severity'] as FindingSeverity)
      ? o['severity'] as FindingSeverity : 'note'
    // Number(null) is 0 and Number('') is 0, both of which survive a bare
    // isFinite check and would cite a photo that doesn't exist. Ids are
    // positive integers, so require that.
    const photoIds = Array.isArray(o['photoIds'])
      ? o['photoIds']
        .map(v => (typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN))
        .filter(n => Number.isInteger(n) && n > 0)
      : []
    const hashRaw = o['requirementHash']
    out.push({
      kind,
      severity,
      title: title.slice(0, 200),
      detail: typeof o['detail'] === 'string' ? o['detail'].trim().slice(0, 1000) : '',
      requirementHash: typeof hashRaw === 'string' && hashRaw.trim() && hashRaw !== 'null'
        ? hashRaw.trim() : null,
      photoIds,
    })
  }
  return out
}

/** Stable identity so re-running a review updates findings instead of
 *  duplicating them. Title is normalized because models rephrase. */
export function fingerprint(f: ReviewFinding): string {
  const t = f.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80)
  return `${f.kind}:${f.requirementHash ?? ''}:${t}`
}

// ─── Run ──────────────────────────────────────────────────────────────

export interface ReviewResult {
  ran: boolean
  reason?: string
  findings: number
  model?: string
}

export async function runJobReview(submissionId: number): Promise<ReviewResult> {
  ensureReviewSchema()
  if (!visionConfigured()) return { ran: false, reason: 'Model not configured', findings: 0 }

  const ctx = buildReviewContext(submissionId)
  if (!ctx) return { ran: false, reason: 'Submission not found', findings: 0 }
  if (ctx.captured.length < 2) {
    // Nothing meaningful to reason across yet — and a review of one photo
    // would just restate that photo's own verdict.
    return { ran: false, reason: 'Not enough described photos yet', findings: 0 }
  }

  let raw: string
  try {
    raw = await callModelText(buildReviewPrompt(ctx))
  } catch (e) {
    return { ran: false, reason: e instanceof Error ? e.message : 'Model call failed', findings: 0 }
  }

  const findings = parseReviewFindings(raw)
  if (!findings) return { ran: false, reason: 'Model returned unparseable output', findings: 0 }

  const model = process.env['OLLAMA_VISION_MODEL'] || 'kimi-k2.6:cloud'
  const upsert = db.prepare(`
    INSERT INTO photoguard_findings
      (submission_id, kind, severity, title, detail, requirement_hash, photo_ids, fingerprint, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(submission_id, fingerprint) DO UPDATE SET
      severity = excluded.severity,
      detail = excluded.detail,
      photo_ids = excluded.photo_ids,
      updated_at = datetime('now')
  `)
  const tx = db.transaction(() => {
    for (const f of findings) {
      upsert.run(submissionId, f.kind, f.severity, f.title, f.detail,
        f.requirementHash, JSON.stringify(f.photoIds), fingerprint(f), model)
    }
  })
  tx()

  publishPhotoGuardEvent({
    type: 'photo_validated',
    status: 'job_review',
    message: `Job review: ${findings.length} finding(s)`,
    data: { submissionId, findings: findings.length, kind: 'job_review' },
  })

  return { ran: true, findings: findings.length, model }
}

export function listFindings(submissionId: number): Array<Record<string, unknown>> {
  ensureReviewSchema()
  return db.prepare(`
    SELECT * FROM photoguard_findings
    WHERE submission_id = ?
    ORDER BY CASE severity WHEN 'blocker' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
             CASE status WHEN 'open' THEN 0 WHEN 'escalated' THEN 1 ELSE 2 END,
             id
  `).all(submissionId) as Array<Record<string, unknown>>
}
