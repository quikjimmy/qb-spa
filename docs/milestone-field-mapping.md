# Milestone Status Bubbles — Field Mapping for the Sales Companion App

**Scope:** how to render the project **milestone status bubbles** and the
**overall project-status bubble** the same way the Kin Ops app does, and the
exact QuickBase fields that drive each bubble's state.

**Intentionally out of scope** (internal-ops only, not shared with sales): SLA /
timing math, missing-item lists, attention flags, tags, tickets, comments,
inspection QA metrics, and all funding data (M1/M2/M3/DCA/NTP).

Milestones covered: **Intake · Site Survey · Design · NEM · Permit · Install ·
Inspection · PTO**, plus the **overall project status**.

---

## 1. Data source

All fields below live on one QuickBase table.

| | |
|---|---|
| **App** | QuickBase (realm: Kin Home) |
| **Table** | Projects — table ID **`br9kwm8na`** |
| **Grain** | one row per project |
| **Key** | Record ID# = **FID 3**; customer-facing Project ID# = **FID 11** |

> Exclude test rows: **FID 622** (`test_project`) — never display a project
> where this is true.

Each milestone bubble has **no status field of its own.** Its state is derived
from which of its date fields are populated. Those derivation rules are the
whole point of this doc.

---

## 2. How a bubble gets its state

### 2.1 "Is this field set?"

A date field counts as **set** only if it is non-empty and not a placeholder:

```
set  ⇔  value is NOT null / "" / "0" / "-"
```

Every "if X is set" below means exactly this.

### 2.2 Bubble states → color

Each milestone bubble is exactly one of these. Colors are the ones the app renders.

| state | meaning | color | hex | glyph |
|---|---|---|---|---|
| `done` | completed / approved | emerald-500 | `#10b981` | ✓ |
| `active` | submitted / in progress | amber-400 | `#f59e0b` | — |
| `scheduled` | scheduled, date not yet past | blue-500 | `#3b82f6` | — |
| `overdue` | scheduled date is in the past, not yet done | violet-500 | `#8b5cf6` | ! |
| `cancelled` | field appointment cancelled *(optional — see footnote †)* | rose-600 | `#e11d48` | ✗ |
| `not` | not started | grey | `#e2e8f0` | — |

Dates render as `MM/DD`. "Is a scheduled date past?" is evaluated in the office
timezone (**America/Denver**).

The **current milestone** = the first bubble in flow order whose state is not
`done`. Flow order: Intake → Survey → Design → Permit → NEM → Install →
Inspection → PTO.

---

## 3. Intake / Site Survey / Design

### Fields
| FID | Field | Meaning |
|---|---|---|
| 461 | `intake_completed` | Intake (KCA) completed date |
| 166 | `survey_scheduled` | Site survey scheduled date |
| 164 | `survey_submitted` | Site survey submitted date |
| 165 | `survey_approved` | Site survey approved date |
| 699 | `cad_submitted` | CAD submitted date |
| 1774 | `design_completed` | Design / CAD complete date |

### Intake bubble
```
done    if intake_completed is set
active  else if survey_scheduled is set     // downstream is moving
not     otherwise
```

### Survey bubble
```
done       if survey_approved is set
cancelled  else if the survey appointment was cancelled †
active     else if survey_submitted is set
overdue    else if survey_scheduled is set AND survey_scheduled is in the past
scheduled  else if survey_scheduled is set
not        otherwise
```

### Design bubble
```
done    if design_completed is set
active  else if cad_submitted is set
not     otherwise
```

---

## 4. NEM / Permit

### Fields
| FID | Field | Meaning |
|---|---|---|
| 326 | `nem_submitted` | NEM (interconnection) submitted date |
| 327 | `nem_approved` | NEM approved date |
| 207 | `permit_submitted` | Permit submitted date |
| 208 | `permit_approved` | Permit approved date |

### Permit bubble
```
done    if permit_approved is set
active  else if permit_submitted is set
not     otherwise
```

### NEM bubble
```
done    if nem_approved is set
active  else if nem_submitted is set
not     otherwise
```

---

## 5. Install / Inspection

### Fields
| FID | Field | Meaning |
|---|---|---|
| 178 | `install_scheduled` | Install scheduled date |
| 534 | `install_completed` | Install completed date |
| 226 | `inspection_scheduled` | Inspection scheduled date |
| 491 | `inspection_passed` | Inspection passed date |

### Install bubble
```
done       if install_completed is set
cancelled  else if the install appointment was cancelled †
overdue    else if install_scheduled is set AND install_scheduled is in the past
scheduled  else if install_scheduled is set
not        otherwise
```

### Inspection bubble
```
done       if inspection_passed is set
cancelled  else if the inspection appointment was cancelled †
overdue    else if inspection_scheduled is set AND inspection_scheduled is in the past
scheduled  else if inspection_scheduled is set
not        otherwise
```

---

## 6. PTO (Permission To Operate)

### Fields
| FID | Field | Meaning |
|---|---|---|
| 537 | `pto_submitted` | PTO submitted date |
| 538 | `pto_approved` | PTO approved (granted) date |

### PTO bubble
```
done    if pto_approved is set
active  else if pto_submitted is set
not     otherwise
```

---

## 7. Overall project status bubble

A single field, rendered with a fixed palette.

| FID | Field |
|---|---|
| 255 | `status` — overall project status (string) |

### Value → color
Match order: **exact** → **prefix** (value starts with key) → any value
containing `"hold"` → muted fallback.

| status value | accent | hex |
|---|---|---|
| `Active` | teal | `#14b8a6` |
| `Complete` / `Completed` / `Completed \| Paid` | slate (muted) | `#94a3b8` |
| `Hold` / `On Hold` (or anything containing "hold") | amber | `#fbbf24` |
| `ROR` | amber | `#fbbf24` |
| `Pending Cancel` | orange | `#fb923c` |
| `Rejected` | violet | `#a78bfa` |
| `Cancelled` | red | `#ef4444` |
| `Surrendered` | stone (muted) | `#a8a29e` |
| anything else | muted fallback | — |

Principle: strong color for actionable states, muted for terminal/closed states.
`Cancelled` is the one deliberate red so it stands out.

---

## Footnotes

**† Cancelled state (optional).** The `cancelled` bubble for Survey / Install /
Inspection comes from field-appointment (Arrivy) cancellation data that the Ops
app overlays on top of QuickBase — the QB milestone date columns do not reflect
a cancelled appointment. **If the sales companion app does not ingest Arrivy
appointment data, omit the `cancelled` state entirely**; those bubbles will fall
through to `scheduled` / `overdue` / `done`, which is correct.

---

## Appendix — flat field reference

```
# Identity
3     record_id        (key)
11    project_number   (customer-facing)
622   test_project     (exclude when true)
255   status           (overall project status)

# Intake / Survey / Design
461   intake_completed
166   survey_scheduled
164   survey_submitted
165   survey_approved
699   cad_submitted
1774  design_completed

# NEM / Permit
326   nem_submitted
327   nem_approved
207   permit_submitted
208   permit_approved

# Install / Inspection
178   install_scheduled
534   install_completed
226   inspection_scheduled
491   inspection_passed

# PTO
537   pto_submitted
538   pto_approved
```
