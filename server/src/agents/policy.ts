import db from '../db'

export interface RolePolicyDecision {
  allowed: boolean
  approvalRequired: boolean
  reason?: string
}

interface AgentRoleRow {
  id: number
  approval_required: number
}

export function hasRolePermission(agentRoleId: number, resource: string, action: string): boolean {
  const row = db.prepare(
    `SELECT 1
     FROM agent_permissions
     WHERE agent_role_id = ? AND resource = ? AND action = ?
     LIMIT 1`
  ).get(agentRoleId, resource, action)
  return !!row
}

export function evaluateRoleAction(
  role: AgentRoleRow,
  resource: string,
  action: string,
  irreversible = false,
): RolePolicyDecision {
  const directAllowed = hasRolePermission(role.id, resource, action)
  const canRequestApproval = hasRolePermission(role.id, resource, 'request_approval')
    || hasRolePermission(role.id, 'external_message', 'request_approval')

  if (!irreversible && directAllowed) {
    return { allowed: true, approvalRequired: false }
  }

  if ((irreversible || role.approval_required === 1) && (directAllowed || canRequestApproval)) {
    return { allowed: true, approvalRequired: true }
  }

  if (directAllowed) {
    return { allowed: true, approvalRequired: false }
  }

  return {
    allowed: false,
    approvalRequired: false,
    reason: `Role ${role.id} cannot ${action} on ${resource}`,
  }
}

