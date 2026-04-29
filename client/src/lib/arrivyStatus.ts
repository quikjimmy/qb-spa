// Unified Arrivy task status taxonomy.
//
// QB's Arrivy table (bvbqgs5yc) field 85 holds the raw task_status string.
// Arrivy emits these as upper-case codes; QB sometimes also has
// pretty-printed display strings ("Site Work Complete", "On Site"). We
// normalize them here so every surface — EventsView, MilestoneStrip,
// MilestoneDetail, FieldDashboardView — speaks the same vocabulary.

export type ArrivyStatusKey =
  | 'scheduled'
  | 'enroute'
  | 'onsite'
  | 'submitted'    // form submitted / sent for review
  | 'cancelled'
  | 'rejected'     // submitted then rejected by reviewer
  | 'approved'     // submitted then approved (terminal happy path)

export interface ArrivyStatusInfo {
  key: ArrivyStatusKey
  label: string
  /** Tailwind classes for the small pill that appears next to the task title. */
  pillCls: string
  /** Tailwind class for a left-border accent on the row/card. */
  borderCls: string
  /** Tailwind class for a colored dot in calendar/strip views. */
  dotCls: string
}

export const STATUS_INFO: Record<ArrivyStatusKey, ArrivyStatusInfo> = {
  scheduled: { key: 'scheduled', label: 'Scheduled', pillCls: 'bg-slate-100 text-slate-600',     borderCls: 'border-l-slate-300', dotCls: 'bg-slate-400' },
  enroute:   { key: 'enroute',   label: 'En Route',  pillCls: 'bg-sky-100 text-sky-700',          borderCls: 'border-l-sky-500',   dotCls: 'bg-sky-500'  },
  onsite:    { key: 'onsite',    label: 'On Site',   pillCls: 'bg-sky-100 text-sky-800',          borderCls: 'border-l-sky-600',   dotCls: 'bg-sky-600'  },
  submitted: { key: 'submitted', label: 'Submitted', pillCls: 'bg-emerald-100 text-emerald-700',  borderCls: 'border-l-emerald-500', dotCls: 'bg-emerald-500' },
  approved:  { key: 'approved',  label: 'Approved',  pillCls: 'bg-emerald-100 text-emerald-700',  borderCls: 'border-l-emerald-500', dotCls: 'bg-emerald-500' },
  rejected:  { key: 'rejected',  label: 'Rejected',  pillCls: 'bg-rose-100 text-rose-700',        borderCls: 'border-l-rose-500',  dotCls: 'bg-rose-500' },
  cancelled: { key: 'cancelled', label: 'Cancelled', pillCls: 'bg-rose-600 text-white',           borderCls: 'border-l-rose-600', dotCls: 'bg-rose-600' },
}

/** Normalize the raw task_status string from QB into one of our known keys.
 *  Substring-tolerant so noisy QB labels ("Cancelled by Customer",
 *  "Task Cancelled", "Site Work Complete") still classify correctly.
 *  Unknown values fall through to null so callers can decide a fallback. */
export function normalizeRawStatus(raw: string | null | undefined): ArrivyStatusKey | null {
  if (!raw) return null
  const s = String(raw).toLowerCase()
  if (!s.trim()) return null
  if (/cancel|exception|notdone|not\s*done/i.test(s)) return 'cancelled'
  if (/reject/i.test(s)) return 'rejected'
  if (/approv/i.test(s)) return 'approved'
  if (/submit|formcomplete|form\s*complete|sitework|site\s*work\s*complete|complete/i.test(s)) return 'submitted'
  if (/onsite|on\s*site|started|start|arrived/i.test(s)) return 'onsite'
  if (/enroute|en\s*route/i.test(s)) return 'enroute'
  if (/scheduled|notstarted|not\s*started|pending/i.test(s)) return 'scheduled'
  return null
}

/** Higher-fidelity classifier that uses both raw status and date timestamps
 *  on an Arrivy task row. Mirrors the logic in EventsView so milestone
 *  derivation and the events list agree. */
export function classifyArrivyTask(opts: {
  rawStatus: string | null | undefined
  arrived: Date | string | null | undefined
  enroute: Date | string | null | undefined
  submitted: Date | string | null | undefined
  approved?: Date | string | null | undefined
  rejected?: Date | string | null | undefined
}): ArrivyStatusKey {
  const norm = normalizeRawStatus(opts.rawStatus)
  if (norm === 'cancelled' || norm === 'rejected') return norm
  if (opts.approved) return 'approved'
  if (opts.rejected) return 'rejected'
  if (opts.submitted) return 'submitted'
  if (opts.arrived) return 'onsite'
  if (opts.enroute) return 'enroute'
  return 'scheduled'
}

/** Pretty SVG paths used by the cancelled X dot — keep here so all views
 *  render identical icons. Returns the inner <path> markup of a 24×24 SVG. */
export const X_ICON_PATHS = '<path d="M6 6l12 12" /><path d="M18 6L6 18" />'
