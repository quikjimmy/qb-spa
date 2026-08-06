// Import Arrivy form definitions into the PhotoGuard form store.
//
// This is the seam between "Arrivy owns the forms" and "we own the forms".
// After an import the definitions live in our tables and can be edited,
// re-hinted, or extended with custom fields; re-running the import refreshes
// Arrivy-sourced fields without touching anything we authored.
import { arrivyConfigured, getArrivyForms, type ArrivyFormDefinition } from './arrivy'
import {
  FORM_TYPES, arrivyFormIdFor, normalizeArrivyForm, upsertForm, seedDefaultRules,
  SCREEN_BREAK, type NormalizedForm, type PhotoGuardFormType, type UpsertResult,
} from './photoguardForms'

export class ArrivyNotConfiguredError extends Error {
  constructor() {
    super('Arrivy is not configured — set ARRIVY_AUTH_KEY and ARRIVY_AUTH_TOKEN')
    this.name = 'ArrivyNotConfiguredError'
  }
}

export interface FormSummary {
  id: string
  title: string
  status: string
  components: number
  photos: number
  screenBreaks: number
}

export function summarizeForm(f: ArrivyFormDefinition): FormSummary {
  const comps = f.content ?? []
  return {
    id: f.id != null ? String(f.id) : '',
    title: (f.title ?? '').trim(),
    status: String(f.status ?? ''),
    components: comps.length,
    photos: comps.filter(c => c.type === 'ImageUploadComponent').length,
    screenBreaks: comps.filter(c => c.type === SCREEN_BREAK).length,
  }
}

/** List every form on the account with its shape. Powers the admin probe so
 *  the mapping to our two form types can be re-checked when Arrivy changes. */
export async function probeArrivyForms(): Promise<FormSummary[]> {
  if (!arrivyConfigured()) throw new ArrivyNotConfiguredError()
  const forms = await getArrivyForms()
  return forms.map(summarizeForm).sort((a, b) => b.photos - a.photos)
}

export interface ImportReport {
  formType: PhotoGuardFormType
  arrivyFormId: string
  title: string
  sections: number
  photoFields: number
  totalFields: number
  upsert: UpsertResult
}

function normalizeOne(
  forms: ArrivyFormDefinition[],
  formType: PhotoGuardFormType,
): NormalizedForm {
  const wantId = arrivyFormIdFor(formType)
  const raw = forms.find(f => String(f.id) === wantId)
  if (!raw) {
    throw new Error(
      `Arrivy form ${wantId} (${formType}) not found on this account. ` +
      `Available: ${forms.map(f => `${f.id}=${f.title}`).slice(0, 40).join(', ')}`,
    )
  }
  return normalizeArrivyForm(raw, formType)
}

/** Pull both PhotoGuard forms from Arrivy and refresh the local store. */
export async function importArrivyForms(
  only?: PhotoGuardFormType,
): Promise<ImportReport[]> {
  if (!arrivyConfigured()) throw new ArrivyNotConfiguredError()
  const forms = await getArrivyForms()
  const targets = only ? [only] : FORM_TYPES

  const reports: ImportReport[] = []
  for (const formType of targets) {
    const normalized = normalizeOne(forms, formType)
    const upsert = upsertForm(normalized)
    reports.push({
      formType,
      arrivyFormId: normalized.arrivyFormId,
      title: normalized.title,
      sections: normalized.sections.length,
      photoFields: normalized.fields.filter(f => f.fieldType === 'photo').length,
      totalFields: normalized.fields.length,
      upsert,
    })
  }
  seedDefaultRules()
  return reports
}
