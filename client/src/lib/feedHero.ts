// Shared hero-scene logic for the activity feed: maps a feed item's
// event type + metadata to a milestone family, tone, kicker copy, and
// ghost icon. Used by FeedView (header avatars for unattributed posts)
// and FeedHero (the animated hero card).

export interface Mention { name: string; email: string | null; role: string; user_id: number | null }

export interface FeedMeta {
  tone?: 'celebration' | 'scheduled' | 'attention'
  milestone_col?: string
  milestone_date?: string
  previous_date?: string
  old_status?: string | null
  new_status?: string
  mentions?: Mention[]
  // FID 5 grabbed live at mint time — a *probable* doer, shown as an
  // explicit "likely" credit when no certain actor exists.
  qb_last_modified_by?: string | null
  // True when the change traced back to a known automation identity
  // (pipeline owner account) — shown as an "Automated" marker.
  automated?: boolean
}

export type HeroFamily =
  | 'survey' | 'design' | 'permit' | 'nem' | 'install' | 'inspection' | 'pto'
  | 'status' | 'note' | 'ticket' | 'task' | 'agent'

export interface Hero {
  family: HeroFamily
  tone: 'celebration' | 'scheduled' | 'attention' | 'neutral'
  kicker: string
  dateLine: string | null
  // Small line under the title — e.g. the status transition
  // "Pending KCA → Active".
  subtitle: string | null
  icon: string
}

// Ghost watermark icons (Lucide paths, 24×24) per milestone family.
export const GHOST_ICONS: Record<HeroFamily, string> = {
  survey: 'M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0 M12 13 a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
  design: 'M15.707 21.293a1 1 0 0 1-1.414 0l-1.586-1.586a1 1 0 0 1 0-1.414l5.586-5.586a1 1 0 0 1 1.414 0l1.586 1.586a1 1 0 0 1 0 1.414z M18 13l-1.375-6.874a1 1 0 0 0-.746-.776L3.235 2.028a1 1 0 0 0-1.207 1.207L5.35 15.879a1 1 0 0 0 .776.746L13 18 M2.3 2.3l7.286 7.286 M11 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
  permit: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z M14 2v4a2 2 0 0 0 2 2h4 m-11 5 2 2 4-4',
  nem: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z',
  install: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M12 2v2 m0 16v2 M4.93 4.93l1.41 1.41 m11.32 11.32 1.41 1.41 M2 12h2 m16 0h2 M6.34 17.66l-1.41 1.41 M19.07 4.93l-1.41 1.41',
  inspection: 'M21 21l-4.34-4.34 M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z m-2.5-8.5 2 2 3.5-3.5',
  pto: 'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0 M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5',
  status: 'M8 3 4 7l4 4 M4 7h16 m-8 14 4-4-4-4 m8 4H4',
  note: 'M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z',
  ticket: 'M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z M13 5v2 m0 4v2 m0 4v2',
  task: 'M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z m5.15 3.38 2 2 4-4',
  agent: 'M12 8V4H8 M4 8h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z M2 14h2 m16 0h2 m-7-1v2 m-6-2v2',
}

// Base gradients per family — used by the story circles (FeedView) and
// kept in sync with the FeedHero scene backgrounds.
export const FAMILY_GRADIENTS: Record<HeroFamily, string> = {
  survey: 'linear-gradient(135deg, #0ea5e9, #4f46e5)',
  design: 'linear-gradient(135deg, #7c3aed, #312e81)',
  permit: 'linear-gradient(135deg, #f59e0b, #b45309)',
  nem: 'linear-gradient(135deg, #0d9488, #155e75)',
  install: 'linear-gradient(135deg, #f97316, #be123c)',
  inspection: 'linear-gradient(135deg, #4338ca, #1e1b4b)',
  pto: 'linear-gradient(135deg, #059669, #0f766e)',
  status: 'linear-gradient(135deg, #475569, #1e293b)',
  note: 'linear-gradient(135deg, #f59e0b, #ea580c)',
  ticket: 'linear-gradient(135deg, #9f1239, #831843)',
  task: 'linear-gradient(135deg, #7c3aed, #6d28d9)',
  agent: 'linear-gradient(135deg, #0891b2, #1d4ed8)',
}

export const FAMILY_LABELS: Record<string, string> = {
  survey: 'Survey',
  design: 'Design',
  permit: 'Permit',
  nem: 'NEM',
  install: 'Install',
  inspection: 'Inspect',
  pto: 'PTO',
  status: 'Status',
}

export function milestoneFamily(col: string): HeroFamily {
  if (col.startsWith('survey')) return 'survey'
  if (col.startsWith('cad') || col.startsWith('design')) return 'design'
  if (col.startsWith('permit')) return 'permit'
  if (col.startsWith('nem')) return 'nem'
  if (col.startsWith('install')) return 'install'
  if (col.startsWith('inspection')) return 'inspection'
  if (col.startsWith('pto')) return 'pto'
  return 'status'
}

function fmtHeroDate(raw: string): string {
  const d = raw.length === 10 ? new Date(`${raw}T12:00:00`) : new Date(raw)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

const LEGACY: Record<string, { family: HeroFamily; kicker: string }> = {
  milestone: { family: 'pto', kicker: 'Milestone' },
  status_change: { family: 'status', kicker: 'Status' },
  project_update: { family: 'status', kicker: 'Project update' },
  note_added: { family: 'note', kicker: 'Note' },
  ticket_created: { family: 'ticket', kicker: 'Ticket' },
  task_event: { family: 'task', kicker: 'Field task' },
  agent_run: { family: 'agent', kicker: 'Agent run' },
}

export function buildHero(eventType: string, meta: FeedMeta): Hero {
  if (eventType === 'milestone' && meta.milestone_col) {
    const family = milestoneFamily(meta.milestone_col)
    const tone = meta.tone || 'celebration'
    const kicker = meta.previous_date ? 'Rescheduled'
      : tone === 'scheduled' ? 'On the calendar'
      : tone === 'attention' ? 'Heads up'
      : 'Milestone'
    const dateLine = tone === 'scheduled' && meta.milestone_date ? fmtHeroDate(meta.milestone_date) : null
    return { family, tone, kicker, dateLine, subtitle: null, icon: GHOST_ICONS[family] }
  }
  if (eventType === 'status_change' && meta.new_status) {
    // The transition IS the story — lift it into the hero.
    const subtitle = meta.old_status ? `${meta.old_status} → ${meta.new_status}` : null
    return { family: 'status', tone: 'neutral', kicker: 'Status', dateLine: null, subtitle, icon: GHOST_ICONS.status }
  }
  const legacy = LEGACY[eventType]
  if (legacy) {
    return { family: legacy.family, tone: 'neutral', kicker: legacy.kicker, dateLine: null, subtitle: null, icon: GHOST_ICONS[legacy.family] }
  }
  return { family: 'status', tone: 'neutral', kicker: eventType.replace(/_/g, ' '), dateLine: null, subtitle: null, icon: GHOST_ICONS.status }
}
