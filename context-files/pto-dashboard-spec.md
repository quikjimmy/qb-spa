# PTO Milestone Dashboard — Spec

## Route: `/projects/pto`

## Filters (top row)
- Lender, Utility (if available), State — dropdowns from cached project data
- Date range — context-dependent per chart section (not one global range)
- EPC — default "Kin Home" (inherited from projects view pattern)

## KPIs (horizontal strip under filters)
| KPI | Logic | Clickable |
|-----|-------|-----------|
| #PTO Sub | Count of projects with pto_submitted date | No |
| kW Submitted | Sum of system_size_kw where pto_submitted | No |
| #Approved | Count with pto_approved date | No |
| kW Approved | Sum kW where pto_approved | No |
| Install to PTO (days) | Avg days from install_completed to pto_approved | No |
| Days Since Install | Avg days from install_completed to today (for Need PTO projects) | No |
| Need PTO | Count: inspection_passed but no pto_approved | YES — filters in-page |

## Charts

### 1. PTO Submitted (bar chart)
- X axis: time (auto: daily/weekly/monthly based on date range)
- Y axis: count of projects where pto_submitted falls in that period
- Date filter: PTO Submitted date range
- Stacked: #Submitted vs #Approved

### 2. PTO Approved (bar chart)
- X axis: time (auto grouping)
- Y axis: count of projects where pto_approved falls in that period
- Date filter: PTO Approved date range

### 3. Time to PTO (combo chart)
- X axis: sale month
- Bars: count of PTO'd projects by their sale month (right Y axis)
- Line 1: avg Install-to-PTO days per sale month cohort (left Y axis)
- Line 2: avg Sale-to-PTO days per sale month cohort (left Y axis)
- No date range filter — shows all historical data

### 4. Inspex Passed, NO PTO (bar chart + table)
- Bar chart: count of projects in each aging bucket since inspection passed
- Buckets: 0-15, 16-30, 31-60, 61-90, 90+ days
- Table alongside: bucket | # | #Sub (already submitted) | kW
- No date range filter — shows current snapshot

### 5. Installed Accounts w/PTO (horizontal stacked bar)
- X axis: percentage (0-100%)
- Y axis: install month
- Stacked: has PTO (yes) vs no PTO
- Shows what % of each month's installed projects have achieved PTO
- No date range filter — shows all months

## Interactions
- Clicking a bar/bucket in any chart filters a project list below on the same page
- Project list uses the same card format as /projects
- Clicking a project opens QB in new tab (same as projects view)

## Chart library: best fit for polish + interactivity (ECharts or Chart.js)
