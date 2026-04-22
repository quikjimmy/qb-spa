# Agent Operating Model

Last updated: 2026-04-21

## Purpose

`qb-spa` is moving from flat user-created agents toward a controlled production agent model for all production agents:

- role-based agents
- parent/child hierarchy
- durable goals
- repeatable task definitions
- DB-backed schedules
- explicit permissions and approvals
- Ari as the first seeded production front door for Project Coordinators
- Agent Lab separated for experiments

This file should stay updated as the system changes.

The structure is not Ari-specific. Ari is the first concrete department manager role, used to prove the pattern. The same tables, scheduler, policy model, task-run records, approvals, and UI controls are intended to support future production agents across departments.

For hands-on creation and testing, use `docs/agent-creation-and-test-sop.md`.

For the first concrete business pilot, use `docs/pc-daily-coordinator-digest-pilot.md`.

For the OpenClaw runtime boundary, use `docs/openclaw-governance-adapter.md`.

## Product Split

## Runtime Strategy

The AI strategy document still positions OpenClaw as part of the long-term runtime strategy. The `qb-spa` implementation should align with that without forcing business users to work inside OpenClaw directly.

The intended split is:

- `qb-spa`: user-facing agent operations control plane.
- OpenClaw: optional/strategic single-agent runtime underneath the control plane.
- Paperclip-style model: the operating pattern for hierarchy, goals, budgets, approvals, inbox, issues, routines, projects, tasks, and dashboards.
- MCP gateway/connectors: the integration layer between agents and company systems.

Business users should use `qb-spa` to see and manage agents, projects, tasks, approvals, inbox items, issues, routines, goals, and run history. They should not need a separate OpenClaw login for day-to-day agent work.

OpenClaw should be treated as an execution adapter target, not the product UI. A production task run in `agent_task_runs` can later dispatch to:

- the current built-in TypeScript runner
- an OpenClaw persona/runtime
- a future NemoClaw/local runtime for stricter data handling
- another specialized runner

This means the database model should remain runtime-neutral. Role, goal, task, schedule, run, approval, and permission records live in `qb-spa`; runtime-specific implementation details should sit behind the dispatcher/runner boundary.

### Production

Ari is the primary production assistant for the Project Coordinators department.

Ari is not currently the universal company-level root agent. Ari starts with `parent_role_id = NULL`, but the schema supports adding a parent above Ari later.

Production agents should only run approved role/task patterns. They should not expose open-ended autonomous behavior.

The production model is generic: any role can have a parent, children, goals, tasks, schedules, permissions, runs, and approvals.

### Agent Lab

Agent Lab contains experimental, user-created agents. The existing `user_agents` system remains here for now.

Access is admin-only by default unless `AGENT_LAB_ENABLED_FOR_ALL=1` is set.

## Seeded Production Hierarchy

Current seeded hierarchy:

```text
Ari
  Outreach Worker
  Status Summary Worker
  Risk / Hold Worker
  Notes Digest Worker
```

A future hierarchy can insert a parent above Ari without schema changes:

```text
Operations Executive Agent
  Ari
    Outreach Worker
    Status Summary Worker
    Risk / Hold Worker
    Notes Digest Worker
  Permitting Manager
  Inspection Manager
  PTO Manager
```

## Core Tables

The production agent model uses these SQLite tables:

- `agent_roles`: persistent agent role definitions and hierarchy via `parent_role_id`
- `agent_goals`: durable business goals per role
- `agent_role_tasks`: repeatable task templates per role
- `agent_task_schedules`: cron-backed schedule records
- `agent_permissions`: role capability matrix
- `agent_task_runs`: queue and execution history for production role tasks
- `agent_approvals`: human approval gate for irreversible actions
- `agent_delivery_configs`: delivery/audience rules for agent output
- `agent_delivery_recipients`: recipient-level delivery mappings and coordinator names
- `agent_delivery_items`: Agent Ops inbox items and delivery history

Existing Agent Lab tables remain:

- `user_agents`
- `user_budgets`
- `user_ollama_config`
- legacy `agent_runs` and `agent_outputs`

## Backend Files

Production agent system:

- `server/src/routes/agent-org.ts`: role, goal, task, schedule, run, and Ari workspace APIs
- `server/src/routes/agent-approvals.ts`: approval queue APIs
- `server/src/routes/agent-lab.ts`: Agent Lab access status
- `server/src/agents/scheduler.ts`: dynamic DB-backed cron registration
- `server/src/agents/taskDispatcher.ts`: creates task runs and dispatches execution
- `server/src/agents/roleRunner.ts`: generic role-task execution layer
- `server/src/agents/policy.ts`: permission and approval policy helper

Existing reused pieces:

- `server/src/agents/runner.ts`: existing hold-classifier execution
- `server/src/agents/holdClassifier.ts`: hold classification logic
- `server/src/routes/user-agents.ts`: Agent Lab custom agent APIs
- `server/src/routes/agents.ts`: legacy admin agent endpoints, with hold-classifier now routed through production task runs where possible

Future OpenClaw integration should be added as a runner adapter, for example:

- `server/src/agents/openClawRunner.ts`
- task-level runtime selection, for example `builtin | openclaw | nemoclaw`
- OpenClaw persona/material generation from `agent_roles`, `agent_goals`, and `agent_role_tasks`
- result normalization back into `agent_task_runs`

## Frontend Files

Main page:

- `client/src/views/AgentsView.vue`: dashboard-first Agent Ops workspace

The Agent Ops page should not behave like a generic agent playground. The initial view is an operations dashboard inspired by Paperclip-style sections:

- Inbox
- Issues
- Routines
- Goals
- Projects
- Tasks

The route remains `/agents` for compatibility, but the sidebar and breadcrumb label are `Agent Ops`.

Production components:

- `client/src/components/agents/AriWorkspace.vue`
- `client/src/components/agents/AgentOrgChart.vue`
- `client/src/components/agents/AgentOrgNode.vue`
- `client/src/components/agents/AgentRoleDashboard.vue`
- `client/src/components/agents/AgentRoleCard.vue`
- `client/src/components/agents/AgentTaskList.vue`
- `client/src/components/agents/AgentRunsTable.vue`
- `client/src/components/agents/AgentApprovalQueue.vue`

## Agent UX Pattern

The recommended handling for production agents is:

1. Show the user a dashboard of all agents they can access.
2. Show a visual org chart, not only a list.
3. Mark agents as running when their latest production run is `queued` or `running`.
4. Mark agents as needing review when they have pending approvals, approval-pending runs, or failures.
5. Let users click an org-chart node to open that agent's dashboard.
6. Agent dashboards should show objective, goals, routines/tasks, schedules, recent runs, and current status.
7. Keep Agent Lab below/separate from production dashboards.

This keeps production work controlled while still making the system observable.

## Current Execution Flow

Manual Ari route:

1. User submits a PC request in Ari workspace.
2. `POST /api/agent-org/ari/route` creates an Ari parent run.
3. Ari keyword-routes the request to an approved worker task.
4. Dispatcher creates a delegated child run.
5. Worker task writes result to `agent_task_runs`.

Scheduled hold classification:

1. Seed creates `Risk / Hold Worker -> Hold classification`.
2. Seed creates schedule `0 2 * * *` in `agent_task_schedules`.
3. `startAgentScheduler()` loads enabled DB schedules.
4. Cron dispatches the task through `dispatchRoleTask()`.
5. `roleRunner` reuses existing `runHoldClassifier()`.

Approval flow:

1. Irreversible or external-action paths must pass policy checks.
2. If approval is required, the task run becomes `approval_pending`.
3. An `agent_approvals` row is created.
4. Admin reviews in the approval queue UI.

## Current Limitations

- Ari routing is simple keyword routing, not a full planner.
- Production role/task/schedule editor UI is early and should keep improving.
- OpenClaw is in the strategy, but `qb-spa` does not currently dispatch to OpenClaw.
- Agent Lab APIs remain available for compatibility.
- Approval records exist, but approved actions are not yet replayed/executed after approval.
- Full server typecheck still reports unrelated pre-existing TypeScript errors in older routes.
- The hold-classifier still writes its legacy `agent_runs` and `agent_outputs`; production `agent_task_runs` wraps it rather than replacing all legacy output storage.

## Next Stage Candidates

Recommended next stage:

1. Expand admin CRUD UI for production roles, goals, tasks, and schedules.
2. Add richer task detail/run result inspection in the org chart.
3. Make approval approval execute or release the pending action.
4. Improve Ari routing from keyword routing to explicit task selection plus structured inputs.
5. Migrate hold-classifier outputs further into production run/result records.
6. Add an OpenClaw runner adapter while keeping `qb-spa` as the user-facing control plane.
