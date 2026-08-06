// Classify a dropped photo against the requirement catalogue.
//
// The form-as-slots model makes a crew pick a field before every shot. Inverted
// here: photos are dropped in bulk and the app works out what each one is,
// which requirement it satisfies, and what's still outstanding. The form
// becomes a checklist that fills itself.
//
// The judgement that matters is not "what is this a photo of" — the vision
// model is good at that — but "which of these 79 requirements does it answer".
// Those requirements overlap by design (a panel photo could be MSP, Panel
// Sticker, or Busbar), so the classifier returns RANKED candidates and we only
// file automatically when one clearly wins. Filing a photo under the wrong
// requirement is worse than asking, because it silently marks a requirement
// satisfied by evidence that doesn't show it.
import { callModelWithImages, extractJson, visionConfigured, VisionNotConfiguredError } from './photoguardVision'
import { getForm } from './photoguardForms'
import { labelsFor } from './photoguardExamples'

export interface CatalogueEntry {
  hash: string
  label: string
  section: string
  hints: string
  collective: boolean
  /** Already satisfied — the model is told, so it can prefer an open one. */
  satisfied: boolean
}

export interface ClassificationCandidate {
  hash: string
  label: string
  confidence: number
  satisfies: boolean
  reason: string
}

export interface Classification {
  description: string
  subject: string
  candidates: ClassificationCandidate[]
  /** Set when nothing in the catalogue plausibly matches. */
  unmatched: boolean
}

// Auto-filing is OFF by default, and that is a measured decision rather than
// caution for its own sake. Blind-tested on four real photos whose requirement
// was known, the classifier put the correct one outside the top pick every
// time and would have auto-filed two of them wrongly.
//
// The cause is not the model: requirements like "MSP (Dead-front Off)", "Main
// Breaker", "Busbar" and "Panel Schedule" are all photos of the same panel, and
// nothing on record says what separates them — the stored hints are generated
// boilerplate that restate the label. Until a requirement carries a real
// discriminator (an authored hint, or labels on a promoted example), a
// confident-looking pick between siblings is a coin toss with a decimal point.
//
// So drop mode SUGGESTS and a human confirms with one tap. Set
// PHOTOGUARD_AUTOFILE=1 once discriminators exist and accuracy has been
// re-measured.
export const AUTO_FILE_ENABLED = process.env['PHOTOGUARD_AUTOFILE'] === '1'
export const AUTO_FILE_CONFIDENCE = Number(process.env['PHOTOGUARD_AUTOFILE_CONF'] || 0.85)
export const AUTO_FILE_MARGIN = Number(process.env['PHOTOGUARD_AUTOFILE_MARGIN'] || 0.25)

/** Generated hints restate the label and discriminate nothing — including them
 *  is pure noise in a 79-way choice. Authored ones are the whole point. */
export function isAuthoredHint(hint: string): boolean {
  const h = (hint ?? '').trim()
  if (!h) return false
  return !/^The photo must clearly show:/i.test(h)
}

export function buildCatalogue(formType: string, satisfiedHashes = new Set<string>()): CatalogueEntry[] {
  const form = getForm(formType)
  if (!form) return []
  const titles = new Map(form.sections.map(s => [s.key, s.title]))
  return form.fields
    .filter(f => f.fieldType === 'photo')
    .map(f => {
      // Labels a reviewer attached to an exemplar are authored discriminators —
      // exactly the "what makes this one different" the generated hints lack.
      const taught = labelsFor(f.hash)
      const hints = taught.length
        ? `look for: ${taught.join('; ')}`
        : (isAuthoredHint(f.hints) ? f.hints : '')
      return {
        hash: f.hash,
        label: f.label,
        section: titles.get(f.sectionKey) ?? f.sectionKey,
        hints,
        collective: f.collective,
        satisfied: satisfiedHashes.has(f.hash),
      }
    })
}

export function buildClassifyPrompt(catalogue: CatalogueEntry[]): string {
  // Grouped by section and kept terse — the full hint text for 79 entries
  // would crowd out the actual task.
  const bySection = new Map<string, CatalogueEntry[]>()
  for (const c of catalogue) {
    const list = bySection.get(c.section) ?? []
    list.push(c)
    bySection.set(c.section, list)
  }
  // Authored guidance is what separates siblings; generated boilerplate is
  // dropped so it can't drown the real signal.
  const listing = [...bySection.entries()].map(([section, items]) =>
    `${section}:\n` + items.map(i => {
      const extra = isAuthoredHint(i.hints) ? ` — ${i.hints.slice(0, 160)}` : ''
      return `  ${i.hash} | ${i.label}${i.collective ? ' (multi-photo)' : ''}` +
        `${i.satisfied ? ' [already has photos]' : ''}${extra}`
    }).join('\n'),
  ).join('\n\n')

  return `You are filing a photo from a solar site visit against a list of documentation requirements.

THE REQUIREMENTS (id | description):

${listing}

Look at the attached photo and decide which requirement(s) it answers.

Rules:
- Return up to 3 candidates, best first, each with a confidence 0.0-1.0.
- Use the ids exactly as given.
- Many requirements are similar. If the photo genuinely could belong to more
  than one, say so with close confidences rather than picking arbitrarily —
  a human will decide.
- "satisfies" means the photo is good enough to count as evidence for that
  requirement: right subject, in focus, readable. A photo can MATCH a
  requirement but not satisfy it (e.g. right panel, label unreadable).
- For a multi-photo requirement, "satisfies" means it is a usable contribution,
  not that it completes the set on its own.
- If nothing in the list fits, return an empty candidates array and set
  "unmatched": true. Do not force a match.

Respond with JSON ONLY:
{
  "description": "what the photo shows, one or two sentences",
  "subject": "short label for the subject, e.g. 'main service panel, dead front off'",
  "unmatched": false,
  "candidates": [
    { "id": "770", "confidence": 0.9, "satisfies": true, "reason": "why this requirement" }
  ]
}`
}

export function parseClassification(raw: string, catalogue: CatalogueEntry[]): Classification | null {
  const obj = extractJson(raw)
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const o = obj as Record<string, unknown>

  const byHash = new Map(catalogue.map(c => [c.hash, c]))
  const rawList = Array.isArray(o['candidates']) ? o['candidates'] : []

  const candidates: ClassificationCandidate[] = []
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue
    const c = item as Record<string, unknown>
    const hash = c['id'] != null ? String(c['id']).trim() : ''
    const entry = byHash.get(hash)
    // A hash the model invented is worse than no answer — drop it rather than
    // filing a photo against a requirement that doesn't exist.
    if (!entry) continue

    const confRaw = typeof c['confidence'] === 'number' ? c['confidence'] : Number(c['confidence'])
    const confidence = Number.isFinite(confRaw)
      ? Math.min(1, Math.max(0, confRaw > 1 ? confRaw / 100 : confRaw))
      : 0

    candidates.push({
      hash,
      label: entry.label,
      confidence,
      satisfies: c['satisfies'] === true || String(c['satisfies']).toLowerCase() === 'true',
      reason: typeof c['reason'] === 'string' ? c['reason'].trim().slice(0, 300) : '',
    })
  }
  candidates.sort((a, b) => b.confidence - a.confidence)

  return {
    description: typeof o['description'] === 'string' ? o['description'].trim() : '',
    subject: typeof o['subject'] === 'string' ? o['subject'].trim().slice(0, 120) : '',
    candidates: candidates.slice(0, 3),
    unmatched: o['unmatched'] === true || candidates.length === 0,
  }
}

export interface FilingDecision {
  /** Hash to file under, or null when a human should choose. */
  hash: string | null
  reason: 'confident' | 'ambiguous' | 'unmatched' | 'low_confidence' | 'suggest_only'
}

/**
 * Decide whether to file automatically.
 *
 * Deliberately conservative: a wrong auto-file marks a requirement satisfied by
 * evidence that doesn't show it, and nobody looks at it again. Being asked to
 * confirm is a small cost against that.
 */
export function decideFiling(c: Classification): FilingDecision {
  if (!AUTO_FILE_ENABLED) return { hash: null, reason: 'suggest_only' }
  if (c.unmatched || !c.candidates.length) return { hash: null, reason: 'unmatched' }
  const [top, second] = c.candidates
  if (!top) return { hash: null, reason: 'unmatched' }
  if (top.confidence < AUTO_FILE_CONFIDENCE) return { hash: null, reason: 'low_confidence' }
  if (second && top.confidence - second.confidence < AUTO_FILE_MARGIN) {
    return { hash: null, reason: 'ambiguous' }
  }
  return { hash: top.hash, reason: 'confident' }
}

export async function classifyPhoto(
  buf: Buffer,
  formType: string,
  satisfiedHashes = new Set<string>(),
): Promise<{ classification: Classification; filing: FilingDecision } | null> {
  if (!visionConfigured()) throw new VisionNotConfiguredError()
  const catalogue = buildCatalogue(formType, satisfiedHashes)
  if (!catalogue.length) return null

  const raw = await callModelWithImages(buildClassifyPrompt(catalogue), [buf])
  const classification = parseClassification(raw, catalogue)
  if (!classification) return null
  return { classification, filing: decideFiling(classification) }
}
