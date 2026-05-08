# How data flows from QuickBase into the app

> **TL;DR** — The app reads from a server-side cache that mirrors QuickBase. A new project takes **roughly 5 minutes** to appear after it's saved in QB (longer if no one has been using the app in the last 30 min). Single-project pages are always live.

This doc explains where data comes from, how often it refreshes, and what to check if something you see in QuickBase isn't showing up in the portal yet.

---

## The two databases

There are two databases at play:

| | What it is | Who writes to it |
|---|---|---|
| **QuickBase (QB)** | The source of truth — every project, ticket, intake event, etc. lives here first. | Sales reps, PCs, intake team — anyone editing in QB. |
| **App cache** (`project_cache`, `ticket_cache`, etc.) | A SQLite database living on the Railway server. Mirrors QB so the app can be fast. | Our server only — never directly edited by humans. |

**The browser only ever reads from the cache.** It never asks QB directly. The cache periodically asks QB *"anything changed since last time?"* and copies what it gets back.

---

## Timeline: a brand-new deal

A sales rep saves a deal in QB at **10:00 AM**.

| Time | What's happening |
|---|---|
| **10:00:00** | New row exists in QB. Our cache doesn't have it yet. The app won't show it anywhere. |
| **10:00:00 → ~10:05:00** | Server is between scheduler ticks. Waiting. |
| **~10:05:00** | Scheduler tick runs. Server queries QB: *"give me every project modified since the last watermark."* The new deal is on that list. It gets written into `project_cache` and tagged with a refresh tier (see below). |
| **~10:05:30** | If anyone has `/projects` open in a browser tab, the page is polling a freshness endpoint every 30 seconds. It notices the cache is fresher and auto-refetches. The new project **pops into the list** with a quick green-ring animation. |
| **Anytime after** | Click into the project → detail page hits QB live and you see the freshest possible data. |

**Worst case:** ~5 minutes if anyone's using the app. Longer if everyone's been offline for >30 minutes (the scheduler pauses fast tiers to save QB API calls when nobody's around — see "Activity gating" below).

---

## Refresh tiers (how often each project re-syncs)

After the first ingest, every project gets a **tier** based on how active it is. The tier controls how often we re-pull it from QB.

| Tier | How often | Which projects |
|---|---|---|
| **Hot** | Every 5 min | Install scheduled in next 14 days, post-install awaiting QA, fresh rejects |
| **Warm** | Every 30 min | Active in the pipeline (default for new deals) |
| **Cool** | Every 6 hours | In-service / PTO approved / stale-but-alive holds |
| **Cold** | Every 24 hours | Terminal states (Cancelled, Completed) and long-dormant projects |

A new deal usually starts in **warm**, then graduates to **hot** as install date approaches.

**Activity gating:** Hot, warm, and cool tiers only run if a real user has been active in the app within the last 30 minutes. Cold runs always (so terminal-state classification stays accurate even after a fully quiet day). This keeps QB API usage low when no one's around.

---

## Two important exceptions

**Test projects (`Test Project = true` in QB) are filtered out at the source.**
Our ingest query asks QB to skip them entirely. They never enter the cache, never show up in any list, and never count in any report. Keep using test projects in QB freely — they won't pollute anything in the portal.

**The single-project detail page is always live.**
When you click into `/projects/12345`, the server hits QB right then, live. So the detail view is always accurate down to the second, even if the tier scheduler hasn't refreshed that project recently. Any field you change in QB will show on the detail page on the next refresh of that page.

---

## Other surfaces have their own caching

| Page | Where data comes from | Refresh cadence |
|---|---|---|
| `/projects` (list) | `project_cache` | Tier scheduler (5 min – 24 hr) + 30-sec auto-refetch when freshness ticks |
| `/projects/:id` (detail) | QB live, then writes to cache | Every page load |
| `/projects/intake` | In-memory 60-sec TTL (server-side) | 60 sec; manual Refresh button forces a fresh QB pull |
| `/tickets` | `ticket_cache` | Incremental every 5 min (active hours), full sweep nightly |
| `/reports/booked-and-boarded` | `project_cache` | Same as `/projects` |
| `/comms` | Webhooks from Dialpad, written live | Real-time (no QB involvement for SMS/calls) |

---

## "I can't see X in the portal but it's in QB"

Walk through this checklist:

1. **Has it been 5+ minutes since you saved it in QB?**
   If less, that's expected — wait for the next tier tick.

2. **Has anyone been using the portal in the last 30 minutes?**
   If everyone's been offline a while, the fast-tier scheduler is paused. Open the portal — the next tick happens within 5 min of activity.

3. **Is the project flagged as a test in QB?**
   Look at the *Test Project* field on the QB record. If it's checked, the portal filters it out by design.

4. **Hard refresh the page (⌘⇧R / Ctrl⇧R).**
   Rules out a stale browser bundle.

5. **Try the project detail URL directly: `/projects/<record-id>`.**
   This bypasses the cache and pulls from QB live. If it shows there but not on the list page, it's purely a list-cache delay — the next freshness tick (~30 sec) will sync it.

6. **Admin: hit the manual Refresh button.**
   On `/projects/intake` (and a few admin pages) there's a Refresh button that forces a fresh pull bypassing the in-memory TTL.

7. **Still nothing after 10+ minutes?**
   That's worth flagging. Could be a QB API issue, a tier classifier bug, or a record that doesn't match the ingest filter. Drop a note in the dev channel with the QB record ID and approximate save time.

---

## Why we don't read directly from QB

Three reasons:

1. **Speed.** A list of 10,000 projects from QB takes ~10 seconds. From SQLite, it's milliseconds.
2. **API limits.** QB rate-limits user tokens. If every page load hit QB, we'd burn through the daily budget fast.
3. **Reliability.** If QB has a hiccup, the portal still works — it's reading from a local copy.

The trade-off is the few-minute lag described above, which is fine for everything except the live single-project view.

---

## Quick reference card (for chats with users)

> *"It takes about 5 minutes for new QB records to show up in the portal list. The single-project page is always live — try `/projects/<record-id>` if you need to confirm. If it's been more than 10 minutes and still missing, ping a dev with the record ID."*
