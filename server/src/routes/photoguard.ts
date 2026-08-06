// PhotoGuard — field photo capture, quality gating and AI validation.
//
// Arrivy is an IMPORT SOURCE ONLY. Field agents complete PhotoGuard forms
// inside this app: submissions, answers, photos and verdicts all live in our
// tables and nothing is written back to Arrivy. The /scan endpoint exists to
// pull historical Arrivy submissions in for review, not to depend on them.
//
// Feedback timing is the whole design constraint — an agent must never have to
// return to site. So an upload answers synchronously with deterministic gate
// results (resolution / EXIF / GPS / staleness / duplicate) and the slower
// vision verdict is pushed over SSE when it lands.
import { Router, type Request, type Response } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import sharp from 'sharp'
import db from '../db'
import { UPLOADS_DIR } from '../lib/upload'
import { arrivyConfigured, arrivyGet } from '../lib/arrivy'
import {
  ensurePhotoGuardFormSchema, getForm, findCategory, resolveRequirements,
  listRules, seedDefaultRules, describeDesign,
  resolveFormTokens, tokenContextFromProject, FORM_TYPES, arrivyFormIdFor,
  type PhotoGuardFormType,
} from '../lib/photoguardForms'
import { importArrivyForms, probeArrivyForms, ArrivyNotConfiguredError } from '../lib/arrivyFormImport'
import {
  extractMetadata, runQualityGates, gatesBlock, haversineMeters, GEOFENCE_METERS,
  perceptualHash, isNearDuplicate,
  type CaptureSource, type GateIssue,
} from '../lib/photoguardQuality'
import { assessSets, listSetAssessments, ensureSetSchema } from '../lib/photoguardSets'
import { ask as askAssessment, listMessages as listChat, ensureChatSchema, type ChatScope } from '../lib/photoguardChat'
import { classifyPhoto, buildCatalogue, decideFiling, parseClassification } from '../lib/photoguardClassify'
import {
  validatePhotoBuffer, visionConfigured, visionModel,
} from '../lib/photoguardVision'
import { attachPhotoGuardSseStream, publishPhotoGuardEvent } from '../lib/photoguardEvents'
import { OFFICE_TZ } from '../lib/officeTime'
import { runJobReview, listFindings, ensureReviewSchema } from '../lib/photoguardReview'
import {
  ensureExampleSchema, harvestExamples, examplesFor, primaryExamples, labelsFor, scoreCandidate,
} from '../lib/photoguardExamples'

export const photoguardRouter = Router()

const PHOTO_DIR = path.join(UPLOADS_DIR, 'photoguard')
const THUMB_DIR = path.join(PHOTO_DIR, 'thumbs')
fs.mkdirSync(PHOTO_DIR, { recursive: true })
fs.mkdirSync(THUMB_DIR, { recursive: true })

// Memory storage: we need the bytes for hashing, EXIF and the vision call
// before deciding where (or whether) to persist them.
const memUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|heic|heif)$/.test(file.mimetype)) cb(null, true)
    else cb(new Error(`Unsupported image type ${file.mimetype}`))
  },
})

// ─── Schema ───────────────────────────────────────────────────────────

function ensureSchema(): void {
  ensurePhotoGuardFormSchema()

  // Arrivy-imported tasks (review of historical field work).
  db.exec(`
    CREATE TABLE IF NOT EXISTS photoguard_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      arrivy_task_id TEXT NOT NULL UNIQUE,
      task_title TEXT, task_type TEXT, task_status TEXT,
      customer_name TEXT, crew_name TEXT, template_name TEXT,
      project_rid INTEGER, form_id TEXT, form_title TEXT,
      completed_at TEXT, scanned_at TEXT,
      total_photos INTEGER DEFAULT 0,
      passed_photos INTEGER DEFAULT 0,
      failed_photos INTEGER DEFAULT 0,
      pending_photos INTEGER DEFAULT 0,
      overall_status TEXT DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  // Native in-app form runs — the primary surface.
  db.exec(`
    CREATE TABLE IF NOT EXISTS photoguard_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      form_type TEXT NOT NULL,
      project_rid INTEGER,
      customer_name TEXT,
      status TEXT NOT NULL DEFAULT 'in_progress',
      started_by INTEGER REFERENCES users(id),
      started_by_name TEXT,
      site_lat REAL, site_lng REAL,
      submitted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  // Non-photo answers (dropdown / checklist / text / number).
  db.exec(`
    CREATE TABLE IF NOT EXISTS photoguard_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id INTEGER NOT NULL REFERENCES photoguard_submissions(id) ON DELETE CASCADE,
      field_hash TEXT NOT NULL,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (submission_id, field_hash)
    )
  `)

  // Photos. task_rowid is nullable (spec had it NOT NULL) because native
  // submissions, not Arrivy tasks, are now the main producer.
  db.exec(`
    CREATE TABLE IF NOT EXISTS photoguard_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_rowid INTEGER REFERENCES photoguard_tasks(id) ON DELETE CASCADE,
      submission_id INTEGER REFERENCES photoguard_submissions(id) ON DELETE CASCADE,
      arrivy_task_id TEXT,
      file_id TEXT NOT NULL UNIQUE,
      filename TEXT, category_label TEXT, category_hash TEXT,
      category_section TEXT, form_type TEXT,
      required INTEGER DEFAULT 1,
      file_path TEXT, thumb_path TEXT,
      file_size INTEGER, width INTEGER, height INTEGER,
      has_exif INTEGER, has_gps INTEGER,
      gps_lat REAL, gps_lng REAL,
      camera_make TEXT, camera_model TEXT, photo_timestamp TEXT,
      content_hash TEXT,
      -- Perceptual hash: catches the same SUBJECT reshot, which content_hash
      -- (exact bytes) never will.
      phash TEXT,
      -- Drop-mode classification: ranked candidate requirements, and whether a
      -- human still needs to file it.
      classification TEXT,
      classify_confidence REAL,
      needs_filing INTEGER NOT NULL DEFAULT 0,
      filed_by TEXT,
      capture_source TEXT,
      captured_by INTEGER REFERENCES users(id),
      captured_by_name TEXT,
      metadata_issues TEXT,
      gate_status TEXT,
      validation_status TEXT DEFAULT 'pending',
      validation_passed INTEGER, validation_confidence REAL,
      validation_issues TEXT, validation_description TEXT,
      validation_model TEXT, validation_time_ms INTEGER,
      validation_error TEXT,
      validated_at TEXT,
      review_status TEXT, reviewer TEXT, review_note TEXT, reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  // Connectivity evidence. "There was no signal" is otherwise unfalsifiable;
  // this makes it checkable in both directions.
  db.exec(`
    CREATE TABLE IF NOT EXISTS photoguard_connectivity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id INTEGER NOT NULL REFERENCES photoguard_submissions(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id),
      user_name TEXT,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      online INTEGER NOT NULL DEFAULT 1,
      rtt_ms INTEGER,
      throughput_kbps INTEGER,
      effective_type TEXT,
      downlink_mbps REAL,
      bytes INTEGER,
      lat REAL, lng REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pg_conn_sub ON photoguard_connectivity(submission_id, at)`)

  db.exec(`CREATE INDEX IF NOT EXISTS idx_pg_photos_task ON photoguard_photos(task_rowid)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pg_photos_sub ON photoguard_photos(submission_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pg_photos_val ON photoguard_photos(validation_status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pg_photos_rev ON photoguard_photos(review_status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pg_photos_hash ON photoguard_photos(content_hash)`)
  {
    const cols = db.prepare(`PRAGMA table_info(photoguard_photos)`).all() as Array<{ name: string }>
    const has = (n: string) => cols.some(c => c.name === n)
    if (!has('phash')) db.exec(`ALTER TABLE photoguard_photos ADD COLUMN phash TEXT`)
    if (!has('classification')) db.exec(`ALTER TABLE photoguard_photos ADD COLUMN classification TEXT`)
    if (!has('classify_confidence')) db.exec(`ALTER TABLE photoguard_photos ADD COLUMN classify_confidence REAL`)
    if (!has('needs_filing')) db.exec(`ALTER TABLE photoguard_photos ADD COLUMN needs_filing INTEGER NOT NULL DEFAULT 0`)
    if (!has('filed_by')) db.exec(`ALTER TABLE photoguard_photos ADD COLUMN filed_by TEXT`)
  }
  ensureReviewSchema()
  ensureExampleSchema()
  ensureSetSchema()
  ensureChatSchema()
  seedDefaultRules()
}
ensureSchema()

// ─── Helpers ──────────────────────────────────────────────────────────

function actorName(req: Request): string {
  const email = req.user?.email ?? 'unknown'
  const row = db.prepare(`SELECT name FROM users WHERE id = ?`).get(req.user?.userId ?? 0) as
    | { name: string } | undefined
  return row?.name || email
}

function isFormType(v: string): v is PhotoGuardFormType {
  return (FORM_TYPES as string[]).includes(v)
}

function projectFor(rid: number | null | undefined): Record<string, unknown> | null {
  if (!rid) return null
  const row = db.prepare(`SELECT * FROM project_cache WHERE record_id = ?`).get(rid)
  return (row as Record<string, unknown>) ?? null
}

/**
 * Where the job actually is.
 *
 * project_cache carries real coordinates for 10,554 of 10,591 projects, so the
 * geofence anchors on the PROPERTY, not on wherever the phone happened to be
 * when the survey was opened. That distinction matters: crews upload from the
 * camera roll after the fact — on the drive home, or next morning — and a
 * device-derived anchor would have measured the photo against their kitchen.
 * The submission's own site_lat/site_lng is only a fallback for jobs with no
 * project attached.
 */
function siteCoordsFor(sub: Record<string, unknown> | undefined): { lat: number | null; lng: number | null } {
  const project = projectFor(sub?.['project_rid'] as number | null | undefined)
  const pLat = project?.['lat'] != null ? Number(project['lat']) : NaN
  const pLng = project?.['lng'] != null ? Number(project['lng']) : NaN
  if (Number.isFinite(pLat) && Number.isFinite(pLng) && !(pLat === 0 && pLng === 0)) {
    return { lat: pLat, lng: pLng }
  }
  return {
    lat: sub?.['site_lat'] != null ? Number(sub['site_lat']) : null,
    lng: sub?.['site_lng'] != null ? Number(sub['site_lng']) : null,
  }
}

/** Answers on a submission as hash → value, for answer-driven rules.
 *  Arrays are flattened to a comma list so `contains` works on multi-selects. */
function answerMap(submissionId: number | null | undefined): Map<string, string> {
  const m = new Map<string, string>()
  if (!submissionId) return m
  const rows = db.prepare(
    `SELECT field_hash, value FROM photoguard_answers WHERE submission_id = ?`,
  ).all(submissionId) as Array<{ field_hash: string; value: string | null }>
  for (const r of rows) {
    if (r.value == null) continue
    let v: unknown = r.value
    try { v = JSON.parse(r.value) } catch { /* plain string */ }
    m.set(r.field_hash, Array.isArray(v) ? v.join(', ') : String(v ?? ''))
  }
  return m
}

/** Photos whose bytes are already on this submission — powers duplicate detection. */
function knownHashes(submissionId: number | null): Set<string> {
  if (!submissionId) return new Set()
  const rows = db.prepare(
    `SELECT content_hash FROM photoguard_photos WHERE submission_id = ? AND content_hash IS NOT NULL`,
  ).all(submissionId) as Array<{ content_hash: string }>
  return new Set(rows.map(r => r.content_hash))
}

function recountTask(taskRowId: number): void {
  db.prepare(`
    UPDATE photoguard_tasks SET
      total_photos  = (SELECT COUNT(*) FROM photoguard_photos WHERE task_rowid = ?),
      passed_photos = (SELECT COUNT(*) FROM photoguard_photos WHERE task_rowid = ? AND validation_passed = 1),
      failed_photos = (SELECT COUNT(*) FROM photoguard_photos WHERE task_rowid = ? AND validation_passed = 0 AND validation_status = 'done'),
      pending_photos= (SELECT COUNT(*) FROM photoguard_photos WHERE task_rowid = ? AND validation_status != 'done'),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(taskRowId, taskRowId, taskRowId, taskRowId, taskRowId)
}

// ─── Async validation queue ───────────────────────────────────────────
//
// Bounded concurrency: a 100-photo Arrivy scan must not open 100 sockets to
// the vision endpoint, and an agent's live upload should still get through
// promptly. Small pool, FIFO.

const MAX_CONCURRENT = Number(process.env['PHOTOGUARD_VISION_CONCURRENCY'] || 3)
let active = 0
const queue: Array<() => Promise<void>> = []

function pump(): void {
  while (active < MAX_CONCURRENT && queue.length) {
    const job = queue.shift()!
    active++
    job().catch(() => { /* job handles its own errors */ }).finally(() => {
      active--
      pump()
    })
  }
}

function enqueueValidation(photoId: number): void {
  queue.push(() => validateStoredPhoto(photoId))
  pump()
}

/**
 * Re-queue work stranded by a restart.
 *
 * The queue is in-process, so a deploy or crash mid-scan leaves photos sitting
 * at 'pending' (or 'running') with nothing left to pick them up — they'd stay
 * unvalidated forever, silently. A bulk Arrivy import makes that near-certain,
 * since it can queue hundreds of minutes of work. Runs once at startup,
 * bounded so a huge backlog doesn't stampede the vision endpoint on boot.
 */
export function resumePendingValidations(limit = 500): number {
  const rows = db.prepare(`
    SELECT id FROM photoguard_photos
    WHERE validation_status IN ('pending', 'running')
      AND gate_status != 'blocked'
      AND file_path IS NOT NULL
    ORDER BY created_at
    LIMIT ?
  `).all(limit) as Array<{ id: number }>
  for (const r of rows) enqueueValidation(r.id)
  if (rows.length) console.log(`[photoguard] resumed ${rows.length} pending validation(s)`)
  return rows.length
}

/**
 * Run the vision model against a stored photo and record the verdict.
 * A transport/config failure leaves the photo 'pending' with the reason
 * recorded — never 'failed'. An outage must not mass-fail a crew's work.
 */
async function validateStoredPhoto(photoId: number): Promise<void> {
  const p = db.prepare(`
    SELECT ph.id, ph.file_path, ph.category_label, ph.category_hash,
           ph.task_rowid, ph.submission_id,
           COALESCE(s.project_rid, t.project_rid) AS project_rid
    FROM photoguard_photos ph
    LEFT JOIN photoguard_submissions s ON s.id = ph.submission_id
    LEFT JOIN photoguard_tasks t ON t.id = ph.task_rowid
    WHERE ph.id = ?
  `).get(photoId) as
    | { id: number; file_path: string; category_label: string | null; category_hash: string | null; task_rowid: number | null; submission_id: number | null; project_rid: number | null }
    | undefined
  if (!p) return

  if (!visionConfigured()) {
    db.prepare(`
      UPDATE photoguard_photos
      SET validation_status = 'pending', validation_error = 'Vision model not configured (OLLAMA_API_KEY)'
      WHERE id = ?
    `).run(photoId)
    publishPhotoGuardEvent({
      type: 'photo_validated', photoId,
      status: 'pending', message: 'Vision model not configured',
    })
    return
  }

  const abs = path.join(PHOTO_DIR, path.basename(p.file_path || ''))
  let buf: Buffer
  try {
    buf = await fs.promises.readFile(abs)
  } catch {
    db.prepare(`UPDATE photoguard_photos SET validation_status='pending', validation_error='File missing on disk' WHERE id=?`).run(photoId)
    return
  }

  const cat = p.category_hash ? findCategory(p.category_hash) : null
  const label = p.category_label || cat?.label || 'Unspecified'
  // Labels a reviewer attached to this requirement's examples are the
  // mechanism for teaching the model what to watch for on this specific shot.
  const taught = p.category_hash ? labelsFor(p.category_hash) : []
  const hints = [cat?.hints || '', taught.length ? `Reviewers specifically check for: ${taught.join('; ')}.` : '']
    .filter(Boolean).join(' ')

  db.prepare(`UPDATE photoguard_photos SET validation_status='running' WHERE id=?`).run(photoId)

  // The design comes from Quickbase via project_cache — it lets the model
  // flag equipment that doesn't match what was sold.
  const design = describeDesign(projectFor(p.project_rid))

  // Position within the set, so the model knows this is one of several.
  let group: { collective: boolean; expectedCount?: number | null; position?: number | null; total?: number | null } | undefined
  if (cat?.collective && p.category_hash) {
    const sibs = db.prepare(`
      SELECT id FROM photoguard_photos
      WHERE category_hash = ?
        AND ((submission_id IS NOT NULL AND submission_id = ?) OR (task_rowid IS NOT NULL AND task_rowid = ?))
      ORDER BY created_at
    `).all(p.category_hash, p.submission_id, p.task_rowid) as Array<{ id: number }>
    const idx = sibs.findIndex(x => x.id === p.id)
    group = {
      collective: true,
      expectedCount: cat.expectedCount,
      position: idx >= 0 ? idx + 1 : null,
      total: sibs.length || null,
    }
  }

  try {
    const r = await validatePhotoBuffer(buf, label, hints, design?.text, group)
    db.prepare(`
      UPDATE photoguard_photos SET
        validation_status='done', validation_passed=?, validation_confidence=?,
        validation_issues=?, validation_description=?, validation_model=?,
        validation_time_ms=?, validation_error=NULL, validated_at=datetime('now')
      WHERE id=?
    `).run(
      r.passed ? 1 : 0, r.confidence, JSON.stringify(r.issues),
      r.description, r.model, r.timeMs, photoId,
    )
    if (p.task_rowid) recountTask(p.task_rowid)
    publishPhotoGuardEvent({
      type: 'photo_validated', photoId,
      status: r.passed ? 'passed' : 'failed',
      data: {
        passed: r.passed, confidence: r.confidence, issues: r.issues,
        description: r.description, submissionId: p.submission_id,
        categoryHash: p.category_hash, timeMs: r.timeMs,
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    db.prepare(`
      UPDATE photoguard_photos SET validation_status='pending', validation_error=? WHERE id=?
    `).run(msg.slice(0, 500), photoId)
    publishPhotoGuardEvent({
      type: 'photo_validated', photoId, status: 'error', message: msg.slice(0, 200),
      data: { submissionId: p.submission_id, categoryHash: p.category_hash },
    })
  }
}

// Deliberately deferred: startup already does a lot, and this can enqueue
// hundreds of jobs.
setTimeout(() => {
  try { resumePendingValidations() }
  catch (e) { console.error('[photoguard] resume failed:', e) }
}, 8000).unref?.()

// ─── Forms ────────────────────────────────────────────────────────────

photoguardRouter.get('/forms/:formType', (req: Request, res: Response) => {
  const ft = String(req.params['formType'] ?? '')
  const form = getForm(ft)
  if (!form) {
    res.status(404).json({
      error: `No stored form '${ft}'. Run POST /api/photoguard/forms/import/arrivy to import it.`,
    })
    return
  }
  const rid = req.query['project'] ? Number(req.query['project']) : null
  const project = projectFor(rid)
  // When the caller names its submission, answer-driven rules can apply —
  // this is what makes a method choice reveal its extra requirements.
  const subId = req.query['submission'] ? Number(req.query['submission']) : null
  const resolved = resolveRequirements(ft, project, answerMap(subId))
  const examples = primaryExamples(ft)

  const tokens = tokenContextFromProject(project)
  res.json({
    ...form,
    projectRid: rid,
    design: describeDesign(project),
    examples,
    fields: form.fields.map(f => {
      // Arrivy leaves {{customer_name}}-style placeholders in its text for
      // its own renderer to fill; we're the renderer now.
      const withTokens = { ...f, label: resolveFormTokens(f.label, tokens) }
      const r = resolved.get(f.hash)
      return r && f.fieldType === 'photo'
        ? { ...withTokens, required: r.required, requiredBase: r.base, requiredReasons: r.reasons }
        : withTokens
    }),
  })
})

photoguardRouter.post('/forms/import/arrivy', async (req: Request, res: Response) => {
  const only = req.query['formType'] ? String(req.query['formType']) : undefined
  if (only && !isFormType(only)) { res.status(400).json({ error: `Unknown formType '${only}'` }); return }
  try {
    const reports = await importArrivyForms(only as PhotoGuardFormType | undefined)
    publishPhotoGuardEvent({ type: 'form_imported', data: { reports } })
    res.json({ ok: true, reports })
  } catch (e) {
    if (e instanceof ArrivyNotConfiguredError) { res.status(503).json({ error: e.message }); return }
    res.status(502).json({ error: e instanceof Error ? e.message : 'Import failed' })
  }
})

photoguardRouter.get('/arrivy/probe', async (_req: Request, res: Response) => {
  try {
    const forms = await probeArrivyForms()
    res.json({
      configured: true,
      mapped: FORM_TYPES.map(ft => ({ formType: ft, arrivyFormId: arrivyFormIdFor(ft) })),
      forms,
    })
  } catch (e) {
    if (e instanceof ArrivyNotConfiguredError) { res.status(503).json({ configured: false, error: e.message }); return }
    res.status(502).json({ error: e instanceof Error ? e.message : 'Probe failed' })
  }
})

// ─── Requirement rules ────────────────────────────────────────────────

photoguardRouter.get('/requirement-rules', (req: Request, res: Response) => {
  const ft = req.query['formType'] ? String(req.query['formType']) : undefined
  res.json({ rules: listRules(ft) })
})

photoguardRouter.post('/requirement-rules', (req: Request, res: Response) => {
  const b = req.body as Record<string, unknown>
  const name = String(b['name'] ?? '').trim()
  if (!name) { res.status(400).json({ error: 'name is required' }); return }
  const info = db.prepare(`
    INSERT INTO photoguard_requirement_rules
      (name, form_type, condition_type, condition_field, condition_op, condition_value,
       target_hashes, target_sections, effect, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    b['formType'] ? String(b['formType']) : null,
    String(b['conditionType'] ?? 'attribute'),
    String(b['conditionField'] ?? ''),
    String(b['conditionOp'] ?? 'nonempty'),
    b['conditionValue'] != null ? String(b['conditionValue']) : null,
    JSON.stringify(b['targetHashes'] ?? []),
    JSON.stringify(b['targetSections'] ?? []),
    String(b['effect'] ?? 'require'),
    b['active'] === false ? 0 : 1,
  )
  res.status(201).json({ id: info.lastInsertRowid })
})

// ─── Submissions (native form runtime) ────────────────────────────────

photoguardRouter.post('/submissions', (req: Request, res: Response) => {
  const b = req.body as Record<string, unknown>
  const formType = String(b['formType'] ?? '')
  if (!isFormType(formType)) { res.status(400).json({ error: `Unknown formType '${formType}'` }); return }
  if (!getForm(formType)) {
    res.status(409).json({ error: `Form '${formType}' not imported yet — run the Arrivy import first.` })
    return
  }
  const rid = b['projectRid'] != null ? Number(b['projectRid']) : null
  const project = projectFor(rid)

  // One checkout per job, not per person. A roof tech and an electrician
  // working the same install join the SAME submission so they fill different
  // sections of one form and can both see what's still outstanding. Photos
  // carry their own captured_by, so attribution survives the sharing.
  if (rid) {
    const existing = db.prepare(`
      SELECT id FROM photoguard_submissions
      WHERE project_rid = ? AND form_type = ? AND status = 'in_progress'
      ORDER BY id LIMIT 1
    `).get(rid, formType) as { id: number } | undefined
    if (existing) {
      res.status(200).json({ id: existing.id, formType, projectRid: rid, joined: true })
      return
    }
  }

  const info = db.prepare(`
    INSERT INTO photoguard_submissions
      (form_type, project_rid, customer_name, started_by, started_by_name, site_lat, site_lng)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    formType, rid,
    (project?.['customer_name'] as string) ?? null,
    req.user?.userId ?? null, actorName(req),
    b['siteLat'] != null ? Number(b['siteLat']) : null,
    b['siteLng'] != null ? Number(b['siteLng']) : null,
  )
  res.status(201).json({ id: info.lastInsertRowid, formType, projectRid: rid, joined: false })
})

/**
 * Jobs scheduled around today, as one-tap entry points.
 *
 * Reads project_cache (already synced from Quickbase) rather than Arrivy, so
 * the list works whether or not Arrivy is reachable. Each job reports any
 * in-progress submission and its progress, so a second trade arriving later
 * sees "Resume · 12/34" instead of starting a duplicate.
 */
photoguardRouter.get('/jobs', (req: Request, res: Response) => {
  const days = Math.min(Math.max(Number(req.query['days'] ?? 1), 0), 30)
  const kind = String(req.query['kind'] ?? 'install')
  const column = kind === 'survey' ? 'survey_scheduled' : 'install_scheduled'
  const formType: PhotoGuardFormType = kind === 'survey' ? 'site_survey' : 'install_checkout'

  const rows = db.prepare(`
    SELECT record_id, customer_name, customer_address, lat, lng,
           ${column} AS scheduled, status, system_size_kw, coordinator
    FROM project_cache
    WHERE ${column} IS NOT NULL
      AND date(${column}) BETWEEN date('now', ?) AND date('now', ?)
    ORDER BY date(${column}), customer_name
    LIMIT 200
  `).all(`-${days} day`, `+${days} day`) as Array<Record<string, unknown>>

  const subStmt = db.prepare(`
    SELECT id, status,
      (SELECT COUNT(*) FROM photoguard_photos p WHERE p.submission_id = s.id) AS photos,
      (SELECT COUNT(DISTINCT captured_by_name) FROM photoguard_photos p WHERE p.submission_id = s.id) AS contributors
    FROM photoguard_submissions s
    WHERE s.project_rid = ? AND s.form_type = ?
    ORDER BY (s.status = 'in_progress') DESC, s.id DESC LIMIT 1
  `)

  const jobs = rows.map(r => {
    const sub = subStmt.get(r['record_id'], formType) as
      | { id: number; status: string; photos: number; contributors: number } | undefined
    return {
      projectRid: r['record_id'],
      customerName: r['customer_name'],
      customerAddress: r['customer_address'],
      scheduled: r['scheduled'],
      status: r['status'],
      systemSizeKw: r['system_size_kw'],
      coordinator: r['coordinator'],
      hasCoords: r['lat'] != null && r['lng'] != null,
      formType,
      submission: sub ?? null,
    }
  })
  res.json({ kind, formType, days, jobs })
})

photoguardRouter.get('/submissions', (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query['limit'] ?? 50), 200)
  const rows = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM photoguard_photos p WHERE p.submission_id = s.id) AS photo_count,
      (SELECT COUNT(*) FROM photoguard_photos p WHERE p.submission_id = s.id AND p.validation_passed = 1) AS passed_count
    FROM photoguard_submissions s
    ORDER BY s.updated_at DESC LIMIT ?
  `).all(limit)
  res.json({ submissions: rows })
})

photoguardRouter.get('/submissions/:id', (req: Request, res: Response) => {
  const id = Number(req.params['id'])
  const sub = db.prepare(`SELECT * FROM photoguard_submissions WHERE id = ?`).get(id) as
    | Record<string, unknown> | undefined
  if (!sub) { res.status(404).json({ error: 'Submission not found' }); return }

  const answers = db.prepare(`SELECT field_hash, value FROM photoguard_answers WHERE submission_id = ?`).all(id)
  const photos = db.prepare(`
    SELECT * FROM photoguard_photos WHERE submission_id = ? ORDER BY created_at
  `).all(id)
  const project = projectFor(sub['project_rid'] as number | null)
  const resolved = resolveRequirements(String(sub['form_type']), project, answerMap(id))

  // Who has contributed, so the crew can see each other working.
  const contributors = db.prepare(`
    SELECT captured_by_name AS name, COUNT(*) AS photos, MAX(created_at) AS last_at
    FROM photoguard_photos
    WHERE submission_id = ? AND captured_by_name IS NOT NULL
    GROUP BY captured_by_name ORDER BY photos DESC
  `).all(id)

  // Completion measured on APPROVED requirements, not captured ones: a photo
  // that exists but failed its check is not progress.
  const requiredHashes = [...resolved.entries()].filter(([, r]) => r.required).map(([h]) => h)
  const passingByHash = new Set(
    (photos as Array<Record<string, unknown>>)
      .filter(p =>
        p['review_status'] === 'approved' ||
        (p['review_status'] == null && p['gate_status'] !== 'blocked' && p['validation_passed'] === 1))
      .map(p => String(p['category_hash'] ?? '')),
  )
  const approvedRequired = requiredHashes.filter(h => passingByHash.has(h)).length
  const progress = {
    requiredTotal: requiredHashes.length,
    requiredApproved: approvedRequired,
    percentApproved: requiredHashes.length
      ? Math.round((approvedRequired / requiredHashes.length) * 100) : 0,
  }

  res.json({
    submission: sub,
    answers,
    photos,
    progress,
    contributors,
    site: siteCoordsFor(sub),
    design: describeDesign(project),
    requirements: Object.fromEntries(resolved),
  })
})

/**
 * Anchor the site coordinates.
 *
 * A survey often starts before location permission is granted, which used to
 * leave site_lat/site_lng null forever — and a null anchor means the geofence
 * silently never runs. The form posts here as soon as it gets a fix.
 *
 * First good fix wins: later readings drift as the agent walks the property,
 * and re-anchoring mid-survey would move the fence under photos already taken.
 * Pass `force` to deliberately re-anchor.
 */
photoguardRouter.post('/submissions/:id/site', (req: Request, res: Response) => {
  const id = Number(req.params['id'])
  const b = req.body as Record<string, unknown>
  const lat = b['siteLat'] != null ? Number(b['siteLat']) : NaN
  const lng = b['siteLng'] != null ? Number(b['siteLng']) : NaN
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    res.status(400).json({ error: 'siteLat and siteLng are required' })
    return
  }
  const sub = db.prepare(`SELECT site_lat, site_lng FROM photoguard_submissions WHERE id = ?`)
    .get(id) as { site_lat: number | null; site_lng: number | null } | undefined
  if (!sub) { res.status(404).json({ error: 'Submission not found' }); return }

  const alreadyAnchored = sub.site_lat != null && sub.site_lng != null
  if (alreadyAnchored && b['force'] !== true) {
    res.json({ ok: true, anchored: false, siteLat: sub.site_lat, siteLng: sub.site_lng })
    return
  }
  db.prepare(`
    UPDATE photoguard_submissions
    SET site_lat = ?, site_lng = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(lat, lng, id)
  res.json({ ok: true, anchored: true, siteLat: lat, siteLng: lng })
})

photoguardRouter.patch('/submissions/:id/answers', (req: Request, res: Response) => {
  const id = Number(req.params['id'])
  const b = req.body as { answers?: Array<{ fieldHash: string; value: unknown }> }
  const list = Array.isArray(b.answers) ? b.answers : []
  const stmt = db.prepare(`
    INSERT INTO photoguard_answers (submission_id, field_hash, value, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(submission_id, field_hash) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `)
  const tx = db.transaction(() => {
    for (const a of list) {
      if (!a?.fieldHash) continue
      stmt.run(id, String(a.fieldHash), a.value == null ? null : JSON.stringify(a.value))
    }
    db.prepare(`UPDATE photoguard_submissions SET updated_at = datetime('now') WHERE id = ?`).run(id)
  })
  tx()
  res.json({ ok: true, saved: list.length })
})

/** Completeness check + submit. Refuses while required photos are missing or
 *  hard-failing — that refusal is the whole point of the feature. */
photoguardRouter.post('/submissions/:id/submit', (req: Request, res: Response) => {
  const id = Number(req.params['id'])
  const sub = db.prepare(`SELECT * FROM photoguard_submissions WHERE id = ?`).get(id) as
    | Record<string, unknown> | undefined
  if (!sub) { res.status(404).json({ error: 'Submission not found' }); return }

  const formType = String(sub['form_type'])
  const form = getForm(formType)
  if (!form) { res.status(409).json({ error: 'Form definition missing' }); return }

  const resolved = resolveRequirements(formType, projectFor(sub['project_rid'] as number | null), answerMap(id))
  const photos = db.prepare(`
    SELECT category_hash, gate_status, validation_passed, review_status
    FROM photoguard_photos WHERE submission_id = ?
  `).all(id) as Array<{ category_hash: string | null; gate_status: string | null; validation_passed: number | null; review_status: string | null }>

  const byHash = new Map<string, typeof photos>()
  for (const p of photos) {
    if (!p.category_hash) continue
    const list = byHash.get(p.category_hash) ?? []
    list.push(p)
    byHash.set(p.category_hash, list)
  }

  const missing: Array<{ hash: string; label: string; reason: string }> = []
  for (const f of form.fields) {
    if (f.fieldType !== 'photo') continue
    const req_ = resolved.get(f.hash)?.required ?? f.required
    if (!req_) continue
    const got = byHash.get(f.hash) ?? []
    const usable = got.filter(p =>
      p.gate_status !== 'blocked' &&
      p.review_status !== 'rejected' &&
      p.review_status !== 'resubmit')
    if (!usable.length) {
      missing.push({
        hash: f.hash, label: f.label,
        reason: got.length ? 'all photos for this item failed quality gates' : 'no photo captured',
      })
    }
  }

  if (missing.length && req.body?.force !== true) {
    res.status(422).json({ error: 'Required photos are missing or unusable', missing })
    return
  }

  db.prepare(`
    UPDATE photoguard_submissions
    SET status = ?, submitted_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(missing.length ? 'submitted_with_gaps' : 'submitted', id)

  publishPhotoGuardEvent({ type: 'scan_complete', data: { submissionId: id, gaps: missing.length } })
  res.json({ ok: true, submitted: true, gaps: missing })
})

/** Tiny endpoint whose only job is to be round-tripped for an RTT reading. */
photoguardRouter.get('/ping', (_req: Request, res: Response) => {
  res.json({ t: Date.now() })
})

/**
 * Record connectivity samples for a job.
 *
 * Batched, because reporting one-at-a-time over a bad link is self-defeating.
 * Samples are observations, not assertions of fault — they exonerate a crew
 * that genuinely had no service just as often as they contradict one.
 */
photoguardRouter.post('/submissions/:id/connectivity', (req: Request, res: Response) => {
  const id = Number(req.params['id'])
  const exists = db.prepare(`SELECT 1 FROM photoguard_submissions WHERE id = ?`).get(id)
  if (!exists) { res.status(404).json({ error: 'Submission not found' }); return }

  const b = req.body as { samples?: Array<Record<string, unknown>> }
  const list = Array.isArray(b.samples) ? b.samples.slice(0, 200) : []
  const stmt = db.prepare(`
    INSERT INTO photoguard_connectivity
      (submission_id, user_id, user_name, at, kind, online, rtt_ms, throughput_kbps,
       effective_type, downlink_mbps, bytes, lat, lng)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const name = actorName(req)
  const tx = db.transaction(() => {
    for (const s of list) {
      stmt.run(
        id, req.user?.userId ?? null, name,
        String(s['at'] ?? new Date().toISOString()),
        String(s['kind'] ?? 'ping'),
        s['online'] === false ? 0 : 1,
        s['rttMs'] != null ? Number(s['rttMs']) : null,
        s['throughputKbps'] != null ? Number(s['throughputKbps']) : null,
        s['effectiveType'] != null ? String(s['effectiveType']) : null,
        s['downlinkMbps'] != null ? Number(s['downlinkMbps']) : null,
        s['bytes'] != null ? Number(s['bytes']) : null,
        s['lat'] != null ? Number(s['lat']) : null,
        s['lng'] != null ? Number(s['lng']) : null,
      )
    }
  })
  tx()
  res.json({ ok: true, recorded: list.length })
})

/** Connectivity summary for a job — what the network was doing on site. */
photoguardRouter.get('/submissions/:id/connectivity', (req: Request, res: Response) => {
  const id = Number(req.params['id'])
  const samples = db.prepare(`
    SELECT * FROM photoguard_connectivity WHERE submission_id = ? ORDER BY at
  `).all(id) as Array<Record<string, unknown>>

  const online = samples.filter(s => s['online'] === 1)
  const rtts = online.map(s => s['rtt_ms']).filter((v): v is number => typeof v === 'number')
  const thr = online.map(s => s['throughput_kbps']).filter((v): v is number => typeof v === 'number')
  const median = (xs: number[]): number | null => {
    if (!xs.length) return null
    const a = [...xs].sort((p, q) => p - q)
    return a[Math.floor(a.length / 2)] ?? null
  }

  res.json({
    samples,
    summary: {
      total: samples.length,
      offlineSamples: samples.length - online.length,
      medianRttMs: median(rtts),
      medianThroughputKbps: median(thr),
      bestThroughputKbps: thr.length ? Math.max(...thr) : null,
      firstAt: samples[0]?.['at'] ?? null,
      lastAt: samples[samples.length - 1]?.['at'] ?? null,
    },
  })
})

// ─── Reference examples ───────────────────────────────────────────────

photoguardRouter.get('/examples/:fieldHash', (req: Request, res: Response) => {
  res.json({ examples: examplesFor(String(req.params['fieldHash'])) })
})

/** Promote an existing photo to be the reference for its requirement. */
photoguardRouter.post('/examples', (req: Request, res: Response) => {
  const b = req.body as Record<string, unknown>
  const photoId = Number(b['photoId'])
  const p = db.prepare(`
    SELECT id, category_hash, form_type, file_path, thumb_path, width, height,
           validation_passed, validation_confidence, review_status, has_exif, has_gps, gate_status
    FROM photoguard_photos WHERE id = ?
  `).get(photoId) as Record<string, unknown> | undefined
  if (!p) { res.status(404).json({ error: 'Photo not found' }); return }
  if (!p['category_hash']) { res.status(400).json({ error: 'Photo has no requirement attached' }); return }

  const labels = Array.isArray(b['labels']) ? (b['labels'] as unknown[]).map(String) : []
  const score = scoreCandidate({
    validationPassed: p['validation_passed'] as number | null,
    validationConfidence: p['validation_confidence'] as number | null,
    reviewStatus: p['review_status'] as string | null,
    megapixels: (Number(p['width'] ?? 0) * Number(p['height'] ?? 0)) / 1_000_000,
    hasExif: p['has_exif'] as number | null,
    hasGps: p['has_gps'] as number | null,
    gateStatus: p['gate_status'] as string | null,
  })
  const hash = String(p['category_hash'])
  const makePrimary = b['primary'] !== false

  const tx = db.transaction(() => {
    if (makePrimary) {
      db.prepare(`UPDATE photoguard_examples SET is_primary = 0 WHERE field_hash = ?`).run(hash)
    }
    db.prepare(`
      INSERT INTO photoguard_examples
        (field_hash, form_type, photo_id, file_path, thumb_path, caption, labels, score, source, is_primary, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'promoted', ?, ?)
      ON CONFLICT(field_hash, photo_id) DO UPDATE SET
        caption = excluded.caption, labels = excluded.labels,
        score = excluded.score, is_primary = excluded.is_primary, source = 'promoted'
    `).run(hash, p['form_type'] ?? null, photoId, p['file_path'], p['thumb_path'],
      String(b['caption'] ?? ''), JSON.stringify(labels), score, makePrimary ? 1 : 0, actorName(req))
  })
  tx()
  res.status(201).json({ ok: true, fieldHash: hash, score })
})

/** Edit the caption/labels on an example. Labels are the training signal — they
 *  are injected into the vision prompt for this requirement. */
photoguardRouter.patch('/examples/:id', (req: Request, res: Response) => {
  const id = Number(req.params['id'])
  const b = req.body as Record<string, unknown>
  const row = db.prepare(`SELECT field_hash FROM photoguard_examples WHERE id = ?`).get(id) as
    | { field_hash: string } | undefined
  if (!row) { res.status(404).json({ error: 'Example not found' }); return }

  if (b['primary'] === true) {
    db.prepare(`UPDATE photoguard_examples SET is_primary = 0 WHERE field_hash = ?`).run(row.field_hash)
  }
  db.prepare(`
    UPDATE photoguard_examples SET
      caption = COALESCE(?, caption),
      labels = COALESCE(?, labels),
      is_primary = CASE WHEN ? THEN 1 ELSE is_primary END
    WHERE id = ?
  `).run(
    b['caption'] != null ? String(b['caption']) : null,
    Array.isArray(b['labels']) ? JSON.stringify((b['labels'] as unknown[]).map(String)) : null,
    b['primary'] === true ? 1 : 0,
    id,
  )
  res.json({ ok: true })
})

photoguardRouter.delete('/examples/:id', (req: Request, res: Response) => {
  db.prepare(`DELETE FROM photoguard_examples WHERE id = ?`).run(Number(req.params['id']))
  res.json({ ok: true })
})

/** Bulk-seed examples from photos already held, including the Arrivy
 *  back-catalogue pulled in by /scan. */
photoguardRouter.post('/examples/harvest', (req: Request, res: Response) => {
  const report = harvestExamples({
    formType: req.query['formType'] ? String(req.query['formType']) : undefined,
    perField: req.query['perField'] ? Number(req.query['perField']) : undefined,
    minScore: req.query['minScore'] ? Number(req.query['minScore']) : undefined,
    createdBy: actorName(req),
  })
  res.json(report)
})

// ─── Drop mode ────────────────────────────────────────────────────────
//
// Photos are dropped without choosing a requirement first; the app works out
// what each one is. Filing is automatic only when one candidate clearly wins —
// a wrong auto-file marks a requirement satisfied by evidence that doesn't
// show it, and nobody looks again.

/** What's satisfied and what's still outstanding, for the live checklist. */
photoguardRouter.get('/outstanding/:submissionId', (req: Request, res: Response) => {
  const id = Number(req.params['submissionId'])
  const sub = db.prepare(`SELECT * FROM photoguard_submissions WHERE id = ?`).get(id) as
    | Record<string, unknown> | undefined
  if (!sub) { res.status(404).json({ error: 'Submission not found' }); return }

  const formType = String(sub['form_type'])
  const form = getForm(formType)
  if (!form) { res.status(409).json({ error: 'Form not imported' }); return }

  const resolved = resolveRequirements(formType, projectFor(sub['project_rid'] as number | null), answerMap(id))
  const photos = db.prepare(`
    SELECT category_hash, validation_passed, validation_status, gate_status, review_status
    FROM photoguard_photos WHERE submission_id = ?
  `).all(id) as Array<Record<string, unknown>>

  const counts = new Map<string, { total: number; passing: number }>()
  for (const p of photos) {
    const h = String(p['category_hash'] ?? '')
    if (!h) continue
    const c = counts.get(h) ?? { total: 0, passing: 0 }
    c.total++
    const ok = p['review_status'] === 'approved' ||
      (p['review_status'] == null && p['gate_status'] !== 'blocked' && p['validation_passed'] === 1)
    if (ok) c.passing++
    counts.set(h, c)
  }

  const titles = new Map(form.sections.map(s => [s.key, s.title]))
  const items = form.fields
    .filter(f => f.fieldType === 'photo')
    .map(f => {
      const c = counts.get(f.hash) ?? { total: 0, passing: 0 }
      return {
        hash: f.hash,
        label: f.label,
        section: titles.get(f.sectionKey) ?? f.sectionKey,
        sectionKey: f.sectionKey,
        required: resolved.get(f.hash)?.required ?? f.required,
        collective: f.collective,
        expectedCount: f.expectedCount,
        hints: f.hints,
        photos: c.total,
        passing: c.passing,
        satisfied: c.passing > 0,
      }
    })

  const needsFiling = db.prepare(`
    SELECT COUNT(*) AS n FROM photoguard_photos WHERE submission_id = ? AND needs_filing = 1
  `).get(id) as { n: number }

  const required = items.filter(i => i.required)
  res.json({
    formType,
    items,
    needsFiling: needsFiling.n,
    summary: {
      requiredTotal: required.length,
      requiredSatisfied: required.filter(i => i.satisfied).length,
      outstanding: required.filter(i => !i.satisfied).length,
    },
  })
})

/** File a photo a human has judged, or correct a wrong auto-file. */
photoguardRouter.post('/photos/:photoId/file', (req: Request, res: Response) => {
  const id = Number(req.params['photoId'])
  const b = req.body as Record<string, unknown>
  const hash = String(b['fieldHash'] ?? '').trim()
  if (!hash) { res.status(400).json({ error: 'fieldHash is required' }); return }

  const photo = db.prepare(`SELECT id, form_type FROM photoguard_photos WHERE id = ?`).get(id) as
    | { id: number; form_type: string | null } | undefined
  if (!photo) { res.status(404).json({ error: 'Photo not found' }); return }

  const cat = findCategory(hash)
  if (!cat) { res.status(400).json({ error: 'Unknown requirement' }); return }

  db.prepare(`
    UPDATE photoguard_photos
    SET category_hash = ?, category_label = ?, category_section = ?,
        required = ?, needs_filing = 0, filed_by = ?,
        validation_status = 'pending', validation_error = NULL
    WHERE id = ?
  `).run(hash, cat.label, cat.sectionKey, cat.required ? 1 : 0, actorName(req), id)

  // The verdict was made against a different requirement, so it has to be
  // re-judged now we know what this photo is actually for.
  enqueueValidation(id)
  publishPhotoGuardEvent({ type: 'photo_added', photoId: id, status: 'filed', data: { fieldHash: hash } })
  res.json({ ok: true, requeued: true })
})

// ─── Assessment chat ──────────────────────────────────────────────────
//
// Grounded in what's already been assessed. Attaches the image when the
// question is about one specific photo, because some questions can only be
// answered by looking again.

function isChatScope(v: string): v is ChatScope {
  return v === 'submission' || v === 'task'
}

photoguardRouter.get('/chat/:scope/:id', (req: Request, res: Response) => {
  const scope = String(req.params['scope'])
  if (!isChatScope(scope)) { res.status(400).json({ error: 'Bad scope' }); return }
  res.json({ messages: listChat(scope, Number(req.params['id'])) })
})

photoguardRouter.post('/chat/:scope/:id', async (req: Request, res: Response) => {
  const scope = String(req.params['scope'])
  if (!isChatScope(scope)) { res.status(400).json({ error: 'Bad scope' }); return }
  const b = req.body as Record<string, unknown>
  const question = String(b['question'] ?? '').trim()
  if (!question) { res.status(400).json({ error: 'question is required' }); return }
  if (question.length > 2000) { res.status(400).json({ error: 'question is too long' }); return }

  const photoId = b['photoId'] != null ? Number(b['photoId']) : null

  const result = await askAssessment(scope, Number(req.params['id']), question, {
    photoId,
    author: actorName(req),
    // Only load bytes when a specific photo is in question.
    imageLoader: async (id: number) => {
      const row = db.prepare(`SELECT file_path FROM photoguard_photos WHERE id = ?`).get(id) as
        | { file_path: string | null } | undefined
      if (!row?.file_path) return null
      try { return await fs.promises.readFile(path.join(PHOTO_DIR, path.basename(row.file_path))) }
      catch { return null }
    },
  })

  if (!result.ok) { res.status(502).json({ error: result.error }); return }
  res.json({ ok: true, answer: result.answer, messages: listChat(scope, Number(req.params['id'])) })
})

// ─── Set-level assessment ─────────────────────────────────────────────

/** Assess whether each multi-photo requirement is actually covered. */
photoguardRouter.post('/sets/:scope/:id/assess', async (req: Request, res: Response) => {
  const scope = String(req.params['scope'])
  if (scope !== 'submission' && scope !== 'task') {
    res.status(400).json({ error: "scope must be 'submission' or 'task'" }); return
  }
  const result = await assessSets(scope, Number(req.params['id']))
  res.json({ ...result, stored: listSetAssessments(scope, Number(req.params['id'])) })
})

photoguardRouter.get('/sets/:scope/:id', (req: Request, res: Response) => {
  const scope = String(req.params['scope'])
  if (scope !== 'submission' && scope !== 'task') {
    res.status(400).json({ error: "scope must be 'submission' or 'task'" }); return
  }
  res.json({ sets: listSetAssessments(scope, Number(req.params['id'])) })
})

/** Backfill perceptual hashes for photos stored before hashing existed. */
photoguardRouter.post('/backfill-phash', async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query['limit'] ?? 500), 2000)
  const rows = db.prepare(`
    SELECT id, file_path FROM photoguard_photos
    WHERE phash IS NULL AND file_path IS NOT NULL LIMIT ?
  `).all(limit) as Array<{ id: number; file_path: string }>

  const upd = db.prepare(`UPDATE photoguard_photos SET phash = ? WHERE id = ?`)
  let done = 0
  for (const r of rows) {
    try {
      const buf = await fs.promises.readFile(path.join(PHOTO_DIR, path.basename(r.file_path)))
      const h = await perceptualHash(buf)
      if (h) { upd.run(h, r.id); done++ }
    } catch { /* skip unreadable */ }
  }
  res.json({ ok: true, considered: rows.length, hashed: done })
})

// ─── Live job review ──────────────────────────────────────────────────

/** Run the AI inspector over the whole job. Safe to call repeatedly —
 *  findings are upserted by fingerprint, not duplicated. */
photoguardRouter.post('/submissions/:id/review', async (req: Request, res: Response) => {
  const id = Number(req.params['id'])
  const result = await runJobReview(id)
  res.json({ ...result, findings: listFindings(id) })
})

photoguardRouter.get('/submissions/:id/findings', (req: Request, res: Response) => {
  res.json({ findings: listFindings(Number(req.params['id'])) })
})

/**
 * Act on a finding.
 *
 * 'escalated' is the human-review request: the crew (or the reviewer) can say
 * "I need a person to look at this one" without blocking the rest of the job.
 * The AI is explicitly not the final word.
 */
photoguardRouter.post('/findings/:id/status', (req: Request, res: Response) => {
  const id = Number(req.params['id'])
  const b = req.body as Record<string, unknown>
  const status = String(b['status'] ?? '')
  if (!['open', 'resolved', 'dismissed', 'escalated'].includes(status)) {
    res.status(400).json({ error: "status must be open, resolved, dismissed or escalated" })
    return
  }
  const row = db.prepare(`SELECT submission_id FROM photoguard_findings WHERE id = ?`).get(id) as
    | { submission_id: number } | undefined
  if (!row) { res.status(404).json({ error: 'Finding not found' }); return }

  const who = actorName(req)
  db.prepare(`
    UPDATE photoguard_findings SET
      status = ?,
      resolved_by = CASE WHEN ? IN ('resolved','dismissed') THEN ? ELSE resolved_by END,
      resolved_at = CASE WHEN ? IN ('resolved','dismissed') THEN datetime('now') ELSE resolved_at END,
      escalated_by = CASE WHEN ? = 'escalated' THEN ? ELSE escalated_by END,
      escalated_note = CASE WHEN ? = 'escalated' THEN ? ELSE escalated_note END,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(status, status, who, status, status, who, status,
    b['note'] != null ? String(b['note']) : null, id)

  publishPhotoGuardEvent({
    type: 'photo_reviewed', status,
    message: status === 'escalated' ? `${who} requested a human review` : undefined,
    data: { submissionId: row.submission_id, findingId: id, kind: 'finding' },
  })
  res.json({ ok: true })
})

/**
 * Audit trail for a job.
 *
 * Answers, per photo: who uploaded it, against which requirement, whether it
 * passed, whether it was taken on site, and — the useful bit — the gap between
 * when the shutter fired and when it reached us. A large gap isn't misconduct
 * (the offline queue and camera-roll workflow both produce one legitimately),
 * but it's the number you'd want in front of you if a job looked wrong.
 */
photoguardRouter.get('/submissions/:id/audit', (req: Request, res: Response) => {
  const id = Number(req.params['id'])
  const sub = db.prepare(`SELECT * FROM photoguard_submissions WHERE id = ?`).get(id) as
    | Record<string, unknown> | undefined
  if (!sub) { res.status(404).json({ error: 'Submission not found' }); return }

  const site = siteCoordsFor(sub)
  const rows = db.prepare(`
    SELECT id, category_label, category_hash, category_section, captured_by_name,
           capture_source, created_at, photo_timestamp, gps_lat, gps_lng,
           has_exif, has_gps, gate_status, validation_status, validation_passed,
           validation_confidence, review_status, reviewer, review_note, reviewed_at,
           file_path, thumb_path
    FROM photoguard_photos WHERE submission_id = ? ORDER BY created_at
  `).all(id) as Array<Record<string, unknown>>

  const entries = rows.map(r => {
    const taken = r['photo_timestamp'] ? new Date(String(r['photo_timestamp'])) : null
    const uploaded = new Date(String(r['created_at']) + 'Z')
    const validTaken = taken && !Number.isNaN(taken.getTime()) ? taken : null
    const delayMinutes = validTaken
      ? Math.round((uploaded.getTime() - validTaken.getTime()) / 60_000)
      : null

    // On site = the photo's own GPS lands within the fence of the property.
    // Unknown (not "off site") when the photo carries no GPS — absence of
    // evidence isn't evidence, and iOS strips GPS on some upload paths.
    let onSite: boolean | null = null
    let distanceM: number | null = null
    const pLat = r['gps_lat'] as number | null
    const pLng = r['gps_lng'] as number | null
    if (pLat != null && pLng != null && site.lat != null && site.lng != null) {
      distanceM = Math.round(haversineMeters(pLat, pLng, site.lat, site.lng))
      onSite = distanceM <= GEOFENCE_METERS
    }

    return {
      photoId: r['id'],
      requirement: r['category_label'],
      section: r['category_section'],
      uploadedBy: r['captured_by_name'],
      captureSource: r['capture_source'],
      takenAt: r['photo_timestamp'],
      uploadedAt: r['created_at'],
      delayMinutes,
      onSite,
      distanceM,
      hasExif: r['has_exif'] === 1,
      hasGps: r['has_gps'] === 1,
      passed: r['review_status'] === 'approved' ? true
        : r['review_status'] === 'rejected' || r['review_status'] === 'resubmit' ? false
        : r['gate_status'] === 'blocked' ? false
        : r['validation_status'] === 'done' ? r['validation_passed'] === 1
        : null,
      validationStatus: r['validation_status'],
      confidence: r['validation_confidence'],
      reviewStatus: r['review_status'],
      reviewer: r['reviewer'],
      reviewNote: r['review_note'],
      thumbPath: r['thumb_path'],
      filePath: r['file_path'],
    }
  })

  const withDelay = entries.filter(e => e.delayMinutes != null).map(e => e.delayMinutes as number)
  res.json({
    submissionId: id,
    site,
    entries,
    summary: {
      photos: entries.length,
      contributors: new Set(entries.map(e => e.uploadedBy).filter(Boolean)).size,
      onSite: entries.filter(e => e.onSite === true).length,
      offSite: entries.filter(e => e.onSite === false).length,
      locationUnknown: entries.filter(e => e.onSite == null).length,
      liveCaptures: entries.filter(e => e.captureSource === 'camera' || e.captureSource === 'video_frame').length,
      libraryUploads: entries.filter(e => e.captureSource === 'upload').length,
      medianDelayMinutes: withDelay.length
        ? [...withDelay].sort((a, b) => a - b)[Math.floor(withDelay.length / 2)] ?? null
        : null,
      maxDelayMinutes: withDelay.length ? Math.max(...withDelay) : null,
    },
  })
})

// ─── Job documents (the design the crew is building to) ───────────────
//
// Design docs already sync from Quickbase into attachment_cache. The existing
// Documents UI links to the QB record page, which assumes a Quickbase login —
// fine for office staff, useless for a subcontractor on a roof. So we proxy
// the bytes with the server's own QB token instead.
//
// QB's /v1/files response is base64-encoded (verified live: a 254KB PDF comes
// back as base64 with content-type application/pdf), so it has to be decoded
// before being streamed on.

/** Attachment types worth putting in front of a crew, most useful first. */
const DESIGN_TYPES = ['Approved Plans', 'Proposed Design', 'Permit', 'Change Order Doc']

photoguardRouter.get('/documents/:projectRid', (req: Request, res: Response) => {
  const rid = Number(req.params['projectRid'])
  if (!Number.isFinite(rid)) { res.status(400).json({ error: 'Bad project id' }); return }

  const rows = db.prepare(`
    SELECT record_id, attachment_type, file_name, file_blob, link_url, date_created
    FROM attachment_cache
    WHERE project_rid = ?
    ORDER BY date_created DESC
  `).all(rid) as Array<{
    record_id: number; attachment_type: string | null; file_name: string | null
    file_blob: string | null; link_url: string | null; date_created: string | null
  }>

  const docs = rows
    .filter(r => DESIGN_TYPES.includes((r.attachment_type ?? '').trim()))
    .map(r => {
      let hasFile = false
      let version = 1
      try {
        const blob = r.file_blob ? JSON.parse(r.file_blob) as { url?: string; versions?: unknown[] } : null
        hasFile = !!blob?.versions?.length
        if (blob?.versions?.length) version = blob.versions.length
      } catch { /* treat as link-only */ }
      return {
        recordId: r.record_id,
        type: r.attachment_type,
        fileName: r.file_name,
        dateCreated: r.date_created,
        linkUrl: r.link_url,
        hasFile,
        version,
        // Served through us, so no Quickbase account is needed on site.
        url: hasFile ? `/api/photoguard/documents/file/${r.record_id}?v=${version}` : null,
      }
    })
    .sort((a, b) => DESIGN_TYPES.indexOf(String(a.type)) - DESIGN_TYPES.indexOf(String(b.type)))

  res.json({ projectRid: rid, documents: docs })
})

photoguardRouter.get('/documents/file/:recordId', async (req: Request, res: Response) => {
  const recordId = Number(req.params['recordId'])
  const version = Math.max(1, Number(req.query['v'] ?? 1))
  const token = process.env['QB_USER_TOKEN']
  const realm = process.env['QB_REALM_HOSTNAME']
  if (!token || !realm) { res.status(503).json({ error: 'Quickbase is not configured' }); return }

  const row = db.prepare(`SELECT file_name FROM attachment_cache WHERE record_id = ?`)
    .get(recordId) as { file_name: string | null } | undefined
  if (!row) { res.status(404).json({ error: 'Document not found' }); return }

  try {
    const qb = await fetch(
      `https://api.quickbase.com/v1/files/br9kwm8ke/${recordId}/7/${version}`,
      { headers: { 'QB-Realm-Hostname': realm, 'Authorization': `QB-USER-TOKEN ${token}` } },
    )
    if (!qb.ok) {
      res.status(qb.status === 404 ? 404 : 502).json({ error: `Quickbase returned ${qb.status}` })
      return
    }
    // Body is base64 text, not raw bytes.
    const buf = Buffer.from(await qb.text(), 'base64')
    const name = row.file_name || `document-${recordId}`
    res.setHeader('Content-Type', qb.headers.get('content-type') || 'application/octet-stream')
    res.setHeader('Content-Disposition', `inline; filename="${name.replace(/"/g, '')}"`)
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.send(buf)
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : 'Download failed' })
  }
})

// ─── Upload (the live capture path) ───────────────────────────────────

photoguardRouter.post('/upload', memUpload.single('file'), async (req: Request, res: Response) => {
  const file = req.file
  if (!file) { res.status(400).json({ error: 'No file uploaded' }); return }

  const b = req.body as Record<string, string>
  const submissionId = b['submissionId'] ? Number(b['submissionId']) : null
  const categoryHash = String(b['fieldHash'] ?? b['categoryHash'] ?? '')
  const source = (String(b['source'] ?? 'camera') as CaptureSource)

  const sub = submissionId
    ? db.prepare(`SELECT * FROM photoguard_submissions WHERE id = ?`).get(submissionId) as Record<string, unknown> | undefined
    : undefined
  if (submissionId && !sub) { res.status(404).json({ error: 'Submission not found' }); return }

  let cat = categoryHash ? findCategory(categoryHash) : null
  const formType = String(b['formType'] ?? sub?.['form_type'] ?? cat?.formType ?? '')

  // Drop mode: no requirement was chosen, so work out what this is.
  let classification: Awaited<ReturnType<typeof classifyPhoto>> = null
  let resolvedHash = categoryHash
  let needsFiling = 0
  if (!categoryHash && formType && visionConfigured()) {
    const already = new Set(
      (db.prepare(`
        SELECT DISTINCT category_hash FROM photoguard_photos
        WHERE submission_id = ? AND category_hash IS NOT NULL AND validation_passed = 1
      `).all(submissionId) as Array<{ category_hash: string }>).map(r => r.category_hash),
    )
    try {
      classification = await classifyPhoto(file.buffer, formType, already)
    } catch { classification = null }
    if (classification?.filing.hash) {
      resolvedHash = classification.filing.hash
      cat = findCategory(resolvedHash)
    } else if (classification) {
      needsFiling = 1
    }
  }

  // 1. Metadata + deterministic gates — the instant-feedback path.
  const meta = await extractMetadata(file.buffer)
  const phash = await perceptualHash(file.buffer)
  const issues: GateIssue[] = runQualityGates(meta, {
    source,
    deviceLat: b['lat'] ? Number(b['lat']) : null,
    deviceLng: b['lng'] ? Number(b['lng']) : null,
    siteLat: siteCoordsFor(sub).lat,
    siteLng: siteCoordsFor(sub).lng,
    capturedAt: b['capturedAt'] ?? null,
    knownHashes: knownHashes(submissionId),
  })
  // Near-duplicate of something already on this requirement. A warning, not a
  // block: a second angle of the same subject is sometimes legitimate, and the
  // set assessment is what decides whether it counts as coverage.
  if (phash && submissionId && categoryHash) {
    const sibs = db.prepare(`
      SELECT phash FROM photoguard_photos
      WHERE submission_id = ? AND category_hash = ? AND phash IS NOT NULL
    `).all(submissionId, categoryHash) as Array<{ phash: string }>
    if (sibs.some(x => isNearDuplicate(x.phash, phash))) {
      issues.push({
        code: 'near_duplicate',
        severity: 'warn',
        message: 'Looks like the same shot as one you already added — a different angle adds more.',
      })
    }
  }

  const blocked = gatesBlock(issues)

  // 2. Persist. Blocked shots are still stored so the agent can see what was
  //    wrong side by side with the retake.
  const fileId = crypto.randomUUID()
  const ext = (meta.format && meta.format !== 'heif' ? `.${meta.format}` : path.extname(file.originalname) || '.jpg')
    .replace('.jpeg', '.jpg')
  const fileName = `${fileId}${ext}`
  await fs.promises.writeFile(path.join(PHOTO_DIR, fileName), file.buffer)

  let thumbName: string | null = `thumb_${fileId}.jpg`
  try {
    await sharp(file.buffer).rotate().resize(480, undefined, { withoutEnlargement: true })
      .jpeg({ quality: 78 }).toFile(path.join(THUMB_DIR, thumbName))
  } catch { thumbName = null }

  const info = db.prepare(`
    INSERT INTO photoguard_photos (
      submission_id, arrivy_task_id, file_id, filename,
      category_label, category_hash, category_section, form_type, required,
      file_path, thumb_path, file_size, width, height,
      has_exif, has_gps, gps_lat, gps_lng, camera_make, camera_model, photo_timestamp,
      content_hash, phash, capture_source, captured_by, captured_by_name,
      metadata_issues, gate_status, validation_status
    ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    submissionId, fileId, file.originalname,
    cat?.label ?? null, resolvedHash || null, cat?.sectionKey ?? null, formType || null,
    cat?.required ? 1 : 0,
    `/uploads/photoguard/${fileName}`,
    thumbName ? `/uploads/photoguard/thumbs/${thumbName}` : null,
    meta.fileSize, meta.width, meta.height,
    meta.hasExif ? 1 : 0, meta.hasGps ? 1 : 0, meta.gpsLat, meta.gpsLng,
    meta.cameraMake, meta.cameraModel, meta.photoTimestamp,
    meta.contentHash, phash, source, req.user?.userId ?? null, actorName(req),
    JSON.stringify(issues), blocked ? 'blocked' : 'ok',
    blocked ? 'skipped' : 'pending',
  )
  const photoId = Number(info.lastInsertRowid)

  if (classification) {
    db.prepare(`
      UPDATE photoguard_photos
      SET classification = ?, classify_confidence = ?, needs_filing = ?
      WHERE id = ?
    `).run(
      JSON.stringify(classification.classification),
      classification.classification.candidates[0]?.confidence ?? 0,
      needsFiling, photoId,
    )
  }

  if (submissionId) {
    db.prepare(`UPDATE photoguard_submissions SET updated_at = datetime('now') WHERE id = ?`).run(submissionId)
  }

  publishPhotoGuardEvent({
    type: 'photo_added', photoId,
    status: blocked ? 'blocked' : 'ok',
    data: { submissionId, categoryHash, issues },
  })

  // 3. Only spend a vision call on a photo that cleared the cheap gates AND
  //    whose requirement is known — judging an unfiled photo against
  //    "Unspecified" costs a call and answers nothing. /file re-queues it once
  //    a human says what it's for.
  if (!blocked && !needsFiling) enqueueValidation(photoId)

  res.status(201).json({
    photoId,
    fileId,
    classification: classification?.classification ?? null,
    filing: classification?.filing ?? null,
    filedAs: cat ? { hash: resolvedHash, label: cat.label, section: cat.sectionKey } : null,
    needsFiling: needsFiling === 1,
    url: `/uploads/photoguard/${fileName}`,
    thumbUrl: thumbName ? `/uploads/photoguard/thumbs/${thumbName}` : null,
    metadata: meta,
    issues,
    blocked,
    // Tells the client whether to expect an SSE verdict or stop here.
    validationQueued: !blocked && visionConfigured(),
    visionConfigured: visionConfigured(),
    visionModel: visionModel(),
  })
})

// ─── Revalidate / review ──────────────────────────────────────────────

photoguardRouter.post('/revalidate/:photoId', (req: Request, res: Response) => {
  const id = Number(req.params['photoId'])
  const row = db.prepare(`SELECT id FROM photoguard_photos WHERE id = ?`).get(id)
  if (!row) { res.status(404).json({ error: 'Photo not found' }); return }
  db.prepare(`UPDATE photoguard_photos SET validation_status='pending', validation_error=NULL WHERE id=?`).run(id)
  enqueueValidation(id)
  res.json({ ok: true, queued: true, visionConfigured: visionConfigured() })
})

photoguardRouter.post('/photos/:photoId/review', (req: Request, res: Response) => {
  const id = Number(req.params['photoId'])
  const b = req.body as Record<string, unknown>
  const status = String(b['status'] ?? '')
  if (!['approved', 'rejected', 'resubmit'].includes(status)) {
    res.status(400).json({ error: "status must be 'approved', 'rejected' or 'resubmit'" })
    return
  }
  const photo = db.prepare(`SELECT id, task_rowid, submission_id FROM photoguard_photos WHERE id = ?`).get(id) as
    | { id: number; task_rowid: number | null; submission_id: number | null } | undefined
  if (!photo) { res.status(404).json({ error: 'Photo not found' }); return }

  db.prepare(`
    UPDATE photoguard_photos
    SET review_status=?, reviewer=?, review_note=?, reviewed_at=datetime('now')
    WHERE id=?
  `).run(status, actorName(req), b['note'] != null ? String(b['note']) : null, id)

  if (photo.task_rowid) recountTask(photo.task_rowid)
  publishPhotoGuardEvent({
    type: 'photo_reviewed', photoId: id, status,
    data: { submissionId: photo.submission_id, reviewer: actorName(req) },
  })
  res.json({ ok: true })
})

photoguardRouter.get('/review-queue', (_req: Request, res: Response) => {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM photoguard_photos
    WHERE review_status IS NULL
      AND (validation_passed = 0 OR gate_status = 'blocked')
  `).get() as { n: number }
  res.json({ count: row.n })
})

// ─── Stats / tasks ────────────────────────────────────────────────────

photoguardRouter.get('/stats', (_req: Request, res: Response) => {
  const p = db.prepare(`
    SELECT
      COUNT(*) AS total_photos,
      SUM(CASE WHEN validation_passed = 1 THEN 1 ELSE 0 END) AS passed,
      SUM(CASE WHEN validation_passed = 0 AND validation_status = 'done' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN validation_status IN ('pending','running') THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN gate_status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
      SUM(CASE WHEN has_gps = 1 THEN 1 ELSE 0 END) AS with_gps,
      SUM(CASE WHEN has_exif = 1 THEN 1 ELSE 0 END) AS with_exif
    FROM photoguard_photos
  `).get() as Record<string, number | null>

  const tasks = db.prepare(`SELECT COUNT(*) AS n FROM photoguard_tasks`).get() as { n: number }
  const subs = db.prepare(`
    SELECT COUNT(*) AS n,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS open
    FROM photoguard_submissions
  `).get() as { n: number; open: number | null }

  const total = Number(p['total_photos'] ?? 0)
  const passed = Number(p['passed'] ?? 0)
  const failed = Number(p['failed'] ?? 0)
  const judged = passed + failed

  res.json({
    totalTasks: tasks.n,
    totalSubmissions: subs.n,
    openSubmissions: subs.open ?? 0,
    totalPhotos: total,
    passed,
    failed,
    pending: Number(p['pending'] ?? 0),
    blocked: Number(p['blocked'] ?? 0),
    withGps: Number(p['with_gps'] ?? 0),
    withExif: Number(p['with_exif'] ?? 0),
    passRate: judged ? Math.round((passed / judged) * 100) : null,
    visionConfigured: visionConfigured(),
    arrivyConfigured: arrivyConfigured(),
  })
})

/** Coverage by section — which parts of the form are actually being captured. */
photoguardRouter.get('/coverage', (req: Request, res: Response) => {
  const ft = String(req.query['formType'] ?? 'site_survey')
  const form = getForm(ft)
  if (!form) { res.status(404).json({ error: `No stored form '${ft}'` }); return }

  const rows = db.prepare(`
    SELECT category_section AS section,
      COUNT(*) AS total,
      SUM(CASE WHEN validation_passed = 1 THEN 1 ELSE 0 END) AS passed,
      SUM(CASE WHEN gate_status = 'blocked' THEN 1 ELSE 0 END) AS blocked
    FROM photoguard_photos
    WHERE form_type = ?
    GROUP BY category_section
  `).all(ft) as Array<{ section: string | null; total: number; passed: number | null; blocked: number | null }>
  const bySection = new Map(rows.map(r => [r.section ?? '', r]))

  res.json({
    formType: ft,
    sections: form.sections.map(s => {
      const expected = form.fields.filter(f => f.fieldType === 'photo' && f.sectionKey === s.key).length
      const got = bySection.get(s.key)
      return {
        key: s.key,
        title: s.title,
        expectedPhotos: expected,
        captured: got?.total ?? 0,
        passed: got?.passed ?? 0,
        blocked: got?.blocked ?? 0,
      }
    }),
  })
})

photoguardRouter.get('/tasks', (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query['limit'] ?? 50), 200)
  const rows = db.prepare(`
    SELECT * FROM photoguard_tasks ORDER BY COALESCE(completed_at, scanned_at) DESC LIMIT ?
  `).all(limit)
  res.json({ tasks: rows })
})

photoguardRouter.get('/tasks/:id', (req: Request, res: Response) => {
  const id = Number(req.params['id'])
  const task = db.prepare(`SELECT * FROM photoguard_tasks WHERE id = ?`).get(id)
  if (!task) { res.status(404).json({ error: 'Task not found' }); return }
  const photos = db.prepare(`
    SELECT * FROM photoguard_photos WHERE task_rowid = ? ORDER BY category_section, category_label
  `).all(id)
  res.json({ task, photos })
})

// ─── Arrivy scan (historical import, optional) ────────────────────────

interface ArrivySubmissionComponent {
  hash?: string | number
  type?: string
  content?: { label?: string; files?: Array<{ filename?: string; file_id?: number | string; file_path?: string }> }
}
interface ArrivySubmission {
  id?: number | string
  master_form_id?: number | string
  updated?: string
  content?: ArrivySubmissionComponent[]
}
interface ArrivyTaskListItem {
  id?: number | string
  title?: string
  status?: string
  customer_name?: string
  external_id?: string
  end_datetime?: string
  template_type?: string
  files?: unknown[]
  forms?: Array<{ form_id?: number | string; title?: string }>
}

// Arrivy is a shared production system that the dispatch desk works in all day.
// A bulk import from here measurably slowed it down for them on 2026-08-06 —
// 400ms between calls was far too aggressive once multi-MB photo downloads were
// in the mix. The defaults below are now deliberately timid, and a scan is
// OPT-IN and refuses to run during office hours unless explicitly forced.
//
//   PHOTOGUARD_SCAN_ENABLED=1   required — no scan runs without it
//   PHOTOGUARD_ARRIVY_DELAY_MS  default 2500 (was 400)
//   PHOTOGUARD_SCAN_MAX_PHOTOS  default 40   (was 150)
//   PHOTOGUARD_SCAN_ANY_HOUR=1  allow running inside office hours
const ARRIVY_CALL_DELAY_MS = Number(process.env['PHOTOGUARD_ARRIVY_DELAY_MS'] || 2500)
const ARRIVY_MAX_PHOTOS = Number(process.env['PHOTOGUARD_SCAN_MAX_PHOTOS'] || 40)
const SCAN_ENABLED = process.env['PHOTOGUARD_SCAN_ENABLED'] === '1'
const SCAN_ANY_HOUR = process.env['PHOTOGUARD_SCAN_ANY_HOUR'] === '1'

/** Office-hours guard. Bulk reads belong outside the working day. */
function insideOfficeHours(now = new Date()): boolean {
  const h = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: OFFICE_TZ, hour: 'numeric', hour12: false,
  }).format(now))
  const day = new Intl.DateTimeFormat('en-US', { timeZone: OFFICE_TZ, weekday: 'short' }).format(now)
  const weekend = day === 'Sat' || day === 'Sun'
  return !weekend && h >= 7 && h < 18
}

/** Arrivy asking us to slow down is not something to retry through. */
class ArrivyBackoff extends Error {
  constructor(public retryAfterSec: number | null) {
    super('Arrivy asked us to back off (429)')
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * Pull recent Arrivy tasks and their form submissions into the review tables.
 *
 * This is a migration/review aid, NOT a runtime dependency: field agents
 * complete forms in this app. Photos are downloaded through Arrivy's
 * /api/files path (auth headers required) and re-hosted locally.
 */
photoguardRouter.post('/scan', async (req: Request, res: Response) => {
  if (!arrivyConfigured()) {
    res.status(503).json({ error: 'Arrivy is not configured — set ARRIVY_AUTH_KEY and ARRIVY_AUTH_TOKEN' })
    return
  }
  if (!SCAN_ENABLED) {
    res.status(423).json({
      error: 'Arrivy scanning is disabled. Set PHOTOGUARD_SCAN_ENABLED=1 to allow it.',
      why: 'Bulk reads hit the same Arrivy the dispatch desk uses; this is opt-in on purpose.',
    })
    return
  }
  if (insideOfficeHours() && !SCAN_ANY_HOUR && req.query['force'] !== '1') {
    res.status(423).json({
      error: 'Refusing to scan during office hours (07:00–18:00 America/Denver, Mon–Fri).',
      hint: 'Run it outside working hours, or pass ?force=1 / PHOTOGUARD_SCAN_ANY_HOUR=1 if you accept the load.',
    })
    return
  }
  const days = Math.min(Math.max(Number(req.query['days'] ?? 3), 1), 30)
  const limit = Math.min(Number(req.query['limit'] ?? 25), 100)

  const end = new Date()
  const start = new Date(end.getTime() - days * 86_400_000)
  const iso = (d: Date) => d.toISOString().slice(0, 10)

  publishPhotoGuardEvent({ type: 'scan_started', message: `Scanning Arrivy, last ${days} day(s)` })

  const wantedFormIds = new Set(FORM_TYPES.map(ft => arrivyFormIdFor(ft)))
  const formTypeById = new Map(FORM_TYPES.map(ft => [arrivyFormIdFor(ft), ft]))

  let scanned = 0, imported = 0, photosAdded = 0
  try {
    // Arrivy caps /tasks at 500 per page and pages via ?page=. A single page
    // is NOT the window: verified live, site surveys fill page 1 while install
    // checkouts don't appear until page 5. Reading one page silently returned
    // "no installs exist", which was wrong.
    const maxPages = Math.min(Math.max(Number(req.query['pages'] ?? 6), 1), 12)
    const tasks: ArrivyTaskListItem[] = []
    for (let page = 1; page <= maxPages; page++) {
      if (page > 1) await sleep(ARRIVY_CALL_DELAY_MS)
      let batch: ArrivyTaskListItem[] = []
      try {
        batch = await arrivyGet<ArrivyTaskListItem[]>(
          `/tasks?start_date=${iso(start)}&end_date=${iso(end)}&page=${page}`,
        )
      } catch { break }
      if (!Array.isArray(batch) || !batch.length) break
      tasks.push(...batch)
      if (batch.length < 500) break   // last page
    }
    // Photos only exist on work that's been done, so completed tasks come
    // first. Spending the run's call budget on scheduled-but-empty tasks is
    // pure waste against a shared production API.
    // The task list already says whether anything was attached, so we can spend
    // the run's budget on tasks that actually contain work without paying an
    // extra call to find out. Verified against a live window: 322 of 329
    // completed survey tasks carry files, while the first few in array order
    // are test/empty records — ranking on status alone imported nothing.
    const rank = (t: ArrivyTaskListItem): number => {
      const st = String(t.status ?? '').toUpperCase()
      const done = st === 'COMPLETE' || st === 'COMPLETED'
      const hasFiles = (t.files?.length ?? 0) > 0
      if (done && hasFiles) return 0
      if (done) return 1
      if (hasFiles) return 2
      return 3
    }
    const wantStatus = req.query['status'] ? String(req.query['status']).toUpperCase() : null
    // Optional single-form targeting, so a run can go after installs
    // specifically rather than drowning in the far more numerous surveys.
    const onlyType = req.query['formType'] ? String(req.query['formType']) : null
    const targetIds = onlyType && isFormType(onlyType)
      ? new Set([arrivyFormIdFor(onlyType)])
      : wantedFormIds

    const candidates = tasks
      .filter(t => (t.forms ?? []).some(f => targetIds.has(String(f.form_id))))
      .filter(t => !wantStatus || String(t.status ?? '').toUpperCase() === wantStatus)
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, limit)

    for (const t of candidates) {
      scanned++
      const arrivyTaskId = String(t.id)
      const formRef = (t.forms ?? []).find(f => targetIds.has(String(f.form_id)))
      const formType = formTypeById.get(String(formRef?.form_id)) ?? null

      db.prepare(`
        INSERT INTO photoguard_tasks
          (arrivy_task_id, task_title, task_type, task_status, customer_name,
           template_name, form_id, form_title, completed_at, scanned_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(arrivy_task_id) DO UPDATE SET
          task_status = excluded.task_status,
          scanned_at = datetime('now'),
          updated_at = datetime('now')
      `).run(
        arrivyTaskId, t.title ?? null, t.template_type ?? null, t.status ?? null,
        t.customer_name ?? null, t.template_type ?? null,
        String(formRef?.form_id ?? ''), formRef?.title ?? null, t.end_datetime ?? null,
      )
      const taskRow = db.prepare(`SELECT id FROM photoguard_tasks WHERE arrivy_task_id = ?`)
        .get(arrivyTaskId) as { id: number }
      imported++

      await sleep(ARRIVY_CALL_DELAY_MS)
      let subs: ArrivySubmission[] = []
      try {
        subs = await arrivyGet<ArrivySubmission[]>(`/tasks/${arrivyTaskId}/forms`)
      } catch { continue }

      for (const sub of subs) {
        if (!targetIds.has(String(sub.master_form_id))) continue
        for (const comp of sub.content ?? []) {
          if (comp.type !== 'ImageUploadComponent') continue
          const files = comp.content?.files ?? []
          for (const f of files) {
            const fileId = `arrivy_${f.file_id}`
            const exists = db.prepare(`SELECT 1 FROM photoguard_photos WHERE file_id = ?`).get(fileId)
            if (exists) continue

            if (photosAdded >= ARRIVY_MAX_PHOTOS) break
            await sleep(ARRIVY_CALL_DELAY_MS)
            const dl = await downloadArrivyFile(f.file_path ?? '')
            if (!dl) continue

            const meta = await extractMetadata(dl)
            const fileName = `${fileId}.jpg`
            try { await fs.promises.writeFile(path.join(PHOTO_DIR, fileName), dl) } catch { continue }
            let thumbName: string | null = `thumb_${fileId}.jpg`
            try {
              await sharp(dl).rotate().resize(480, undefined, { withoutEnlargement: true })
                .jpeg({ quality: 78 }).toFile(path.join(THUMB_DIR, thumbName))
            } catch { thumbName = null }

            const hash = comp.hash != null ? String(comp.hash) : ''
            const cat = hash ? findCategory(hash) : null
            const info = db.prepare(`
              INSERT INTO photoguard_photos (
                task_rowid, arrivy_task_id, file_id, filename,
                category_label, category_hash, category_section, form_type, required,
                file_path, thumb_path, file_size, width, height,
                has_exif, has_gps, gps_lat, gps_lng, camera_make, camera_model, photo_timestamp,
                content_hash, capture_source, metadata_issues, gate_status, validation_status
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'arrivy_import', '[]', 'ok', 'pending')
            `).run(
              taskRow.id, arrivyTaskId, fileId, f.filename ?? null,
              comp.content?.label ?? cat?.label ?? null, hash || null,
              cat?.sectionKey ?? null, formType, cat?.required ? 1 : 0,
              `/uploads/photoguard/${fileName}`,
              thumbName ? `/uploads/photoguard/thumbs/${thumbName}` : null,
              meta.fileSize, meta.width, meta.height,
              meta.hasExif ? 1 : 0, meta.hasGps ? 1 : 0, meta.gpsLat, meta.gpsLng,
              meta.cameraMake, meta.cameraModel, meta.photoTimestamp, meta.contentHash,
            )
            photosAdded++
            enqueueValidation(Number(info.lastInsertRowid))
          }
        }
      }
      recountTask(taskRow.id)
      publishPhotoGuardEvent({
        type: 'scan_progress', taskId: taskRow.id, arrivyTaskId,
        data: { scanned, imported, photosAdded },
      })
      if (photosAdded >= ARRIVY_MAX_PHOTOS) {
        publishPhotoGuardEvent({
          type: 'scan_progress',
          message: `Stopped at the ${ARRIVY_MAX_PHOTOS}-photo ceiling for this run`,
        })
        break
      }
    }

    publishPhotoGuardEvent({
      type: 'scan_complete',
      message: `${imported} task(s), ${photosAdded} photo(s)`,
      data: { scanned, imported, photosAdded },
    })
    res.json({
      ok: true, days, scanned, imported, photosAdded,
      officeHours: insideOfficeHours(),
      cappedAt: photosAdded >= ARRIVY_MAX_PHOTOS ? ARRIVY_MAX_PHOTOS : null,
      delayMs: ARRIVY_CALL_DELAY_MS,
    })
  } catch (e) {
    if (e instanceof ArrivyBackoff) {
      const msg = `Arrivy returned 429 — run stopped. ${e.retryAfterSec ? `Retry after ${e.retryAfterSec}s.` : ''}`
      publishPhotoGuardEvent({ type: 'scan_failed', message: msg })
      res.status(429).json({ error: msg, scanned, imported, photosAdded, backedOff: true })
      return
    }
    const msg = e instanceof Error ? e.message : 'Scan failed'
    publishPhotoGuardEvent({ type: 'scan_failed', message: msg })
    res.status(502).json({ error: msg, scanned, imported, photosAdded })
  }
})

// ─── On-demand single-survey pull ─────────────────────────────────────
//
// This is the safe way to get Arrivy data while testing: a human asks for ONE
// survey and waits for it, instead of a sweep hitting hundreds of files. Load
// is comparable to a person browsing the task in Arrivy, so unlike /scan it is
// not gated on office hours — but it keeps the same pacing between downloads.

interface ImportTaskResult {
  arrivyTaskId: string
  taskRowId: number | null
  title: string | null
  photosAdded: number
  photosSkipped: number
  queuedForValidation: number
  error?: string
}

async function importSingleArrivyTask(arrivyTaskId: string): Promise<ImportTaskResult> {
  const out: ImportTaskResult = {
    arrivyTaskId, taskRowId: null, title: null,
    photosAdded: 0, photosSkipped: 0, queuedForValidation: 0,
  }

  const wantedFormIds = new Set(FORM_TYPES.map(ft => arrivyFormIdFor(ft)))
  const formTypeById = new Map(FORM_TYPES.map(ft => [arrivyFormIdFor(ft), ft]))

  let task: ArrivyTaskListItem
  try {
    task = await arrivyGet<ArrivyTaskListItem>(`/tasks/${encodeURIComponent(arrivyTaskId)}`)
  } catch (e) {
    out.error = e instanceof Error ? e.message : 'Could not load that task'
    return out
  }
  out.title = task.title ?? null

  const formRef = (task.forms ?? []).find(f => wantedFormIds.has(String(f.form_id)))
  const formType = formTypeById.get(String(formRef?.form_id)) ?? null

  db.prepare(`
    INSERT INTO photoguard_tasks
      (arrivy_task_id, task_title, task_type, task_status, customer_name,
       template_name, form_id, form_title, completed_at, scanned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(arrivy_task_id) DO UPDATE SET
      task_status = excluded.task_status, scanned_at = datetime('now'), updated_at = datetime('now')
  `).run(
    arrivyTaskId, task.title ?? null, task.template_type ?? null, task.status ?? null,
    task.customer_name ?? null, task.template_type ?? null,
    String(formRef?.form_id ?? ''), formRef?.title ?? null, task.end_datetime ?? null,
  )
  const taskRow = db.prepare(`SELECT id FROM photoguard_tasks WHERE arrivy_task_id = ?`)
    .get(arrivyTaskId) as { id: number }
  out.taskRowId = taskRow.id

  await sleep(ARRIVY_CALL_DELAY_MS)
  let subs: ArrivySubmission[] = []
  try {
    subs = await arrivyGet<ArrivySubmission[]>(`/tasks/${encodeURIComponent(arrivyTaskId)}/forms`)
  } catch (e) {
    out.error = e instanceof Error ? e.message : 'Could not load that task\'s form submissions'
    return out
  }

  for (const sub of subs) {
    if (!wantedFormIds.has(String(sub.master_form_id))) continue
    const subType = formTypeById.get(String(sub.master_form_id)) ?? formType
    for (const comp of sub.content ?? []) {
      if (comp.type !== 'ImageUploadComponent') continue
      for (const f of comp.content?.files ?? []) {
        const fileId = `arrivy_${f.file_id}`
        if (db.prepare(`SELECT 1 FROM photoguard_photos WHERE file_id = ?`).get(fileId)) {
          out.photosSkipped++
          continue
        }
        await sleep(ARRIVY_CALL_DELAY_MS)
        const dl = await downloadArrivyFile(f.file_path ?? '')
        if (!dl) continue

        const meta = await extractMetadata(dl)
        const dlPhash = await perceptualHash(dl)
        const fileName = `${fileId}.jpg`
        try { await fs.promises.writeFile(path.join(PHOTO_DIR, fileName), dl) } catch { continue }
        let thumbName: string | null = `thumb_${fileId}.jpg`
        try {
          await sharp(dl).rotate().resize(480, undefined, { withoutEnlargement: true })
            .jpeg({ quality: 78 }).toFile(path.join(THUMB_DIR, thumbName))
        } catch { thumbName = null }

        const hash = comp.hash != null ? String(comp.hash) : ''
        const cat = hash ? findCategory(hash) : null
        const info = db.prepare(`
          INSERT INTO photoguard_photos (
            task_rowid, arrivy_task_id, file_id, filename,
            category_label, category_hash, category_section, form_type, required,
            file_path, thumb_path, file_size, width, height,
            has_exif, has_gps, gps_lat, gps_lng, camera_make, camera_model, photo_timestamp,
            content_hash, phash, capture_source, metadata_issues, gate_status, validation_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'arrivy_import', '[]', 'ok', 'pending')
        `).run(
          taskRow.id, arrivyTaskId, fileId, f.filename ?? null,
          comp.content?.label ?? cat?.label ?? null, hash || null,
          cat?.sectionKey ?? null, subType, cat?.required ? 1 : 0,
          `/uploads/photoguard/${fileName}`,
          thumbName ? `/uploads/photoguard/thumbs/${thumbName}` : null,
          meta.fileSize, meta.width, meta.height,
          meta.hasExif ? 1 : 0, meta.hasGps ? 1 : 0, meta.gpsLat, meta.gpsLng,
          meta.cameraMake, meta.cameraModel, meta.photoTimestamp, meta.contentHash, dlPhash,
        )
        out.photosAdded++
        enqueueValidation(Number(info.lastInsertRowid))
        out.queuedForValidation++
      }
    }
  }
  recountTask(taskRow.id)
  return out
}

/**
 * Which Arrivy tasks we've already pulled, and how they're doing.
 *
 * Local only — no Arrivy call. The browsing UI reads survey tasks from the
 * Field view's own cached endpoint, so picking a survey costs Arrivy nothing;
 * Arrivy is touched only when someone actually requests an import.
 */
photoguardRouter.get('/imported-tasks', (_req: Request, res: Response) => {
  const rows = db.prepare(`
    SELECT p.arrivy_task_id AS id,
           MAX(p.task_rowid) AS taskRowId,
           COUNT(*) AS photos,
           SUM(CASE WHEN p.validation_passed = 1 THEN 1 ELSE 0 END) AS passed,
           SUM(CASE WHEN p.validation_passed = 0 AND p.validation_status = 'done' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN p.validation_status != 'done' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN p.review_status IS NOT NULL THEN 1 ELSE 0 END) AS reviewed,
           MAX(p.created_at) AS lastImportedAt
    FROM photoguard_photos p
    WHERE p.arrivy_task_id IS NOT NULL
    GROUP BY p.arrivy_task_id
  `).all() as Array<Record<string, unknown>>
  const byId: Record<string, Record<string, unknown>> = {}
  for (const r of rows) byId[String(r['id'])] = r
  res.json({ tasks: byId })
})

/** Recent Arrivy surveys a tester can pick from. One list call, page 1 only —
 *  surveys dominate it, so paging deeper isn't worth the load. */
photoguardRouter.get('/arrivy/recent', async (req: Request, res: Response) => {
  if (!arrivyConfigured()) { res.status(503).json({ error: 'Arrivy is not configured' }); return }
  const days = Math.min(Math.max(Number(req.query['days'] ?? 2), 0), 14)
  const end = new Date()
  const start = new Date(end.getTime() - days * 86_400_000)
  const iso = (d: Date) => d.toISOString().slice(0, 10)

  try {
    const tasks = await arrivyGet<ArrivyTaskListItem[]>(
      `/tasks?start_date=${iso(start)}&end_date=${iso(end)}`,
    )
    const wanted = new Set(FORM_TYPES.map(ft => arrivyFormIdFor(ft)))
    const imported = new Set(
      (db.prepare(`SELECT arrivy_task_id FROM photoguard_tasks`).all() as Array<{ arrivy_task_id: string }>)
        .map(r => r.arrivy_task_id),
    )
    const counts = db.prepare(`
      SELECT arrivy_task_id AS id, COUNT(*) AS n,
             SUM(CASE WHEN validation_passed = 1 THEN 1 ELSE 0 END) AS passed,
             SUM(CASE WHEN validation_status != 'done' THEN 1 ELSE 0 END) AS pending
      FROM photoguard_photos WHERE arrivy_task_id IS NOT NULL GROUP BY 1
    `).all() as Array<{ id: string; n: number; passed: number; pending: number }>
    const byId = new Map(counts.map(c => [c.id, c]))

    const rows = tasks
      .filter(t => (t.forms ?? []).some(f => wanted.has(String(f.form_id))))
      .map(t => {
        const id = String(t.id)
        const c = byId.get(id)
        return {
          arrivyTaskId: id,
          title: t.title ?? null,
          customerName: t.customer_name ?? null,
          status: t.status ?? null,
          endDatetime: t.end_datetime ?? null,
          hasFiles: (t.files?.length ?? 0) > 0,
          imported: imported.has(id),
          photos: c?.n ?? 0,
          passed: c?.passed ?? 0,
          pending: c?.pending ?? 0,
        }
      })
      .sort((a, b) => String(b.endDatetime ?? '').localeCompare(String(a.endDatetime ?? '')))
      .slice(0, 100)

    res.json({ days, count: rows.length, tasks: rows })
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : 'Could not list Arrivy tasks' })
  }
})

/** Pull one survey on demand and queue its photos for assessment. */
photoguardRouter.post('/arrivy/import/:arrivyTaskId', async (req: Request, res: Response) => {
  if (!arrivyConfigured()) { res.status(503).json({ error: 'Arrivy is not configured' }); return }
  const raw = String(req.params['arrivyTaskId'] ?? '').trim()
  // Accept a pasted Arrivy URL as well as a bare id.
  const id = (raw.match(/(\d{6,})/)?.[1]) ?? raw
  if (!/^\d+$/.test(id)) { res.status(400).json({ error: 'Expected an Arrivy task id' }); return }

  try {
    const result = await importSingleArrivyTask(id)
    if (result.error) { res.status(502).json(result); return }
    publishPhotoGuardEvent({
      type: 'scan_complete', arrivyTaskId: id,
      message: `Pulled ${result.photosAdded} photo(s) from Arrivy`,
      data: { ...result },
    })
    res.json({ ok: true, ...result })
  } catch (e) {
    if (e instanceof ArrivyBackoff) {
      res.status(429).json({ error: 'Arrivy asked us to slow down — try again shortly.' })
      return
    }
    res.status(502).json({ error: e instanceof Error ? e.message : 'Import failed' })
  }
})

/** Arrivy file paths are API-relative and need the auth headers. */
async function downloadArrivyFile(filePath: string): Promise<Buffer | null> {
  // Throws ArrivyBackoff on 429 so the caller stops the run entirely.
  if (!filePath) return null
  const key = process.env['ARRIVY_AUTH_KEY']
  const token = process.env['ARRIVY_AUTH_TOKEN']
  if (!key || !token) return null
  const base = (process.env['ARRIVY_API_BASE'] || 'https://app.arrivy.com/api').replace(/\/api\/?$/, '')
  const url = filePath.startsWith('http') ? filePath : `${base}${filePath}`
  try {
    const r = await fetch(url, { headers: { 'X-Auth-Key': key, 'X-Auth-Token': token } })
    if (r.status === 429) {
      const ra = Number(r.headers.get('retry-after'))
      throw new ArrivyBackoff(Number.isFinite(ra) ? ra : null)
    }
    if (!r.ok) return null
    const ct = r.headers.get('content-type') || ''
    if (!/^image\//i.test(ct)) return null
    return Buffer.from(await r.arrayBuffer())
  } catch (e) {
    if (e instanceof ArrivyBackoff) throw e
    return null
  }
}

// ─── SSE ──────────────────────────────────────────────────────────────
// Auth comes from the ?token= fallback in the shared authenticate middleware,
// since EventSource can't set an Authorization header.

photoguardRouter.get('/events', (_req: Request, res: Response) => {
  attachPhotoGuardSseStream(res)
})

export default photoguardRouter
