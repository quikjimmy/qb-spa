# Comms Hub — Standard Operating Procedures

## What the Comms Hub does

The Comms Hub is the portal's single screen for everything happening on the phone system: live calls in progress, missed calls, voicemails, recordings, and SMS threads. It pulls every call and text from Dialpad in real time, attributes each one to a customer project where it can, and gives coordinators one place to triage the day. It is not a replacement for the Dialpad app — calls are still placed and received through Dialpad — it is the dashboard on top of it. Built mobile-first; coordinators in the field run it from a phone, managers from a laptop, both see the same data.

---

## For Coordinators (day-to-day use)

This is the screen you live in. Default tab is **Inbox**. Everything you need to action is one tap away.

### Your daily rhythm

1. Open the Comms Hub. Land on **Inbox → Unread**.
2. Work the unread list top-to-bottom. Each row is a missed call, voicemail, or unread text. Tap the row to open the unified thread for that contact — every prior call and SMS with that person is in one drawer.
3. When Unread hits zero, you're current. Move to **Missed** or **VMs** if you want to double-check the day.
4. Keep the **Live Activity** rail visible (right side on desktop, collapsible strip on mobile). It shows what is ringing, connecting, and hanging up across your scope right now.

### The Inbox tabs

| Tab | What's in it |
|-----|--------------|
| **Unread** | Missed calls, voicemails, and inbound texts you have not opened. This is your to-do list. |
| **All** | Everything from the last 14 days, read or unread. |
| **Missed** | Inbound calls you did not answer. |
| **VMs** | Voicemails left for you. |
| **Texts** | Inbound SMS threads. |
| **Recordings** | Recorded calls (where available). |

Counts on each tab reflect what is open. "Mark all read" sits top-right on the Unread tab when you have a backlog.

### Opening a thread

Tap any row — call or text — and the **unified contact thread** opens. On mobile it slides up from the bottom; on desktop it slides in from the right. The drawer shows the full timeline (calls and SMS interleaved) for that contact, regardless of which row you tapped. Reply, place a call, or jump to the matched QB project from inside the drawer.

### Click-to-call, SMS, and saving contacts

- Tap a phone number anywhere in the Hub to dial through Dialpad.
- To start a new outbound text, use **Compose** from the Recent Threads section or open the contact's thread and type. If your sender list is empty, opening Compose once refreshes it.
- When an inbound call comes from an unknown number, a small bookmark icon appears on the row. Tap to save. The save pushes to Dialpad's shared address book, so every coordinator and every Dialpad agent app sees the name on the next call.

### Per-message reminders ("remind me about this")

Inside a thread, **long-press** a message on mobile (or right-click on desktop). A menu appears with:

- Mark as unread
- Save contact
- **Remind me** — In 10 minutes / In 30 minutes / Later today / Tomorrow / Custom

Pick a time. You get a notification at that time, and clicking it drops you back into this exact thread. Use it any time a customer texts something you need to follow up on after a different task.

### The notifications bell

Top-right of the portal. It pulses when you have unread items. Open it to see recent reminders, unread SMS notifications, and other portal alerts. Click any item to jump straight to the thread.

### Caller attribution chips

Live rows show a small chip next to the caller's name:

- **Crew** — a field tech recognized from the Arrivy roster. Treat as internal.
- **Internal** — another Kin portal user.
- (no chip) — likely a customer or unknown number.

Use the chip to decide how to answer before you pick up.

### Searching

The search bar at the top of the Hub searches across calls and SMS by customer name, phone number, message body, or coordinator name. Use it when a customer calls back and you need their last conversation in two seconds.

---

## For Managers (oversight + coverage)

You run a team. You need to see what your coordinators are handling, where the gaps are, and who is covering whom.

### Scope and view modes

In the Comms Hub header you have two toggles that matter:

- **Me | Team** — Switches the Reporting view between your personal numbers and the whole team.
- The **All users** dropdown narrows reporting to a single coordinator.

In the Live Activity panel, you have a separate **Me | All** filter (controls what you see in the live feed) and, next to the bell icon, a **Mine | All** ring toggle (controls what you *hear*). These two are decoupled on purpose. You can watch everything and only be audibly notified about your own.

### Reporting

The **Reporting** tab gives you KPI tiles (total calls, inbound, outbound, inbound answer rate, outbound connect rate), a drill-down "Call breakdown" tree, a **By user** table (click any row for that coordinator's activity feed), and a "When are we busy?" heatmap by day-of-week × hour-of-day with its own user/department/entry-point filter. Date presets at the top: 7d, 14d, 30d, 60d, 90d, Mo, Qtr, YTD.

### Coverage: someone is OOO or on PTO

Coverage is handled via department routing, not per-person redirects. The clean path:

1. The PTO'd coordinator stays in their department. Do not remove them from the team during coverage.
2. The covering coordinator must be a member of the same portal department as the absent one. If they aren't already, an Admin adds them temporarily (Admin → Departments → assign user). Department membership is what makes their Comms Hub see the absent coordinator's incoming calls.
3. The covering coordinator switches the Live Activity ring scope to **All** (bell-prefixed pill in the panel header) for the duration of coverage. This is the only setting they need to flip.
4. When the absent coordinator returns, the Admin removes the temporary department assignment from the cover. The cover flips ring scope back to **Mine**.

Department membership is the lever. Do not chase per-user routing.

### What you should glance at every day

- **Inbound answer rate** on the Reporting tab. If it dips below 75% it goes amber. That's your signal.
- **By user table** — look for a coordinator whose inbound answer rate dropped today. Click their row, see the per-coordinator feed.
- **Heatmap** — if a particular hour block keeps showing up dark, you may be understaffed there.
- **Unmatched users** — at the top of the By user table. An unmatched chip means a Dialpad agent's email does not line up with a portal account, so their activity isn't attributed to them. Get the Admin to reconcile.

### When to step in

If you see the same project name surfacing in multiple coordinators' missed-call lists in the same morning, that customer is on the edge of getting frustrated. Pick a coordinator to own it and put it in their thread.

---

## For Admins (routing setup + overrides)

You own the wiring between Dialpad's routing tree and the portal's departments. Get this right once per department and the team stops missing calls they should see.

### The mental model

Dialpad routes incoming calls to **routing targets** — a call center, a department, a specific user, an office, a coaching group, or a room. When a call hits a target, the portal needs to know which group of users in your org should *see* that call ringing in their Comms Hub.

That mapping lives in **Admin → Departments → Routing**. Each portal department points at one or more Dialpad routing targets. A coordinator in a department sees live events for every target that department claims. If nobody has claimed the target, every connected user sees it (grace fallback — so a new routing line never goes silent before you map it).

A user always sees calls Dialpad routed to them personally, regardless of department mapping. That part is hard-wired.

### Set up routing for a new department — checklist

1. **Create the portal department** — Admin → Departments → add. Clear name ("Project Coordinators — West").
2. **Assign the team** — Admin → Users → add the department to each member.
3. **Confirm the Dialpad target exists.** Note the ID of the call center or department line in Dialpad admin.
4. **Open Admin → Departments → Routing** on the new department row.
5. **Use the "Recently seen in events" picker.** It lists targets actually hit in the last 30 days with timestamps and counts. Click the right one — it pre-fills Kind and ID. Do not paste raw IDs blind.
6. If your target hasn't appeared yet (brand new line), pick **Kind** (callcenter / department / user / office / coachinggroup / room) and paste the **Dialpad ID**. Add a **Label** so future admins recognize it. Click **Add**.
7. Verify: have a team member trigger an inbound call. Confirm it appears in another department member's Live Activity panel — someone Dialpad did not route to personally. If it does, you're wired.

Do this once per department. Members can be added or removed later without touching routing.

### The admin "Show all" override

In the Live Activity panel header, admins see an amber **Show all** button that the team does not. Clicking it bypasses department-based visibility and shows you every event in the org — useful for spot-checks, coverage gaps, and verifying routing is wired correctly. The setting is per-browser and persists across reloads. Turn it off when you're done so your panel goes back to a normal load.

### Ring policy guidance per role

The visual filter (what you see) and the ring filter (what you hear) are separate. Both default to **Mine**. Set them deliberately by role:

| Role | Visual scope | Ring scope (bell-prefixed pill) |
|------|--------------|--------------------------------|
| Coordinator, normal day | Me | Mine |
| Coordinator covering someone OOO | All (or Me, see below) | All |
| Coordinator on a focused outbound block | Me | Mine, mute sound |
| Team lead watching for hot accounts | All | Mine — you watch, you don't get every ring in your ear |
| Admin spot-checking routing | All + "Show all" override | Mine — never blast yourself with org-wide ringing |

The separation is intentional. Ringing every PC in the org for every inbound call is the fastest way to train the team to ignore the sound.

### Audio mute vs. ring scope

The speaker icon in the Live Activity panel is the **hard mute**. Use it when the team is on a call, in a meeting, or anywhere a phone going off is rude. Ring scope is the **policy** — who should ring you when you are listening. Mute trumps scope.

---

## The Page / Emma scenario

This is the case the system is designed around. Read it once. It will tell you whether your routing is wired right.

> The project coordinator inbound line is ringing for one of Page's customers. Page is already on another call. Emma is also a PC, sitting at her desk, available. Without doing anything special, Emma should see that call ringing in her Live Activity panel so she can pick up.

How the Hub delivers this:

- Page and Emma are both in the **Project Coordinators** portal department.
- That department is mapped (in Admin → Departments → Routing) to the Dialpad call center the inbound line routes through.
- Inbound call arrives → routed to the call center → both Page and Emma's Comms Hubs see it ringing because their department claims the target.
- Whether Emma's Hub audibly rings depends on her **Mine | All** ring setting. If she's on "Mine," she sees it but doesn't get the sound. If she's on "All," she sees and hears it.
- Page sees it too but is on another line, so she doesn't act on it. Emma picks up.

If Emma is not seeing the call: she is not in the right department, the department doesn't claim the target, or there is no department mapping at all and the call is hitting a target your admin has claimed for *another* department. See Troubleshooting.

---

## Real-time review-line scenario

> The customer-review line rings. Who's notified?

Same model. The review line is a Dialpad routing target. An admin maps it to the portal department responsible for reviews (e.g. "Customer Success"). Anyone in that department sees the call ringing live. Anyone with ring scope set to **All** hears it. If no department has claimed it yet, everyone sees it (grace fallback) — that's a signal to the admin that the target needs a home.

---

## Troubleshooting

### "I'm not hearing rings I should hear"

1. Click the speaker icon in the Live Activity panel header on.
2. If you cover for the team, switch the **Mine | All** pill (next to the bell) to **All**.
3. Confirm the call is appearing *visually* in the panel. If yes, the problem is audio (steps 1–2). If no, see "I don't see calls I should."
4. Check device volume and tab mute (right-click tab → Unmute).

### "I'm hearing too many rings"

1. Set the **Mine | All** pill to **Mine**. You only hear calls Dialpad routed to you personally.
2. Hard-mute via the speaker icon during focused work.
3. If a covering coordinator left ring scope on All by mistake, ask them to flip back to Mine.

### "I see calls I shouldn't"

1. Admins: check whether the amber **Show all** override is on. Turn it off.
2. Coordinators: you may be in more departments than you should be. Ask an admin to review your memberships.

### "I don't see calls I should"

1. Confirm your department assignments — Admin → Users → your row.
2. Confirm the department claims the routing target the call hits — Admin → Departments → Routing.
3. Admin checks the **Recently seen in events** picker for the target ID the call is arriving on. If it appears there but your department isn't mapped to it, add the mapping.
4. As a last resort, the admin's **Show all** confirms whether the event is reaching the portal at all. If it isn't, the issue is upstream (Dialpad routing or webhook delivery), not the Hub.

### "A coordinator's calls aren't showing up in Reporting"

Reporting attributes activity by matching the Dialpad agent's email to a portal user's email. An **unmatched** chip in the By user table means the emails don't line up. Admin reconciles the email on either side so they match exactly, then re-syncs.

## Updating this SOP

This document is a live procedure, not a one-time handoff. It needs to track the operation it describes — an SOP that lags reality is worse than no SOP, because coordinators will trust it and act on it.

### When you notice something wrong or missing

Flag it to James Tootill (jamestootill@gmail.com) with the section heading and what you'd change. The single source of truth lives in the qb-spa repo; what you read in-app is generated from that file on every deploy. Never edit the in-app copy directly — your changes would be overwritten on the next release.

### When a procedure changes operationally

Update the SOP the same day the change goes into effect. Common triggers:

- A new department is created or retired
- A coverage policy changes (who covers whom, on which days)
- A new Dialpad routing target is added or repurposed
- A coordinator role's ring-policy default changes

### What to include in an edit request

- The role(s) affected — Coordinator, Manager, or Admin
- The scenario the change responds to — a real incident is better than a hypothetical
- The exact label or button name as it appears in the app, not paraphrased — labels are the contract between this doc and the UI

### How quickly an edit reaches users

Edits land as a code change and ship on the next deploy of the portal. Plan for same-day if it's flagged before noon, next-day otherwise. There is no separate publishing step for the SOP itself.

---

