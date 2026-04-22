# Pilot: PC Daily Coordinator Digest

Last updated: 2026-04-21

## Why This Pilot

The OpenClaw export at:

`/Users/jamestootill/Desktop/AI/full-backup-2026-03-31/workspace-coordinator/knowledge/morning-briefing-blocks-template.md`

is a strong first production-agent test because it is:

- repeatable
- easy for Project Coordinators to judge
- safe to start as a draft
- tied to real project operations
- a natural fit for schedules, approvals, and run history

This is not agent training. It is turning a proven briefing format into a controlled routine that Agent Ops can schedule, audit, and improve.

## Agent Ops Mapping

Role:

- `Status Summary Worker`

Goal:

- Summarize current project state and package repeatable coordinator updates.

Task:

- `Generate daily coordinator digest`

Task type:

- `digest`

Runtime today:

- Built-in `qb-spa` role runner.

Future runtime option:

- OpenClaw adapter using the same role/task/goal records.

## First Test

In Agent Ops:

1. Open the visual org chart.
2. Click `Status Summary Worker`.
3. Find `Generate daily coordinator digest`.
4. Click `Run sample`.
5. Open the recent run row.
6. Review the generated draft.

The sample run uses a built-in test payload with installs, attention items, wins, and system kW values. This proves the control plane before we connect live Quickbase data:

- role exists
- task exists
- run is recorded
- output is inspectable
- no message is sent directly

## Live Quickbase Test

After the sample run works:

1. Open `Agent Ops`.
2. Click `Status Summary Worker`.
3. Find `Generate daily coordinator digest`.
4. Click `Run live`.
5. Open the newest recent run row.
6. Review the draft generated from Quickbase project data.

The live run uses the server-side `QB_USER_TOKEN` and does not use the hardcoded token from the OpenClaw export.

Current live query scope is based on the OpenClaw Python tool:

- Paige Elkins projects
- active projects
- today's installs
- tomorrow's installs
- submitted permits without approval
- install complete with no inspection
- inspection passed with no PTO

If `QB_USER_TOKEN` is not configured, the run will complete with query errors in the result payload instead of sending anything externally.

## Delivery Test

After the live single-user run works:

1. Confirm the intended recipients are active users in the `PC` department.
2. Confirm each user's app email matches QuickBase `Project Coordinator - Email` field `822`.
3. Open `Agent Ops`.
4. Click `Status Summary Worker`.
5. Find `Generate daily coordinator digest`.
6. Click `Deliver PCs`.
7. Review the delivery summary.
8. Each PC user should see their generated digest in their Agent Ops inbox.

For this first version, `all PCs` means active `qb-spa` users assigned to the `PC` department. The QuickBase coordinator filter uses the user's app email against `Project Coordinator - Email` field `822` in the Projects table. The app name is display-only.

Future admin work should add explicit recipient mapping only for exceptions where a user's app email does not match QuickBase field `822`.

## Input Shape

The useful production input shape is:

```json
{
  "coordinator": "Paige",
  "day": "Tuesday",
  "installs": [
    {
      "rid": 123,
      "customer_name": "Customer Name",
      "location": "City, State",
      "lender": "Lender",
      "permit_status": "Permit approved 2026-04-20",
      "system_kw": 8.2
    }
  ],
  "attention_items": [
    {
      "rid": 456,
      "project_name": "Project Name",
      "issue": "Permit pending 14 days",
      "context": "AHJ response not received after resubmission.",
      "system_kw": 9.4
    }
  ],
  "wins": [
    "Three permits approved yesterday",
    "Two installs cleared for scheduling"
  ]
}
```

## Output Shape

The output should be a Slack-ready draft, not a sent message.

Sections:

- Today's installs
- Needs your attention
- Good news
- Short action buttons
- Delayed ops revenue impact when relevant

The OpenClaw button directive style is preserved as text for now:

```text
[[slack_buttons: View in Dashboard:https://kin-pc-dashboard.vercel.app, Mark Resolved:resolved_456, Escalate:escalate_456]]
```

Later, the Slack sender can convert this to real Block Kit or OpenClaw can compile it if that becomes the runtime.

## Data Needed

To make the digest useful, the task needs data from:

- Quickbase projects table
- project milestones
- permit status fields
- installs scheduled today
- notes/activity since last digest
- holds or blocker classifications
- system size kW for dollar impact

This tells us which MCPs matter first:

1. Quickbase Projects MCP
2. Quickbase Notes MCP
3. Milestones/Permits MCP
4. Notifications or Slack Draft MCP

## Approval Rule

The digest can be generated automatically, but posting externally or into Slack should be approval-gated until the output is trusted.

Safe now:

- generate draft
- show in Agent Ops
- include action recommendations

Not safe without approval:

- send Slack message
- mark item resolved
- escalate to a person
- update project records
- reschedule install

## Success Criteria

The pilot is working when:

- a PC can scan the digest in under two minutes
- today's installs are accurate
- urgent issues are not buried
- dollar impact appears for material delays
- actions are clear but not executed automatically
- every run is visible in Agent Ops

## Next Build Step

Review the live result with a Project Coordinator. Then decide whether to:

- adjust the Quickbase filters
- make coordinator selection dynamic instead of Paige-only
- add city/state fields if needed
- add real Slack draft/approval flow
- extract the Quickbase query pack into dedicated MCP-style tools
