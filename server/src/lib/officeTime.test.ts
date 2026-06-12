import { test } from 'node:test'
import assert from 'node:assert/strict'
import { officeTodayIso, officeDayBoundsUtc, addDaysIso, officeDaysAgo, OFFICE_TZ } from './officeTime'

// These tests assume the default office zone; they guard the exact failure
// from issue #29 (UTC "today" rolling forward at 6pm Mountain on Railway).
test('default office timezone is America/Denver', () => {
  assert.equal(OFFICE_TZ, 'America/Denver')
})

test('officeTodayIso holds the office date past 6pm Mountain (the issue #29 case)', () => {
  // 2026-06-12T01:30Z = 2026-06-11 19:30 MDT — UTC has flipped, Denver has not.
  assert.equal(officeTodayIso(new Date('2026-06-12T01:30:00Z')), '2026-06-11')
  // Plain afternoon: both calendars agree.
  assert.equal(officeTodayIso(new Date('2026-06-11T20:00:00Z')), '2026-06-11')
  // Just before midnight Denver.
  assert.equal(officeTodayIso(new Date('2026-06-12T05:59:00Z')), '2026-06-11')
  // Midnight Denver rolls the office date.
  assert.equal(officeTodayIso(new Date('2026-06-12T06:00:00Z')), '2026-06-12')
})

test('officeDayBoundsUtc in summer (MDT, UTC-6)', () => {
  const { from, to } = officeDayBoundsUtc('2026-06-11')
  assert.equal(from.toISOString(), '2026-06-11T06:00:00.000Z')
  assert.equal(to.toISOString(), '2026-06-12T05:59:59.000Z')
})

test('officeDayBoundsUtc in winter (MST, UTC-7)', () => {
  const { from, to } = officeDayBoundsUtc('2026-01-15')
  assert.equal(from.toISOString(), '2026-01-15T07:00:00.000Z')
  assert.equal(to.toISOString(), '2026-01-16T06:59:59.000Z')
})

test('addDaysIso crosses month/year/DST boundaries without drift', () => {
  assert.equal(addDaysIso('2026-01-01', -1), '2025-12-31')
  assert.equal(addDaysIso('2026-02-28', 1), '2026-03-01')
  // US spring-forward 2026 is Mar 8 — must not skip or repeat a day.
  assert.equal(addDaysIso('2026-03-07', 1), '2026-03-08')
  assert.equal(addDaysIso('2026-03-08', 1), '2026-03-09')
  assert.equal(addDaysIso('2026-06-11', -30), '2026-05-12')
})

test('officeDaysAgo anchors to the office calendar', () => {
  // 01:30Z on the 12th is still the 11th in Denver, so 1 day ago is the 10th.
  const now = new Date('2026-06-12T01:30:00Z')
  assert.equal(officeDaysAgo(1, now), '2026-06-10')
  assert.equal(officeDaysAgo(0, now), '2026-06-11')
})
