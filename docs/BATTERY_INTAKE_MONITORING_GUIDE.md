# Battery Intake — Monitoring & Audit Guide

_For the intake team. Explains what we built, the Quick Base table that tracks
every inbound battery deal, how to read it to audit the process, and how the
monitoring app is driven off it._

Last updated: 2026-07-20.

---

## 1. What we built (the 30-second version)

Every battery deal sold in the **Sunobi Battery Sizer** is now automatically
turned into a Quick Base **Project** (with its Contact, Organization, battery
Adder, and Survey), and **every step of that journey is recorded on one row**
in a single staging table. That table is the source of truth: it tells you, for
any deal, whether it landed, where it got stuck, why, and lets you re-push it
with one click.

You no longer need to be in Zapier or wait on engineering to see or fix a stuck
deal. The monitoring app reads this table and gives you a queue + a **Re-push**
button.

---

## 2. The flow, end to end

```
Sunobi Battery Sizer  (a deal is sold)
        │  sends the deal (JSON) to a webhook
        ▼
STEP 0  — writes ONE row into the "HVC Raw JSON" table  (the staging table)
        │  • stores the raw deal            (raw_json)
        │  • checks "Send to Zap" = Yes     (for real deals only)
        │  • flags likely test submissions  (Likely Test)
        │  • skips byte-identical resends   (no duplicate rows)
        ▼
PIPELINE — Quick Base watches "Send to Zap = Yes" → sends the deal onward
        ▼
STEP 1  — the INTAKE: creates Organization + Contact + Project + battery Adder
        │  + Survey. Then it writes the OUTCOME back onto the same staging row:
        │  Intake Status, Project Record ID, any error, and unchecks Send to Zap.
        ▼
STEP 2  — downloads the deal's documents and attaches them to the Project.
        ▼
SLACK   — posts the sales + intake announcements (deduped so they post once).
```

**Key idea:** the staging row is created at Step 0 and then *stamped with the
result* at Step 1. So one row = one deal = its full status.

---

## 3. The table: **HVC Raw JSON** (`bvmute72r`)

Every inbound battery deal is one row here. Fields grouped by purpose:

### Identity — which deal is this?
| Field | Fid | What it is |
|---|---|---|
| Record ID# | 3 | The row's id. This is what you "re-push". |
| Proposal Id | 8 | The deal's unique id from Sunobi. One proposal can have several rows (original + change orders). |
| Date Created | 1 | When the deal first arrived. |
| raw_json | 6 | The full original deal (customer, system, financing, documents). The app parses the customer name/address out of this. |

### Intake outcome — **the fields you audit** (added 2026-07-20)
| Field | Fid | What it tells you |
|---|---|---|
| **Intake Status** | 16 | The result of the last intake attempt. See §4 for values. **This is the main field.** |
| **Intake Error** | 17 | If it failed, the error message. |
| **Intake Step** | 18 | Where it stopped (e.g. `create_project`). Blank/`done` on success. |
| **Intake Missing** | 19 | If the deal was incomplete, the list of missing/invalid data (Slack-ready bullets). |
| **Intake Project Record ID** | 20 | The Project it created. Present ⇒ it landed. |
| **Intake Last Attempt** | 21 | When intake last ran on this row. |
| **Intake Attempt Count** | 22 | How many times intake has run (goes up each re-push). |

### Queue / plumbing — how a deal gets (re)sent
| Field | Fid | What it is |
|---|---|---|
| **Send to Zap** | 10 | The **queue flag**. Checked = "process this deal." Intake unchecks it when done. **Checking it is how you re-push.** |
| Sent to Zap At | 11 | When the pipeline last sent the deal onward (informational). |
| **Resend to Zap** | 12 | A button that re-checks Send to Zap — a one-click re-push from inside Quick Base. |
| Find Arrivy Task | 13 | Unrelated helper button (survey scheduling). |

### Test / noise detection
| Field | Fid | What it is |
|---|---|---|
| Likely Test | 14 | Checked when the deal looks like a test (e.g. name contains "test", internal email). Test rows are **not** sent to intake. |
| Test Signals | 15 | The reasons it was flagged (or "empty ping" notes). |

### Slack de-dupe (managed automatically)
| Field | Fid | What it is |
|---|---|---|
| Sales Slack Message ID | 7 | The sales announcement's Slack id (prevents double-posting). |
| Intake Slack Message ID | 9 | The intake announcement's Slack id. |

---

## 4. `Intake Status` values — what each means and what to do

| Status | Meaning | What to do |
|---|---|---|
| `success` | Project created/updated cleanly. | Nothing. `Intake Project Record ID` links the Project. |
| `incomplete` | Real deal, but required data was missing — **no Project was created.** | Read **Intake Missing (19)**. Fix the data in the battery tool and resubmit, or fix + re-push. |
| `error` | Something failed mid-intake. | Read **Intake Error (17)** + **Intake Step (18)** for where/why. Fix the cause, then re-push. |
| `manual_review` | A safety check tripped (e.g. the contact name on file doesn't match the incoming name). | Look at the error, confirm the right customer, then decide whether to re-push. |
| `bad_payload` | The deal couldn't be read (malformed). | Engineering — the raw data is broken. |
| _(blank)_ | Not processed yet, or a test/quarantined row. | Check **Send to Zap** (still queued?) and **Likely Test**. |

**"Stuck" = `Intake Status` is `error`, `incomplete`, `manual_review`, or
`bad_payload`.** Those are the rows that need a human.

### `Intake Step` — where it stopped (only matters on error)
Reads like a breadcrumb of the intake sequence. Common values:
`completeness_check` · `sales_office_lookup` · `lender_lookup` ·
`project_lookup` · `create_organization` · `create_contact` ·
`create_project` · `create_junction` · `survey` · `adder` · `done`.
Example: `error` at `create_project` means everything up to creating the
Project worked, and the Project write itself failed.

---

## 5. How to fix a stuck deal — **re-push**

Re-pushing re-runs the intake on that exact deal. It is **safe to do anytime**:
intake is idempotent — re-running finds the existing Project and updates it
rather than making a duplicate.

**Three ways to re-push (all do the same thing — set `Send to Zap = Yes`):**
1. In the **monitoring app**, click **Re-push** on the row.
2. In Quick Base, click the **Resend to Zap** button on the row.
3. In Quick Base, just check the **Send to Zap** box.

**What happens next (within ~a minute):**
- Intake runs again → creates/updates the Project.
- The row updates: `Intake Status → success`, `Intake Project Record ID`
  fills in, `Intake Attempt Count` goes up, `Send to Zap` unchecks itself.

**If it stays stuck after a re-push:** the `Intake Error` / `Intake Step` will
show the new failure. If it's a data problem (`incomplete`), the fix is in the
source data, not a re-push — correct it and resubmit/re-push.

> **Why re-pushing can't cause an endless loop:** the pipeline only fires when
> `Send to Zap` *changes to Yes*. Intake sets it back to `No` the moment it
> finishes, and nothing else ever sets it to `Yes` on its own. So each re-push
> is exactly one run. (Status write-backs, Slack-id writes, and document
> uploads never touch `Send to Zap`, so they can't re-trigger anything.)

---

## 6. Audit playbook (day-to-day)

1. **Open the app → "Stuck" tab.** These are deals that arrived but didn't land.
2. For each: read **Intake Status**, then **Intake Error / Intake Missing**.
   - `incomplete` → the deal is missing data (address, price, etc.). Fix at the
     source, resubmit or re-push.
   - `error` → transient or config issue. Re-push once; if it persists, note
     the `Intake Step` and escalate.
   - `manual_review` → confirm the customer, then re-push if correct.
3. **"Queued" tab** = anything currently checked `Send to Zap` (in-flight or
   waiting). If something's been queued a long time with no result, the pipeline
   or intake may be down — escalate.
4. **"Tests" tab** = `Likely Test` rows. Ignore or delete; they're not real.
5. Spot-check a `success` row occasionally: open its Project (via **Intake
   Project Record ID**) and confirm price, rebate, battery, and address look
   right.

**Sanity checks that catch problems early:**
- A deal you know sold but **can't find any row** → it never reached Step 0
  (webhook/Sunobi issue).
- Row exists, `Send to Zap` still checked, no `Intake Status` after several
  minutes → pipeline/intake not delivering.
- `Intake Status = success` but **no `Intake Project Record ID`** → shouldn't
  happen; escalate.
- Two Projects for one Proposal Id → a race; the intake flags this on the row
  (`duplicateProjectRace`) and keeps the lowest-numbered Project as canonical.

---

## 7. How the app is (and should be) driven off this table

The monitoring app is a thin layer over this table — **all its data comes from
the fields above.** It never needs Zapier or a Quick Base seat for the team.

**What the app reads (per row):** Record ID#, Proposal Id, Date Created,
Intake Status/Error/Step/Missing, Intake Project Record ID, Intake Last
Attempt / Attempt Count, Send to Zap, Likely Test — plus customer name &
address parsed from `raw_json` on the server.

**The app's tabs are just filters on this table:**
| Tab | Filter |
|---|---|
| Stuck | `Intake Status` is error / incomplete / manual_review / bad_payload |
| Queued | `Send to Zap` = Yes |
| Tests | `Likely Test` = Yes |
| All | everything, newest first |

**The app's one write action** — "Re-push" — sets `Send to Zap = Yes` on the
row via the Quick Base API. That's it. Everything else is read-only.

**Deep links** the app surfaces: the Quick Base **staging row** (to see the full
raw payload) and the **Project** (`Intake Project Record ID`) once it exists.

> Design rule for anyone extending the app: **read status from `Intake Status`,
> not from `Send to Zap`.** `Send to Zap` means "queued to (re)process," not
> "is a real/good deal." A landed deal has `Send to Zap = No` and
> `Intake Status = success`.

---

## 8. Extending this to normal (non-battery) intake

The goal is **one app that shows both battery and normal intake projects.** The
pattern that makes battery intake auditable is portable — it's just three ideas:

1. **A staging/intake row per inbound deal** (we have this for battery).
2. **A written-back status on that row** — the equivalent of `Intake Status`,
   `Intake Error`, `Intake Step`, and a link to the Project it created.
3. **A re-fire flag** — the equivalent of `Send to Zap`, so the team can
   re-push without engineering.

To unify them in the app, we'd:
- Add the same status fields (or map existing ones) onto whatever table the
  **normal intake** lands in.
- Add a **`Source` / `Type`** field (e.g. "Battery" vs "Solar/Normal") to each,
  so the app can show a combined queue with a filter.
- Point the app at both tables (or a shared report) using the identical
  read-fields + re-push-flag contract described in §7.

Nothing about the app's design is battery-specific — it's a status-driven queue.
Once normal intake exposes the same three ideas, it drops straight into the same
UI. _(This part is a plan, not yet built — the battery side is live today.)_

---

## 9. Cheat sheet

**Table:** HVC Raw JSON · `bvmute72r`

**Audit fields:** Intake Status (16) · Intake Error (17) · Intake Step (18) ·
Intake Missing (19) · Intake Project Record ID (20) · Intake Last Attempt (21) ·
Intake Attempt Count (22)

**Status values:** `success` · `incomplete` · `error` · `manual_review` ·
`bad_payload`

**Re-push:** set **Send to Zap (10) = Yes** — via the app's Re-push button, the
Resend to Zap button, or checking the box. Safe & idempotent; can't loop.

**"Stuck" =** Intake Status is error / incomplete / manual_review / bad_payload.
