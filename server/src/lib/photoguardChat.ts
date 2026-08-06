// Ask questions about an assessment.
//
// Everything needed is already on record — each photo has an AI description
// and verdict, sets have coverage findings, the project has a design — so most
// questions ("which roof planes are actually covered?", "is the sub panel
// interior shown anywhere?") are answerable from text alone, cheaply.
//
// When a question is about ONE photo the image is attached, because "is there
// a label in the top-left corner?" can't be answered from someone else's
// summary of it.
//
// The whole risk here is confident invention. A reviewer asking "is the rear
// plane covered?" and getting a fluent "yes" that nothing supports is worse
// than no chat at all — so the prompt requires answers to be grounded in the
// listed evidence, requires photo ids to be cited, and requires the model to
// say plainly when the record doesn't answer the question.
import db from '../db'
import { callModelWithImages, visionConfigured } from './photoguardVision'
import { getForm, describeDesign } from './photoguardForms'

export type ChatScope = 'submission' | 'task'

export interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  photo_id: number | null
  author: string | null
  created_at: string
}

export function ensureChatSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS photoguard_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      scope_id INTEGER NOT NULL,
      photo_id INTEGER REFERENCES photoguard_photos(id) ON DELETE SET NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      author TEXT,
      model TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pg_chat ON photoguard_chat_messages(scope, scope_id, id)`)
}

export function listMessages(scope: ChatScope, scopeId: number, limit = 100): ChatMessage[] {
  ensureChatSchema()
  return db.prepare(`
    SELECT id, role, content, photo_id, author, created_at
    FROM photoguard_chat_messages
    WHERE scope = ? AND scope_id = ?
    ORDER BY id LIMIT ?
  `).all(scope, scopeId, limit) as ChatMessage[]
}

/** Everything known about this assessment, rendered for the model. */
export function buildContext(scope: ChatScope, scopeId: number, photoId?: number | null): string {
  const col = scope === 'submission' ? 'submission_id' : 'task_rowid'

  const photos = db.prepare(`
    SELECT id, category_label, category_section, validation_passed, validation_status,
           validation_description, validation_issues, review_status, captured_by_name,
           photo_timestamp, has_gps, capture_source
    FROM photoguard_photos WHERE ${col} = ? ORDER BY category_section, id
  `).all(scopeId) as Array<Record<string, unknown>>
  if (!photos.length) return ''

  const formType = String(photos.find(p => p['form_type'])?.['form_type'] ??
    (db.prepare(`SELECT form_type FROM photoguard_photos WHERE ${col} = ? AND form_type IS NOT NULL LIMIT 1`)
      .get(scopeId) as { form_type: string } | undefined)?.form_type ?? '')

  const projectRid = scope === 'submission'
    ? (db.prepare(`SELECT project_rid FROM photoguard_submissions WHERE id = ?`).get(scopeId) as { project_rid: number | null } | undefined)?.project_rid
    : (db.prepare(`SELECT project_rid FROM photoguard_tasks WHERE id = ?`).get(scopeId) as { project_rid: number | null } | undefined)?.project_rid
  const project = projectRid
    ? db.prepare(`SELECT * FROM project_cache WHERE record_id = ?`).get(projectRid) as Record<string, unknown> | undefined
    : undefined
  const design = describeDesign(project ?? null)

  const lines = photos.map(p => {
    const issues = (() => {
      try { return (JSON.parse(String(p['validation_issues'] ?? '[]')) as string[]).join('; ') }
      catch { return '' }
    })()
    const verdict = p['review_status']
      ? `reviewed:${p['review_status']}`
      : p['validation_status'] === 'done'
        ? (p['validation_passed'] === 1 ? 'PASS' : 'FAIL')
        : 'not yet assessed'
    return `- [photo ${p['id']}] (${p['category_section'] ?? '—'} / ${p['category_label'] ?? 'unassigned'}) ${verdict}: ` +
      `${String(p['validation_description'] ?? '(no description)')}` +
      (issues ? ` | flagged: ${issues}` : '')
  }).join('\n')

  const sets = db.prepare(`
    SELECT label, satisfied, distinct_shots, photo_count, duplicate_count, expected_count, missing, note
    FROM photoguard_set_assessments WHERE scope = ? AND scope_id = ?
  `).all(scope, scopeId) as Array<Record<string, unknown>>
  const setLines = sets.map(a => {
    let missing: string[] = []
    try { missing = JSON.parse(String(a['missing'] ?? '[]')) as string[] } catch { /* ignore */ }
    return `- "${a['label']}": ${a['satisfied'] ? 'COVERED' : 'GAP'} ` +
      `(${a['photo_count']} photos, ${a['distinct_shots']} distinct` +
      `${a['duplicate_count'] ? `, ${a['duplicate_count']} near-duplicate` : ''}` +
      `${a['expected_count'] ? `, asks for ${a['expected_count']}` : ''})` +
      (missing.length ? ` — missing: ${missing.join('; ')}` : '')
  }).join('\n')

  // Required photos with nothing usable against them.
  const form = formType ? getForm(formType) : null
  const have = new Set(photos
    .filter(p => p['review_status'] !== 'rejected')
    .map(p => String(p['category_label'] ?? '')))
  const outstanding = (form?.fields ?? [])
    .filter(f => f.fieldType === 'photo' && f.required && !have.has(f.label))
    .map(f => f.label)

  const focus = photoId
    ? photos.find(p => Number(p['id']) === photoId)
    : null

  return [
    `SURVEY: ${project?.['customer_name'] ?? 'Unknown customer'}${formType ? ` (${formType})` : ''}`,
    design ? `SYSTEM SOLD: ${design.text}` : '',
    '',
    'PHOTOS ON RECORD (each line is the assessment already made of one photo):',
    lines,
    '',
    setLines ? `MULTI-PHOTO REQUIREMENT COVERAGE:\n${setLines}` : '',
    '',
    outstanding.length
      ? `REQUIRED PHOTOS WITH NOTHING SUBMITTED (${outstanding.length}): ${outstanding.slice(0, 25).join(', ')}`
      : 'All required photos have something submitted.',
    focus
      ? `\nTHE USER IS ASKING ABOUT PHOTO ${focus['id']} — "${focus['category_label']}". Its image is attached; look at it directly rather than relying on the description above.`
      : '',
  ].filter(Boolean).join('\n')
}

export function buildChatPrompt(context: string, history: ChatMessage[], question: string): string {
  const convo = history
    .slice(-8)
    .map(m => `${m.role === 'user' ? 'Reviewer' : 'You'}: ${m.content}`)
    .join('\n')

  return `You are helping a reviewer understand a solar site survey photo assessment.

${context}

${convo ? `CONVERSATION SO FAR:\n${convo}\n` : ''}
Reviewer's question: ${question}

Rules:
- Answer ONLY from the evidence above (and the attached image, if there is one).
- Cite the photo ids you're relying on, like [photo 214].
- If the record doesn't answer the question, say so plainly — "the photos on
  record don't show that" is a useful answer. Do not speculate or fill gaps
  with what is usually true of solar installs.
- Be concise and concrete. Two or three sentences is usually right.
- You are advising a human reviewer who decides; don't give orders.`
}

export interface AskResult {
  ok: boolean
  answer?: string
  error?: string
}

export async function ask(
  scope: ChatScope,
  scopeId: number,
  question: string,
  opts: { photoId?: number | null; author?: string; imageLoader?: (id: number) => Promise<Buffer | null> } = {},
): Promise<AskResult> {
  ensureChatSchema()
  if (!visionConfigured()) return { ok: false, error: 'Model not configured' }

  const context = buildContext(scope, scopeId, opts.photoId)
  if (!context) return { ok: false, error: 'Nothing assessed for this survey yet' }

  const history = listMessages(scope, scopeId)

  db.prepare(`
    INSERT INTO photoguard_chat_messages (scope, scope_id, photo_id, role, content, author)
    VALUES (?, ?, ?, 'user', ?, ?)
  `).run(scope, scopeId, opts.photoId ?? null, question, opts.author ?? null)

  const images: Buffer[] = []
  if (opts.photoId && opts.imageLoader) {
    const buf = await opts.imageLoader(opts.photoId)
    if (buf) images.push(buf)
  }

  let answer: string
  try {
    answer = (await callModelWithImages(buildChatPrompt(context, history, question), images)).trim()
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Model call failed' }
  }
  if (!answer) return { ok: false, error: 'Model returned nothing' }

  db.prepare(`
    INSERT INTO photoguard_chat_messages (scope, scope_id, photo_id, role, content, model)
    VALUES (?, ?, ?, 'assistant', ?, ?)
  `).run(scope, scopeId, opts.photoId ?? null, answer,
    process.env['OLLAMA_VISION_MODEL'] || 'kimi-k2.6:cloud')

  return { ok: true, answer }
}
