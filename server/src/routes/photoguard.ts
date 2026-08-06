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
  extractMetadata, runQualityGates, gatesBlock,
  type CaptureSource, type GateIssue,
} from '../lib/photoguardQuality'
import {
  validatePhotoBuffer, visionConfigured, visionModel,
} from '../lib/photoguardVision'
import { attachPhotoGuardSseStream, publishPhotoGuardEvent } from '../lib/photoguardEvents'

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
  const hints = cat?.hints || ''

  db.prepare(`UPDATE photoguard_photos SET validation_status='running' WHERE id=?`).run(photoId)

  // The design comes from Quickbase via project_cache — it lets the model
  // flag equipment that doesn't match what was sold.
  const design = describeDesign(projectFor(p.project_rid))

  try {
    const r = await validatePhotoBuffer(buf, label, hints, design?.text)
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
  const resolved = resolveRequirements(ft, project)

  const tokens = tokenContextFromProject(project)
  res.json({
    ...form,
    projectRid: rid,
    design: describeDesign(project),
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
  const resolved = resolveRequirements(String(sub['form_type']), project)

  // Who has contributed, so the crew can see each other working.
  const contributors = db.prepare(`
    SELECT captured_by_name AS name, COUNT(*) AS photos, MAX(created_at) AS last_at
    FROM photoguard_photos
    WHERE submission_id = ? AND captured_by_name IS NOT NULL
    GROUP BY captured_by_name ORDER BY photos DESC
  `).all(id)

  res.json({
    submission: sub,
    answers,
    photos,
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

  const resolved = resolveRequirements(formType, projectFor(sub['project_rid'] as number | null))
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

  const cat = categoryHash ? findCategory(categoryHash) : null
  const formType = String(b['formType'] ?? sub?.['form_type'] ?? cat?.formType ?? '')

  // 1. Metadata + deterministic gates — the instant-feedback path.
  const meta = await extractMetadata(file.buffer)
  const issues: GateIssue[] = runQualityGates(meta, {
    source,
    deviceLat: b['lat'] ? Number(b['lat']) : null,
    deviceLng: b['lng'] ? Number(b['lng']) : null,
    siteLat: siteCoordsFor(sub).lat,
    siteLng: siteCoordsFor(sub).lng,
    capturedAt: b['capturedAt'] ?? null,
    knownHashes: knownHashes(submissionId),
  })
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
      content_hash, capture_source, captured_by, captured_by_name,
      metadata_issues, gate_status, validation_status
    ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    submissionId, fileId, file.originalname,
    cat?.label ?? null, categoryHash || null, cat?.sectionKey ?? null, formType || null,
    cat?.required ? 1 : 0,
    `/uploads/photoguard/${fileName}`,
    thumbName ? `/uploads/photoguard/thumbs/${thumbName}` : null,
    meta.fileSize, meta.width, meta.height,
    meta.hasExif ? 1 : 0, meta.hasGps ? 1 : 0, meta.gpsLat, meta.gpsLng,
    meta.cameraMake, meta.cameraModel, meta.photoTimestamp,
    meta.contentHash, source, req.user?.userId ?? null, actorName(req),
    JSON.stringify(issues), blocked ? 'blocked' : 'ok',
    blocked ? 'skipped' : 'pending',
  )
  const photoId = Number(info.lastInsertRowid)

  if (submissionId) {
    db.prepare(`UPDATE photoguard_submissions SET updated_at = datetime('now') WHERE id = ?`).run(submissionId)
  }

  publishPhotoGuardEvent({
    type: 'photo_added', photoId,
    status: blocked ? 'blocked' : 'ok',
    data: { submissionId, categoryHash, issues },
  })

  // 3. Only spend a vision call on a photo that cleared the cheap gates.
  if (!blocked) enqueueValidation(photoId)

  res.status(201).json({
    photoId,
    fileId,
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
  forms?: Array<{ form_id?: number | string; title?: string }>
}

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
    const tasks = await arrivyGet<ArrivyTaskListItem[]>(
      `/tasks?start_date=${iso(start)}&end_date=${iso(end)}`,
    )
    const candidates = tasks
      .filter(t => (t.forms ?? []).some(f => wantedFormIds.has(String(f.form_id))))
      .slice(0, limit)

    for (const t of candidates) {
      scanned++
      const arrivyTaskId = String(t.id)
      const formRef = (t.forms ?? []).find(f => wantedFormIds.has(String(f.form_id)))
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

      let subs: ArrivySubmission[] = []
      try {
        subs = await arrivyGet<ArrivySubmission[]>(`/tasks/${arrivyTaskId}/forms`)
      } catch { continue }

      for (const sub of subs) {
        if (!wantedFormIds.has(String(sub.master_form_id))) continue
        for (const comp of sub.content ?? []) {
          if (comp.type !== 'ImageUploadComponent') continue
          const files = comp.content?.files ?? []
          for (const f of files) {
            const fileId = `arrivy_${f.file_id}`
            const exists = db.prepare(`SELECT 1 FROM photoguard_photos WHERE file_id = ?`).get(fileId)
            if (exists) continue

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
    }

    publishPhotoGuardEvent({
      type: 'scan_complete',
      message: `${imported} task(s), ${photosAdded} photo(s)`,
      data: { scanned, imported, photosAdded },
    })
    res.json({ ok: true, days, scanned, imported, photosAdded })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Scan failed'
    publishPhotoGuardEvent({ type: 'scan_failed', message: msg })
    res.status(502).json({ error: msg, scanned, imported, photosAdded })
  }
})

/** Arrivy file paths are API-relative and need the auth headers. */
async function downloadArrivyFile(filePath: string): Promise<Buffer | null> {
  if (!filePath) return null
  const key = process.env['ARRIVY_AUTH_KEY']
  const token = process.env['ARRIVY_AUTH_TOKEN']
  if (!key || !token) return null
  const base = (process.env['ARRIVY_API_BASE'] || 'https://app.arrivy.com/api').replace(/\/api\/?$/, '')
  const url = filePath.startsWith('http') ? filePath : `${base}${filePath}`
  try {
    const r = await fetch(url, { headers: { 'X-Auth-Key': key, 'X-Auth-Token': token } })
    if (!r.ok) return null
    const ct = r.headers.get('content-type') || ''
    if (!/^image\//i.test(ct)) return null
    return Buffer.from(await r.arrayBuffer())
  } catch {
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
