// PhotoGuard form schema access.
//
// The definitions themselves live in OUR database (server/src/lib/
// photoguardForms.ts), imported once from Arrivy and editable thereafter.
// Arrivy is not in the runtime path: this module just fetches the stored
// schema so the native form can render, and caches it per (formType, project)
// because photo requirements vary by what's outstanding on the project.
//
// Verified source forms (Arrivy, 2026-08-05):
//   site_survey      → 'Site Survey Form'               79 photo fields
//   install_checkout → 'Field Task Site Checkout V1.02' 127 photo fields
import { authHeaders, isEmptyBlock, type FormDefinition, type FormField, type FormSection } from '@/lib/photoguard'

export type { FormDefinition, FormField, FormSection }

const cache = new Map<string, FormDefinition>()

function key(formType: string, projectRid?: number | null): string {
  return `${formType}::${projectRid ?? ''}`
}

export class FormNotImportedError extends Error {
  constructor(public formType: string, message: string) {
    super(message)
    this.name = 'FormNotImportedError'
  }
}

export async function loadForm(
  formType: string,
  projectRid?: number | null,
  opts: { force?: boolean } = {},
): Promise<FormDefinition> {
  const k = key(formType, projectRid)
  const hit = cache.get(k)
  if (hit && !opts.force) return hit

  const qs = projectRid ? `?project=${projectRid}` : ''
  const res = await fetch(`/api/photoguard/forms/${encodeURIComponent(formType)}${qs}`, {
    headers: authHeaders(),
  })
  if (res.status === 404) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    throw new FormNotImportedError(formType, body.error || `Form '${formType}' has not been imported yet.`)
  }
  if (!res.ok) throw new Error(`Failed to load form (${res.status})`)

  const form = await res.json() as FormDefinition
  cache.set(k, form)
  return form
}

export function clearFormCache(): void {
  cache.clear()
}

/** Fields grouped into their sections, in form order, sections with no
 *  renderable field dropped. */
export function groupBySection(
  form: FormDefinition,
): Array<{ section: FormSection; fields: FormField[] }> {
  const bySection = new Map<string, FormField[]>()
  for (const f of form.fields) {
    if (f.fieldType === 'unknown') continue
    // Arrivy forms use empty TextComponents as spacers, and token
    // substitution can empty one out too — neither should render.
    if (f.fieldType === 'block' && isEmptyBlock(f.label)) continue
    const list = bySection.get(f.sectionKey) ?? []
    list.push(f)
    bySection.set(f.sectionKey, list)
  }
  return form.sections
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(section => ({
      section,
      fields: (bySection.get(section.key) ?? []).sort((a, b) => a.sortOrder - b.sortOrder),
    }))
    .filter(g => g.fields.length > 0)
}

export function photoFields(form: FormDefinition): FormField[] {
  return form.fields.filter(f => f.fieldType === 'photo')
}

export const FORM_LABELS: Record<string, string> = {
  site_survey: 'Site Survey',
  install_checkout: 'Install Checkout',
}

export function formLabel(formType: string): string {
  return FORM_LABELS[formType] ?? formType
}
