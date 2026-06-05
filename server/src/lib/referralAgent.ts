import type { Request, Response, NextFunction } from 'express'
import db from '../db'

// "Referral Agent" — a deliberately tiny, read-only role. These users have
// no Quickbase access and see exactly one slice of the app: projects that
// have been PTO-approved more than 30 days ago AND are now in a completed
// status (the post-PTO "activation" bucket). Everything else in the app is
// off-limits. The server is the authority here; the client gating mirrors
// this for UX but does not enforce it.
export const REFERRAL_AGENT_ROLE = 'Referral Agent'

// True when the bearer is a Referral Agent and NOT also an admin. Admins keep
// full access so they can support/inspect these users without being locked out.
export function isReferralAgent(req: Request): boolean {
  const roles = req.user?.roles ?? []
  return roles.includes(REFERRAL_AGENT_ROLE) && !roles.includes('admin')
}

// Denver-local YYYY-MM-DD, N days ago. Mirrors the helper in routes/projects.ts
// (duplicated here to avoid a circular import — projects.ts imports this file).
const DENVER_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Denver',
  year: 'numeric', month: '2-digit', day: '2-digit',
})
function daysAgo(n: number): string {
  return DENVER_DATE_FMT.format(new Date(Date.now() - n * 86400_000))
}

// The single visibility rule for a Referral Agent, as a SQL WHERE fragment.
// The date is our own formatter output (safe YYYY-MM-DD) and the status match
// is a constant, so this is parameter-free and safe to inline.
export function activationWhere(): string {
  const cutoff = daysAgo(30)
  return `(pto_approved IS NOT NULL AND pto_approved != '' AND pto_approved <= '${cutoff}' AND LOWER(status) LIKE 'complete%')`
}

// Can a Referral Agent see this specific project? (Exists in cache AND matches
// the activation rule.) Used to gate the detail endpoint and project-scoped
// sub-data endpoints.
export function canViewerSeeProject(projectId: number): boolean {
  if (!Number.isFinite(projectId) || projectId <= 0) return false
  const row = db.prepare(
    `SELECT 1 FROM project_cache WHERE record_id = ? AND ${activationWhere()} LIMIT 1`,
  ).get(projectId)
  return !!row
}

const ID_PARAM_KEYS = ['project_id', 'project_rid', 'projectId', 'id', 'rid']
function extractProjectId(req: Request): number | null {
  for (const key of ID_PARAM_KEYS) {
    const raw = (req.query[key] ?? req.params[key]) as unknown
    if (typeof raw === 'string' && raw.trim() !== '') {
      const n = parseInt(raw, 10)
      if (Number.isFinite(n) && n > 0) return n
    }
  }
  return null
}

// Guard for project-scoped routers (notes, feed, attachments, tickets,
// retention, pc-dashboard). No-ops for everyone except Referral Agents; for
// them it requires a project-id param pointing at a project they're allowed
// to see. A param-less "global" call (e.g. a whole-org list) → 403.
export function referralAgentScope(req: Request, res: Response, next: NextFunction): void {
  if (!isReferralAgent(req)) { next(); return }
  const id = extractProjectId(req)
  if (id == null || !canViewerSeeProject(id)) {
    res.status(403).json({ error: 'Out of scope' })
    return
  }
  next()
}

// Field (Arrivy) router has a mix of project-scoped and task-scoped endpoints.
// Referral Agents may reach only the three the project detail uses:
//   /project-tasks  (project-scoped — must be a visible project)
//   /task-log       (opaque Arrivy task id — reached only from a visible project)
//   /arrivy-task/*  (opaque Arrivy task id — photos for a task)
// Everything else (cancellations, late, probes) is org-wide and denied.
export function referralAgentFieldScope(req: Request, res: Response, next: NextFunction): void {
  if (!isReferralAgent(req)) { next(); return }
  const p = req.path
  if (p.includes('/project-tasks')) {
    const id = extractProjectId(req)
    if (id == null || !canViewerSeeProject(id)) {
      res.status(403).json({ error: 'Out of scope' })
      return
    }
    next()
    return
  }
  if (p.includes('/task-log') || p.includes('/arrivy-task')) { next(); return }
  res.status(403).json({ error: 'Out of scope' })
}

// Blanket deny for routers a Referral Agent must never touch.
export function denyReferralAgent(req: Request, res: Response, next: NextFunction): void {
  if (isReferralAgent(req)) {
    res.status(403).json({ error: 'Not available' })
    return
  }
  next()
}
