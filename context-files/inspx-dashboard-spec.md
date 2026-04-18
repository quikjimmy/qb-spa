# Inspection (INSPX) Milestone Dashboard — Spec

## Data Sources

### Inspections Table (bsc3v7tdg)
| FID | Field | Use |
|-----|-------|-----|
| 3 | Record ID | PK |
| 12 | Related Project | FK to projects |
| 14 | Project Full Name | Display |
| 7 | Inspection Completed | Date completed |
| 8 | Inspection Pass/Fail | Pass or Fail |
| 19 | Inspection Scheduled Date | When scheduled for |
| 1 | Date Created | When record was created (= when scheduled ON a day) |
| 100 | Inspection Type | Final/Electrical |
| 166 | Official Pass/Fail | Formula result |
| 179 | Inspection Age Bucket | QB-computed |
| 47 | Project Install Completed (lookup) | For Install→Inspx days |
| 59 | Project EPC | Filter |
| 92 | fail_reason | Why it failed |
| 140 | Inspection To-Do | What's needed next |
| 67 | State (if exists, or from project) | Geography |

### Projects Table (already cached, add fields)
| FID | Field | Use |
|-----|-------|-----|
| 1757 | Inspection First Time Pass | Checkbox |
| 571 | Inspection Pass/Fail | Multitext summary |
| 1469 | Inspection Failed Date | Date |
| 1410 | # of Inspections | Count |
| 1073 | # of Inspections (Passed) | Count |

## KPIs
- #Scheduled (in date range)
- #Passed (in date range)
- %Passed
- #First Time Pass
- %First Time
- Days Since Install (avg for need-inspection projects) — red
- Need Inspection (install complete, no inspection passed) — red

## Charts

### 1. #Scheduled on a Day (NEW — not in example)
- X axis: date (day or week)
- Y axis: count of inspection records created (Date Created FID 1) per period
- Shows when inspections are being scheduled (booked), not when they're scheduled for

### 2. Install Complete → Inspection Passed
- Median days from install_completed to inspection_passed
- Distribution chart (box plot or histogram)
- Table by State: State | #Sched | #Passed | #First Time | %FirstTime | Inst→Insp days

### 3. Aging Buckets (Need Inspection)
- Buckets: 0-5, 6-30, 31-60, 61-90, 90+ days since install completed
- Table with # and %Total
- Active Fails count

### 4. #Passed by Month
- Bar chart of passing inspections by month

### 5. Inspection Outcomes by Install Month
- Horizontal stacked bar: Pass (green) | Sched (blue) | N/A (gray) | Fail (red) | Fail-Pass (pink)
- Shows what % of each install month's projects have passed, failed, scheduled, etc.

## Route: `/projects/inspections`
