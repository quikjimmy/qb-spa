# Kin Home — Booked & Boarded Daily Report

**Spec for Claude Code implementation against QuickBase live data**

---

## Purpose

A daily flash report, modeled on the auto retail "booked and boarded" report, that gives leadership a single-glance view of pipeline velocity from sale through final funding. Sent every morning by 7:00 AM MT. Sliced by state and sales team, with aging buckets that surface stuck deals before they become problems.

This is the report Larry Miller asked for on his deathbed. It's the report that makes sales managers chase paperwork because their names are on stale deals.

---

## The Five-Stage Lifecycle

Kin Home's equivalent of "sold → delivered → funded":

| Stage | Definition | QuickBase Trigger Field (suggested) |
|-------|-----------|-------------------------------------|
| **1. Booked** | Signed contract, deal entered into system | `Contract Signed Date` |
| **2. Installed** | Panels on roof, install complete | `Install Completion Date` |
| **3. M1 Funded** | Milestone 1 funding received from LightReach/GoodLeap | `M1 Funded Date` |
| **4. M2 Funded** | Milestone 2 funding received (typically post-PTO) | `M2 Funded Date` |
| **5. M3 Funded** | Milestone 3 / final funding received | `M3 Funded Date` |

Each stage has a **count** (projects), **watts** (system size in kW DC), and **dollar value** (contract price or funded amount).

---

## Report Structure

### Section 1: Daily Flash (top of email)

A single table showing yesterday / MTD / MTD Pace / Last MTD / YTD / Last YTD across all five stages.

```
KIN HOME — BOOKED & BOARDED
Reporting Date: Monday, May 04, 2026 (data through Sunday EOD)

                    YESTERDAY    MTD      MTD PACE   LAST MTD   YTD       LAST YTD
                    ─────────    ─────    ────────   ────────   ──────    ────────
BOOKED              12 / 96kW    38       142        51         412       487
INSTALLED           8 / 64kW     31       116        44         378       445
M1 FUNDED           6 / 48kW     27       101        38         351       422
M2 FUNDED           4 / 32kW     22       82         35         318       398
M3 FUNDED           3 / 24kW     18       67         29         287       365

Selling days elapsed: 2 of 22  |  Pace = MTD ÷ days_elapsed × total_days
```

**Why MTD Pace matters:** This is the projected month-end number based on selling days elapsed. It's what GMs argue about in auto. For solar, it's what tells you whether install crews can absorb May's bookings or whether Florida permitting is going to choke M1 funding again.

---

### Section 2: The Gaps (the queues that hold cash)

The two most important numbers on the page. Every deal sitting in these queues represents capital you haven't recovered yet.

```
SOLD-NOT-INSTALLED          INSTALLED-NOT-M1-FUNDED     M1-NOT-M3-FUNDED
─────────────────────       ───────────────────────     ─────────────────────
Count:        87            Count:        34            Count:        62
Watts:        698 kW        Watts:        272 kW        Watts:        496 kW
Avg age:      18 days       Avg age:      11 days       Avg age:      47 days
Oldest:       73 days       Oldest:       38 days       Oldest:       142 days
```

---

### Section 3: Aging Buckets (where names get attached)

For each gap, show the count of projects in each aging bucket. **Anything in the red bucket gets a name.**

```
SOLD-NOT-INSTALLED AGING
                    0-7 days    8-14 days   15-30 days   31-60 days   60+ days
                    ────────    ─────────   ──────────   ──────────   ────────
Florida             18          12          9            4            2
California          14          8           5            2            0
Ohio                3           2           1            1            0
Iowa                2           1           1            2            0
─────────────────   ────────    ─────────   ──────────   ──────────   ────────
TOTAL               37          23          16          ⚠ 9          ⚠ 2

INSTALLED-NOT-M1-FUNDED AGING
                    0-7 days    8-14 days   15-30 days   31+ days
                    ────────    ─────────   ──────────   ────────
Florida             8           4           3           ⚠ 2
California          6           3           2            1
Ohio                2           1           0            0
Iowa                1           1           0            0
─────────────────   ────────    ─────────   ──────────   ────────
TOTAL               17          9           5          ⚠ 3
```

---

### Section 4: Stuck Deals — Named Accountability

The teeth of the report. Any deal past the SLA threshold for its current stage gets listed by name with the responsible owner.

```
🔴 STUCK DEALS — REQUIRES ACTION

INSTALLED >14 DAYS, NOT M1 FUNDED
─────────────────────────────────────────────────────────────────────────────
Project ID    Customer          State   Sales Rep      Days   Blocker
12847         Henderson, M.     FL      Caleb C.       38     Permit rejection (3rd round)
13104         Vasquez, R.       FL      Tyce S.        24     PTO pending — utility delay
13298         Park, J.          CA      Connor Free    19     M1 docs incomplete
13315         Ahmed, S.         FL      Blake A.       17     Inspection failed — reschedule

SOLD >30 DAYS, NOT INSTALLED
─────────────────────────────────────────────────────────────────────────────
Project ID    Customer          State   Sales Rep      Days   Blocker
12654         Brennan, K.       FL      Judson         73     AHJ permit (Marion County)
12891         Chen, L.          CA      Molina         45     HOA approval pending
12903         Ortiz, D.         FL      Justin D.      42     Customer financing recheck
13002         Williams, T.      OH      William D.     38     Electrical upgrade required
```

---

### Section 5: By Sales Team / Rep (MTD)

Same five-stage view, but pivoted by rep. This is what makes it competitive.

```
SALES REP PERFORMANCE (MTD)
                  Booked    Installed   M1      M2      M3      Sold-Not-Inst
                  ──────    ─────────   ────    ────    ────    ─────────────
Caleb C.          8         6           5       4       3       12
Connor Free       7         5           4       3       2       9
Blake A.          6         5           4       3       2       8
Tyce S.           5         4           3       2       2       7
Justin D.         5         3           3       2       1       11
Judson            4         4           3       3       2       6
Molina            3         4           4       3       3       4
─────────────     ──────    ─────────   ────    ────    ────    ─────────────
TOTAL             38        31          27      22      18      87
```

---

### Section 6: Cycle Time Medians (rolling 90 days)

The trend line that answers "is funding faster this year than last?"

```
MEDIAN DAYS BETWEEN STAGES (last 90 days vs. same period prior year)

                          Current    Prior Yr   Δ
                          ───────    ────────   ─────
Booked → Installed        24 days    31 days    -7  ✓
Installed → M1 Funded     8 days     14 days    -6  ✓
M1 → M2 Funded            21 days    19 days    +2  ⚠
M2 → M3 Funded            34 days    41 days    -7  ✓
─────────────────────     ───────    ────────   ─────
Booked → M3 (full cycle)  87 days    105 days   -18 ✓
```

---

## Implementation Notes for Claude Code

### Data Source

QuickBase. Pull from the main project table. Required fields (use actual QB field IDs in implementation):

- `Project ID` (record ID)
- `Customer Name`
- `State` (FL / CA / OH / IA)
- `System Size (kW DC)`
- `Contract Price`
- `Sales Rep`
- `Sales Team`
- `Install Crew`
- `Lender` (LightReach / GoodLeap / Cash)
- Stage timestamp fields:
  - `Contract Signed Date`
  - `Install Completion Date`
  - `M1 Funded Date`
  - `M2 Funded Date`
  - `M3 Funded Date`
- `Current Blocker` (text — for stuck deals section)
- `Project Status` (to filter out cancelled / on-hold)

### Calculations

```
days_in_stage = TODAY() - max(date for stages reached so far)
selling_days_elapsed = business days from month start to yesterday (exclude Sun)
selling_days_total = business days in month
mtd_pace = mtd_value / selling_days_elapsed * selling_days_total
```

For cycle time medians, calculate per-project days between consecutive stage dates, then take median across all projects with both stages completed in the lookback window. Median (not mean) — outliers from stuck permits will skew the average.

### SLA Thresholds (configurable)

```yaml
sla_thresholds:
  booked_to_installed_warn: 14
  booked_to_installed_red: 30
  installed_to_m1_warn: 7
  installed_to_m1_red: 14
  m1_to_m2_warn: 30
  m1_to_m2_red: 60
  m2_to_m3_warn: 30
  m2_to_m3_red: 60
```

These should live in a config file or QuickBase settings table so they can be tuned without redeploying.

### Delivery

- **Email format:** HTML email, mobile-readable (most leadership reads on phone first thing)
- **Recipients:** Configurable distribution list — exec team, state leads, sales managers
- **Schedule:** 7:00 AM MT, Monday–Saturday (skip Sunday since no install activity Saturday is light)
- **Subject line:** `Kin Home B&B — May 4 — MTD: 38 Booked / 31 Installed / 18 M3 Funded`
- **Attachment:** CSV export of the stuck deals section so managers can sort/filter

### Stretch Features (phase 2)

1. **Weekly digest** sent Monday morning summarizing the prior week with WoW comparisons
2. **State-specific versions** sent only to state leads with their slice
3. **Slack post** to a `#booked-and-boarded` channel mirroring the email
4. **Looker Studio dashboard** linked from the email for drill-down
5. **Anomaly callouts** — e.g., "🚨 Florida M1 funding cycle time jumped from 8 to 17 days this week" — driven by simple z-score on rolling averages

### Architecture Suggestion

```
QuickBase (source of truth)
    ↓ via QB API (use existing API token / app-level service account)
Apps Script or n8n workflow (you already have both deployed)
    ↓ pulls overnight, builds report payload
Email send (Gmail API or SMTP) + Slack post (existing webhook)
```

Given the existing tech stack, I'd recommend **n8n** for this — you've already got it running for the AI email triage workflow, scheduling is native, and the QuickBase + Gmail nodes will handle everything without custom code. Apps Script is a fallback if n8n credits become a concern.

### Historical Backfill

Before going live, run the report against last year's data (May 2025) to validate:
- Cycle time medians match what you remember
- Funding milestone counts reconcile to LightReach/GoodLeap statements
- Stuck deals query catches the projects you already know were problems

This gives you the "last year cycle" baseline you asked about and serves as a regression test for the calculations.

---

## Success Criteria

The report is working when:

1. State leads start their day by reading it before opening anything else
2. Stuck deals get worked because names are attached and visible
3. MTD Pace becomes a number that gets argued about in Monday meetings
4. Cycle time medians show measurable improvement quarter over quarter
5. You can answer "how many watts did we install last Tuesday in Florida" in 5 seconds

---

## Open Questions for James

1. **Funding milestone definitions** — confirm M1/M2/M3 trigger criteria match the LightReach and GoodLeap contracts (they may differ between lenders, in which case the report needs lender-specific logic)
2. **"Booked" definition** — contract signed, or contract signed AND credit approved? Auto industry uses "deal jacket complete" which is closer to the latter
3. **Cancellations** — should cancelled deals be backed out retroactively from prior days' booked counts, or shown as a separate "cancellation" line?
4. **Sales team structure** — current memory shows individual reps; is there a team/manager hierarchy that should also roll up?
5. **Iowa/Ohio wind-down** — should those states still appear in the report or be moved to a "legacy markets" footer?
