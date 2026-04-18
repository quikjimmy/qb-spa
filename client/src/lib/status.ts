// Centralized project status palette
// Used across the entire app — projects list, detail, feed, KPIs
//
// Principle: strong color for actionable states, muted for terminal states.
// Never use harsh red for resolved/closed statuses.

export interface StatusConfig {
  bg: string
  text: string
  dot: string
  border: string
  label: string
}

const statuses: Record<string, StatusConfig> = {
  // ── Positive / In Progress ──
  'Active': {
    bg: 'bg-teal-50 dark:bg-teal-950/30',
    text: 'text-teal-700 dark:text-teal-400',
    dot: 'bg-teal-500',
    border: 'border-l-teal-500',
    label: 'Active',
  },

  // ── Completed / Resolved ──
  'Complete': {
    bg: 'bg-slate-100 dark:bg-slate-800/40',
    text: 'text-slate-600 dark:text-slate-400',
    dot: 'bg-slate-400',
    border: 'border-l-slate-400',
    label: 'Complete',
  },
  'Completed': {
    bg: 'bg-slate-100 dark:bg-slate-800/40',
    text: 'text-slate-600 dark:text-slate-400',
    dot: 'bg-slate-400',
    border: 'border-l-slate-400',
    label: 'Completed',
  },
  'Completed | Paid': {
    bg: 'bg-slate-100 dark:bg-slate-800/40',
    text: 'text-slate-600 dark:text-slate-400',
    dot: 'bg-slate-400',
    border: 'border-l-slate-400',
    label: 'Completed | Paid',
  },

  // ── Needs Attention (actionable) ──
  'Hold': {
    bg: 'bg-amber-50 dark:bg-amber-950/25',
    text: 'text-amber-700 dark:text-amber-400',
    dot: 'bg-amber-400',
    border: 'border-l-amber-400',
    label: 'Hold',
  },
  'On Hold': {
    bg: 'bg-amber-50 dark:bg-amber-950/25',
    text: 'text-amber-700 dark:text-amber-400',
    dot: 'bg-amber-400',
    border: 'border-l-amber-400',
    label: 'On Hold',
  },
  'ROR': {
    bg: 'bg-amber-50 dark:bg-amber-950/25',
    text: 'text-amber-700 dark:text-amber-400',
    dot: 'bg-amber-400',
    border: 'border-l-amber-400',
    label: 'ROR',
  },
  'Pending Cancel': {
    bg: 'bg-orange-50 dark:bg-orange-950/25',
    text: 'text-orange-700 dark:text-orange-400',
    dot: 'bg-orange-400',
    border: 'border-l-orange-400',
    label: 'Pending Cancel',
  },

  // ── Informational (needs work, not urgent) ──
  'Rejected': {
    bg: 'bg-violet-50 dark:bg-violet-950/25',
    text: 'text-violet-700 dark:text-violet-400',
    dot: 'bg-violet-400',
    border: 'border-l-violet-400',
    label: 'Rejected',
  },

  // ── Terminal / Closed (muted, fade back) ──
  'Cancelled': {
    bg: 'bg-gray-100 dark:bg-gray-800/30',
    text: 'text-gray-500 dark:text-gray-500',
    dot: 'bg-gray-400',
    border: 'border-l-gray-300',
    label: 'Cancelled',
  },
  'Surrendered': {
    bg: 'bg-stone-100 dark:bg-stone-800/30',
    text: 'text-stone-500 dark:text-stone-500',
    dot: 'bg-stone-400',
    border: 'border-l-stone-300',
    label: 'Surrendered',
  },
}

const fallback: StatusConfig = {
  bg: 'bg-muted',
  text: 'text-muted-foreground',
  dot: 'bg-muted-foreground/50',
  border: 'border-l-muted-foreground/30',
  label: '',
}

export function getStatusConfig(status: string): StatusConfig {
  if (!status) return fallback

  // Exact match first
  if (statuses[status]) return { ...statuses[status]!, label: status }

  // Partial match (status might have extra text like "Completed | Paid")
  for (const [key, config] of Object.entries(statuses)) {
    if (status.startsWith(key)) return { ...config, label: status }
  }

  return { ...fallback, label: status }
}

// All known statuses for filter dropdowns
export const allStatuses = Object.keys(statuses)
