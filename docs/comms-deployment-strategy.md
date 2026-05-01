# Comms — branching + deployment isolation

The Comms Hub (Dialpad webhooks, SMS threads, call timeline, live activity,
notifications, reminders) is the most-touched surface in the app and the
easiest one to silently break — webhooks land regardless of whether the UI
boots, so a botched deploy that takes the rest of the app down also drops
inbound texts on the floor.

This doc captures the workflow + isolation approach so changes to the comms
surface ship without dragging the rest of the app along, and changes to the
rest of the app can't accidentally regress comms.

## 1. Branch naming

| Path being touched                  | Branch prefix     | Reviewer (CODEOWNERS) |
| ----------------------------------- | ----------------- | --------------------- |
| Comms files (see CODEOWNERS list)   | `comms/<slug>`    | contact-center-architect |
| Anything else with no comms impact  | `feat/<slug>` or `fix/<slug>` | normal flow |
| Cross-cutting (touches comms + other) | `comms-x/<slug>` | contact-center-architect (final approval) |

The `comms/` prefix is a signal — both for humans skimming the branch list
and for the contact-center-architect agent (which auto-triggers on comms
keywords). PRs from `comms/` branches must list the contact-center-architect
in the description so the reviewer is clear.

## 2. Approval gate (CODEOWNERS)

`.github/CODEOWNERS` lists every comms file. GitHub auto-requests review
from the listed handle on any PR that modifies those paths. Until a
real comms-owner team exists, the gate routes to `@quikjimmy` —
swap the handle when the org is ready.

A change is mergeable only when:
1. The comms-owner has approved (CODEOWNERS-required review).
2. CI is green (typecheck + build).
3. If the change touches the live event flow (webhooks, SSE,
   `dialpad_events` schema), a manual smoke check has been done in
   prod-shape (see §5).

## 3. Three isolation models we can adopt — pick one

This is **not yet implemented**. The current deploy is one Express service
on Railway; the choice below decides how comms gets isolated. Pick before
the next major comms feature.

### A. **Same service, branch protection only** (cheapest, current state)

Comms code lives in the same repo + same Railway service as the rest of the
app. Isolation is purely social: branch naming + CODEOWNERS review. A bad
non-comms commit (like the missing `retention.ts` import we already hit) can
still take the whole service down with comms.

- Pros: zero infra change. Already what we have.
- Cons: any boot-time crash anywhere in the app drops webhooks. Webhook
  retries cover ~24h of Dialpad's retry window, but voicemail / call data
  past that gets lost.

### B. **Two Railway services, shared SQLite volume** (recommended next step)

Split the Express app into:
- **Main service** — everything except `/api/dialpad/*` and `/api/webhooks/dialpad`
- **Comms service** — only `/api/dialpad/*`, `/api/webhooks/dialpad`, the
  message-reminders + unread-SMS workers, and the SSE stream.
- **Shared volume** — both mount `/data` for `portal.db`. SQLite WAL mode
  lets concurrent readers + a single writer; comms is the dominant writer
  on the comms tables, so this works in practice.

The client stays one bundle; an Nginx-style edge route or Railway's
multi-service routing forwards `/api/dialpad/*` and `/api/webhooks/*` to
the comms service, everything else to the main service.

- Pros: a botched deploy on the main service does not drop webhooks. Comms
  has its own scheduler restart cadence. Independent rollback per service.
- Cons: shared SQLite has a small risk of writer contention if both services
  start writing the same table. Mitigation: comms owns its tables, main
  service treats them read-only.

### C. **Comms moved to its own DB + service** (longest tail, cleanest)

Same split as (B) but comms gets its own SQLite (or a small Postgres) for
the comms tables. The main service queries comms via HTTP (`/api/dialpad/...`)
when it needs join data (e.g., showing texts on a project detail page).

- Pros: full blast-radius isolation. Either side can be migrated to a new
  DB / new platform without touching the other.
- Cons: every cross-surface query goes over HTTP; project-detail comms
  panel has to fetch instead of join. Latency cost.

**Recommendation**: stay on (A) until the next material comms outage. Move
to (B) when the volume justifies the operational complexity. Don't jump
straight to (C) — service-mesh thinking is overkill for the team size.

## 4. Cross-surface change protocol

When work in another part of the app touches comms (e.g., a project detail
panel adds an "SMS history" widget, or a new admin tool needs the unread
count), the *other* surface owner must:

1. Open a comms-x/<slug> branch with the proposed contract changes.
2. Tag the contact-center-architect for design review **before** writing
   the integration code.
3. Wait for the architect to either:
   - Approve the existing endpoint contract (no comms code change), or
   - Counter-propose a new endpoint shape (comms code change required).
4. Land the architect's comms code first, then land the consumer side.

The architect's job is to keep the comms API contract stable. New consumers
shouldn't dictate field shapes that don't fit the contact-center model.

## 5. Smoke check — comms-only deploys

After any deploy that touches webhooks, SSE, or the dialpad_events schema:

1. Send a known test SMS from a personal phone to a Dialpad number.
2. Within 30s, confirm the row arrives in `dialpad_events` (look at row
   count delta).
3. Open `/comms` in a browser, confirm the SMS shows in Live Activity and
   in the relevant thread drawer.
4. Confirm the Notification Bell didn't double-fire on the same event.

If any step fails, roll back via `git revert <last comms commit> && push`
and re-investigate locally.

## 6. Open follow-ups

- [ ] Convert option (A) → (B) when comms feature work picks up. Track
      effort: ~1 day to split routes, ~half day to wire Railway services.
- [ ] Add a `/api/dialpad/health` endpoint that the smoke check (§5) hits
      without firing a Dialpad call.
- [ ] Backfill a comms-runbook doc covering the most common incidents
      (webhook stopped firing, SSE disconnect storm, reminder cron stuck).
