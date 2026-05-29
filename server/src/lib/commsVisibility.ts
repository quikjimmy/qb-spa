// Per-event, per-subscriber "should I show this in the Comms Hub live
// panel?" decision. The org-wide broadcast used to fire visibility for
// every connected user; PR-1c narrows it to routing-tree members via the
// department_dialpad_targets bridge (set up in PR-1b).
//
// Per-event grace: if no department has claimed an event's target or
// entry_point_target, fall back to broadcast so the rollout can happen
// one routing line at a time without dropping events on the floor.
import db from '../db'

interface VisibilityEvent {
  target_kind?: string | null
  target_id?: string | null
  entry_point_target_kind?: string | null
  entry_point_target_id?: string | null
}

// Returns the set of portal department IDs a user belongs to. Cheap
// lookup; callers cache it once per request / connection.
export function loadUserDeptIds(userId: number): Set<number> {
  const rows = db.prepare(
    `SELECT department_id FROM user_departments WHERE user_id = ?`
  ).all(userId) as Array<{ department_id: number }>
  return new Set(rows.map(r => r.department_id))
}

// Computes the dept IDs that have claimed a (kind, id) routing target.
// Two indexed lookups; small result sets.
function deptsMatching(targetKind: string | null | undefined, targetId: string | null | undefined): Set<number> {
  if (!targetKind || !targetId) return new Set()
  const rows = db.prepare(
    `SELECT department_id FROM department_dialpad_targets
      WHERE target_kind = ? AND target_id = ?`
  ).all(targetKind, targetId) as Array<{ department_id: number }>
  return new Set(rows.map(r => r.department_id))
}

// Per-event visibility decision. Caller passes the user's dept set and
// the already-computed is_mine flag so this function stays pure-ish (no
// extra DB hits for things the caller already knows).
export function shouldShowEvent(event: VisibilityEvent, isMine: boolean, userDeptIds: Set<number>): 0 | 1 {
  // Dialpad rang you directly → you always see it, regardless of mappings.
  if (isMine) return 1

  const hasTarget = !!(event.target_id && event.target_kind)
  const hasEntry = !!(event.entry_point_target_id && event.entry_point_target_kind)
  // No routing-tree info at all (SMS, direct user-to-user) → broadcast.
  if (!hasTarget && !hasEntry) return 1

  const claimedBy = new Set<number>()
  for (const id of deptsMatching(event.target_kind, event.target_id)) claimedBy.add(id)
  for (const id of deptsMatching(event.entry_point_target_kind, event.entry_point_target_id)) claimedBy.add(id)

  // Nobody's claimed this target yet → broadcast (per-event grace, so a
  // new routing line doesn't go silent before admins map it).
  if (claimedBy.size === 0) return 1

  // Claimed — show only to members of the claiming departments.
  for (const id of claimedBy) if (userDeptIds.has(id)) return 1
  return 0
}
