// Shared PhotoGuard types + presentation helpers.
// Accents come from docs/ui-component-specs.md — do not invent new ones.
import { useAuthStore } from '@/stores/auth'

export type PhotoGuardFormType = 'site_survey' | 'install_checkout'

export type FieldType =
  | 'photo' | 'dropdown' | 'checklist' | 'text' | 'textarea'
  | 'number' | 'address' | 'signature' | 'block' | 'unknown'

export interface FormField {
  hash: string
  label: string
  fieldType: FieldType
  required: boolean
  requiredBase?: boolean
  requiredReasons?: string[]
  options: string[] | null
  hints: string
  sectionKey: string
  sortOrder: number
  source: string
}

export interface FormSection {
  key: string
  title: string
  sortOrder: number
}

export interface FormDefinition {
  formType: string
  title: string
  arrivyFormId: string | null
  version: number
  importedAt: string | null
  projectRid?: number | null
  sections: FormSection[]
  fields: FormField[]
}

export interface GateIssue {
  code: string
  severity: 'fail' | 'warn'
  message: string
}

export interface PhotoRow {
  id: number
  submission_id: number | null
  task_rowid: number | null
  file_id: string
  filename: string | null
  category_label: string | null
  category_hash: string | null
  category_section: string | null
  form_type: string | null
  required: number
  file_path: string | null
  thumb_path: string | null
  width: number | null
  height: number | null
  file_size: number | null
  has_exif: number | null
  has_gps: number | null
  gps_lat: number | null
  gps_lng: number | null
  camera_make: string | null
  camera_model: string | null
  photo_timestamp: string | null
  capture_source: string | null
  captured_by_name: string | null
  metadata_issues: string | null
  gate_status: string | null
  validation_status: string | null
  validation_passed: number | null
  validation_confidence: number | null
  validation_issues: string | null
  validation_description: string | null
  validation_error: string | null
  review_status: string | null
  reviewer: string | null
  review_note: string | null
  created_at: string
}

export interface PhotoGuardStats {
  totalTasks: number
  totalSubmissions: number
  openSubmissions: number
  totalPhotos: number
  passed: number
  failed: number
  pending: number
  blocked: number
  withGps: number
  withExif: number
  passRate: number | null
  visionConfigured: boolean
  arrivyConfigured: boolean
}

export function authHeaders(): Record<string, string> {
  const auth = useAuthStore()
  return { Authorization: `Bearer ${auth.token}` }
}

/** Effective state of one photo, folding human review over the AI verdict. */
export type PhotoState = 'blocked' | 'passed' | 'failed' | 'pending' | 'approved' | 'rejected' | 'resubmit'

export function photoState(p: PhotoRow): PhotoState {
  if (p.review_status === 'approved') return 'approved'
  if (p.review_status === 'rejected') return 'rejected'
  if (p.review_status === 'resubmit') return 'resubmit'
  if (p.gate_status === 'blocked') return 'blocked'
  if (p.validation_status === 'done') return p.validation_passed === 1 ? 'passed' : 'failed'
  return 'pending'
}

// Rose is reserved for genuinely actionable failure — which a blocked or
// rejected photo is: someone has to retake it.
const ACCENTS: Record<PhotoState, string> = {
  approved: 'emerald',
  passed: 'emerald',
  failed: 'rose',
  blocked: 'rose',
  rejected: 'rose',
  resubmit: 'amber',
  pending: 'slate',
}

export function stateAccent(s: PhotoState): string {
  return ACCENTS[s]
}

// Tailwind scans source statically, so an interpolated `bg-${accent}-500`
// never gets generated. Every accent class used by PhotoGuard is spelled out
// here and looked up by key.
export const ACCENT_BAR: Record<string, string> = {
  emerald: 'bg-emerald-500',
  rose: 'bg-rose-500',
  amber: 'bg-amber-500',
  sky: 'bg-sky-500',
  violet: 'bg-violet-500',
  slate: 'bg-slate-300',
}

export const ACCENT_TEXT: Record<string, string> = {
  emerald: 'text-emerald-600',
  rose: 'text-rose-600',
  amber: 'text-amber-600',
  sky: 'text-sky-600',
  violet: 'text-violet-600',
  slate: 'text-slate-500',
}

export function accentBar(accent: string): string {
  return ACCENT_BAR[accent] ?? ACCENT_BAR['slate']!
}

export function accentText(accent: string): string {
  return ACCENT_TEXT[accent] ?? ACCENT_TEXT['slate']!
}

export function stateLabel(s: PhotoState): string {
  switch (s) {
    case 'approved': return 'Approved'
    case 'passed': return 'Passed'
    case 'failed': return 'Failed'
    case 'blocked': return 'Blocked'
    case 'rejected': return 'Rejected'
    case 'resubmit': return 'Retake'
    default: return 'Checking'
  }
}

export function parseIssues(raw: string | null): GateIssue[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    if (!Array.isArray(v)) return []
    return v.filter((x): x is GateIssue =>
      !!x && typeof x === 'object' && typeof (x as GateIssue).message === 'string')
  } catch { return [] }
}

/** validation_issues is a plain string[] rather than GateIssue[]. */
export function parseStringList(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.map(String) : []
  } catch { return [] }
}

export function fmtConfidence(c: number | null): string {
  if (c == null) return '—'
  return `${Math.round(c * 100)}%`
}

export function fmtBytes(n: number | null): string {
  if (!n) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function fmtCoords(lat: number | null, lng: number | null): string {
  if (lat == null || lng == null) return '—'
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`
}

/** Browser geolocation, best-effort — a refusal must not block capture. */
export function currentPosition(timeoutMs = 8000): Promise<{ lat: number; lng: number } | null> {
  if (!('geolocation' in navigator)) return Promise.resolve(null)
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    )
  })
}
