# SOP: Create And Test An Agent

Last updated: 2026-04-21

## Purpose

Use this SOP to create and test agents in `qb-spa`.

There are two paths:

- Production agents: controlled, role-based agents with goals, tasks, schedules, permissions, runs, and approvals.
- Agent Lab agents: experimental user-created agents for trying ideas before productionizing them.

Use Production for real workflows. Use Agent Lab for experiments.

## Before You Start

Confirm:

- You can log in to `qb-spa`.
- You have admin access if creating production roles, tasks, goals, or schedules.
- The backend and frontend are running.
- The target workflow is clear enough to become a repeatable task.
- Any irreversible action has an approval path.

Do not create a production agent for open-ended autonomous behavior. Production agents should have bounded responsibilities.

## Recommended Agent Shape

A production agent should have:

- Role: who the agent is.
- Objective: what business outcome it is responsible for.
- Parent: who manages or delegates to it.
- Goals: durable success targets.
- Tasks: repeatable actions the role can perform.
- Schedule: optional cron-backed recurring execution.
- Permissions: what resources and actions the role is allowed to use.
- Runs: auditable execution history.
- Approvals: human review for irreversible actions.

Runtime is intentionally separate from shape. The same production agent definition should be able to run through the built-in `qb-spa` runner today and an OpenClaw adapter later without changing what users see in Agent Ops.

## Create A Production Agent

1. Open `Agent Ops`.
2. Go to `Production Agent Controls`.
3. Create the role:
   - Name: human-readable role name.
   - Slug: stable machine name, for example `permitting-status-worker`.
   - Department: owning department.
   - Parent: choose an existing manager, or leave blank for a top-level role.
   - Mode: `manager`, `worker`, or `singleton`.
   - LLM: current execution label, for example `builtin-worker`.
   - Objective: clear business responsibility.
4. Add one or more goals to the selected role.
5. Add one or more tasks to the selected role.
6. Add a schedule only if the task should run automatically.
7. Confirm the role appears in the visual org chart.
8. Click the role node to open the agent dashboard.

## Create A Test Task

Start with a safe read-only or summary task.

Example:

- Name: `Generate permitting status summary`
- Type: `summary`
- Instructions: `Summarize open permitting work and identify projects that need coordinator attention. Do not update records or send messages.`
- Schedule: leave blank until the manual run behaves correctly.

Avoid starting with tasks that send messages, mutate records, or trigger external systems.

## Test A Production Agent

1. Open `Agent Ops`.
2. Click the agent in the visual org chart.
3. Review:
   - objective
   - goals
   - routines/tasks
   - recent activity
   - current status
4. Click `Run now` on a safe task.
5. Confirm the dashboard updates.
6. Open the recent run row.
7. Review the payload, result, status, and any error.
8. If the run fails, update the task instructions or implementation and rerun.
9. If the task needs irreversible action, confirm it creates an approval instead of executing directly.

Expected statuses:

- `queued`: run record exists but execution has not started.
- `running`: task is executing.
- `completed`: task finished successfully.
- `failed`: task errored.
- `approval_pending`: task produced an action requiring human approval.
- `cancelled`: task was stopped.

## Test A Scheduled Agent

1. Confirm the manual task run works first.
2. Create a schedule from `Production Agent Controls`.
3. Use a cron expression and timezone.
4. Confirm the schedule appears on the task.
5. Restart or reload the backend scheduler if needed.
6. After the scheduled time, confirm:
   - `agent_task_schedules.last_run_at` changed.
   - a new `agent_task_runs` row exists.
   - the role dashboard shows the latest run.

For initial tests, use a short temporary cron schedule. Return it to the real schedule after verification.

## Test Approval Behavior

1. Create or run a task that requests an irreversible action.
2. Confirm the task run becomes `approval_pending`.
3. Open the approval queue in `Agent Ops`.
4. Review the requested action and payload.
5. Approve or reject.
6. Confirm the approval row status changes.

Current limitation: approvals are recorded and reviewed, but approved actions are not yet automatically replayed or executed after approval. Treat approval execution as a future stage unless the specific task implements it.

## Create An Agent Lab Agent

Use Agent Lab when you want to experiment without adding a production role.

1. Open `Agent Ops`.
2. Scroll to `Agent Lab`.
3. Create a lab agent:
   - Name
   - LLM
   - Objective
   - Optional department
4. Submit it if approval is required.
5. Once approved, use `Run once`.
6. Review the output.

Lab agents should not become production dependencies. If a lab agent proves useful, convert it into a production role with goals, tasks, permissions, and approval rules.

## Promote A Lab Idea To Production

Before promoting:

- Define the role objective.
- Define repeatable task instructions.
- Identify required data sources.
- Identify any irreversible action.
- Define permissions.
- Define success metrics.
- Decide whether it needs a schedule.
- Decide where it sits in the org chart.

Then create it as a production role/task instead of relying on the lab agent.

## Safety Rules

Production agents must not:

- send external communication directly without approval
- mutate business records directly without approval
- perform irreversible actions without approval
- bypass role permissions
- run broad freestyle prompts as production workflows

Production tasks should:

- be repeatable
- have clear inputs and outputs
- write auditable run records
- fail closed when permissions or approvals are missing

## Useful Files

- `docs/agent-operating-model.md`
- `client/src/views/AgentsView.vue`
- `client/src/components/agents/AgentOrgChart.vue`
- `client/src/components/agents/AgentRoleDashboard.vue`
- `server/src/routes/agent-org.ts`
- `server/src/agents/taskDispatcher.ts`
- `server/src/agents/roleRunner.ts`
- `server/src/agents/policy.ts`
- `server/src/agents/scheduler.ts`

## Verification Commands

Frontend:

```bash
npm --prefix client run build
```

Targeted backend agent framework check:

```bash
./server/node_modules/.bin/tsc --noEmit --pretty false --target ES2022 --module ES2022 --moduleResolution bundler --strict --esModuleInterop --skipLibCheck server/src/middleware/auth.ts server/src/routes/agent-org.ts server/src/agents/taskDispatcher.ts server/src/agents/roleRunner.ts server/src/agents/policy.ts server/src/agents/scheduler.ts
```

## OpenClaw Export Files

Files such as `SOUL.md`, `MEMORY.md`, `HEARTBEAT.md`, `SESSION-STATE.md`, and similar OpenClaw exports are not currently part of the `qb-spa` runtime.

OpenClaw remains part of the broader AI strategy as a possible agent runtime, but `qb-spa` is the intended user-facing control plane. Users should create, review, approve, and monitor agents in Agent Ops rather than logging into OpenClaw for normal team workflows.

Keep exported OpenClaw files as reference material unless we deliberately migrate useful concepts into:

- `docs/agent-operating-model.md`
- this SOP
- production role seed data
- explicit agent goals/tasks
- implementation code

When OpenClaw integration is added, prefer an adapter that maps `qb-spa` production records into OpenClaw runtime inputs:

- `agent_roles` -> persona and identity
- `agent_goals` -> durable objectives
- `agent_role_tasks` -> repeatable skills/tasks
- `agent_permissions` -> tool/resource constraints
- `agent_task_runs` -> execution ledger
- `agent_approvals` -> human gates
