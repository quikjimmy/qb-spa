# Customer Portal — Project Context

## Overview
Build an external-facing customer/stakeholder portal for **Kin Home**, a solar installation company. The portal surfaces project status, milestones, and communications to customers, lenders, and other external parties — without requiring QuickBase (QB) user licenses.

The data layer already exists in QuickBase. This project wraps it in a standalone SPA with its own auth, routing, and role-based views.

## Existing System (qb-skin)
An internal mobile-optimized QB code page suite has been built with the following pages:
- **Home (cc-quick-glance.html)** — KPI dashboard with Sales, KCA, Surveys, Installs, Inspections, Favorites
- **Project Detail (qb-skin-project-detail.html)** — Full project view with milestone tracker, notes, Arrivy field tasks, communications, tickets, star/favorite
- **Tickets (qb-skin-tasks.html)** — Ticket management with pivot tables (Assigned To, Requested By, Issue, Category, State, etc.)
- **Field (qb-skin-labor.html)** — Technician leaderboard, event breakdown, survey on-time tracking
- **Trends (qb-skin-trends.html)** — Reporting with dynamic KPI charts, pivot breakdown, date range filters

All pages query the QB API directly using a user token. The same API pattern can power the portal.

## QuickBase API Pattern
```javascript
// All queries use the QB REST API v1
const headers = {
  'QB-Realm-Hostname': 'kin.quickbase.com',
  'Authorization': 'QB-USER-TOKEN <token>',
  'Content-Type': 'application/json'
};

// Query records
fetch('https://api.quickbase.com/v1/records/query', {
  method: 'POST',
  headers,
  body: JSON.stringify({
    from: '<table_id>',
    select: [3, 255, 522, ...],  // field IDs
    where: "{'522'.AF.'2026-01-01'}",
    options: { top: 500 }
  })
});

// Upsert records
fetch('https://api.quickbase.com/v1/records', {
  method: 'POST',
  headers,
  body: JSON.stringify({
    to: '<table_id>',
    data: [{ '3': { value: recordId }, '255': { value: 'Active' } }]
  })
});

// Get field metadata
fetch('https://api.quickbase.com/v1/fields?tableId=<table_id>', { headers });
```

## Key QB Tables & IDs
| Table | Table ID | Purpose |
|-------|----------|---------|
| Projects | br9kwm8na | Main project records — milestones, status, customer info |
| Arrivy Tasks | bvbqgs5yc | Field tasks — installs, surveys, inspections |
| Arrivy Task Log | bvbbznmdb | Task event log — late detection, status changes |
| Intake Events | bt4a8ypkq | KCA/intake checklist submissions |
| Events | bsbguxz4i | General events |
| Notes | bsb6bqt3b | Project notes/chat log |
| Tickets | bstdqwrkg | Internal tickets |
| SMS Log | bvjf44d7d | Dialpad text messages |
| Call Log | bvjf2i36u | Dialpad call log |

## Key Project Fields (table: br9kwm8na)
| Field ID | Label | Type |
|----------|-------|------|
| 3 | Record ID# | recordid |
| 13 | System Size (kW) | numeric |
| 145 | Customer Name | text |
| 146 | Customer Address | address |
| 148 | Mobile Phone | phone |
| 149 | Email | email |
| 189 | Customer - State | text |
| 255 | Status | text |
| 339 | Sales Office | text |
| 344 | Lender | text |
| 355 | Closer | text |
| 461 | Intake Completed Date | date |
| 491 | Passing Inspection Completed Date | date |
| 522 | Sales Date | date |
| 534 | Install Completed Date | date |
| 538 | PTO Approved Date | date |
| 571 | Inspection Pass/Fail | text |
| 820 | Project Coordinator | text |
| 2303 | Related Project Coordinator - User | user |
| 2653 | Starred By Users | multiuser |

### Milestone Fields (lifecycle order)
| Step | Field ID | Label |
|------|----------|-------|
| Survey Scheduled | 166 | Survey Scheduled Date |
| Survey Submitted | 164 | Survey Submitted Date |
| Survey Approved | 165 | Survey Approved Date |
| CAD Submitted | 699 | Min Initial Design CAD Submitted |
| CAD Approved | 701 | Min Initial CAD Design Approved |
| Design Completed | 1774 | Min Initial Design Completed |
| Permit Submitted | 207 | Permit Submitted |
| Permit Approved | 208 | Permit Approved |
| NEM Submitted | 326 | NEM Submitted Date |
| NEM Approved | 327 | NEM Approved Date |
| Install Scheduled | 178 | Install Scheduled Start Date |
| Install Completed | 534 | Install Completed Date |
| Inspection Scheduled | 226 | Inspection Scheduled Date |
| Inspection Passed | 491 | Passing Inspection Completed Date |
| PTO Submitted | 537 | PTO Submitted Date |
| PTO Approved | 538 | PTO Approved Date |

## Proven Pattern: Single-User Portal Architecture
Kin Home has already built a **Field Services Portal** using this exact approach — built rapidly with AI, it reduced QB user count to save on licensing costs. Key learnings:

- **Single QB service account** — the portal authenticates to QB with one user token, serving data to all portal users
- **Portal governs its own access** — users don't need QB accounts; auth is managed entirely by the portal (email/password, magic link, SSO, etc.)
- **Access is not synced with QB** — portal users are a separate user base. Those users no longer have (or need) direct QB access
- **Same data, different audience** — the portal reads/writes the same QB tables via API, just filters what each user can see based on their role

This is the same model for the customer portal: one QB token on the server, portal auth on the front, role-based data filtering in between.

## Portal Architecture Recommendations

### Tech Stack
- **Framework:** Vue 3 + Vite
- **UI Components:** Shadcn-vue (https://www.shadcn-vue.com/) — use the pre-built **Blocks** (https://www.shadcn-vue.com/blocks) as starting points for dashboard layouts, auth pages, data tables, and detail views. These are production-ready page templates that can be customized.
- **Styling:** Tailwind CSS (comes with Shadcn)
- **Auth:** Custom — portal manages its own users/sessions (not QB auth). Consider magic link (email-based, no password) for customer simplicity.
- **Backend:** Lightweight API proxy (Cloudflare Workers, Vercel Edge Functions, or Express)
- **Hosting:** Vercel or Netlify (free tier works)
- **Data:** QB REST API via the proxy (keeps token server-side, never exposed to browser)

### Shadcn-vue Blocks to Start With
Browse https://www.shadcn-vue.com/blocks for ready-made layouts:
- **Dashboard blocks** — KPI cards, charts, data tables (maps to the Trends page patterns)
- **Authentication blocks** — Login, register, magic link flows
- **Data table blocks** — Sortable, filterable tables with pagination (maps to ticket pivot tables)
- **Detail/profile blocks** — Card layouts with key-value pairs (maps to project detail)
- **Sidebar navigation blocks** — App shell with collapsible nav (maps to the drawer menu)

These blocks give you a polished starting point — customize with Kin Home branding and wire to the QB API proxy.

### Why a Proxy
The QB user token cannot be exposed in client-side code for an external portal. A thin server-side proxy:
1. Holds the QB token securely
2. Validates portal auth (JWT or session)
3. Filters data by the authenticated user's role/projects
4. Forwards allowed queries to QB API
5. Can cache frequently accessed data

### Suggested Role-Based Views

**Customer View:**
- Their project's current status + milestone progress bar
- Upcoming scheduled events (survey, install, inspection)
- Recent notes/communications
- Document/photo access
- Simple timeline of what's happened and what's next

**Lender View:**
- Portfolio of projects they're financing
- Milestone completion status across all projects
- Funding milestone tracker (NTP, M1, M2, M3)
- Inspection pass/fail status
- PTO status

**Subcontractor/Crew View:**
- Today's scheduled tasks
- Task details with customer info and address
- Ability to update task status
- Photo upload for site documentation

### Design System
The internal qb-skin uses these design tokens — the portal should share them for brand consistency:
```css
--bg: #f7f3f0;
--card: #ffffff;
--text: #1e293b;
--muted: #64748b;
--border: #e0d8d1;
--success: #10b981;
--warning: #f59e0b;
--danger: #ef4444;
--info: #3b82f6;
--purple: #8b5cf6;
--header-bg: #1e293b;
```

### Slack Integration
The internal app links to Slack channel `C05S7QQT5CN` for intake discussions. The portal could optionally surface relevant Slack thread updates to internal users. Workspace: `kin-home`.

## What Already Works (reusable patterns)
- QB API query/upsert patterns
- Field ID mappings for all key tables
- Milestone progress tracker logic
- KPI aggregation (sales by week, funnel, days-in-stage)
- Late detection via Arrivy Task Log (PREDICTED_LATE, LATE, NOSHOW events)
- Star/favorite toggle via multi-user field 2653
- Survey on-time rate calculation
- First-time inspection pass rate logic
- Dynamic bar chart with auto day/week/month grouping
- Pivot breakdown by any dimension (office, closer, state, lender, coordinator)

## Getting Started
1. Scaffold the Vue/React project with Shadcn components
2. Build the API proxy with QB token (start with Vercel Edge Functions)
3. Create a simple auth system (email + magic link, or email + password)
4. Map portal users to QB project records (by email, phone, or project ID)
5. Build the customer status view first — it's the highest-value, simplest scope
6. Expand to lender and crew views once the pattern is proven

## Contact
- **Builder:** James (james@kinhome.com)
- **Company:** Kin Home (solar installation)
- **QB Realm:** kin.quickbase.com
- **QB App ID:** br9kwm8bk
