// Reference examples — "here's what a good one looks like".
//
// Two problems this solves at once:
//
//  1. The crew doesn't always know what's being asked for. A thumbnail of an
//     accepted photo answers that faster than any hint text.
//  2. The vision model is only as good as what it's told to look for. Generic
//     hints produce generic checks; labels attached to real exemplars ("torque
//     stripe visible", "meter serial legible") are specific and get injected
//     straight into the prompt for that requirement.
//
// Examples come from photos we already hold — promoted by a reviewer, or
// harvested in bulk from the Arrivy back-catalogue — rather than a stock
// library, so they show the standard this company actually accepts.
import db from '../db'

export interface ExampleRow {
  id: number
  field_hash: string
  form_type: string | null
  photo_id: number | null
  file_path: string | null
  thumb_path: string | null
  caption: string
  labels: string
  score: number
  source: string
  is_primary: number
  created_by: string | null
  created_at: string
}

export function ensureExampleSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS photoguard_examples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field_hash TEXT NOT NULL,
      form_type TEXT,
      photo_id INTEGER REFERENCES photoguard_photos(id) ON DELETE SET NULL,
      file_path TEXT,
      thumb_path TEXT,
      caption TEXT NOT NULL DEFAULT '',
      -- Things a reviewer wants the model to check for on this requirement.
      -- These are appended to the vision prompt, so they're training signal,
      -- not decoration.
      labels TEXT NOT NULL DEFAULT '[]',
      score INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'promoted',
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (field_hash, photo_id)
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pg_ex_field ON photoguard_examples(field_hash, is_primary DESC, score DESC)`)
}

// ─── Scoring ──────────────────────────────────────────────────────────

export interface ScoreInput {
  validationPassed: number | null
  validationConfidence: number | null
  reviewStatus: string | null
  megapixels: number
  hasExif: number | null
  hasGps: number | null
  gateStatus: string | null
}

/**
 * How good a candidate is as a reference image, 0-100.
 *
 * Deliberately weights HUMAN approval above model confidence: the model's
 * opinion is what we're trying to improve, so letting it pick its own teaching
 * examples would just entrench whatever it already believes.
 */
export function scoreCandidate(c: ScoreInput): number {
  if (c.gateStatus === 'blocked') return 0
  if (c.reviewStatus === 'rejected' || c.reviewStatus === 'resubmit') return 0
  if (c.validationPassed === 0 && c.reviewStatus !== 'approved') return 0

  let score = 0
  if (c.reviewStatus === 'approved') score += 45        // a human said yes
  else if (c.validationPassed === 1) score += 25        // only the model did

  score += Math.round((c.validationConfidence ?? 0) * 25)

  // Detail matters in a reference image; cap the reward so a 48MP photo of
  // nothing can't outrank a sharp 8MP photo of the right thing.
  score += Math.min(20, Math.round(c.megapixels * 2))

  if (c.hasExif === 1) score += 5
  if (c.hasGps === 1) score += 5

  return Math.max(0, Math.min(100, score))
}

// ─── Harvest ──────────────────────────────────────────────────────────

export interface HarvestReport {
  fieldsConsidered: number
  examplesCreated: number
  perField: Array<{ fieldHash: string; label: string; created: number; topScore: number }>
}

/**
 * Mine photos we already hold for the best example per requirement.
 *
 * The Arrivy back-catalogue is the useful source here — those photos were
 * accepted as real work, so they represent the standard in practice. Only
 * candidates that clear `minScore` are taken, so a requirement with nothing
 * good gets no example rather than a bad one.
 */
export function harvestExamples(opts: {
  formType?: string
  perField?: number
  minScore?: number
  createdBy?: string
} = {}): HarvestReport {
  ensureExampleSchema()
  const perField = Math.max(1, Math.min(opts.perField ?? 2, 5))
  const minScore = opts.minScore ?? 55

  const rows = db.prepare(`
    SELECT p.id, p.category_hash, p.category_label, p.form_type, p.file_path, p.thumb_path,
           p.validation_passed, p.validation_confidence, p.review_status,
           p.width, p.height, p.has_exif, p.has_gps, p.gate_status
    FROM photoguard_photos p
    WHERE p.category_hash IS NOT NULL
      AND p.file_path IS NOT NULL
      ${opts.formType ? 'AND p.form_type = @formType' : ''}
  `).all(opts.formType ? { formType: opts.formType } : {}) as Array<Record<string, unknown>>

  const byField = new Map<string, Array<{ row: Record<string, unknown>; score: number }>>()
  for (const r of rows) {
    const mp = (Number(r['width'] ?? 0) * Number(r['height'] ?? 0)) / 1_000_000
    const score = scoreCandidate({
      validationPassed: r['validation_passed'] as number | null,
      validationConfidence: r['validation_confidence'] as number | null,
      reviewStatus: r['review_status'] as string | null,
      megapixels: mp,
      hasExif: r['has_exif'] as number | null,
      hasGps: r['has_gps'] as number | null,
      gateStatus: r['gate_status'] as string | null,
    })
    if (score < minScore) continue
    const hash = String(r['category_hash'])
    const list = byField.get(hash) ?? []
    list.push({ row: r, score })
    byField.set(hash, list)
  }

  const insert = db.prepare(`
    INSERT INTO photoguard_examples
      (field_hash, form_type, photo_id, file_path, thumb_path, caption, labels, score, source, is_primary, created_by)
    VALUES (?, ?, ?, ?, ?, '', '[]', ?, 'harvested', ?, ?)
    ON CONFLICT(field_hash, photo_id) DO UPDATE SET score = excluded.score
  `)

  const report: HarvestReport = { fieldsConsidered: byField.size, examplesCreated: 0, perField: [] }
  const tx = db.transaction(() => {
    for (const [hash, list] of byField) {
      list.sort((a, b) => b.score - a.score)
      const take = list.slice(0, perField)
      // Only claim primary if a human hasn't already chosen one.
      const hasPrimary = db.prepare(
        `SELECT 1 FROM photoguard_examples WHERE field_hash = ? AND is_primary = 1`,
      ).get(hash)

      let created = 0
      take.forEach((c, i) => {
        const info = insert.run(
          hash, c.row['form_type'] ?? null, c.row['id'],
          c.row['file_path'], c.row['thumb_path'], c.score,
          !hasPrimary && i === 0 ? 1 : 0,
          opts.createdBy ?? 'harvest',
        )
        if (info.changes) created++
      })
      report.examplesCreated += created
      report.perField.push({
        fieldHash: hash,
        label: String(take[0]?.row['category_label'] ?? ''),
        created,
        topScore: take[0]?.score ?? 0,
      })
    }
  })
  tx()
  report.perField.sort((a, b) => b.topScore - a.topScore)
  return report
}

// ─── Read / write ─────────────────────────────────────────────────────

export function examplesFor(fieldHash: string): ExampleRow[] {
  ensureExampleSchema()
  return db.prepare(`
    SELECT * FROM photoguard_examples
    WHERE field_hash = ?
    ORDER BY is_primary DESC, score DESC, id
  `).all(fieldHash) as ExampleRow[]
}

/** Every requirement's primary example, for rendering a whole form at once. */
export function primaryExamples(formType: string): Record<string, { thumb: string | null; full: string | null; caption: string; labels: string[] }> {
  ensureExampleSchema()
  const rows = db.prepare(`
    SELECT field_hash, thumb_path, file_path, caption, labels,
           ROW_NUMBER() OVER (PARTITION BY field_hash ORDER BY is_primary DESC, score DESC, id) AS rn
    FROM photoguard_examples
    WHERE form_type = ? OR form_type IS NULL
  `).all(formType) as Array<Record<string, unknown>>

  const out: Record<string, { thumb: string | null; full: string | null; caption: string; labels: string[] }> = {}
  for (const r of rows) {
    if (Number(r['rn']) !== 1) continue
    let labels: string[] = []
    try { labels = JSON.parse(String(r['labels'] ?? '[]')) as string[] } catch { labels = [] }
    out[String(r['field_hash'])] = {
      thumb: (r['thumb_path'] as string | null) ?? null,
      full: (r['file_path'] as string | null) ?? null,
      caption: String(r['caption'] ?? ''),
      labels,
    }
  }
  return out
}

/**
 * Labels a reviewer has attached to this requirement's examples, deduped.
 * These go into the vision prompt — the mechanism by which a human teaches
 * the model what to watch for on a specific shot.
 */
export function labelsFor(fieldHash: string): string[] {
  ensureExampleSchema()
  const rows = db.prepare(
    `SELECT labels FROM photoguard_examples WHERE field_hash = ?`,
  ).all(fieldHash) as Array<{ labels: string }>
  const set = new Set<string>()
  for (const r of rows) {
    try {
      for (const l of JSON.parse(r.labels || '[]') as string[]) {
        const t = String(l).trim()
        if (t) set.add(t)
      }
    } catch { /* skip malformed */ }
  }
  return [...set]
}
