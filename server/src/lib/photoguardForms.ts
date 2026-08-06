// PhotoGuard form store.
//
// Form definitions live in OUR database, not Arrivy's. Arrivy is an import
// source, not the system of record — that's what lets us edit these forms,
// add AI-authored hints, and eventually replace Arrivy's form runner
// entirely without a migration.
//
// Verified against the live Arrivy /api/forms response (2026-08-05):
//   'Site Survey Form'              id 6536703100190720 → 79 photo fields
//   'Field Task Site Checkout V1.02' id 6156749393756160 → 127 photo fields
// 79 + 127 = the 206 photo categories the PhotoGuard spec describes.
//
// Arrivy models a form as a flat, y-ordered list of components. Sections are
// implied by ScreenBreakComponent markers rather than nesting, so grouping is
// "walk in y order, start a new section at each break".
import db from '../db'

export type PhotoGuardFormType = 'site_survey' | 'install_checkout'

export const FORM_TYPES: PhotoGuardFormType[] = ['site_survey', 'install_checkout']

// Which Arrivy form backs each of our form types. Overridable per-install via
// env so a different Arrivy account can point at its own forms.
export function arrivyFormIdFor(formType: PhotoGuardFormType): string {
  if (formType === 'site_survey') return process.env['ARRIVY_SITE_SURVEY_FORM_ID'] || '6536703100190720'
  return process.env['ARRIVY_INSTALL_CHECKOUT_FORM_ID'] || '6156749393756160'
}

export type FieldType =
  | 'photo' | 'dropdown' | 'checklist' | 'text' | 'textarea'
  | 'number' | 'address' | 'signature' | 'block' | 'unknown'

// Arrivy component type → our field type. Every type seen across the 27 live
// forms is mapped; anything new falls through to 'unknown' and is imported
// but not rendered, rather than silently dropped.
export const ARRIVY_TYPE_MAP: Record<string, FieldType> = {
  ImageUploadComponent: 'photo',
  ImageComponent: 'block',
  DropDownComponent: 'dropdown',
  ChecklistComponent: 'checklist',
  TextInputComponent: 'text',
  TextComponent: 'block',
  NumberComponent: 'number',
  AddressComponent: 'address',
  SignatureComponent: 'signature',
  LineBreakComponent: 'block',
  QuoteTableComponent: 'unknown',
  BundleSelectionComponent: 'unknown',
}

export const SCREEN_BREAK = 'ScreenBreakComponent'

// ─── Normalized shapes ────────────────────────────────────────────────

export interface NormalizedSection {
  key: string
  title: string
  sortOrder: number
}

export interface NormalizedField {
  hash: string
  label: string
  fieldType: FieldType
  required: boolean
  options: string[] | null
  sectionKey: string
  sortOrder: number
  hints: string
}

export interface NormalizedForm {
  formType: PhotoGuardFormType
  title: string
  arrivyFormId: string
  sections: NormalizedSection[]
  fields: NormalizedField[]
}

// Raw Arrivy shapes — only the parts we consume.
interface ArrivyComponentContent {
  label?: string
  screenTitle?: string
  title?: string
  text?: string
  isRequired?: boolean
  options?: Array<{ label?: string; value?: string }>
  items?: Array<{ label?: string; value?: string; text?: string }>
}
export interface ArrivyComponent {
  hash?: string | number
  type?: string
  yAxisValue?: number
  xAxisValue?: number
  content?: ArrivyComponentContent
}
export interface ArrivyForm {
  id?: string | number
  title?: string
  content?: ArrivyComponent[]
}

export function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'section'
}

/** Default vision hint when the form field carries no authored guidance.
 *  Arrivy has no hints field, so a first import derives one from the label;
 *  an editor (human or AI) can overwrite it later and re-import won't
 *  clobber it — see upsertForm(). */
export function defaultHintFor(label: string): string {
  return `The photo must clearly show: ${label}. It should be in focus, well lit, and framed so the subject is unambiguous.`
}

function optionsFor(type: string, c: ArrivyComponentContent): string[] | null {
  if (type === 'DropDownComponent') {
    const raw = c.options
    if (!Array.isArray(raw)) return null
    const out = raw.map(o => o?.label ?? o?.value ?? '').filter(v => v !== '')
    return out.length ? out : null
  }
  if (type === 'ChecklistComponent') {
    const raw = c.items
    if (!Array.isArray(raw)) return null
    const out = raw.map(o => o?.label ?? o?.value ?? o?.text ?? '').filter(v => v !== '')
    return out.length ? out : null
  }
  return null
}

/**
 * Flatten one Arrivy form into sections + fields.
 *
 * Components are y-ordered (Arrivy stores them unordered in the array), and a
 * ScreenBreakComponent opens a new section. Anything before the first break
 * lands in a synthetic "general" section — on the real Site Survey Form that's
 * the routing/consent questions plus the House Number photo.
 */
export function normalizeArrivyForm(raw: ArrivyForm, formType: PhotoGuardFormType): NormalizedForm {
  const comps = [...(raw.content ?? [])].sort((a, b) =>
    (a.yAxisValue ?? 0) - (b.yAxisValue ?? 0) || (a.xAxisValue ?? 0) - (b.xAxisValue ?? 0))

  const sections: NormalizedSection[] = []
  const fields: NormalizedField[] = []
  const usedKeys = new Set<string>()

  let currentKey = 'general'
  let currentSeeded = false
  let sortOrder = 0

  const seedGeneral = () => {
    if (currentSeeded) return
    sections.push({ key: 'general', title: 'General', sortOrder: sections.length })
    usedKeys.add('general')
    currentSeeded = true
  }

  for (const comp of comps) {
    const type = comp.type ?? ''
    const c = comp.content ?? {}

    if (type === SCREEN_BREAK) {
      const title = (c.screenTitle ?? '').trim() || `Section ${sections.length + 1}`
      let key = slugify(title)
      // Two breaks can carry the same title; keep keys unique so fields
      // don't collapse into the wrong group.
      let n = 2
      while (usedKeys.has(key)) key = `${slugify(title)}_${n++}`
      usedKeys.add(key)
      sections.push({ key, title, sortOrder: sections.length })
      currentKey = key
      currentSeeded = true
      continue
    }

    const fieldType = ARRIVY_TYPE_MAP[type] ?? 'unknown'
    const hash = comp.hash != null ? String(comp.hash) : ''
    if (!hash) continue

    // A field before any screen break belongs to the synthetic general section.
    if (currentKey === 'general') seedGeneral()

    const label = (c.label ?? c.title ?? c.text ?? '').trim()
    fields.push({
      hash,
      label: label || (fieldType === 'block' ? '' : `(untitled ${fieldType})`),
      fieldType,
      required: c.isRequired === true,
      options: optionsFor(type, c),
      sectionKey: currentKey,
      sortOrder: sortOrder++,
      hints: fieldType === 'photo' ? defaultHintFor(label || 'the requested subject') : '',
    })
  }

  return {
    formType,
    title: (raw.title ?? '').trim() || formType,
    arrivyFormId: raw.id != null ? String(raw.id) : '',
    sections,
    fields,
  }
}

// ─── Schema ───────────────────────────────────────────────────────────

export function ensurePhotoGuardFormSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS photoguard_forms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      form_type TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'arrivy',
      arrivy_form_id TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      imported_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS photoguard_form_sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      form_id INTEGER NOT NULL REFERENCES photoguard_forms(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      title TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      UNIQUE (form_id, key)
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS photoguard_form_fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      form_id INTEGER NOT NULL REFERENCES photoguard_forms(id) ON DELETE CASCADE,
      hash TEXT NOT NULL,
      label TEXT NOT NULL,
      field_type TEXT NOT NULL,
      required INTEGER NOT NULL DEFAULT 0,
      options TEXT,
      hints TEXT NOT NULL DEFAULT '',
      hints_edited INTEGER NOT NULL DEFAULT 0,
      section_key TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'arrivy',
      ai_readable INTEGER NOT NULL DEFAULT 1,
      ai_writable INTEGER NOT NULL DEFAULT 0,
      retired_at TEXT,
      UNIQUE (form_id, hash)
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS photoguard_requirement_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      form_type TEXT,
      condition_type TEXT NOT NULL,
      condition_field TEXT NOT NULL,
      condition_op TEXT NOT NULL,
      condition_value TEXT,
      target_hashes TEXT NOT NULL DEFAULT '[]',
      target_sections TEXT NOT NULL DEFAULT '[]',
      effect TEXT NOT NULL DEFAULT 'require',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pg_fields_form ON photoguard_form_fields(form_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pg_fields_type ON photoguard_form_fields(field_type)`)
}

// ─── Upsert ───────────────────────────────────────────────────────────

export interface UpsertResult {
  formId: number
  sections: number
  fieldsInserted: number
  fieldsUpdated: number
  fieldsRetired: number
  hintsPreserved: number
}

/**
 * Import a normalized form into the store.
 *
 * Non-destructive by design:
 *  - fields whose `source` is 'custom' are never touched (they're ours, not Arrivy's)
 *  - a hint that's been edited (`hints_edited=1`) survives re-import
 *  - fields that vanish from Arrivy are marked `retired_at`, not deleted, so
 *    historical photos keep resolving their category label
 */
export function upsertForm(form: NormalizedForm): UpsertResult {
  ensurePhotoGuardFormSchema()

  const run = db.transaction((f: NormalizedForm): UpsertResult => {
    db.prepare(`
      INSERT INTO photoguard_forms (form_type, title, source, arrivy_form_id, imported_at, updated_at)
      VALUES (?, ?, 'arrivy', ?, datetime('now'), datetime('now'))
      ON CONFLICT(form_type) DO UPDATE SET
        title = excluded.title,
        arrivy_form_id = excluded.arrivy_form_id,
        version = photoguard_forms.version + 1,
        imported_at = datetime('now'),
        updated_at = datetime('now')
    `).run(f.formType, f.title, f.arrivyFormId)

    const formRow = db.prepare(`SELECT id FROM photoguard_forms WHERE form_type = ?`)
      .get(f.formType) as { id: number }
    const formId = formRow.id

    const secStmt = db.prepare(`
      INSERT INTO photoguard_form_sections (form_id, key, title, sort_order)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(form_id, key) DO UPDATE SET title = excluded.title, sort_order = excluded.sort_order
    `)
    for (const s of f.sections) secStmt.run(formId, s.key, s.title, s.sortOrder)

    const existing = db.prepare(`
      SELECT hash, source, hints_edited FROM photoguard_form_fields WHERE form_id = ?
    `).all(formId) as Array<{ hash: string; source: string; hints_edited: number }>
    const prior = new Map(existing.map(r => [r.hash, r]))

    const insert = db.prepare(`
      INSERT INTO photoguard_form_fields
        (form_id, hash, label, field_type, required, options, hints, section_key, sort_order, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'arrivy')
    `)
    // Deliberately does NOT touch hints — see hint-preservation update below.
    const update = db.prepare(`
      UPDATE photoguard_form_fields
      SET label = ?, field_type = ?, required = ?, options = ?, section_key = ?,
          sort_order = ?, retired_at = NULL
      WHERE form_id = ? AND hash = ?
    `)
    const refreshHint = db.prepare(`
      UPDATE photoguard_form_fields SET hints = ?
      WHERE form_id = ? AND hash = ? AND hints_edited = 0
    `)

    let inserted = 0, updated = 0, hintsPreserved = 0
    const seen = new Set<string>()

    for (const fl of f.fields) {
      seen.add(fl.hash)
      const opts = fl.options ? JSON.stringify(fl.options) : null
      const was = prior.get(fl.hash)
      if (!was) {
        insert.run(formId, fl.hash, fl.label, fl.fieldType, fl.required ? 1 : 0,
          opts, fl.hints, fl.sectionKey, fl.sortOrder)
        inserted++
        continue
      }
      // Fields we authored ourselves are not Arrivy's to overwrite.
      if (was.source === 'custom') continue
      update.run(fl.label, fl.fieldType, fl.required ? 1 : 0, opts,
        fl.sectionKey, fl.sortOrder, formId, fl.hash)
      if (was.hints_edited === 1) hintsPreserved++
      else refreshHint.run(fl.hints, formId, fl.hash)
      updated++
    }

    // Retire (don't delete) Arrivy fields that disappeared upstream.
    let retired = 0
    for (const row of existing) {
      if (seen.has(row.hash) || row.source === 'custom') continue
      db.prepare(`
        UPDATE photoguard_form_fields SET retired_at = datetime('now')
        WHERE form_id = ? AND hash = ? AND retired_at IS NULL
      `).run(formId, row.hash)
      retired++
    }

    return {
      formId,
      sections: f.sections.length,
      fieldsInserted: inserted,
      fieldsUpdated: updated,
      fieldsRetired: retired,
      hintsPreserved,
    }
  })

  return run(form)
}

// ─── Read ─────────────────────────────────────────────────────────────

export interface StoredField {
  hash: string
  label: string
  field_type: FieldType
  required: number
  options: string | null
  hints: string
  section_key: string
  sort_order: number
  source: string
  ai_readable: number
  ai_writable: number
}

export interface StoredForm {
  formType: string
  title: string
  arrivyFormId: string | null
  version: number
  importedAt: string | null
  sections: Array<{ key: string; title: string; sortOrder: number }>
  fields: Array<{
    hash: string
    label: string
    fieldType: FieldType
    required: boolean
    options: string[] | null
    hints: string
    sectionKey: string
    sortOrder: number
    source: string
  }>
}

export function getForm(formType: string): StoredForm | null {
  ensurePhotoGuardFormSchema()
  const form = db.prepare(`
    SELECT id, form_type, title, arrivy_form_id, version, imported_at
    FROM photoguard_forms WHERE form_type = ?
  `).get(formType) as
    | { id: number; form_type: string; title: string; arrivy_form_id: string | null; version: number; imported_at: string | null }
    | undefined
  if (!form) return null

  const sections = db.prepare(`
    SELECT key, title, sort_order FROM photoguard_form_sections
    WHERE form_id = ? ORDER BY sort_order
  `).all(form.id) as Array<{ key: string; title: string; sort_order: number }>

  const fields = db.prepare(`
    SELECT hash, label, field_type, required, options, hints, section_key, sort_order, source
    FROM photoguard_form_fields
    WHERE form_id = ? AND retired_at IS NULL
    ORDER BY sort_order
  `).all(form.id) as StoredField[]

  return {
    formType: form.form_type,
    title: form.title,
    arrivyFormId: form.arrivy_form_id,
    version: form.version,
    importedAt: form.imported_at,
    sections: sections.map(s => ({ key: s.key, title: s.title, sortOrder: s.sort_order })),
    fields: fields.map(f => ({
      hash: f.hash,
      label: f.label,
      fieldType: f.field_type,
      required: f.required === 1,
      options: f.options ? (JSON.parse(f.options) as string[]) : null,
      sectionKey: f.section_key,
      sortOrder: f.sort_order,
      hints: f.hints,
      source: f.source,
    })),
  }
}

/** Category lookup for a photo coming back from Arrivy, by field hash. */
export function findCategory(hash: string): {
  formType: string; label: string; sectionKey: string; hints: string; required: boolean
} | null {
  ensurePhotoGuardFormSchema()
  const row = db.prepare(`
    SELECT f.form_type, ff.label, ff.section_key, ff.hints, ff.required
    FROM photoguard_form_fields ff
    JOIN photoguard_forms f ON f.id = ff.form_id
    WHERE ff.hash = ? AND ff.field_type = 'photo'
    ORDER BY ff.retired_at IS NOT NULL
    LIMIT 1
  `).get(hash) as
    | { form_type: string; label: string; section_key: string; hints: string; required: number }
    | undefined
  if (!row) return null
  return {
    formType: row.form_type,
    label: row.label,
    sectionKey: row.section_key,
    hints: row.hints,
    required: row.required === 1,
  }
}

// ─── Requirement rules ────────────────────────────────────────────────
//
// "Require certain pics depending on what is outstanding at the project level."
// Rules read project_cache and flip individual photo fields (or whole sections)
// between required and optional for a given project.

// ─── Design context ───────────────────────────────────────────────────
//
// The system design is already synced from Quickbase into project_cache —
// module/inverter make+model, counts, system size. Feeding it to the vision
// model turns "is this a photo of an inverter?" into "is this the inverter
// this customer actually bought?", which is the check that catches wrong
// equipment while the crew is still on the roof.

export interface DesignSummary {
  systemSizeKw: number | null
  moduleBrand: string | null
  module: string | null
  panelCount: number | null
  inverterBrand: string | null
  inverter: string | null
  inverterCount: number | null
  /** One-line rendering, used in the vision prompt and the form header. */
  text: string
}

function cleanStr(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

function cleanNum(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Build a design summary from a project_cache row. Returns null when the
 *  project carries nothing useful, so callers can skip the prompt block
 *  rather than inject an empty one. */
export function describeDesign(project: ProjectRow | null): DesignSummary | null {
  if (!project) return null

  const moduleBrand = cleanStr(project['module_brand'])
  const moduleModel = cleanStr(project['module'])
  const inverterBrand = cleanStr(project['inverter_brand'])
  const inverterModel = cleanStr(project['inverter'])
  const kw = cleanNum(project['system_size_kw'])
  const panelCount = cleanNum(project['panel_count'])
  const inverterCount = cleanNum(project['inverter_count'])

  if (!moduleModel && !inverterModel && kw == null) return null

  // Brand is often already embedded in the model string ("Enphase IQ8+"),
  // so don't repeat it.
  const join = (brand: string | null, model: string | null): string | null => {
    if (!model) return brand
    if (!brand) return model
    return model.toLowerCase().includes(brand.toLowerCase()) ? model : `${brand} ${model}`
  }

  const parts: string[] = []
  if (kw != null) parts.push(`${kw} kW system`)

  const mod = join(moduleBrand, moduleModel)
  if (mod) parts.push(panelCount != null ? `${panelCount} × ${mod} modules` : `${mod} modules`)

  const inv = join(inverterBrand, inverterModel)
  if (inv) parts.push(inverterCount != null ? `${inverterCount} × ${inv}` : inv)

  return {
    systemSizeKw: kw,
    moduleBrand, module: moduleModel, panelCount,
    inverterBrand, inverter: inverterModel, inverterCount,
    text: parts.join(' · '),
  }
}

// ─── Merge tokens ─────────────────────────────────────────────────────
//
// Arrivy form text carries {{customer_name}}-style placeholders that its own
// renderer substitutes from the task. We render these forms ourselves, so we
// have to do the substitution — otherwise the field agent reads a literal
// "{{customer_address}}" on their phone.
//
// Vocabulary in the two live forms is small ({{customer_name}},
// {{customer_address}}, {{details}}), but unknown tokens are stripped rather
// than left in place: a blank is a better field experience than braces, and
// new tokens will appear as Arrivy forms are edited.
const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_. ]+)\s*\}\}/g

export interface TokenContext {
  customerName?: string | null
  customerAddress?: string | null
  details?: string | null
}

export function resolveFormTokens(text: string, ctx: TokenContext): string {
  if (!text || !text.includes('{{')) return text
  const map: Record<string, string> = {
    customer_name: ctx.customerName?.trim() || '',
    customer_address: ctx.customerAddress?.trim() || '',
    details: ctx.details?.trim() || '',
  }
  return text.replace(TOKEN_RE, (_m, raw: string) => map[raw.trim().toLowerCase()] ?? '')
}

export function tokenContextFromProject(project: ProjectRow | null): TokenContext {
  if (!project) return {}
  return {
    customerName: cleanStr(project['customer_name']),
    customerAddress: cleanStr(project['customer_address']),
  }
}

export type ConditionType = 'missing_items' | 'attribute' | 'inspection'
export type ConditionOp = 'contains' | 'nonempty' | 'empty' | 'eq' | 'neq' | 'gt' | 'lt'

export interface RequirementRule {
  id?: number
  name: string
  form_type: string | null
  condition_type: ConditionType
  condition_field: string
  condition_op: ConditionOp
  condition_value: string | null
  target_hashes: string
  target_sections: string
  effect: 'require' | 'optional'
  active: number
}

export type ProjectRow = Record<string, unknown>

// QB serializes checkbox fields as the STRINGS 'false'/'true', so a plain
// emptiness test reads "false" as "set" and fires the rule on every project.
// Verified against live data: project_cache.mpu_callout = 'false' on projects
// with no panel upgrade. Treat these as absent.
const FALSEY = new Set(['false', 'no', '0', 'n/a', 'na', 'none', 'null', 'undefined'])

/** True when a project field carries an actual affirmative value. */
export function hasValue(raw: unknown): boolean {
  if (raw == null) return false
  const s = String(raw).trim()
  if (s === '') return false
  return !FALSEY.has(s.toLowerCase())
}

/** Columns a rule is allowed to read. Allowlisted so a rule row can never
 *  reference an arbitrary column (these are user-editable records). */
export const RULE_FIELDS: Record<ConditionType, string[]> = {
  missing_items: ['permit_missing_items', 'nem_missing_items', 'pto_missing_items'],
  attribute: [
    'mpu_callout', 'existing_system', 'system_size_kw', 'module_brand', 'inverter_brand',
    'inverter', 'module', 'state', 'utility_company', 'ahj_name', 'lender', 'epc', 'status',
  ],
  inspection: ['inspx_pass_fail', 'inspx_count', 'inspx_first_time_pass', 'inspx_fail_date'],
}

/**
 * Evaluate one rule against a project_cache row.
 * Pure — no DB access — so the matrix of ops is cheap to unit test.
 */
export function evaluateRule(rule: RequirementRule, project: ProjectRow): boolean {
  if (rule.active !== 1) return false
  const allowed = RULE_FIELDS[rule.condition_type]
  if (!allowed || !allowed.includes(rule.condition_field)) return false

  const raw = project[rule.condition_field]
  const str = raw == null ? '' : String(raw).trim()
  const target = (rule.condition_value ?? '').trim()

  switch (rule.condition_op) {
    case 'nonempty': return hasValue(raw)
    case 'empty': return !hasValue(raw)
    case 'eq': return str.toLowerCase() === target.toLowerCase()
    case 'neq': return str.toLowerCase() !== target.toLowerCase()
    case 'contains': {
      if (target === '' || str === '') return false
      // QB multi-selects arrive semicolon-joined ("Site plan; Load calc").
      // Match a whole entry first, then fall back to substring so a rule
      // written against a plain text column still works.
      const parts = str.split(';').map(p => p.trim().toLowerCase()).filter(Boolean)
      const t = target.toLowerCase()
      return parts.includes(t) || str.toLowerCase().includes(t)
    }
    case 'gt': {
      const a = Number(str), b = Number(target)
      return Number.isFinite(a) && Number.isFinite(b) && a > b
    }
    case 'lt': {
      const a = Number(str), b = Number(target)
      return Number.isFinite(a) && Number.isFinite(b) && a < b
    }
    default: return false
  }
}

export function listRules(formType?: string): RequirementRule[] {
  ensurePhotoGuardFormSchema()
  const rows = formType
    ? db.prepare(`SELECT * FROM photoguard_requirement_rules WHERE form_type IS NULL OR form_type = ? ORDER BY id`).all(formType)
    : db.prepare(`SELECT * FROM photoguard_requirement_rules ORDER BY id`).all()
  return rows as RequirementRule[]
}

export interface ResolvedRequirement {
  required: boolean
  base: boolean
  reasons: string[]
}

/**
 * Overlay active rules onto each photo field's base `required` flag for one
 * project. Returns a map keyed by field hash.
 *
 * Precedence: a matching 'require' rule always wins over a matching 'optional'
 * rule — tightening beats loosening, so a misconfigured optional rule can never
 * silently drop a photo the business needs.
 */
export function resolveRequirements(
  formType: string,
  project: ProjectRow | null,
): Map<string, ResolvedRequirement> {
  const out = new Map<string, ResolvedRequirement>()
  const form = getForm(formType)
  if (!form) return out

  for (const f of form.fields) {
    if (f.fieldType !== 'photo') continue
    out.set(f.hash, { required: f.required, base: f.required, reasons: [] })
  }
  if (!project) return out

  const rules = listRules(formType)
  const requiredBy = new Map<string, string[]>()
  const optionalBy = new Map<string, string[]>()

  for (const rule of rules) {
    if (!evaluateRule(rule, project)) continue

    let hashes: string[] = []
    let sections: string[] = []
    try { hashes = JSON.parse(rule.target_hashes || '[]') as string[] } catch { hashes = [] }
    try { sections = JSON.parse(rule.target_sections || '[]') as string[] } catch { sections = [] }

    const targets = new Set(hashes)
    if (sections.length) {
      for (const f of form.fields) {
        if (f.fieldType === 'photo' && sections.includes(f.sectionKey)) targets.add(f.hash)
      }
    }
    const bucket = rule.effect === 'optional' ? optionalBy : requiredBy
    for (const h of targets) {
      if (!out.has(h)) continue
      const list = bucket.get(h) ?? []
      list.push(rule.name)
      bucket.set(h, list)
    }
  }

  for (const [hash, entry] of out) {
    const req = requiredBy.get(hash)
    const opt = optionalBy.get(hash)
    if (req?.length) {
      entry.required = true
      entry.reasons = req
    } else if (opt?.length) {
      entry.required = false
      entry.reasons = opt
    }
  }
  return out
}

/** Default rules seeded once, covering the three signals chosen for v1.
 *  Targets are section-scoped so they survive an Arrivy re-import changing
 *  individual field hashes. */
export function seedDefaultRules(): void {
  ensurePhotoGuardFormSchema()
  const count = db.prepare(`SELECT COUNT(*) AS n FROM photoguard_requirement_rules`).get() as { n: number }
  if (count.n > 0) return

  const ins = db.prepare(`
    INSERT INTO photoguard_requirement_rules
      (name, form_type, condition_type, condition_field, condition_op, condition_value, target_hashes, target_sections, effect, active)
    VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, 1)
  `)
  // Conditions below use values verified against live project_cache rather
  // than assumed ones — the difference matters, because a rule that misfires
  // sends a crew after photos nobody needs:
  //   mpu_callout      → 'true' (1,087) / 'false' (9,504). NEVER test emptiness.
  //   existing_system  → 'Existing System' (116) / 'No Existing System' (3,048)
  //                      / '' (7,427). "No Existing System" is non-empty but
  //                      means the opposite, so this must be an equality test.
  //   inspx_pass_fail  → 'Pass' / 'Fail' / 'Fail, Pass'. `contains` catches the
  //                      combined value, so a project that failed once still
  //                      gets its re-photos.
  //   *_missing_items  → semicolon-joined multi-selects ('NOC;Permit Expiration').
  const seed: Array<[string, string | null, ConditionType, string, ConditionOp, string | null, string, 'require' | 'optional']> = [
    ['Main panel upgrade called out → require electrical photos', 'site_survey',
      'attribute', 'mpu_callout', 'eq', 'true', JSON.stringify(['electrical_photos']), 'require'],
    ['Main panel upgrade called out → require upgrade photos', 'install_checkout',
      'attribute', 'mpu_callout', 'eq', 'true', JSON.stringify(['electrical_upgrade']), 'require'],
    ['Existing system on site → require existing solar photos', 'site_survey',
      'attribute', 'existing_system', 'eq', 'Existing System', JSON.stringify(['existing_solar']), 'require'],
    ['Inspection has failed → require inspection photos', 'install_checkout',
      'inspection', 'inspx_pass_fail', 'contains', 'Fail', JSON.stringify(['inspection']), 'require'],
    ['AHJ rejected the permit → require site photos', 'site_survey',
      'missing_items', 'permit_missing_items', 'contains', 'AHJ Rejection', JSON.stringify(['site_photos']), 'require'],
  ]
  const tx = db.transaction(() => {
    for (const [name, ft, ct, cf, op, cv, sections, effect] of seed) {
      ins.run(name, ft, ct, cf, op, cv, sections, effect)
    }
  })
  tx()
}
