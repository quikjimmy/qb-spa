# Handoff: Kin Home — Project Detail (Mobile + Desktop)

## Overview

A redesigned **Project Detail** view for Kin Home's internal ops tool. The screen is the daily workspace for project coordinators, closers, and area directors — the place they triage what needs attention on a solar install in flight, see who said what to the customer, and track every milestone from Sale through PTO Approved.

The redesign keeps Kin's existing app chrome (thin grey breadcrumb strip, white page header, green "+ New Project" CTA, ghost action buttons, no app-wide dark navbar) and only adds an inline **Search** affordance in the top strip. All new design work happens *inside* the page: a customer/SLA card, an ops-signal "What needs attention" card, a granular 20-step **Progress Timeline**, a unified **Deal Feed** stream, segmented **Communications**, and a **Tickets** stack with a colored left rail per state.

The same React components compose into a 3-column desktop layout (`360 / 1fr / 380`) so the design system scales up without forking.

---

## About the Design Files

The files in this bundle are **design references created in HTML** — interactive prototypes showing the intended look, layout, and behavior. **They are not production code to copy directly.**

The implementation task is to **recreate these designs in Kin's existing codebase** (Quickbase form rewrite / wrapping app — whatever the live product uses today) using its established component library, routing, data layer, and styling patterns. If you don't already have a frontend framework chosen, React + a CSS-in-JS or Tailwind setup will port most directly because the JSX in this bundle is plain React 18 with inline `style` objects.

The HTML/JSX prototype lives in `Project View.html` (entry) → loads `project-view.jsx` (all components + mock data) inside `design-canvas.jsx` (pannable canvas chrome) and a small `PhoneShell` wrapper defined inline in the HTML.

Open `Project View.html` in a browser to see the artboards. Drag to pan, scroll/pinch to zoom, click any artboard label to focus.

---

## Fidelity

**High-fidelity (hifi).** Final colors, typography scale, spacing, border radii, copy, and interaction patterns are all locked. Mock data (customer name, project ID 10621, address, system size, milestones, SMS threads, feed events) is realistic and derived from a real Kin project record. Replace with live data; do not redesign.

The phone shell (rounded bezel, dynamic island, status bar, home indicator) and the desktop browser chrome (traffic lights, URL bar) are **presentation only** — they show how the design sits inside iOS / a desktop browser. **Do not implement the bezels.** Implement only the content inside them.

---

## Screens / Views

There are **7 artboards** in the canvas, all driven by **two top-level components**: `MobileProjectView` (with a `tab` prop) and `DesktopProjectView`. Mobile artboards are the same component pre-set to different tabs.

### 1. Mobile · Overview (`tab="overview"`, default)

**Purpose:** First screen on tap-in. Coordinator scans customer, SLA, blockers, and project specs in under 5 seconds.

**Layout (top to bottom):**
1. **App chrome** — see "Chrome" section below
2. **Tab strip** — horizontal segmented control: `Overview · Deal Feed · Progress · Comms · Tickets` (sticks under header)
3. **Customer card** — star toggle · name · `#10621` · Active pill · phone/email/address · 3 SLA pills (days-in-stage, open stips count, outreach pref) · Call/Text/Email/Map quick-action row (4 equal buttons)
4. **What needs attention card** — list of ops blockers with a left tone rail (red/amber/blue), label, sub-label, and an inline action affordance
5. **Project Specs grid** — 2-column key/value: System Size, Panels, Inverter, Module, Est. Production, Offset, Contract Value, $/W, Sale Date, Project Age, Lender, Finance Type
6. **Team card** — Closer / Setter / Area Director / Coordinator (4 rows, each with avatar initials)
7. **Bottom safe area** — 24px

### 2. Mobile · Deal Feed (`tab="feed"`)

**Purpose:** Single chronological stream of every event on the project — notes, SMS, calls, audit-log changes, milestone transitions, system events, doc uploads. Replaces the old "look in 4 different tabs" workflow.

**Layout:**
1. App chrome + tab strip
2. **Filter chips row** — `All · Notes · Texts · Calls · Milestones · Changes · System` (horizontal scroll, active chip is filled navy)
3. **Day-grouped feed** — for each day: a sticky-ish day header (`Today`, `Apr 28`, `Apr 27`), then a vertical timeline of event cards
4. **Event card structure:** left gutter has a colored dot + dotted vertical line connecting events; main body has `[time · channel-pill] [actor + role] [title (bold)] [body (1-2 lines)] [optional category chip]`
5. **Pinned notes** float to top of their day with a 📌 affordance
6. Composer FAB bottom-right: floating circle with `+` icon → opens new-note sheet

### 3. Mobile · Progress (`tab="progress"`)

**Purpose:** See exactly which of the 20 granular milestones are done, which is active, and which are pending. Replaces the coarse 9-step bar in the original Kin form.

**Layout:**
- App chrome + tab strip
- **Progress Timeline card** — vertical list of 20 steps, each row:
  - 16px-wide left gutter with dot (filled green = done, ringed blue with pulsing halo = active, hollow grey = pending) and a 1px vertical connector line between dots
  - Step label (15px / 600)
  - Date sub-label (12px / 500 / muted) when known, em-dash when not
  - Sublist (e.g. under NEM: "auto-assigned · Manel Atienza")
- Steps are: Sale Agreement → NTP Submitted → KCA/Intake → Welcome Call → Survey Scheduled → Survey Submitted → Survey Approved → CAD Submitted → CAD Approved → Engineering Submitted → Design Completed → Permit Submitted → Permit Approved → NEM Submitted → NEM Approved → Install Scheduled → Install Completed → Inspection Passed → PTO Submitted → PTO Approved

### 4. Mobile · Communications (`tab="comms"`)

**Purpose:** All customer messaging (SMS + calls), filtered.

**Layout:**
- App chrome + tab strip
- **Segmented sub-tabs:** `All · Calls · Texts` (counts in superscript)
- **Conversation list** — each row:
  - SMS in/out: bubble-style preview, direction arrow, timestamp, channel pill (`SMS`)
  - Call: phone icon, "Outgoing"/"Incoming", duration, recording-available indicator, timestamp
- Composer FAB bottom-right: opens SMS sheet pre-addressed to customer's phone

### 5. Mobile · Tickets (`tab="tickets"`)

**Purpose:** Open stipulations, design rejects, scheduling holds — anything blocking the deal.

**Layout:**
- App chrome + tab strip
- **Tickets card** — list of ticket rows, each with:
  - 3px-wide colored left rail (red = open/overdue, amber = pending, green = resolved)
  - Title (15px / 700)
  - Sub-line: department · assignee · state (12px / 500 / muted)
  - Right side: due-date pill ("Due Apr 29, 2026")
- Tap → ticket detail sheet (not in this prototype scope; gesture is set up)

### 6. Mobile · iPhone SE width

Same `MobileProjectView` at 360×760. Sanity-check that the design holds at 320–375px widths. Nothing should be hand-tuned for SE — the components are responsive.

### 7. Desktop · Project Detail (`DesktopProjectView`)

**Purpose:** Same data, opened in a desktop browser. Three-column layout that takes advantage of width without redesigning components.

**Layout:**
- App chrome (full version with all action buttons + persistent search field)
- **Page body** — 1240px max-width, `display: grid; gridTemplateColumns: 360px 1fr 380px; gap: 18px`
- **Left column (360px):** Customer card, Project Specs grid, Team card
- **Center column (1fr):** Deal Feed (filter chips + grouped stream — same component as mobile)
- **Right column (380px):** What Needs Attention, Progress Timeline (compact), Tickets

The Comms surface on desktop is reachable via the deal feed's filter chips (`Texts` / `Calls`) — no separate tab.

---

## Chrome (App Header)

The app chrome is what we **kept from the existing Kin app** — do not redesign it.

**Breadcrumb strip (always visible):**
- Height: 36px
- Background: `#f3f4f6` with `1px solid #e5e7eb` bottom border
- Padding: `0 12px`, gap: 10
- Font: 12px / 500 / `#374151`

**Contents (left to right):**
1. Home icon button (24×24, transparent bg) — house glyph
2. `›` chevron in `#9ca3af`
3. Stacked breadcrumb chip — `#fff` bg, `1px solid #d1d5db`, 4px radius, 2×8 padding, two stacked lines:
   - Line 1: "Projects ›" (12px / 600 / `#111827`)
   - Line 2: "Reports › Settings" (10px / 400 / `#6b7280`)
4. **Project title** (desktop only, inline) — `Jaclynn Drummer - Jaclynn Drummer - 2586 Alena Pl` (12px / 500 / `#111827`, ellipsis, flex: 1)
5. **Search box** — see below
6. **Action buttons** (desktop only): green `+ New Project`, ghost `✎ Edit`, `✉ Email`, `More ▾`, `⚙ Customize this Form`
7. **Hamburger button** (mobile only)

**Page title row (mobile only, below the strip):**
- Padding: `10px 14px 12px`, `1px solid #e5e7eb` bottom
- Title: 15px / 700 / `#111827` (truncates)
- Right side: `↶ Return` (11px / `#6b7280`)

**Search box:**
- **Desktop:** persistent — 240px min-width, `#fff` bg, `1px solid #d1d5db`, 4px radius, magnifier icon, placeholder `Search projects, customers, addresses…`
- **Mobile:** collapsed by default to a 24×24 magnifier button. Tap → expands to a full-width inline input that overlays the strip; `×` button collapses it. (This is the **only addition** to the existing chrome — the user explicitly asked to keep it.)

**Button styles:**
- Green CTA (`pillBtnGreen`): `#16a34a` bg / `#15803d` border / `#fff` fg, 4px radius, 4×10 padding, 12px / 600
- Ghost (`pillBtnGhost`): `#fff` bg / `#d1d5db` border / `#374151` fg, 4px radius, 4×10 padding, 12px / 500

---

## Components

All components live in `project-view.jsx`. Reuse them across tabs and across mobile/desktop.

| Component | Purpose | Key props |
|---|---|---|
| `AppHeader` | Breadcrumb strip + page title | `mobile`, `title` |
| `SearchBox` | Collapsible (mobile) / persistent (desktop) search | `mobile` |
| `StatusPill` | Rounded status chip in 9 tones | `tone`, `dot` |
| `Card` | White rounded container | `padding`, `style` |
| `CardHeader` | Caps-eyebrow card title with optional count | `count`, `action` |
| `CustomerCard` | Star + name + ID + Active pill + SLA pills + quick-actions row | — |
| `AttentionCard` | "What needs attention" ops-signal list | `items` |
| `ProgressTimeline` | 20-step vertical milestone list | `steps` |
| `FieldActivity` | Crew/scheduling table | `items` |
| `Communications` | Segmented `All / Calls / Texts` + thread list | `comms` |
| `Tickets` | Colored-rail ticket stack | `items` |
| `DealFeed` | Filter chips + day-grouped event stream | `events` |
| `MobileProjectView` | Mobile shell + tab strip + active panel | `initialTab` |
| `DesktopProjectView` | 3-column desktop composition | — |

### `StatusPill` tones

| Tone | Bg | Fg | Use |
|---|---|---|---|
| `active` | `#103929` | `#fff` | Project state ACTIVE |
| `ok` | `#dcfce7` | `#166534` | Done milestones, success |
| `warn` | `#fef3c7` | `#b45309` | Pending stips |
| `bad` | `#fee2e2` | `#b91c1c` | Overdue / rejected |
| `info` | `#e0f2fe` | `#0369a1` | Info notes |
| `blue` | `#dbeafe` | `#1d4ed8` | Active milestone, NTP |
| `pending` | `#fde68a` | `#92400e` | Awaiting action |
| `complete` | `#dcfce7` | `#166534` | Closed tickets |
| `soft` | `#eef2f7` | `#334155` | Neutral category chip |

Pill base: 3×9 padding, 999px radius, 11px / 600, optional 6px dot.

---

## Interactions & Behavior

- **Tab strip (mobile):** controlled state in `MobileProjectView`. Switching tabs swaps the panel; preserve scroll position per tab.
- **Filter chips (Deal Feed):** single-select, defaults to `All`. Filtered list is derived; pinned notes still float to top within their day.
- **Quick-action row (Customer card):** Call → `tel:` link, Text → opens SMS composer sheet, Email → `mailto:`, Map → `maps://?q=<address>` on iOS or Google Maps on web.
- **Composer FAB (Deal Feed, Comms):** bottom-right, 56×56 circle, navy bg, white `+`. Tap → bottom sheet with channel selector (Note / SMS / Call log) + textarea.
- **Search:** mobile collapses to icon by default; tap expands. Desktop stays open. On submit, navigate to projects/customers search results (out of scope here — wire to your existing search route).
- **Tickets row tap:** open ticket detail sheet (not implemented in prototype). Long-press → bulk-select.
- **Star (Customer card):** toggles favorite — local state only in prototype; wire to user's saved projects.
- **Animation:** tab strip swap should crossfade (~150ms), no slide. Composer sheet slides up from bottom (~220ms ease-out). Active milestone dot has a slow pulsing halo (2s, ease-in-out, infinite).

### Responsive behavior
- **Mobile breakpoint:** ≤ 768px → `MobileProjectView`
- **Desktop:** ≥ 1024px → `DesktopProjectView` (3 columns)
- **Tablet (768–1024px):** drop the right column, keep left + center stacked at full width. Customer/specs/team go above Deal Feed; What Needs Attention + Tickets go below.

---

## State Management

- `MobileProjectView` holds `tab` (string) and `commsFilter` (string)
- `DealFeed` holds `chip` (string)
- `Communications` holds `seg` ('all' | 'calls' | 'texts')
- `SearchBox` holds `open` (bool, mobile only) and `q` (string)
- `Tickets` and the customer star are stateless display in the prototype — wire to your store

**Data shape:** see `ProjectData` in `project-view.jsx` for the full TypeScript-able shape — customer, status, daysInStage, systemSize, panels, inverter, module, estProduction, offset, contractValue, grossPPW, saleDate, ageDays, closer/setter/areaDirector/coordinator, lender, financeType, office, utility, ahj, utilityAccount, starred, ntp/m1/m2/m3, `progress[]`, `field[]`, `comms[]`, `tickets[]`, `feed[]`.

---

## Design Tokens

### Colors
```
bg          #f4ede6   warm beige page bg
surface     #ffffff   card bg
surface2    #faf6f1   nested surface
ink         #0f172a   primary text
ink2        #1e293b
body        #334155   body text
muted       #64748b
faint       #94a3b8
hairline    #e6dfd6   warm hairline
hairline2   #d8cfc4
navy        #1d2a3d   (legacy header — NOT used in final chrome)
ok          #16a34a   success green
okSoft      #dcfce7
okText      #166534
warn        #b45309
warnSoft    #fef3c7
bad         #b91c1c
badSoft     #fee2e2
info        #0369a1
infoSoft    #e0f2fe
accent      #0f5132   Kin green (Active pill)
accentBg    #dcfce7
blue        #1d4ed8
blueSoft    #dbeafe
red         #dc2626
redSoft     #fee2e2
amber       #d97706

// Chrome (matches existing Kin app)
chrome.bg          #f3f4f6
chrome.border      #e5e7eb
chrome.fg          #374151
chrome.title       #111827
chrome.muted       #6b7280
chrome.input.border #d1d5db
chrome.cta         #16a34a / #15803d
```

### Typography
- Stack: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif`
- Sizes: 10 / 11 / 12 / 13 / 15 / 17 / 20 / 24 px
- Weights: 400 / 500 / 600 / 700 / 800
- Eyebrow / card header: 11px / 800 / `#64748b` / 1.2 letter-spacing / uppercase
- Body: 13–14px / 500 / `#334155`
- Title: 15–17px / 700 / `#0f172a`

### Spacing
- Card padding: 16
- Card inner section: `0 16px 14px`
- Card header: `14px 16px 10px`
- Grid gap (desktop): 18
- Page padding (desktop): `20px 24px`
- Page padding (mobile): `12px 12px 24px`

### Radii
- Card: 14
- Pill / status: 999
- Button: 4 (matches existing Kin chrome)
- Input: 4
- FAB: 28 (56×56)

### Shadow
- Card: `0 1px 2px rgba(15,23,42,0.04), 0 1px 0 rgba(15,23,42,0.03)`
- Phone bezel (presentation only): `0 30px 60px -20px rgba(0,0,0,0.35)`

---

## Assets

No raster assets. Everything is inline SVG in `project-view.jsx`:
- Home, search, hamburger, chevron, back arrow, phone, mail, map, mic, attach, plus, star icons
- Channel/event glyphs in the Deal Feed (sms bubble, call handset, doc, milestone flag, audit pencil, system gear)
- Avatar initials are generated from team-member names (no photos)

If your design system has an icon library (Heroicons, Phosphor, Lucide, your in-house set), substitute them — match weight/size, not specific style.

---

## Files in this bundle

| File | What it is |
|---|---|
| `Project View.html` | Entry point. Loads the JSX scripts, defines `PhoneShell` + `DesktopShell` + `App`, mounts the `DesignCanvas`. |
| `project-view.jsx` | All design components + mock data (`ProjectData`). The single source of truth for the design. |
| `design-canvas.jsx` | Pannable / zoomable canvas chrome (presentation only — not part of the product). |
| `ios-frame.jsx` | iOS device frame component (not actually used by `Project View.html` — it uses the inline `PhoneShell` instead, kept for reference). |

Open `Project View.html` to see the design.

---

## Implementation notes for Claude Code

1. **Keep the chrome.** The breadcrumb strip + button row + search box are intentionally matched to Kin's existing app. If your codebase already has these as components, reuse them — don't build new ones from this prototype's inline styles.
2. **Single source of components.** `MobileProjectView` and `DesktopProjectView` import the same primitives. When you port them, keep that discipline — don't fork mobile and desktop trees.
3. **Mock data → real data.** `ProjectData` matches what Kin's Quickbase Projects table exposes. Replace the literal with a fetched record; field names should be obvious matches (`customer.name`, `systemSize`, `progress[]`, etc).
4. **Active milestone pulse:** add a small CSS keyframe (`@keyframes pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(29,78,216,0.4) } 50% { box-shadow: 0 0 0 6px rgba(29,78,216,0) } }`). Apply to the active step's dot.
5. **Don't re-implement the design canvas or the phone shell.** Those are framing only.
