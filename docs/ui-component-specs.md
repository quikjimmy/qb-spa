# UI Component Specs

Canonical layout / sizing / typography rules for repeated patterns.
Use this when adding a new dashboard, performance view, or admin
panel — every shared shape has one source of truth so the app stays
visually consistent across views.

Last updated: 2026-04-28

---

## Color & accent palette

Status colors stay calm — never use anxiety reds for non-actionable data.
Status accent rules:

| Tone | Tailwind | Use for |
|------|----------|---------|
| Sky | `text-sky-600` / `bg-sky-500` | Primary metric, neutral count |
| Emerald | `text-emerald-600` / `bg-emerald-500` | Success / completed |
| Amber | `text-amber-600` / `bg-amber-500` | Warning, slightly behind |
| Rose | `text-rose-600` / `bg-rose-500` | Actionable failure only |
| Violet | `text-violet-600` / `bg-violet-500` | Secondary metric, accent |
| Slate | `text-slate-500` / `bg-slate-300` | Inactive / scheduled |

The **accent strip** at the top of a KPI tile uses the bg variant; the
big number uses the text variant.

---

## KPI tile

Used everywhere a top-line metric needs to land hard. Same dimensions
across the app — Comms Hub, Field Performance, PTO, etc.

```html
<div class="rounded-xl border bg-card p-3 min-w-0 relative overflow-hidden">
  <div class="absolute top-0 left-0 right-0 h-[3px] bg-{accent}-500" />
  <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
    {Label in title case or sentence — never ALL CAPS in the JSX, the class handles it}
  </p>
  <p class="mt-1 flex items-baseline gap-1.5 min-w-0">
    <span class="text-2xl font-extrabold tabular-nums text-{accent}-600 leading-none">
      {primary value}
    </span>
    <span class="text-[11px] font-semibold tabular-nums text-muted-foreground truncate">
      / {secondary value}
    </span>
  </p>
</div>
```

- **Card**: `rounded-xl border bg-card p-3 min-w-0 relative overflow-hidden`
- **Accent strip**: 3px tall, full width, top of tile, `bg-{accent}-500`
- **Label**: `text-[10px]` uppercase, tracking-wider, muted-foreground
- **Primary value**: `text-2xl font-extrabold tabular-nums text-{accent}-600 leading-none`
- **Secondary value (after `/`)**: `text-[11px] font-semibold tabular-nums text-muted-foreground`

Two-up grid on mobile: `grid grid-cols-2 gap-2`. Three or four-up on
sm+ if needed: `sm:grid-cols-3` / `sm:grid-cols-4`.

**Don't** invent new variants. If a metric needs a different color,
pick from the accent palette above; don't tune hex values.

---

## Section title (above a table or chart)

```html
<p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
  TITLE · DIMENSION
</p>
```

Pattern: `OBJECT · CONTEXT`. Use `·` (middle dot) as separator. The
context piece is uppercased programmatically when sourced from a
dimension picker.

Example: `INSTALL COMPLETE · SALES OFFICE`, `BY USER`,
`CALL BREAKDOWN`.

Right-aligned subtitle (count, day-unit hint, etc.):

```html
<p class="text-[10px] text-muted-foreground">{count} buckets · business days</p>
```

---

## Filter strip

Three styles, used in this order top-to-bottom inside a panel:

### Date presets (rounded pill row)

```html
<button class="px-2 py-0.5 rounded-full border text-[10px] font-medium transition-colors whitespace-nowrap"
  :class="active ? 'bg-foreground text-background border-foreground' : 'bg-card hover:bg-muted'">
  30d
</button>
```

Wrap with `flex flex-wrap gap-1.5`.

### Toggle pair (segmented)

```html
<div class="inline-flex rounded-md border overflow-hidden">
  <button class="px-2 py-1 text-[11px] font-medium" :class="active ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'">A</button>
  <button class="px-2 py-1 text-[11px] font-medium" :class="active ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'">B</button>
</div>
```

### Dimension chip strip (h-scroll allowed for filter strips ONLY)

```html
<div class="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1 min-w-0">
  <button class="flex-none px-2.5 py-1 rounded-full border text-[11px] font-medium transition-colors whitespace-nowrap"
    :class="active ? 'bg-foreground text-background border-foreground' : 'bg-card hover:bg-muted'">
    Sales Office
  </button>
</div>
```

**Place dimension strip directly above the table or chart it filters.**
Don't put a global dimension picker at the top of the page — keep
the selector visually attached to what it groups so the user can
switch without scrolling away.

---

## Tables

### Container

```html
<div class="rounded-xl border bg-card overflow-hidden min-w-0">
  <div class="px-3 py-2 border-b flex items-baseline justify-between gap-2 flex-wrap">
    <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">{TITLE}</p>
    <p class="text-[10px] text-muted-foreground">{subtitle}</p>
  </div>
  <!-- desktop table -->
  <div class="hidden sm:block">
    <table class="w-full text-[11px] tabular-nums">…</table>
  </div>
  <!-- mobile cards -->
  <div class="sm:hidden divide-y">…</div>
</div>
```

### Desktop table

- Body text: `text-[11px] tabular-nums`
- Header cells: `bg-muted/30 text-muted-foreground`, `text-left/right font-medium px-3 py-2`
- Sortable header: `cursor-pointer hover:text-foreground`, append caret `↓` / `↑`
- Body rows: `hover:bg-muted/30`, divider via `tbody.divide-y`
- Cell padding: first column `px-3 py-1.5`, numeric columns `text-right px-2`
- Long string columns: `truncate max-w-[180px]` with `:title` for the full value

### Totals row

Always include if the table is showing aggregations.

```html
<tfoot class="border-t-2 bg-muted/20 font-semibold">
  <tr>
    <td class="px-3 py-1.5">Total</td>
    <td class="text-right px-2">{value}</td>
    …
  </tr>
</tfoot>
```

For mobile cards, the equivalent is a final card with `bg-muted/30`:

```html
<div class="px-3 py-2 bg-muted/30 min-w-0">
  <p class="font-semibold text-[12px]">Total</p>
  <div class="grid grid-cols-3 gap-1.5 mt-1 text-[10px] tabular-nums">…</div>
</div>
```

### Mobile card row

Per-row card with metric chips in a 2- or 3-column grid:

```html
<div class="px-3 py-2 min-w-0">
  <p class="font-semibold text-[12px] truncate">{primary identifier}</p>
  <div class="grid grid-cols-3 gap-1.5 mt-1 text-[10px] tabular-nums">
    <div class="rounded bg-muted/30 px-2 py-1 min-w-0">
      <p class="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p class="font-semibold">{value}</p>
    </div>
    …
  </div>
</div>
```

### Wide-table mobile collapse

When a table has many columns (e.g. install duration deciles with
D10..D100), the mobile variant should show a curated subset of the
most useful columns rather than h-scroll. For deciles, show:
**D20 / Mean / D90 / Max**.

### Pivot vs decile semantics

- **Pivot table**: each row is a dimension value, columns are KPIs
  (count, sum, mean, P90).
- **Decile table**: each row is a dimension value, columns are the
  decile boundaries D10..D100 (D100 = max) plus Mean. Pure numeric
  grid, no chart embedding.

Both end with a Total row that aggregates across the whole window.

---

## Charts

### Bar chart (ECharts)

- Renderer: `CanvasRenderer` only — keeps bundle slim.
- Modules: `BarChart`, `GridComponent`, `TooltipComponent`,
  `LegendComponent`. Don't pull `DataZoom` etc. unless used.
- Bar fill: matches the metric's accent color from the palette.
- Border radius on bars: `borderRadius: [4, 4, 0, 0]` (top corners only).
- **Data labels are required** above each bar. Format example:

  ```ts
  label: {
    show: true,
    position: 'top',
    fontSize: 9,
    color: '#0369a1',  // accent-700 to stay readable
    formatter: (p) => p.value > 0 ? String(p.value) : '',
  }
  ```
- X-axis labels: `fontSize: 10, hideOverlap: true`.
- Grid: `top: 32, right: 16, bottom: 36, left: 44, containLabel: true`.
- Heights: 240–280px range; not bigger.

### Time-series x-axis

When the date range can vary, **auto-bucket** the granularity:
- ≤35 days → daily
- 36–180 days → weekly (Mon–Sun, label = the Monday)
- >180 days → monthly

The label should hint at the granularity (`'Mon–Sun · x-axis: week'`).

---

## Date conventions

- **Weeks are Monday–Sunday.** Snap a date to the start of its week
  with `d - (day === 0 ? 6 : day - 1)` where `day = d.getDay()`.
- **Business days = Mon–Fri.** Holidays are NOT excluded in v1; if
  precision is needed for a particular metric, document it explicitly
  and reference a holiday calendar at compute time.
- **Day unit toggle**: when a metric is a duration in days, expose a
  `Biz days` / `Cal days` toggle in the filter strip. Compute server-
  side under both modes from the same data; do not require a refetch
  to switch.
- All date strings round-trip in `YYYY-MM-DD` ISO format. UI display
  uses `toLocaleDateString(undefined, { month: 'short', day: 'numeric' })`
  for short labels.

---

## Spacing and grid

- Page root: `<div class="grid gap-3 min-w-0">` — never let a child
  blow out the page width.
- Card-to-card gap: `gap-2` to `gap-3`.
- Filter row inner gap: `gap-1.5` for small chips, `gap-2` for toggles.
- Touch targets: minimum 44px (`size-11`) for primary buttons; chip
  buttons can be smaller (~28–32px) since the action is filter-only.

---

## What NOT to do

- Don't add new accent colors. Pick from the palette above.
- Don't change KPI tile dimensions per view — they're fixed app-wide.
- Don't put h-scroll on data tables. Tables become stacked cards on
  mobile. The only allowed h-scroll is the dimension chip strip and
  date preset strip.
- Don't embed charts inside cells. Decile rows are numeric only —
  trends + breakdowns belong in their own chart card above the table.
- Don't add anxiety colors (full-saturation red borders, danger
  toasts) for non-actionable data. Calm palette wins.
