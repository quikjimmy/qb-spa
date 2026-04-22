# OpenClaw Governance Adapter

Last updated: 2026-04-21

## Intent

`qb-spa` should be the operations control plane for agent work. OpenClaw can be a runtime underneath it, but Ops users should not need to log in to OpenClaw to consume, approve, or monitor agent work.

The adapter boundary keeps OpenClaw powerful while preventing a free-for-all.

## Ownership Split

`qb-spa` owns:

- users and departments
- production agent roles
- goals
- approved tasks
- schedules
- delivery configs
- inbox items
- approvals
- run history
- policy decisions
- audit trail

OpenClaw owns:

- persona/runtime execution
- memory usage inside the approved work packet
- tool orchestration inside allowed tools
- runtime-specific prompt/material handling
- producing a normalized task result

## Required OpenClaw Contract

Every OpenClaw execution should receive a bounded work packet from `qb-spa`:

```json
{
  "run_id": 123,
  "role": {
    "slug": "pc-status-summary-worker",
    "name": "Status Summary Worker",
    "objective": "Summarize current project state and package repeatable coordinator updates."
  },
  "task": {
    "id": 456,
    "name": "Generate daily coordinator digest",
    "type": "digest",
    "instructions": "Generate a morning Project Coordinator briefing..."
  },
  "goals": [],
  "permissions": [],
  "payload": {},
  "delivery": {
    "channel": "agent_ops_inbox",
    "recipient_user_id": 7,
    "qb_coordinator_name": "Paige Elkins"
  },
  "policy": {
    "external_messages_allowed": false,
    "mutations_allowed": false,
    "approval_required_for_irreversible_actions": true
  }
}
```

OpenClaw should return:

```json
{
  "status": "completed",
  "summary": "Draft generated.",
  "result": {},
  "requested_actions": [],
  "tokens_in": 0,
  "tokens_out": 0,
  "cost_cents": 0,
  "error": null
}
```

## Guardrails

OpenClaw must not directly:

- send Slack messages
- send customer email or SMS
- mutate Quickbase records
- mark issues resolved
- reschedule installs
- escalate to people

Instead, OpenClaw returns `requested_actions`. `qb-spa` creates approvals or delivery items.

## Delivery Flow

For the PC daily coordinator digest:

1. `qb-spa` schedule or user action triggers the task.
2. `qb-spa` expands the delivery config into eligible recipients.
3. `qb-spa` creates one `agent_task_runs` row per recipient.
4. The runner executes through built-in code today or OpenClaw later.
5. Result is normalized into `agent_task_runs.result_json`.
6. `qb-spa` creates one `agent_delivery_items` inbox row per recipient.
7. Users consume the report in Agent Ops.

## Definition Of "All PCs"

For delivery, `all PCs` means:

- active `qb-spa` users
- assigned to the `PC` department
- delivery enabled for the config
- mapped by app email to QuickBase `Project Coordinator - Email` field `822`

The default coordinator mapping is app user email to QuickBase `Project Coordinator - Email` field `822`. App names are display-only. A future admin UI should allow explicit recipient mapping only for exceptions.

## Adapter Build Steps

1. Keep the current built-in TypeScript runner as the baseline.
2. Add `server/src/agents/openClawRunner.ts`.
3. Add task-level runtime selection, for example `builtin | openclaw | nemoclaw`.
4. Convert `agent_roles`, `agent_goals`, and `agent_role_tasks` into OpenClaw persona/work-packet inputs.
5. Call OpenClaw with the bounded packet.
6. Normalize OpenClaw output back into `agent_task_runs`.
7. Keep delivery, approval, and monitoring in `qb-spa`.
