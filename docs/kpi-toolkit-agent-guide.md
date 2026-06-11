# KPI Toolkit — Agent Guide & Self-Test

**You are an agent. Read this file top to bottom, then do the "Self-test" at the end and report your results.**

This is a read-only toolkit that lets you measure the operational state of Kin
Home's solar pipeline — funnel-gap and aging KPIs — and drill from any KPI into
the specific projects behind it. It reads a local SQLite mirror of QuickBase
(`project_cache`), so it's fast and needs no QuickBase credentials for reads.

It is **provider-neutral**: the same three tools are exposed to Anthropic, to
OpenAI-style function callers, and over MCP. You don't need to care which — you
just call tools by name with a JSON input and read the JSON result.

---

## What you can call (the tool contract)

Nine tools, all read-only. The first three are the generic funnel/KPI surface;
the rest are domain digests (funding, comms, tickets, breakdowns, scheduling).
Always start with `list_kpis` to see what's live.

### 1. `list_kpis`
Discover what can be measured. **Call this first.**
- Input: `{}` (no arguments)
- Returns: `{ kpis: [{ slug, label, description, unit, qbSource }] }`

### 2. `get_kpi`
Compute one KPI from the live cache.
- Input:
  ```json
  { "slug": "inspection_passed_not_pto", "sample_limit": 10 }
  ```
  - `slug` (required) — a slug from `list_kpis`
  - `sample_limit` (optional, 0–100, default 10) — how many example projects to return
- Returns:
  ```json
  {
    "slug": "...", "label": "...", "value": 41, "unit": "projects",
    "avg_days_in_stage": 61,
    "sample": [
      { "record_id": 8174, "customer_name": "...", "coordinator": "...",
        "state": "AZ", "days_in_stage": 406 }
    ],
    "sample_truncated": true, "as_of": "2026-06-02T..."
  }
  ```
  `sample` is oldest-first, so the top rows are the ones to chase.

### 3. `query_projects`
Free-form structured query when no single KPI fits. Read-only, column-allowlisted.
- Input (all optional):
  ```json
  { "status_contains": "Hold", "coordinator": "Emma Martin", "state": "AZ",
    "has_set": "install_completed", "not_set": "pto_approved", "limit": 25 }
  ```
  `has_set`/`not_set` accept milestone date columns only (e.g. `sales_date`,
  `install_completed`, `inspection_passed`, `pto_approved`, `permit_submitted`,
  `m1_approved_date`, `cancel_date`).
- Returns: `{ count, limit, projects: [...] }`

### 4. `get_funding_status`
Funding-milestone backlog: status buckets (Ready / Pending / Approved-Not-Received
/ Not Ready) with counts + expected $, plus clawback-risk callouts.
- Input: `{ "milestone": "M2" }` (omit `milestone` for all of M1/M2/M3/DCA). Optional `state`/`closer`/`lender`.

### 5. `get_funding_by_lender`
One milestone pivoted by lender, top N + "Other".
- Input: `{ "milestone": "M2", "top": 5 }`

### 6. `get_comms_stats`
Phone/SMS over a rolling window: inbound/outbound volume, **inbound answer rate**,
**outbound connect rate**, SMS in/out.
- Input: `{ "window_days": 7 }` (use 7 and 30). Optional `coordinator`.

### 7. `get_tickets`
Ticket backlog: open / overdue / due-today / future counts, plus **top offenders**
by assignee and by category.
- Input: `{ "top": 5 }`

### 8. `get_breakdown`
Intake/sales performance grouped by a dimension: projects sold, kW sold, KCA'd,
**KCA rate %**, **first-time inspection-pass rate %**.
- Input: `{ "dimension": "state" }` or `{ "dimension": "lender", "top": 5 }`
  (`dimension` = `state` | `lender` | `closer` | `coordinator`)

### 9. `get_schedule`
Installs/surveys on the calendar: count, kW, per-state locations.
- Input: `{ "task": "install", "window": "next_7_days" }`
  (`task` = `install` | `survey`; `window` = `today` | `yesterday` | `next_7_days` | `prev_7_days`)

> Freshness note: `get_comms_stats` reads the Dialpad call/SMS cache. If a window
> returns all zeros, the cache hasn't synced data for that range — widen the
> window or check the sync, don't assume the team made no calls.

---

## The KPIs (as of this writing)

| slug | meaning |
|---|---|
| `sold_not_installed` | Contract signed, install not done. Top-of-funnel backlog. |
| `installed_not_m1_funded` | Installed but Milestone-1 funding not approved. |
| `installed_not_inspection_passed` | Installed, inspection not yet passed. |
| `inspection_passed_not_pto` | Inspection passed, PTO not approved — final activation gap. |
| `permit_submitted_not_approved` | Permit at the AHJ, not approved or rejected. |
| `on_hold` | Any hold status (Finance / HOA / Roof / generic). |

Always treat `list_kpis` as the source of truth — slugs may be added or changed.

### Data note — recency bound on the install-funnel KPIs
The three **install-funnel** KPIs (`sold_not_installed`,
`installed_not_m1_funded`, `installed_not_inspection_passed`) apply a **180-day
recency bound** — they exclude legacy projects whose later milestone dates were
never backfilled (which otherwise inflated the counts into the hundreds at
~1,900 days old). Their result carries `recency_days: 180` so you know the
window. If you need the full historical set, say so and the bound can be lifted
per-call.

---

## How to run it

This toolkit lives in the `qb-spa` repo. You need the repo present on your host
with its local SQLite cache populated (the running portal populates it).

**From the `server/` directory:**

```bash
# Read-only smoke test — lists every KPI and computes each from the real cache.
# No API key needed.
npm run kpi:demo
```

If `ANTHROPIC_API_KEY` is set, `kpi:demo` also runs a live agent loop so you can
watch a model call the tools. You don't need that to test — you can call the
tools yourself.

**Call a tool directly (no LLM):**
```bash
npx tsx -e "import('./src/agents/tools/dataTools').then(m => \
  console.log(JSON.stringify(m.executeDataTool('get_kpi', { slug: 'inspection_passed_not_pto', sample_limit: 5 }), null, 2)))"
```

**Use it over MCP** (if you're an MCP client): launch the stdio server and it
advertises the same three tools:
```bash
npm run kpi:mcp
```

---

## Self-test — do this and report back

1. Confirm you can reach the repo: from `server/`, run `npm run kpi:demo`.
   - **If it errors that `project_cache` is missing or the repo isn't here →
     STOP and report: "Cannot reach the qb-spa repo / local cache on my host."**
     That means you need a network bridge (a hosted endpoint), not a file —
     say so and stop here.
2. From the demo output, report the `value` and `avg_days_in_stage` for
   `inspection_passed_not_pto`, `permit_submitted_not_approved`, and `on_hold`.
3. Call `get_kpi` for `inspection_passed_not_pto` with `sample_limit: 3` and
   list the 3 record_ids + coordinators it returns.
4. Call `get_funding_status` with `{ "milestone": "M2" }` and report the
   Approved-Not-Received count and any clawback callout.
5. Call `get_tickets` with `{ "top": 5 }` and name the top past-due assignee.
6. Call `get_breakdown` with `{ "dimension": "state" }` and report KCA rate %
   and first-time-pass rate % for the top state.
7. State one thing you'd want this toolkit to do that it can't yet.

Report all of them. That tells us the toolkit works for you and what to build next.
