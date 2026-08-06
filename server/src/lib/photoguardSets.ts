// Set-level assessment for multi-photo requirements.
//
// Judging each frame as a contribution stopped the false failures, but left
// the real question unasked: does the COLLECTION actually satisfy
// "Photos of Every Roof Plane"? Nineteen usable roof photos is not the same as
// a documented roof, and a count-based check can't tell the difference —
// nineteen shots of one plane would read as full coverage.
//
// So coverage is assessed on DISTINCT CONTENT. Photos are clustered by
// perceptual hash first, the model is told which are near-duplicates of each
// other, and it's asked to judge what the set covers and what's missing. A
// requirement stating a count ("(8 Photos)") is measured against distinct
// shots, never raw uploads.
import db from '../db'
import { callModelText, extractJson, visionConfigured } from './photoguardVision'
import { getForm } from './photoguardForms'
import { clusterByLikeness } from './photoguardQuality'

export interface SetMember {
  id: number
  description: string
  passed: number | null
  phash: string | null
}

export interface SetVerdict {
  satisfied: boolean
  confidence: number
  covered: string[]
  missing: string[]
  note: string
}

export function ensureSetSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS photoguard_set_assessments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,              -- 'submission' | 'task'
      scope_id INTEGER NOT NULL,
      field_hash TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      satisfied INTEGER NOT NULL DEFAULT 0,
      confidence REAL,
      distinct_shots INTEGER NOT NULL DEFAULT 0,
      photo_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      expected_count INTEGER,
      covered TEXT NOT NULL DEFAULT '[]',
      missing TEXT NOT NULL DEFAULT '[]',
      note TEXT NOT NULL DEFAULT '',
      model TEXT,
      assessed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (scope, scope_id, field_hash)
    )
  `)
}

export function buildSetPrompt(
  label: string,
  hints: string,
  members: SetMember[],
  clusters: number[][],
  expectedCount: number | null,
): string {
  const dupNote = clusters
    .filter(c => c.length > 1)
    .map(c => `- photos ${c.join(', ')} look like the same shot`)
    .join('\n')

  const lines = members.map(m => `- [photo ${m.id}] ${m.description}`).join('\n')

  return `You are a solar site survey reviewer checking whether a SET of photos satisfies one requirement.

REQUIREMENT: "${label}"
${hints ? `What it should show: ${hints}` : ''}
${expectedCount ? `The form asks for about ${expectedCount} photos.` : ''}

The crew submitted ${members.length} photo(s). Each line is another reviewer's description of one photo:
${lines}

${dupNote ? `NEAR-DUPLICATES DETECTED (visually near-identical framing):\n${dupNote}\n\nTreat each of those groups as ONE piece of evidence, not several.` : 'No near-duplicates detected.'}

Judge COVERAGE, not quantity. ${expectedCount ? 'A stated photo count is a guide, not proof — ' : ''}the same subject photographed repeatedly does not become coverage. If the descriptions all describe the same thing from nearly the same angle, the requirement is NOT satisfied however many photos there are.

Be concrete about what is and isn't represented (e.g. "front and left planes shown; rear plane not represented").

If the descriptions genuinely cover the requirement, say so — do not invent gaps.

Respond with JSON ONLY:
{
  "satisfied": true/false,
  "confidence": 0.0-1.0,
  "covered": ["what is clearly evidenced"],
  "missing": ["what is not evidenced, specifically"],
  "note": "one sentence summarising the coverage"
}`
}

export function parseSetVerdict(raw: string): SetVerdict | null {
  const obj = extractJson(raw)
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const o = obj as Record<string, unknown>

  // As with per-photo verdicts, we refuse to guess the actual judgement.
  let satisfied: boolean
  if (typeof o['satisfied'] === 'boolean') satisfied = o['satisfied']
  else if (typeof o['satisfied'] === 'string') {
    const v = o['satisfied'].trim().toLowerCase()
    if (['true', 'yes'].includes(v)) satisfied = true
    else if (['false', 'no'].includes(v)) satisfied = false
    else return null
  } else return null

  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String).map(s => s.trim()).filter(Boolean) : []

  const confRaw = typeof o['confidence'] === 'number' ? o['confidence'] : Number(o['confidence'])
  const conf = Number.isFinite(confRaw) ? Math.min(1, Math.max(0, confRaw > 1 ? confRaw / 100 : confRaw)) : 0

  return {
    satisfied,
    confidence: conf,
    covered: list(o['covered']),
    missing: list(o['missing']),
    note: typeof o['note'] === 'string' ? o['note'].trim().slice(0, 500) : '',
  }
}

export interface SetAssessment extends SetVerdict {
  fieldHash: string
  label: string
  photoCount: number
  distinctShots: number
  duplicateCount: number
  expectedCount: number | null
}

/**
 * Assess every collective requirement in one submission or imported task.
 *
 * Runs one cheap text call per requirement that has photos, reasoning over the
 * per-photo descriptions already produced — no images re-sent.
 */
export async function assessSets(
  scope: 'submission' | 'task',
  scopeId: number,
): Promise<{ ran: boolean; reason?: string; assessments: SetAssessment[] }> {
  ensureSetSchema()
  if (!visionConfigured()) return { ran: false, reason: 'Model not configured', assessments: [] }

  const col = scope === 'submission' ? 'submission_id' : 'task_rowid'
  const formTypeRow = db.prepare(`
    SELECT form_type FROM photoguard_photos WHERE ${col} = ? AND form_type IS NOT NULL LIMIT 1
  `).get(scopeId) as { form_type: string } | undefined
  if (!formTypeRow) return { ran: false, reason: 'No photos for that scope', assessments: [] }

  const form = getForm(formTypeRow.form_type)
  if (!form) return { ran: false, reason: 'Form definition missing', assessments: [] }

  const collective = form.fields.filter(f => f.fieldType === 'photo' && f.collective)
  if (!collective.length) return { ran: true, assessments: [] }

  const out: SetAssessment[] = []
  const model = process.env['OLLAMA_VISION_MODEL'] || 'kimi-k2.6:cloud'
  const save = db.prepare(`
    INSERT INTO photoguard_set_assessments
      (scope, scope_id, field_hash, label, satisfied, confidence, distinct_shots,
       photo_count, duplicate_count, expected_count, covered, missing, note, model, assessed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(scope, scope_id, field_hash) DO UPDATE SET
      satisfied = excluded.satisfied, confidence = excluded.confidence,
      distinct_shots = excluded.distinct_shots, photo_count = excluded.photo_count,
      duplicate_count = excluded.duplicate_count, covered = excluded.covered,
      missing = excluded.missing, note = excluded.note, assessed_at = datetime('now')
  `)

  for (const field of collective) {
    const members = db.prepare(`
      SELECT id, validation_description AS description, validation_passed AS passed, phash
      FROM photoguard_photos
      WHERE ${col} = ? AND category_hash = ? AND gate_status != 'blocked'
      ORDER BY created_at
    `).all(scopeId, field.hash) as Array<{ id: number; description: string | null; passed: number | null; phash: string | null }>

    const usable = members
      .filter(m => (m.description ?? '').trim() !== '')
      .map(m => ({ id: m.id, description: String(m.description), passed: m.passed, phash: m.phash }))
    if (!usable.length) continue

    const clusters = clusterByLikeness(usable)
    const duplicateCount = usable.length - clusters.length

    let verdict: SetVerdict | null = null
    try {
      verdict = parseSetVerdict(await callModelText(
        buildSetPrompt(field.label, field.hints, usable, clusters, field.expectedCount),
      ))
    } catch { verdict = null }
    if (!verdict) continue

    // A stated count is measured against DISTINCT shots. The model can be
    // talked round; arithmetic can't.
    let satisfied = verdict.satisfied
    const missing = [...verdict.missing]
    if (field.expectedCount && clusters.length < field.expectedCount) {
      satisfied = false
      missing.unshift(
        `Only ${clusters.length} distinct shot(s) among ${usable.length} photo(s); the requirement asks for ${field.expectedCount}`,
      )
    }

    save.run(
      scope, scopeId, field.hash, field.label, satisfied ? 1 : 0, verdict.confidence,
      clusters.length, usable.length, duplicateCount, field.expectedCount,
      JSON.stringify(verdict.covered), JSON.stringify(missing), verdict.note, model,
    )
    out.push({
      ...verdict, satisfied, missing,
      fieldHash: field.hash, label: field.label,
      photoCount: usable.length, distinctShots: clusters.length,
      duplicateCount, expectedCount: field.expectedCount,
    })
  }

  return { ran: true, assessments: out }
}

export function listSetAssessments(scope: 'submission' | 'task', scopeId: number) {
  ensureSetSchema()
  return db.prepare(`
    SELECT * FROM photoguard_set_assessments
    WHERE scope = ? AND scope_id = ?
    ORDER BY satisfied, label
  `).all(scope, scopeId) as Array<Record<string, unknown>>
}
