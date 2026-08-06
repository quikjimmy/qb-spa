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
let parseVisionResponse: Vision['parseVisionResponse']
let buildVisionPrompt: Vision['buildVisionPrompt']
let haversineMeters: Quality['haversineMeters']
let dmsToDecimal: Quality['dmsToDecimal']
let runQualityGates: Quality['runQualityGates']
let gatesBlock: Quality['gatesBlock']

before(async () => {
  ({
    normalizeArrivyForm, evaluateRule, slugify, defaultHintFor,
    upsertForm, getForm, resolveRequirements, ARRIVY_TYPE_MAP, describeDesign, resolveFormTokens,
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

test('a stale photo blocks; a fresh one does not', () => {
  const old = runQualityGates({ ...GOOD, photoTimestamp: '2026-08-01T12:00:00.000Z' },
    { source: 'camera', now: NOW })
  assert.ok(old.some(i => i.code === 'stale' && i.severity === 'fail'))

  const fresh = runQualityGates(GOOD, { source: 'camera', now: NOW })
  assert.equal(fresh.some(i => i.code === 'stale'), false)
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
