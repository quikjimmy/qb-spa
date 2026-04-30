// Generic decile-by-dimension aggregator. Used by milestone analytics
// endpoints (Inspection, PTO, etc.) so each one returns the same shape
// for the shared MilestoneDecileTable client component.
//
// Inputs:
//   rows: Array<{ dim: string; days: number; kw?: number }>
//   bizFactor: number — multiplier applied to each `days` when the
//     caller wants business-day units (e.g. 5/7 ≈ 0.714).
//
// Output:
//   { rows: DecileRow[], total: DecileRow }

export interface DecileRow {
  dimension_value: string
  count: number
  kw: number
  d10: number; d20: number; d30: number; d40: number; d50: number
  d60: number; d70: number; d80: number; d90: number; d100: number
  mean: number
}

interface InputRow {
  dim: string
  days: number
  kw?: number
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]!
  const i = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo)
}

function meanOf(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((s, n) => s + n, 0) / arr.length
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function decileOf(items: InputRow[], bizFactor: number, label: string): DecileRow {
  const days = items
    .map(r => r.days * bizFactor)
    .filter(n => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b)
  const kw = items.reduce((s, r) => s + (Number(r.kw) || 0), 0)
  return {
    dimension_value: label,
    count: items.length,
    kw: round1(kw),
    d10:  round1(pct(days, 10)),
    d20:  round1(pct(days, 20)),
    d30:  round1(pct(days, 30)),
    d40:  round1(pct(days, 40)),
    d50:  round1(pct(days, 50)),
    d60:  round1(pct(days, 60)),
    d70:  round1(pct(days, 70)),
    d80:  round1(pct(days, 80)),
    d90:  round1(pct(days, 90)),
    d100: days.length ? round1(days[days.length - 1]!) : 0,
    mean: round1(meanOf(days)),
  }
}

/** Group input rows by their dimension value, compute decile stats per
 *  group, and append a Total row computed across the whole input. */
export function computeDeciles(
  input: InputRow[],
  bizFactor = 1,
): { rows: DecileRow[]; total: DecileRow } {
  const byDim = new Map<string, InputRow[]>()
  for (const r of input) {
    if (!r.dim) continue
    const arr = byDim.get(r.dim) ?? []
    arr.push(r)
    byDim.set(r.dim, arr)
  }
  const rows = [...byDim.entries()]
    .map(([dim, items]) => decileOf(items, bizFactor, dim))
    .sort((a, b) => b.count - a.count)
  const total = decileOf(input, bizFactor, '— Total')
  return { rows, total }
}
