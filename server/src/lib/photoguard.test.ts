import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

// Point the SQLite handle at a throwaway dir BEFORE db.ts is loaded, so the
// suite never touches a real portal.db. The modules under test are therefore
// imported dynamically in `before` — a static import would be hoisted above
// this assignment, and tsx compiles to CJS here so top-level await is out.
process.env['DATA_DIR'] = fs.mkdtempSync(path.join(os.tmpdir(), 'photoguard-test-'))

// db.ts runs a one-shot chat-thread migration that LEFT JOINs project_cache,
// but that table is created over in routes/projects.ts — so db.ts cannot
// bootstrap a brand-new database on its own. Existing deploys never hit this
// because their DB already has the table. Seed the minimum here so the suite
// stays hermetic; fixing the load-order coupling is out of scope for
// PhotoGuard and would touch unrelated startup code.
{
  const boot = new Database(path.join(process.env['DATA_DIR'], 'portal.db'))
  boot.exec(`CREATE TABLE IF NOT EXISTS project_cache (record_id INTEGER PRIMARY KEY, customer_name TEXT)`)
  boot.close()
}

type Forms = typeof import('./photoguardForms')
type Vision = typeof import('./photoguardVision')
type Quality = typeof import('./photoguardQuality')

let normalizeArrivyForm: Forms['normalizeArrivyForm']
let evaluateRule: Forms['evaluateRule']
let slugify: Forms['slugify']
let defaultHintFor: Forms['defaultHintFor']
let upsertForm: Forms['upsertForm']
let getForm: Forms['getForm']
let resolveRequirements: Forms['resolveRequirements']
let ARRIVY_TYPE_MAP: Forms['ARRIVY_TYPE_MAP']
let describeDesign: Forms['describeDesign']
let resolveFormTokens: Forms['resolveFormTokens']
let detectGrouping: Forms['detectGrouping']
let parseVisionResponse: Vision['parseVisionResponse']
let buildVisionPrompt: Vision['buildVisionPrompt']
let haversineMeters: Quality['haversineMeters']
let dmsToDecimal: Quality['dmsToDecimal']
let runQualityGates: Quality['runQualityGates']
let gatesBlock: Quality['gatesBlock']

before(async () => {
  ({
    normalizeArrivyForm, evaluateRule, slugify, defaultHintFor,
    upsertForm, getForm, resolveRequirements, ARRIVY_TYPE_MAP, describeDesign, resolveFormTokens, detectGrouping,
  } = await import('./photoguardForms'));
  ({ parseVisionResponse, buildVisionPrompt } = await import('./photoguardVision'));
  ({ haversineMeters, dmsToDecimal, runQualityGates, gatesBlock } = await import('./photoguardQuality'))
})

// ─── Fixture ──────────────────────────────────────────────────────────
// Shaped from the live GET /api/forms response (Arrivy, 2026-08-05): a flat
// y-ordered component list where ScreenBreakComponent implies a section, the
// label lives at content.label, and required is content.isRequired.
// Deliberately out of array order to prove we sort by yAxisValue.
function fixtureForm() {
  return {
    id: '6536703100190720',
    title: 'Site Survey Form',
    content: [
      { hash: '650', type: 'ImageUploadComponent', yAxisValue: 30,
        content: { label: 'Photos of Every Roof Plane', isRequired: true } },
      { hash: '1078', type: 'ScreenBreakComponent', yAxisValue: 20,
        content: { screenTitle: 'Roof Photos' } },
      { hash: '438', type: 'ImageUploadComponent', yAxisValue: 5,
        content: { label: 'House Number', isRequired: true } },
      { hash: '173', type: 'ChecklistComponent', yAxisValue: 4,
        content: { label: 'Customer Home', isRequired: true, items: [{ label: 'Yes' }, { label: 'No' }] } },
      { hash: '900', type: 'ScreenBreakComponent', yAxisValue: 40,
        content: { screenTitle: 'Electrical Photos' } },
      { hash: '770', type: 'ImageUploadComponent', yAxisValue: 45,
        content: { label: 'MSP (Dead-front Off)', isRequired: true } },
      { hash: '916', type: 'DropDownComponent', yAxisValue: 46,
        content: { label: 'Panel Rating', isRequired: false,
          options: [{ label: '100A', value: '100A' }, { label: '200A', value: '200A' }] } },
      { hash: '999', type: 'ImageUploadComponent', yAxisValue: 47,
        content: { label: 'Optional Sub Panel', isRequired: false } },
    ],
  }
}

// ─── Form normalization ───────────────────────────────────────────────

test('normalizeArrivyForm groups fields into sections by screen break, in y order', () => {
  const f = normalizeArrivyForm(fixtureForm(), 'site_survey')

  // Components before the first break land in a synthetic "general" section.
  assert.deepEqual(f.sections.map(s => s.key), ['general', 'roof_photos', 'electrical_photos'])
  assert.equal(f.sections[0]?.title, 'General')

  const byHash = new Map(f.fields.map(x => [x.hash, x]))
  assert.equal(byHash.get('173')?.sectionKey, 'general')
  assert.equal(byHash.get('438')?.sectionKey, 'general')
  assert.equal(byHash.get('650')?.sectionKey, 'roof_photos')
  assert.equal(byHash.get('770')?.sectionKey, 'electrical_photos')

  // Sorted by yAxisValue, not array order.
  assert.deepEqual(f.fields.map(x => x.hash), ['173', '438', '650', '770', '916', '999'])
})

test('normalizeArrivyForm maps Arrivy component types and carries required/options', () => {
  const f = normalizeArrivyForm(fixtureForm(), 'site_survey')
  const byHash = new Map(f.fields.map(x => [x.hash, x]))

  assert.equal(byHash.get('438')?.fieldType, 'photo')
  assert.equal(byHash.get('173')?.fieldType, 'checklist')
  assert.equal(byHash.get('916')?.fieldType, 'dropdown')

  assert.equal(byHash.get('438')?.required, true)
  assert.equal(byHash.get('999')?.required, false)

  assert.deepEqual(byHash.get('916')?.options, ['100A', '200A'])
  assert.deepEqual(byHash.get('173')?.options, ['Yes', 'No'])
  assert.equal(byHash.get('438')?.options, null)

  // Photo fields get a derived vision hint; non-photo fields don't.
  assert.match(byHash.get('438')?.hints ?? '', /House Number/)
  assert.equal(byHash.get('916')?.hints, '')

  // Every type seen on the live account is mapped.
  assert.equal(ARRIVY_TYPE_MAP['ImageUploadComponent'], 'photo')
  assert.equal(ARRIVY_TYPE_MAP['SignatureComponent'], 'signature')
})

test('normalizeArrivyForm keeps duplicate section titles distinct', () => {
  const raw = {
    id: '1', title: 'Dup',
    content: [
      { hash: 'a', type: 'ScreenBreakComponent', yAxisValue: 1, content: { screenTitle: 'Electrical' } },
      { hash: 'b', type: 'ImageUploadComponent', yAxisValue: 2, content: { label: 'One' } },
      { hash: 'c', type: 'ScreenBreakComponent', yAxisValue: 3, content: { screenTitle: 'Electrical' } },
      { hash: 'd', type: 'ImageUploadComponent', yAxisValue: 4, content: { label: 'Two' } },
    ],
  }
  const f = normalizeArrivyForm(raw, 'site_survey')
  assert.deepEqual(f.sections.map(s => s.key), ['electrical', 'electrical_2'])
  const byHash = new Map(f.fields.map(x => [x.hash, x]))
  assert.equal(byHash.get('b')?.sectionKey, 'electrical')
  assert.equal(byHash.get('d')?.sectionKey, 'electrical_2')
})

test('slugify and defaultHintFor produce stable, usable values', () => {
  assert.equal(slugify('Roof Photos'), 'roof_photos')
  assert.equal(slugify('MSP (Dead-front Off)'), 'msp_dead_front_off')
  assert.equal(slugify('   '), 'section')
  assert.match(defaultHintFor('Main Breaker'), /Main Breaker/)
})

// ─── Store round-trip ─────────────────────────────────────────────────

test('upsertForm round-trips through the store and is idempotent', () => {
  const f = normalizeArrivyForm(fixtureForm(), 'site_survey')
  const first = upsertForm(f)
  assert.equal(first.fieldsInserted, 6)
  assert.equal(first.sections, 3)

  const stored = getForm('site_survey')
  assert.ok(stored)
  assert.equal(stored.fields.length, 6)
  assert.equal(stored.fields.filter(x => x.fieldType === 'photo').length, 4)

  // Re-import updates rather than duplicating.
  const second = upsertForm(f)
  assert.equal(second.fieldsInserted, 0)
  assert.equal(second.fieldsUpdated, 6)
  assert.equal(getForm('site_survey')?.fields.length, 6)
})

test('re-import preserves edited hints and retires vanished fields', async () => {
  const { default: db } = await import('../db')
  upsertForm(normalizeArrivyForm(fixtureForm(), 'site_survey'))

  // Someone (human or AI) tightens a hint.
  db.prepare(`
    UPDATE photoguard_form_fields SET hints = ?, hints_edited = 1
    WHERE hash = '438'
  `).run('Must show the house number legibly from the street.')

  // Arrivy drops a field on the next import.
  const trimmed = fixtureForm()
  trimmed.content = trimmed.content.filter(c => c.hash !== '999')
  const rep = upsertForm(normalizeArrivyForm(trimmed, 'site_survey'))

  assert.equal(rep.hintsPreserved, 1)
  assert.equal(rep.fieldsRetired, 1)

  const stored = getForm('site_survey')
  assert.match(stored?.fields.find(x => x.hash === '438')?.hints ?? '', /legibly from the street/)
  // Retired fields drop out of the active form but aren't deleted.
  assert.equal(stored?.fields.some(x => x.hash === '999'), false)
})

// ─── Requirement rules ────────────────────────────────────────────────

const RULE = {
  name: 'r', form_type: 'site_survey', condition_type: 'attribute' as const,
  condition_field: 'mpu_callout', condition_op: 'nonempty' as const,
  condition_value: null, target_hashes: '[]', target_sections: '[]',
  effect: 'require' as const, active: 1,
}

test('evaluateRule handles the operator matrix', () => {
  assert.equal(evaluateRule(RULE, { mpu_callout: 'Yes' }), true)
  assert.equal(evaluateRule(RULE, { mpu_callout: '' }), false)
  assert.equal(evaluateRule(RULE, { mpu_callout: null }), false)
  assert.equal(evaluateRule({ ...RULE, condition_op: 'empty' }, { mpu_callout: '' }), true)

  const eq = { ...RULE, condition_type: 'inspection' as const, condition_field: 'inspx_pass_fail', condition_op: 'eq' as const, condition_value: 'Fail' }
  assert.equal(evaluateRule(eq, { inspx_pass_fail: 'Fail' }), true)
  assert.equal(evaluateRule(eq, { inspx_pass_fail: 'fail' }), true, 'case-insensitive')
  assert.equal(evaluateRule(eq, { inspx_pass_fail: 'Pass' }), false)

  const gt = { ...RULE, condition_type: 'inspection' as const, condition_field: 'inspx_count', condition_op: 'gt' as const, condition_value: '1' }
  assert.equal(evaluateRule(gt, { inspx_count: 2 }), true)
  assert.equal(evaluateRule(gt, { inspx_count: 1 }), false)
  assert.equal(evaluateRule(gt, { inspx_count: 'abc' }), false)
})

test('evaluateRule matches semicolon-joined QB multi-selects by whole entry', () => {
  const r = {
    ...RULE, condition_type: 'missing_items' as const,
    condition_field: 'permit_missing_items', condition_op: 'contains' as const,
    condition_value: 'Site Plan',
  }
  assert.equal(evaluateRule(r, { permit_missing_items: 'Load Calc; Site Plan; SLD' }), true)
  assert.equal(evaluateRule(r, { permit_missing_items: 'Load Calc; SLD' }), false)
  assert.equal(evaluateRule(r, { permit_missing_items: '' }), false)
})

test("nonempty treats QB's string 'false' as absent, not as a value", () => {
  // Live data: project_cache.mpu_callout is the string 'false' when no panel
  // upgrade is called out. A naive emptiness test fires on every project.
  assert.equal(evaluateRule(RULE, { mpu_callout: 'false' }), false)
  assert.equal(evaluateRule(RULE, { mpu_callout: 'No' }), false)
  assert.equal(evaluateRule(RULE, { mpu_callout: '0' }), false)
  assert.equal(evaluateRule(RULE, { mpu_callout: 'N/A' }), false)
  assert.equal(evaluateRule(RULE, { mpu_callout: 'true' }), true)
  assert.equal(evaluateRule(RULE, { mpu_callout: 'Yes — 200A' }), true)

  // ...and `empty` is the exact inverse.
  const empty = { ...RULE, condition_op: 'empty' as const }
  assert.equal(evaluateRule(empty, { mpu_callout: 'false' }), true)
  assert.equal(evaluateRule(empty, { mpu_callout: 'true' }), false)
})

test('evaluateRule refuses inactive rules and non-allowlisted columns', () => {
  assert.equal(evaluateRule({ ...RULE, active: 0 }, { mpu_callout: 'Yes' }), false)
  // password_hash is not in RULE_FIELDS — a crafted rule row must not read it.
  const evil = { ...RULE, condition_field: 'password_hash', condition_op: 'nonempty' as const }
  assert.equal(evaluateRule(evil, { password_hash: 'secret' }), false)
})

test('resolveRequirements overlays rules, and require beats optional', async () => {
  const { default: db } = await import('../db')
  upsertForm(normalizeArrivyForm(fixtureForm(), 'site_survey'))
  db.prepare(`DELETE FROM photoguard_requirement_rules`).run()

  const ins = db.prepare(`
    INSERT INTO photoguard_requirement_rules
      (name, form_type, condition_type, condition_field, condition_op, condition_value,
       target_hashes, target_sections, effect, active)
    VALUES (?, 'site_survey', ?, ?, ?, ?, ?, ?, ?, 1)
  `)
  // '999' is optional at base; MPU callout should force it on.
  ins.run('force sub panel', 'attribute', 'mpu_callout', 'nonempty', null,
    JSON.stringify(['999']), '[]', 'require')
  // A conflicting rule tries to relax the same field.
  ins.run('relax sub panel', 'attribute', 'mpu_callout', 'nonempty', null,
    JSON.stringify(['999']), '[]', 'optional')

  const off = resolveRequirements('site_survey', { mpu_callout: '' })
  assert.equal(off.get('999')?.required, false, 'rule does not fire without the callout')
  assert.equal(off.get('438')?.required, true, 'base requirement is untouched')

  const on = resolveRequirements('site_survey', { mpu_callout: 'Yes' })
  assert.equal(on.get('999')?.required, true, 'tightening wins over relaxing')
  assert.deepEqual(on.get('999')?.reasons, ['force sub panel'])

  // Section-scoped targeting survives hash churn.
  db.prepare(`DELETE FROM photoguard_requirement_rules`).run()
  ins.run('whole electrical section', 'attribute', 'existing_system', 'nonempty', null,
    '[]', JSON.stringify(['electrical_photos']), 'require')
  const sec = resolveRequirements('site_survey', { existing_system: 'Yes' })
  assert.equal(sec.get('999')?.required, true)
  assert.equal(sec.get('770')?.required, true)
  assert.equal(sec.get('650')?.required, true, 'roof photo keeps its own base requirement')

  db.prepare(`DELETE FROM photoguard_requirement_rules`).run()
})

// ─── Vision ───────────────────────────────────────────────────────────

test('resolveFormTokens fills Arrivy merge placeholders', () => {
  // Real text from the Install Checkout form — Arrivy's own renderer
  // substitutes these, so ours has to.
  const ctx = { customerName: 'Test James', customerAddress: '12 Oak St, Provo UT' }
  assert.equal(
    resolveFormTokens('{{customer_name}} | {{customer_address}}', ctx),
    'Test James | 12 Oak St, Provo UT',
  )
  assert.equal(resolveFormTokens('{{ customer_name }}', ctx), 'Test James', 'tolerates padding')

  // A token we can't resolve is removed, never left as literal braces on a
  // field agent's screen.
  assert.equal(resolveFormTokens('Notes: {{details}}', ctx), 'Notes: ')
  assert.equal(resolveFormTokens('{{totally_unknown}}', ctx), '')
  assert.equal(resolveFormTokens('{{customer_name}}', {}), '')

  // Untouched when there's nothing to substitute.
  assert.equal(resolveFormTokens('Plain label', ctx), 'Plain label')
})

test('an empty Arrivy TextComponent yields a blank label, not "(untitled block)"', () => {
  const raw = {
    id: '1', title: 'T',
    content: [
      { hash: 'b1', type: 'TextComponent', yAxisValue: 1, content: { text: '' } },
      { hash: 'p1', type: 'ImageUploadComponent', yAxisValue: 2, content: { label: '' } },
    ],
  }
  const f = normalizeArrivyForm(raw, 'site_survey')
  const byHash = new Map(f.fields.map(x => [x.hash, x]))
  // Spacer blocks render as nothing; a nameless photo still needs a label.
  assert.equal(byHash.get('b1')?.label, '')
  assert.equal(byHash.get('p1')?.label, '(untitled photo)')
})

test('describeDesign renders the Quickbase design without repeating the brand', () => {
  // Real shapes from project_cache: the model string usually already contains
  // the brand ('Enphase IQ8+'), and module_brand is often blank.
  assert.equal(
    describeDesign({
      system_size_kw: 11.68, module_brand: 'URE', module: 'URE 365', panel_count: 32,
      inverter_brand: 'Enphase', inverter: 'Enphase IQ8+', inverter_count: 32,
    })?.text,
    '11.68 kW system · 32 × URE 365 modules · 32 × Enphase IQ8+',
  )
  assert.equal(
    describeDesign({ system_size_kw: 6.46, module: 'QCell 340', inverter: 'Enphase IQ 7 Micro' })?.text,
    '6.46 kW system · QCell 340 modules · Enphase IQ 7 Micro',
  )
  // Brand kept when it isn't already in the model string.
  assert.match(
    describeDesign({ module_brand: 'Jinko', module: 'JKM405M-72HL-V' })?.text ?? '',
    /Jinko JKM405M-72HL-V/,
  )
  // Nothing useful → no block at all, rather than an empty one in the prompt.
  assert.equal(describeDesign({ customer_name: 'X' }), null)
  assert.equal(describeDesign(null), null)
})

test('buildVisionPrompt carries the design spec but scopes it to visible labels', () => {
  const p = buildVisionPrompt('Inverter', 'Show the nameplate.', '11.68 kW system · 32 × Enphase IQ8+')
  assert.match(p, /Enphase IQ8\+/)
  assert.match(p, /Equipment specified for this job/)
  // Must not turn every non-equipment photo into a failure.
  assert.match(p, /Do NOT fail a photo merely because equipment is not visible/)

  // Omitted entirely when there's no design.
  assert.equal(/Equipment specified/.test(buildVisionPrompt('Roof Slope', 'x')), false)
})

test('buildVisionPrompt interpolates the category and hints', () => {
  const p = buildVisionPrompt('Main Breaker', 'Show the amperage rating.')
  assert.match(p, /category: "Main Breaker"/)
  assert.match(p, /Show the amperage rating\./)
  assert.match(p, /"passed": true\/false/)
})

test('buildVisionPrompt still reads sensibly with no hints', () => {
  assert.match(buildVisionPrompt('Roof Slope', ''), /No additional requirements/)
})

test('a local Ollama daemon counts as configured without an API key', async () => {
  const { visionConfigured, isLocalBase } = await import('./photoguardVision')
  const key = process.env['OLLAMA_API_KEY']
  const base = process.env['OLLAMA_BASE']
  try {
    delete process.env['OLLAMA_API_KEY']

    // Cloud with no key: genuinely unconfigured.
    process.env['OLLAMA_BASE'] = 'https://ollama.com'
    assert.equal(visionConfigured(), false)

    // A daemon on this machine needs no auth — requiring a key here would
    // make a working local Ollama look broken.
    for (const b of ['http://localhost:11434', 'http://127.0.0.1:11434', 'http://[::1]:11434']) {
      process.env['OLLAMA_BASE'] = b
      assert.equal(isLocalBase(b), true, b)
      assert.equal(visionConfigured(), true, b)
    }

    // A remote host is not local just because it has a port.
    assert.equal(isLocalBase('https://ollama.example.com:11434'), false)

    // Key alone is enough regardless of base.
    process.env['OLLAMA_BASE'] = 'https://ollama.com'
    process.env['OLLAMA_API_KEY'] = 'k'
    assert.equal(visionConfigured(), true)
  } finally {
    if (key === undefined) delete process.env['OLLAMA_API_KEY']
    else process.env['OLLAMA_API_KEY'] = key
    if (base === undefined) delete process.env['OLLAMA_BASE']
    else process.env['OLLAMA_BASE'] = base
  }
})

test('parseVisionResponse reads clean JSON', () => {
  const v = parseVisionResponse('{"passed":true,"confidence":0.91,"issues":[],"description":"A meter."}')
  assert.deepEqual(v, { passed: true, confidence: 0.91, issues: [], description: 'A meter.' })
})

test('parseVisionResponse survives fenced JSON and leading prose', () => {
  const fenced = parseVisionResponse('```json\n{"passed":false,"confidence":0.4,"issues":["blurry"],"description":"x"}\n```')
  assert.equal(fenced?.passed, false)
  assert.deepEqual(fenced?.issues, ['blurry'])

  const prose = parseVisionResponse('Sure! Here is the result:\n{"passed":true,"confidence":0.8,"issues":[],"description":"ok"}\nHope that helps.')
  assert.equal(prose?.passed, true)
})

test('parseVisionResponse normalizes confidence and issue shapes', () => {
  assert.equal(parseVisionResponse('{"passed":true,"confidence":85,"issues":[],"description":""}')?.confidence, 0.85)
  assert.equal(parseVisionResponse('{"passed":true,"confidence":5,"issues":[],"description":""}')?.confidence, 0.05)
  assert.equal(parseVisionResponse('{"passed":true,"confidence":-1,"issues":[],"description":""}')?.confidence, 0)
  assert.equal(parseVisionResponse('{"passed":true,"description":""}')?.confidence, 0, 'missing confidence is not a crash')

  // A single string instead of an array.
  assert.deepEqual(
    parseVisionResponse('{"passed":false,"confidence":0.2,"issues":"too dark","description":""}')?.issues,
    ['too dark'],
  )
  // String booleans.
  assert.equal(parseVisionResponse('{"passed":"yes","confidence":0.5,"issues":[],"description":""}')?.passed, true)
})

test('parseVisionResponse returns null rather than guessing a verdict', () => {
  assert.equal(parseVisionResponse(''), null)
  assert.equal(parseVisionResponse('I cannot analyze this image.'), null)
  assert.equal(parseVisionResponse('{"confidence":0.9,"description":"no verdict"}'), null,
    'missing `passed` must not default to pass')
  assert.equal(parseVisionResponse('[1,2,3]'), null)
  assert.equal(parseVisionResponse('{"passed":"maybe"}'), null)
})

// ─── Geometry / EXIF helpers ──────────────────────────────────────────

test('haversineMeters measures real distances', () => {
  assert.equal(Math.round(haversineMeters(40.7608, -111.8910, 40.7608, -111.8910)), 0)
  // ~1.11 km per 0.01° of latitude.
  const d = haversineMeters(40.0, -111.0, 40.01, -111.0)
  assert.ok(d > 1100 && d < 1120, `expected ~1113m, got ${d}`)
})

test('dmsToDecimal converts EXIF GPS with hemisphere refs', () => {
  assert.equal(dmsToDecimal([40, 45, 36], 'N')?.toFixed(4), '40.7600')
  assert.equal(dmsToDecimal([111, 53, 24], 'W')?.toFixed(4), '-111.8900')
  assert.equal(dmsToDecimal(undefined, 'N'), null)
  assert.equal(dmsToDecimal([], 'N'), null)
})

// ─── Quality gates ────────────────────────────────────────────────────

const GOOD = {
  width: 3000, height: 4000, megapixels: 12, fileSize: 2_400_000, format: 'jpeg',
  hasExif: true, hasGps: true, gpsLat: 40.7608, gpsLng: -111.8910,
  cameraMake: 'Apple', cameraModel: 'iPhone 15', photoTimestamp: '2026-08-05T12:00:00.000Z',
  orientation: 1, contentHash: 'abc',
}
const NOW = new Date('2026-08-05T13:00:00.000Z')

test('a good on-site photo passes every gate', () => {
  const issues = runQualityGates(GOOD, {
    source: 'camera', siteLat: 40.7608, siteLng: -111.8910, now: NOW,
  })
  assert.deepEqual(issues, [])
  assert.equal(gatesBlock(issues), false)
})

test('low resolution blocks', () => {
  const issues = runQualityGates({ ...GOOD, width: 640, height: 480, megapixels: 0.31 },
    { source: 'camera', now: NOW })
  assert.ok(issues.some(i => i.code === 'low_resolution' && i.severity === 'fail'))
  assert.equal(gatesBlock(issues), true)
})

test('an off-site photo blocks and reports the distance', () => {
  // ~1.1km away, well outside the default 300m fence.
  const issues = runQualityGates(GOOD, {
    source: 'camera', siteLat: 40.7708, siteLng: -111.8910, now: NOW,
  })
  const off = issues.find(i => i.code === 'off_site')
  assert.ok(off)
  assert.equal(off?.severity, 'fail')
  assert.match(off?.message ?? '', /from the site address/)
})

test('photo age does not block by default — crews upload from the camera roll later', async () => {
  // Deliberate product decision: photos are routinely uploaded hours or days
  // after the job (drive home, next morning), so age is recorded and shown but
  // never rejected. The geofence carries the provenance load instead, anchored
  // on the project's own coordinates rather than wherever the phone is.
  const old = runQualityGates({ ...GOOD, photoTimestamp: '2026-06-01T12:00:00.000Z' },
    { source: 'upload', now: NOW })
  assert.equal(old.some(i => i.code === 'stale'), false)
  assert.equal(gatesBlock(old), false)

  // ...but the gate is still there when PHOTOGUARD_MAX_AGE_H is set.
  const { MAX_AGE_HOURS } = await import('./photoguardQuality')
  assert.equal(MAX_AGE_HOURS, 0, 'disabled unless explicitly configured')
})

test('a missing capture time is still reported, just not fatal', () => {
  const issues = runQualityGates({ ...GOOD, photoTimestamp: null }, { source: 'upload', now: NOW })
  const t = issues.find(i => i.code === 'no_timestamp')
  assert.equal(t?.severity, 'warn')
  assert.equal(gatesBlock(issues), false)
})

test('a re-used image is caught as a duplicate', () => {
  const issues = runQualityGates(GOOD, {
    source: 'camera', now: NOW, knownHashes: new Set(['abc']),
  })
  assert.ok(issues.some(i => i.code === 'duplicate' && i.severity === 'fail'))
})

test('video frames are not punished for lacking EXIF, but uploads are warned', () => {
  const frame = runQualityGates(
    { ...GOOD, hasExif: false, hasGps: false, gpsLat: null, gpsLng: null, photoTimestamp: null },
    { source: 'video_frame', deviceLat: 40.7608, deviceLng: -111.8910,
      capturedAt: '2026-08-05T12:30:00.000Z', siteLat: 40.7608, siteLng: -111.8910, now: NOW },
  )
  assert.equal(frame.some(i => i.code === 'no_exif'), false, 'a frame cannot carry EXIF')
  assert.equal(gatesBlock(frame), false, 'session provenance stands in for EXIF')

  const picked = runQualityGates({ ...GOOD, hasExif: false }, { source: 'upload', now: NOW })
  const warn = picked.find(i => i.code === 'no_exif')
  assert.equal(warn?.severity, 'warn', 'suspicious, but not worth blocking on')
})

test('device geolocation substitutes for missing EXIF GPS', () => {
  const issues = runQualityGates(
    { ...GOOD, hasGps: false, gpsLat: null, gpsLng: null },
    { source: 'camera', deviceLat: 40.7608, deviceLng: -111.8910,
      siteLat: 40.7608, siteLng: -111.8910, now: NOW },
  )
  assert.equal(issues.some(i => i.code === 'no_gps'), false)
  assert.equal(gatesBlock(issues), false)
})

test('an undecodable image fails fast without cascading errors', () => {
  const issues = runQualityGates({ ...GOOD, width: 0, height: 0, megapixels: 0 },
    { source: 'camera', now: NOW })
  assert.equal(issues.length, 1)
  assert.equal(issues[0]?.code, 'unreadable')
})

// ─── Job reviewer ─────────────────────────────────────────────────────

test('parseReviewFindings accepts both shapes and normalizes fields', async () => {
  const { parseReviewFindings } = await import('./photoguardReview')

  const wrapped = parseReviewFindings(JSON.stringify({
    findings: [{
      kind: 'mismatch', severity: 'blocker',
      title: 'Inverter does not match the design',
      detail: 'Photo 12 shows a SolarEdge unit; the job sold Enphase IQ8+.',
      requirementHash: '770', photoIds: [12, 13],
    }],
  }))
  assert.equal(wrapped?.length, 1)
  assert.equal(wrapped?.[0]?.kind, 'mismatch')
  assert.equal(wrapped?.[0]?.severity, 'blocker')
  assert.deepEqual(wrapped?.[0]?.photoIds, [12, 13])

  // A bare array is accepted too — models drop the wrapper often enough.
  assert.equal(parseReviewFindings('[{"title":"x","kind":"gap","severity":"note"}]')?.length, 1)
})

test('parseReviewFindings treats an empty result as success, not failure', async () => {
  const { parseReviewFindings } = await import('./photoguardReview')
  // A clean job MUST be able to produce zero findings — distinct from a parse
  // failure, which returns null and is reported as "review didn't run".
  assert.deepEqual(parseReviewFindings('{"findings":[]}'), [])
  assert.deepEqual(parseReviewFindings('[]'), [])
  assert.equal(parseReviewFindings('the job looks fine to me'), null)
  assert.equal(parseReviewFindings(''), null)
})

test('parseReviewFindings is defensive about junk the model invents', async () => {
  const { parseReviewFindings } = await import('./photoguardReview')
  const out = parseReviewFindings(JSON.stringify({
    findings: [
      { title: '', kind: 'gap' },                                  // no title → dropped
      { title: 'Unknown kind', kind: 'vibes', severity: 'urgent' }, // coerced
      { title: 'Bad ids', photoIds: ['a', 3, null] },               // filtered
      { title: 'Null hash', requirementHash: 'null' },              // treated as absent
    ],
  }))
  assert.equal(out?.length, 3, 'the untitled finding is dropped')
  assert.equal(out?.[0]?.kind, 'other', 'unknown kind lands on other, not safety')
  assert.equal(out?.[0]?.severity, 'note')
  assert.deepEqual(out?.[1]?.photoIds, [3])
  assert.equal(out?.[2]?.requirementHash, null)
})

test('review findings fingerprint stably so re-runs update instead of duplicating', async () => {
  const { fingerprint } = await import('./photoguardReview')
  const base = { kind: 'gap' as const, severity: 'warning' as const, detail: 'd', requirementHash: '770', photoIds: [1] }
  // Models rephrase capitalisation and punctuation between runs.
  assert.equal(
    fingerprint({ ...base, title: 'Missing rapid-shutdown label' }),
    fingerprint({ ...base, title: 'missing rapid shutdown label!' }),
  )
  // Genuinely different complaints stay distinct.
  assert.notEqual(
    fingerprint({ ...base, title: 'Missing rapid-shutdown label' }),
    fingerprint({ ...base, title: 'Missing placard at meter' }),
  )
})

test('buildReviewPrompt tells the model that silence is an acceptable answer', async () => {
  const { buildReviewPrompt } = await import('./photoguardReview')
  const p = buildReviewPrompt({
    formTitle: 'Field Task Site Checkout V1.02',
    design: '11.68 kW system · 32 × Enphase IQ8+',
    sections: [{ title: 'Electrical section', required: 46, satisfied: 12 }],
    captured: [{ photoId: 1, requirement: 'Inverter', section: 'Electrical section',
      passed: true, description: 'A SolarEdge inverter on a stucco wall.', issues: [] }],
    missing: [{ hash: '9', label: 'Rapid shutdown label', section: 'Electrical section' }],
    answers: [{ label: 'Crew lead', value: 'James' }],
  })
  assert.match(p, /11\.68 kW system/)
  assert.match(p, /SolarEdge inverter on a stucco wall/)
  assert.match(p, /empty array is a correct and\s+expected answer/)
  assert.match(p, /You cannot see the\s+photos/)
  // Must not nag about the outstanding list the form already shows.
  assert.match(p, /Do NOT report a required photo as missing just because/)
})

// ─── Method branching ─────────────────────────────────────────────────

test('an answer can branch the job into extra requirements', async () => {
  const { default: db } = await import('../db')
  upsertForm(normalizeArrivyForm(fixtureForm(), 'site_survey'))
  db.prepare(`DELETE FROM photoguard_requirement_rules`).run()

  // "If you used an Ironridge clamp, we need the torque marking" — the branch
  // doesn't exist until someone on site picks a method.
  db.prepare(`
    INSERT INTO photoguard_requirement_rules
      (name, form_type, condition_type, condition_field, condition_op, condition_value,
       target_hashes, target_sections, effect, active)
    VALUES ('Ironridge clamp needs torque photo', 'site_survey', 'answer', '916',
            'contains', 'Ironridge', ?, '[]', 'require', 1)
  `).run(JSON.stringify(['999']))

  // '999' is optional at base.
  assert.equal(resolveRequirements('site_survey', null).get('999')?.required, false)

  // Another method selected — rule stays quiet.
  const other = resolveRequirements('site_survey', null, new Map([['916', 'Unirac']]))
  assert.equal(other.get('999')?.required, false)

  // The method that demands the extra evidence.
  const branched = resolveRequirements('site_survey', null, new Map([['916', 'Ironridge FlashFoot2']]))
  assert.equal(branched.get('999')?.required, true)
  assert.deepEqual(branched.get('999')?.reasons, ['Ironridge clamp needs torque photo'])

  db.prepare(`DELETE FROM photoguard_requirement_rules`).run()
})

test('answer rules are ignored without answers, and are not bound by the project allowlist', async () => {
  const rule = {
    name: 'r', form_type: 'site_survey', condition_type: 'answer' as const,
    condition_field: '916', condition_op: 'eq' as const, condition_value: 'Ironridge',
    target_hashes: '[]', target_sections: '[]', effect: 'require' as const, active: 1,
  }
  // No answers supplied at all.
  assert.equal(evaluateRule(rule, {}), false)
  // A form field hash is not a project_cache column, and must not be rejected
  // for failing that allowlist.
  assert.equal(evaluateRule(rule, {}, new Map([['916', 'Ironridge']])), true)
  assert.equal(evaluateRule(rule, {}, new Map([['916', 'Unirac']])), false)
})

// ─── Example scoring ──────────────────────────────────────────────────

test('scoreCandidate ranks human approval above model confidence', async () => {
  const { scoreCandidate } = await import('./photoguardExamples')
  const base = { megapixels: 12, hasExif: 1, hasGps: 1, gateStatus: 'ok' as string | null }

  const humanApproved = scoreCandidate({ ...base, validationPassed: 1, validationConfidence: 0.5, reviewStatus: 'approved' })
  const modelOnly = scoreCandidate({ ...base, validationPassed: 1, validationConfidence: 1.0, reviewStatus: null })
  assert.ok(humanApproved > modelOnly,
    'a human-approved photo must outrank one the model merely liked — otherwise the model picks its own teaching examples')
})

test('scoreCandidate refuses anything a reviewer or gate rejected', async () => {
  const { scoreCandidate } = await import('./photoguardExamples')
  const base = { megapixels: 12, hasExif: 1, hasGps: 1, validationConfidence: 0.99, validationPassed: 1 }
  assert.equal(scoreCandidate({ ...base, reviewStatus: 'rejected', gateStatus: 'ok' }), 0)
  assert.equal(scoreCandidate({ ...base, reviewStatus: 'resubmit', gateStatus: 'ok' }), 0)
  assert.equal(scoreCandidate({ ...base, reviewStatus: null, gateStatus: 'blocked' }), 0)
  assert.equal(scoreCandidate({ ...base, validationPassed: 0, reviewStatus: null, gateStatus: 'ok' }), 0)
  // ...but a human override beats a model failure.
  assert.ok(scoreCandidate({ ...base, validationPassed: 0, reviewStatus: 'approved', gateStatus: 'ok' }) > 0)
})

test('scoreCandidate caps the resolution reward so a huge photo of nothing cannot win', async () => {
  const { scoreCandidate } = await import('./photoguardExamples')
  const mk = (megapixels: number) => scoreCandidate({
    megapixels, hasExif: 1, hasGps: 1, validationPassed: 1,
    validationConfidence: 0.9, reviewStatus: 'approved', gateStatus: 'ok',
  })
  assert.equal(mk(48), mk(12), 'resolution saturates')
  assert.ok(mk(12) > mk(2))
  assert.ok(mk(48) <= 100)
})

// ─── Collective requirements ──────────────────────────────────────────

test('detectGrouping reads multi-photo requirements from real Arrivy labels', () => {
  // Explicit counts.
  assert.deepEqual(detectGrouping('360 Degree of Sub panel room (8 Photos)'),
    { collective: true, expectedCount: 8 })
  assert.deepEqual(detectGrouping('Rafter size (Measuring Tape | 2 Photos)'),
    { collective: true, expectedCount: 2 })
  assert.deepEqual(detectGrouping('Foundation Attachment Point(s) (3 Photos)'),
    { collective: true, expectedCount: 3 })

  // "(1 Photo)" is a single shot, NOT a set.
  assert.deepEqual(detectGrouping('Knee Wall (1 Photo)'),
    { collective: false, expectedCount: 1 })

  // One-each-of-N, count unknown until someone counts them.
  assert.deepEqual(detectGrouping('Panel Sticker (1 Photo per Sticker)'),
    { collective: true, expectedCount: null })
  assert.deepEqual(detectGrouping('Meter Wall (1 Photo per Meter)'),
    { collective: true, expectedCount: null })

  // Collective by wording.
  assert.deepEqual(detectGrouping('Photos of Every Roof Plane'),
    { collective: true, expectedCount: null })
  assert.equal(detectGrouping('360-Degree View of Attic (8 Photos)').collective, true)
})

test('detectGrouping does not mistake a content requirement for a set', () => {
  // The counterexample that matters: one photo that must SHOW everything is
  // not the same as a set of photos. Treating it as collective would stop us
  // failing a photo that genuinely misses the point.
  assert.deepEqual(detectGrouping('Final Array ( must be able to count all panels)'),
    { collective: false, expectedCount: null })
  assert.equal(detectGrouping('Rail Bonding (bare copper on each row or Bonding Clips)').collective, false)
  assert.equal(detectGrouping('MSP (Dead-front Off)').collective, false)
  assert.equal(detectGrouping('House Number').collective, false)
  assert.equal(detectGrouping('').collective, false)
})

test('a collective photo is judged as a contribution, not as the whole job', () => {
  const label = 'Photos of Every Roof Plane'
  const solo = buildVisionPrompt(label, 'Show the roof planes.')
  const group = buildVisionPrompt(label, 'Show the roof planes.', undefined,
    { collective: true, expectedCount: null, position: 3, total: 15 })

  // The failure that was happening: every single roof photo rejected for not
  // showing all the planes.
  assert.match(group, /MULTI-PHOTO REQUIREMENT/)
  assert.match(group, /Do NOT fail it for being partial/)
  assert.match(group, /photo 3 of 15/)
  assert.match(group, /Penalising a single photo for not\s+showing everything is always wrong/)

  // "Wrong angle" must not survive into a set member's fail criteria.
  assert.equal(/- Wrong angle or doesn't show what's needed/.test(group), false)
  assert.equal(/- Wrong angle or doesn't show what's needed/.test(solo), true)

  // A normal requirement is unchanged.
  assert.equal(/MULTI-PHOTO REQUIREMENT/.test(solo), false)
})

test('normalizeArrivyForm carries grouping onto photo fields', () => {
  const raw = {
    id: '1', title: 'T',
    content: [
      { hash: 'a', type: 'ImageUploadComponent', yAxisValue: 1,
        content: { label: '360 Degree of Sub panel room (8 Photos)', isRequired: true } },
      { hash: 'b', type: 'ImageUploadComponent', yAxisValue: 2,
        content: { label: 'House Number', isRequired: true } },
      { hash: 'c', type: 'DropDownComponent', yAxisValue: 3, content: { label: 'Panel Rating' } },
    ],
  }
  const f = normalizeArrivyForm(raw, 'site_survey')
  const byHash = new Map(f.fields.map(x => [x.hash, x]))
  assert.equal(byHash.get('a')?.collective, true)
  assert.equal(byHash.get('a')?.expectedCount, 8)
  assert.equal(byHash.get('b')?.collective, false)
  // Non-photo fields never carry grouping.
  assert.equal(byHash.get('c')?.collective, false)
})

// ─── Duplicate detection & set coverage ───────────────────────────────

test('hammingDistance and near-duplicate thresholds behave', async () => {
  const { hammingDistance, isNearDuplicate } = await import('./photoguardQuality')
  assert.equal(hammingDistance('ffffffffffffffff', 'ffffffffffffffff'), 0)
  assert.equal(hammingDistance('0000000000000000', 'ffffffffffffffff'), 64)
  assert.equal(hammingDistance('0000000000000001', '0000000000000000'), 1)
  // Same shot, tiny difference.
  assert.equal(isNearDuplicate('0000000000000003', '0000000000000000'), true)
  // Genuinely different subject.
  assert.equal(isNearDuplicate('ffffffffffffffff', '0000000000000000'), false)
  // A missing hash must never be treated as a match — that would silently
  // collapse real coverage.
  assert.equal(isNearDuplicate(null, '0000000000000000'), false)
  assert.equal(isNearDuplicate('0000000000000000', null), false)
})

test('clusterByLikeness counts distinct subjects, not photos', async () => {
  const { clusterByLikeness } = await import('./photoguardQuality')
  // Nineteen shots of one plane must not read as nineteen pieces of evidence.
  const sameThing = Array.from({ length: 19 }, (_, i) => ({ id: i + 1, phash: '0000000000000000' }))
  assert.equal(clusterByLikeness(sameThing).length, 1)

  const threePlanes = [
    { id: 1, phash: '0000000000000000' },
    { id: 2, phash: '0000000000000001' },   // same as 1
    { id: 3, phash: 'ffffffffffffffff' },
    { id: 4, phash: '0f0f0f0f0f0f0f0f' },
  ]
  const clusters = clusterByLikeness(threePlanes)
  assert.equal(clusters.length, 3)
  assert.deepEqual(clusters[0], [1, 2])
})

test('parseSetVerdict refuses to guess whether a set is satisfied', async () => {
  const { parseSetVerdict } = await import('./photoguardSets')
  const ok = parseSetVerdict('{"satisfied":false,"confidence":0.8,"covered":["front"],"missing":["rear plane"],"note":"n"}')
  assert.equal(ok?.satisfied, false)
  assert.deepEqual(ok?.missing, ['rear plane'])

  assert.equal(parseSetVerdict('{"confidence":0.9,"note":"looks fine"}'), null,
    'missing `satisfied` must not default to satisfied')
  assert.equal(parseSetVerdict('the roof looks covered'), null)
  assert.equal(parseSetVerdict('{"satisfied":"maybe"}'), null)
  assert.equal(parseSetVerdict('{"satisfied":"yes","confidence":85}')?.confidence, 0.85)
})

test('the set prompt judges coverage on distinct content, not photo count', async () => {
  const { buildSetPrompt } = await import('./photoguardSets')
  const members = [
    { id: 1, description: 'Front roof plane', passed: 1, phash: 'a' },
    { id: 2, description: 'Front roof plane again', passed: 1, phash: 'a' },
    { id: 3, description: 'Left roof plane', passed: 1, phash: 'b' },
  ]
  const p = buildSetPrompt('Photos of Every Roof Plane', 'Show every plane', members, [[1, 2], [3]], 8)

  assert.match(p, /photos 1, 2 look like the same shot/)
  assert.match(p, /Treat each of those groups as ONE piece of evidence/)
  assert.match(p, /Judge COVERAGE, not quantity/)
  assert.match(p, /the same subject photographed repeatedly does not become coverage/)
  assert.match(p, /about 8 photos/)
  // It must be able to say "this is fine" without inventing gaps.
  assert.match(p, /do not invent gaps/)

  // With no duplicates it says so rather than implying some.
  assert.match(buildSetPrompt('X', '', members, [[1], [2], [3]], null), /No near-duplicates detected/)
})

// ─── Drop-mode classification ─────────────────────────────────────────

const CATALOGUE = [
  { hash: '770', label: 'MSP (Dead-front Off)', section: 'Electrical', hints: '', collective: false, satisfied: false },
  { hash: '792', label: 'Panel Schedule', section: 'Electrical', hints: '', collective: false, satisfied: false },
  { hash: '650', label: 'Photos of Every Roof Plane', section: 'Roof', hints: '', collective: true, satisfied: false },
]

test('parseClassification keeps only ids that exist in the catalogue', async () => {
  const { parseClassification } = await import('./photoguardClassify')
  const c = parseClassification(JSON.stringify({
    description: 'An open electrical panel.',
    subject: 'main service panel',
    candidates: [
      { id: '770', confidence: 0.92, satisfies: true, reason: 'dead front is off' },
      { id: '9999', confidence: 0.8, satisfies: true, reason: 'invented requirement' },
      { id: '792', confidence: 0.4, satisfies: false, reason: 'schedule not readable' },
    ],
  }), CATALOGUE)

  // A hallucinated id must be dropped, not filed against.
  assert.equal(c?.candidates.length, 2)
  assert.deepEqual(c?.candidates.map(x => x.hash), ['770', '792'])
  // Labels come from the catalogue, never from the model.
  assert.equal(c?.candidates[0]?.label, 'MSP (Dead-front Off)')
  assert.equal(c?.unmatched, false)
})

test('parseClassification treats no usable candidate as unmatched', async () => {
  const { parseClassification } = await import('./photoguardClassify')
  assert.equal(parseClassification('{"candidates":[],"unmatched":true}', CATALOGUE)?.unmatched, true)
  // Every id invented -> nothing usable left.
  assert.equal(parseClassification('{"candidates":[{"id":"nope","confidence":0.9}]}', CATALOGUE)?.unmatched, true)
  assert.equal(parseClassification('not json at all', CATALOGUE), null)
})

test('isAuthoredHint separates real guidance from generated boilerplate', async () => {
  const { isAuthoredHint } = await import('./photoguardClassify')
  // What defaultHintFor produces — restates the label, discriminates nothing.
  assert.equal(isAuthoredHint('The photo must clearly show: Main Breaker (1 Photo). It should be in focus.'), false)
  assert.equal(isAuthoredHint(''), false)
  // What a reviewer writes — the thing that actually separates siblings.
  assert.equal(isAuthoredHint('Dead front removed, busbar rating sticker readable'), true)
})

test('decideFiling suggests rather than files while auto-filing is off', async () => {
  const { decideFiling, AUTO_FILE_ENABLED } = await import('./photoguardClassify')
  assert.equal(AUTO_FILE_ENABLED, false, 'auto-filing must be opt-in')
  // Even a 0.99 winner is only a suggestion by default: blind-testing showed
  // confident picks between sibling requirements were wrong.
  const c = {
    description: '', subject: '', unmatched: false,
    candidates: [{ hash: '770', label: 'MSP', confidence: 0.99, satisfies: true, reason: '' }],
  }
  assert.deepEqual(decideFiling(c), { hash: null, reason: 'suggest_only' })
})

test('decideFiling only auto-files a clear winner', async () => {
  const { decideFiling } = await import('./photoguardClassify')
  const mk = (cands: Array<[string, number]>) => ({
    description: '', subject: '', unmatched: false,
    candidates: cands.map(([hash, confidence]) => ({
      hash, label: hash, confidence, satisfies: true, reason: '',
    })),
  })

  // With auto-filing off (the default) everything is a suggestion.
  assert.equal(decideFiling(mk([['770', 0.93], ['792', 0.2]])).reason, 'suggest_only')

  // Two plausible requirements — a human decides. Filing a photo under the
  // wrong requirement silently marks it satisfied by evidence that doesn't
  // show it.
  assert.equal(decideFiling(mk([['770', 0.72], ['792', 0.68]])).hash, null)
  assert.equal(decideFiling(mk([['770', 0.55]])).hash, null)
  assert.equal(decideFiling({ description: '', subject: '', unmatched: true, candidates: [] }).hash, null)
})

test('the classify prompt lists requirements by id and refuses forced matches', async () => {
  const { buildClassifyPrompt } = await import('./photoguardClassify')
  const p = buildClassifyPrompt(CATALOGUE)
  assert.match(p, /770 \| MSP \(Dead-front Off\)/)
  assert.match(p, /650 \| Photos of Every Roof Plane \(multi-photo\)/)
  assert.match(p, /Electrical:/)
  assert.match(p, /Do not force a match/)
  assert.match(p, /a human will decide/)
  // "matches" and "satisfies" are different questions and must stay separate.
  assert.match(p, /can MATCH a\s+requirement but not satisfy it/)
})

test('buildClassifyPrompt marks requirements that already have photos', async () => {
  const { buildClassifyPrompt } = await import('./photoguardClassify')
  const p = buildClassifyPrompt([{ ...CATALOGUE[0]!, satisfied: true }, CATALOGUE[1]!])
  assert.match(p, /MSP \(Dead-front Off\) \[already has photos\]/)
  assert.equal(/Panel Schedule \[already has photos\]/.test(p), false)
})
