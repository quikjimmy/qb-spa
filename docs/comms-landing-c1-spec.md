# Comms Landing — C1: Invert priority on /comms

Audit C1: a PC who hears a customer-text alert spends ~2 scrolls to reach the row that needs a reply. The page renders search -> recent threads (often collapsed) -> live activity (up to 60vh) -> tab toggle -> tab content. This spec rewires that so "needs reply" is the first thing visible.

## 1. Goal

A PC opens `/comms` on a 390 px iPhone in landscape after a customer-text alert. **Click cost: 0 scrolls to the row that needs a reply, 1 tap to open the thread.** When `needsReplyCount > 0`, the topmost block under the sticky header must be RecentThreads, expanded, with the highest-priority row above the fold. Live Activity, Reporting toggles, KPIs, drill-down, by-user, heatmap stay reachable but stop competing for the first 60vh.

## 2. Layout — current vs proposed

### Mobile, 390 px landscape (~360 px usable height)

```
CURRENT                                PROPOSED
[ sticky header ........... 56 ]       [ sticky header ........... 56 ]
[ search + New CTA ........ 44 ]       [ search + New CTA ........ 44 ]
[ RecentThreads collapsed . 40 ]       [ RecentThreads expanded . 200 ] <- first row visible
[ DialpadLivePanel ....... 220 ]       [ live strip (1 line) ..... 28 ]
[ Inbox|Reporting toggle .. 36 ]       [ Inbox|Reporting toggle .. 36 ]
[ Inbox tabs (h-scroll) ... 36 ]       [ Inbox tabs (h-scroll) ... 36 ]  (below fold)
  --- fold (~360 px) ---                 --- fold (~360 px) ---
[ Me|All + list .......... ... ]       [ Me|All + list .......... ... ]
```

Current above-fold: header + search + collapsed-threads chrome + half of Live Activity. **Zero reply rows.**
Proposed above-fold: header + search + first 2 thread rows (~76 px each) + 1-line live strip. **Two reply rows.**

### Desktop, 1280 px

```
CURRENT                                PROPOSED
[ header ......................... ]   [ header ......................... ]
[ search .......................... ]   [ search .......................... ]
[ RecentThreads (often collapsed) ]   [ RecentThreads expanded if needsReply>0 ]
[ DialpadLivePanel ~420px ........ ]   [ live strip (rail closed) OR hidden (rail open) ]
[ Inbox|Reporting toggle ......... ]   [ Inbox|Reporting toggle ......... ]
[ Inbox or Reporting content ..... ]   [ Inbox or Reporting content ..... ]
```

The persistent Live Hub rail (`useCommsRail`) already replaces the inline panel when open; this spec only changes the rail-closed case.

## 3. Component change list

### `CommsHubView.vue`
- Line 345 (`<DialpadLivePanel v-if="!railOpen" />`) becomes `<DialpadLiveStrip v-if="!railOpen" />`. Removes the ~220 px mid-viewport block that pushes Inbox below the fold. Strip click re-mounts the full panel (§4).
- Line 341: pass `:needs-reply-count="..."` (or equivalent) to `RecentThreads` so the parent doesn't have to know — see below.
- **Push back on the audit**: "push Reporting behind the Reporting tab" is already done at `CommsHubView.vue:371` (`<template v-if="mainTab === 'reporting'">`) and lazy-loads at line 301. No re-spec needed.

### `RecentThreads.vue`
- Lines 36, 58: `collapsed` becomes tri-state — explicit user choice wins, else `needsReplyCount > 0 ? expanded : collapsed`. `needs_reply` is already in the API payload.
- Bump storage key `comms.recent.collapsed` -> `comms.recent.collapsed.v2` (line 38). Same pattern as `comms.live.scope.v2` so users who manually collapsed yesterday under the old heuristic don't inherit that choice.
- No change to list internals.

### New: `DialpadLiveStrip.vue`
- 28 px single-line indicator. Reuses `useDialpadLive` for `connected`, `visibleEvents`. Does **not** render the event list. Click opens the rail (`useCommsRail().setOpen(true)`) on desktop, or toggles inline `DialpadLivePanel` on mobile. Expansion state in component-local ref, no localStorage.

### `DialpadLivePanel.vue`
- Unchanged when mounted via rail or mobile expansion. Only the default mount path on `/comms` changes.

### CommsInbox tabs / Reporting strip
- Unchanged.

## 4. The 1-line live strip

Visual: `~28 px tall, rounded-md, bg-muted/30, border, px-3, text-[11px]`, tabular-nums, dot prefix. Per ui-ux-pro-max **Navigation/Active State** (visual feedback for current location), the strip uses dot color to telegraph state without a second line.

- **Active**: `[green dot, pulse] 3 events in the last hour - tap to open Live Hub` (n = `visibleEvents.filter(e => Date.now() - new Date(e.started_at) < 3_600_000).length`)
- **Empty**: `[grey dot] No live activity - tap to open Live Hub` (SSE connected, no events in last hour)
- **Disconnected**: `[amber dot] Reconnecting to live feed...` (not clickable)

Click: desktop -> `useCommsRail().setOpen(true)`; mobile (<sm) -> toggle inline `DialpadLivePanel`.

## 5. Default behaviors (testable)

1. When `needsReplyCount > 0`, RecentThreads opens expanded; otherwise collapsed.
2. Manual toggle (post-v2) wins on subsequent loads regardless of `needsReplyCount`.
3. Mobile (<sm): inline live is the strip only — full panel never auto-mounts.
4. Desktop, rail open: live strip hidden.
5. Desktop, rail closed: live strip visible.
6. Reporting summary doesn't load until `setMainTab('reporting')` (already true at `CommsHubView.vue:301`).
7. Strip event count updates every 30s, no network call (computed off `visibleEvents`).
8. SSE disconnected: strip shows reconnect copy; RecentThreads keeps polling.
9. `comms.recent.collapsed.v2` replaces `comms.recent.collapsed`; old key is read-then-deleted on first load.
10. No layout shift > 8 px between mount and data-loaded states (skeleton at expanded height when `default-expanded` is true).

## 6. Edge cases

- **Zero recent threads**: RecentThreads renders nothing (`RecentThreads.vue:104` `v-if="rows.length > 0"`); the strip is the only above-fold dynamic block.
- **SSE disconnected**: strip shows amber "Reconnecting...". RecentThreads keeps its 60s poll (`RecentThreads.vue:60`).
- **Collapsed yesterday, today has needs-reply**: respect explicit choice only if made under v2 key. The v1->v2 migration treats v1 as not-an-explicit-choice — the override fires once on first load post-deploy.
- **Desktop, rail open**: strip hidden, rail is the source.
- **No `dvh` support (iOS Safari < 15.4)**: strip is fixed `28 px`. RecentThreads keeps `42vh` (line 144). No new `dvh` introduced.

## 7. Out of scope (anti-scope)

ComposeDialog, ContactCard, SmsThreadDialog drawer, CommsSearch, the heatmap itself, `CommsInbox` internal tab logic, `useDialpadLive` event store, webhook handling, notifications. None of those move.

## 8. Rollout

- **Phase 1 (~0.5 day)**: ship RecentThreads-default-expanded prop + storage key bump.
- **Phase 2 (~1 day)**: ship `DialpadLiveStrip` + replace inline `DialpadLivePanel` mount on `/comms`. Keep panel reachable via strip click and rail.
- **Phase 3 (~0.5 day, optional)**: zero-state polish for RecentThreads when no thread moved in 24 h.

All on branch `comms/landing-priority`.

## 9. Acceptance criteria

- [ ] On 390 px iPhone, `/comms` with `needsReplyCount > 0` shows the first thread row above the fold without scrolling.
- [ ] On 390 px iPhone, with zero needs-reply but unread > 0, the unread badge in collapsed RecentThreads header is above the fold.
- [ ] Tapping a thread row opens `SmsThreadDialog` in 1 tap.
- [ ] Live strip shows correct count for last hour; updates within 30s of a new SSE event.
- [ ] Strip click: desktop opens rail; mobile expands inline panel.
- [ ] Reporting not mounted until clicked (KPI tiles absent on first paint DOM).
- [ ] No layout shift > 8 px between initial render and first data load.
- [ ] Old `comms.recent.collapsed` removed after one load.

## 10. Deliberately not solved here

- Stale RecentThreads digest vs live SSE drift — audit **H1**, separate spec.
- Notification-bell deep-link race when `/comms` is already open — audit **N2**.
- Inbox 6-pill h-scroll redesign — audit **C3**.

OK to ship in `comms/landing-priority` branch?
