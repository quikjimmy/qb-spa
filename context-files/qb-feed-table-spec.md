# QB Feed Table — Spec & Pipeline Plan

## Status: Pending — table needs to be created in QB

## Table Schema

**Table Name:** `Portal Feed`
**Purpose:** Central activity log for all human and agent work, powering the portal's social feed

| Field ID | Label | Type | Notes |
|----------|-------|------|-------|
| 6 | Event Type | Text (multiple choice) | `milestone`, `status_change`, `note`, `ticket`, `task_event`, `agent_run`, `comment`, `escalation`, `approval` |
| 7 | Title | Text | Short headline — "Install Completed", "Permit Checker failed" |
| 8 | Body | Text (multi-line) | Longer detail — "Processed 8 intakes, flagged 2 incomplete" |
| 9 | Actor Name | Text | Who did it — human name or agent name |
| 10 | Actor Email | Email | Email of the human, null for agents |
| 11 | Actor Type | Text (multiple choice) | `human`, `agent`, `system`, `webhook` |
| 12 | Agent ID | Text | For agent events — the agent identifier (e.g. `agent-intake-processor`) |
| 13 | Related Project | Numeric (relationship) | FK to Projects table (record ID) |
| 14 | Related Project Name | Lookup | Pulls Customer Name from Projects via field 13 |
| 15 | Source Table | Text | Which QB table this event came from — `Projects`, `Tickets`, `Arrivy Tasks`, etc. |
| 16 | Source Record ID | Numeric | Record ID in the source table |
| 17 | Severity | Text (multiple choice) | `info`, `success`, `warning`, `error` — drives notification priority |
| 18 | Tags | Text | Comma-separated — `late`, `escalated`, `automated`, `needs-review`, `cron` |
| 19 | Duration (sec) | Numeric | For agent runs — how long the task took |
| 20 | Records Processed | Numeric | For agent runs — how many records were touched |
| 21 | Trigger | Text (multiple choice) | `cron`, `manual`, `webhook`, `event`, `user` — what kicked this off |
| 22 | Status | Text (multiple choice) | `completed`, `failed`, `running`, `pending` — for agent task tracking |
| 23 | Error Message | Text (multi-line) | If something failed, capture why |
| 24 | Link URL | URL | Deep link back to the portal page or QB record |
| 25 | Metadata | Text (multi-line) | JSON blob for anything extra — flexible extension point |
| 26 | Occurred At | DateTime | When this actually happened (not when the record was created) |
| 27 | Is Visible | Checkbox | Default true — lets you hide items from the feed without deleting |

**Built-in QB fields (automatic):**
- Field 1 = Date Created
- Field 2 = Date Modified
- Field 3 = Record ID
- Field 4 = Record Owner
- Field 5 = Last Modified By

## Pipelines Needed

Once the table exists, these QB Pipelines (or external automations) populate it:

### 1. Project Milestone Pipeline
- **Trigger:** Any milestone date field changes from empty to a value on the Projects table
- **Milestone fields to watch:** 166 (Survey Scheduled), 164 (Survey Submitted), 165 (Survey Approved), 699 (CAD Submitted), 701 (CAD Approved), 1774 (Design Completed), 207 (Permit Submitted), 208 (Permit Approved), 326 (NEM Submitted), 327 (NEM Approved), 178 (Install Scheduled), 534 (Install Completed), 226 (Inspection Scheduled), 491 (Inspection Passed), 537 (PTO Submitted), 538 (PTO Approved)
- **Creates feed record:** event_type=`milestone`, title=field label, actor=Project Coordinator (field 820), related_project=Record ID, severity=`success`

### 2. Project Status Change Pipeline
- **Trigger:** Status field (255) changes on Projects table
- **Creates feed record:** event_type=`status_change`, title="Status: {new value}", actor=Last Modified By, severity=`info`

### 3. Note Added Pipeline
- **Trigger:** New record created in Notes table (bsb6bqt3b)
- **Creates feed record:** event_type=`note`, title="Note added", body=note content (truncated), actor=Record Owner, related_project from lookup

### 4. Ticket Created Pipeline
- **Trigger:** New record in Tickets table (bstdqwrkg)
- **Creates feed record:** event_type=`ticket`, title="Ticket: {title}", actor=Record Owner, severity=`warning` if high priority

### 5. Arrivy Task Event Pipeline
- **Trigger:** New record in Arrivy Task Log (bvbbznmdb)
- **Creates feed record:** event_type=`task_event`, title based on event type (CREW_ASSIGNED, LATE, NOSHOW, etc.), severity=`error` for LATE/NOSHOW, actor from assignee field

### 6. Agent Run Pipeline
- **Trigger:** Agents write directly to the feed table via API after each task run
- **No pipeline needed** — the agent itself creates the record with event_type=`agent_run`, actor_type=`agent`, agent_id, duration, records_processed, status, error_message

## Portal Changes When Table Exists

Once the table is created and pipelines are running:

1. **Replace multi-table ingestion** — portal reads from this one table instead of querying 9 separate QB tables
2. **Real-time feed** — poll the feed table every 30-60 seconds for new records, or use a webhook
3. **Agent monitoring** — filter by `actor_type=agent` for the Agents view, replacing mock data
4. **Auto-notifications** — portal watches for `severity=error` or `severity=warning` and creates portal notifications automatically
5. **Two-way sync** — portal can write comments back to QB (as new feed records with event_type=`comment`) if desired

## What We Need From You

- [ ] Create the `Portal Feed` table in QB app br9kwm8bk
- [ ] Share the table ID once created
- [ ] Set up pipelines 1-5 (or let us know if you want help building them)
- [ ] Confirm which agents should write directly to the feed table
- [ ] Decide if comments should sync back to QB or stay portal-only
