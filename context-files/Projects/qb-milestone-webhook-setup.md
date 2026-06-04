# QuickBase → Portal: live milestone webhook setup

**Goal:** when a milestone field changes on a project in QuickBase, the portal's
`project_cache` updates within seconds — so reports (Booked & Boarded, funding,
dashboards) show live data instead of waiting on the background tier scheduler.

**Status:** server endpoint is built and deployed (`/api/webhooks/qb/project-changed`).
The remaining step is QB-side: point a Pipeline at it. Until that Pipeline exists,
milestone fields only refresh on the activity-gated scheduler or an on-demand
`?live=1` open — i.e. they can read stale.

---

## How it works

```
QuickBase Pipeline (on record update)
   │  POST { record_id: <Record ID#> }
   ▼
POST /api/webhooks/qb/project-changed        (server/src/routes/qb-webhooks.ts)
   │  resolves the project from its own record id (selfIsProject)
   │  → fetchOneLive(recordId) pulls the canonical row from QB
   │  → upserts project_cache (cached_at = now)
   ▼
Reports / dashboards read the fresh row
```

Why a dedicated endpoint: the milestone fields (install completed, PTO, status,
M2/M3/DCA dates + amounts) all live **on the Projects table `br9kwm8na` itself**,
so the changed record *is* the project. The older `/project-refresh` endpoint
expects a separate related-project field and will log these as `ignored`. Use
`/project-changed` for anything that edits the Projects row directly.

---

## QuickBase Pipeline configuration

Create one Pipeline (QB **Pipelines**, not legacy webhooks):

1. **Trigger** — channel: *Quickbase*, step: **"When a record is updated"**
   - Table: **Projects** (`br9kwm8na`)
   - (Recommended) Add a condition so it only fires on the fields that matter,
     to avoid noise from unrelated edits. Milestone field IDs:

     | Field | FID |
     |---|---|
     | Install Completion Date | 534 |
     | PTO Approval Date | 538 |
     | Status | 255 |
     | M2 Deposit Date | 1914 |
     | M2 Net Received | 1889 |
     | M3 Deposit Date | 1915 |
     | M3 Net Received | 1890 |
     | DCA Actual Deposit | 2773 |
     | DCA Total Received | 2772 |

2. **Action** — channel: *Webhooks*, step: **"Make a custom request"** (POST)
   - **URL:** `https://<PROD_HOST>/api/webhooks/qb/project-changed`
   - **Method:** `POST`
   - **Headers:**
     - `Content-Type: application/json`
     - `X-QB-Webhook-Secret: <value of QB_WEBHOOK_SECRET on the server>`
   - **Body (JSON):**
     ```json
     { "record_id": {{ a.Record ID# }} }
     ```
     Map the trigger record's own **[Record ID#]** into `record_id`.
     (`changed_field_ids` is optional but makes the audit log nicer:
     `{ "record_id": {{ a.Record ID# }}, "changed_field_ids": "534" }`.)

3. **Turn the Pipeline on.**

### Secret
- Set `QB_WEBHOOK_SECRET` in the server environment (Railway) and use the same
  value in the header above.
- If the env var is **unset**, the endpoint runs in open mode (accepts anonymously,
  logs a warning) — fine for a quick test, not for production.

---

## Verifying it works

1. Edit a project's install-completed (or any milestone) field in QuickBase.
2. Hit the diagnostic endpoint (secret-guarded — pass `?secret=` or the header):
   ```
   GET https://<PROD_HOST>/api/webhooks/qb/recent?secret=<QB_WEBHOOK_SECRET>
   ```
3. Read the result:
   - a `project-changed` row with **`status: processed`** → working; cache refreshed.
   - **`status: ignored`** → payload carried no usable id (check the Body mapping).
   - **`status: failed`** with an `error` → see the message (e.g. project filtered
     out of QB query, or auth).
   - **zero rows** → the Pipeline isn't firing (check it's enabled / the trigger
     condition / the URL).

`byStatus` in the same response gives the rolling counts per kind+status.

---

## Notes / gotchas

- **`fetchOneLive` respects the standard QB filters** (Kin Home EPC, not-test,
  active-pipeline exclusions). A record that's filtered out will come back
  `not_found` — that's expected, not a bug.
- **Coalescing:** rapid repeated edits to the same project while a refresh is in
  flight are marked `coalesced` and collapsed into the one pull. Normal.
- **Don't reuse `project-created`** for this — that Pipeline only invalidates the
  intake caches; it does **not** refresh `project_cache` milestone fields.
- This is the durable fix. The report-level live pull (B&B awaits
  `refreshFundingPopulationLive()`) is a belt-and-suspenders backstop; the webhook
  is what keeps every surface live without a report being open.
