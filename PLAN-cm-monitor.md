# PLAN — CM Action Router (`cm-monitor.js`)

Status: **draft / scaffolding** · Author: Henry + Claude · 2026-07-15
Home: second inbox-monitor module inside **demand-drafting-ui** (BAA app). Ships dormant.

## Purpose

Case managers email Henry (and his team) asking for a direct action on a case. These
get missed. This agent watches Henry's inbox, detects the explicit action requests,
figures out **which intake specialist signed that case up**, and pings that person in
Teams — with an escalation ladder so nothing sits unanswered.

The routing linchpin is already proven (`scripts/prove-poc-field.js`): from a file
number we read Filevine `factsOfLoss`, extract the `POC is {name}` line, and map that
first name to an Intake Specialist in the staff registry.

## Data flow

```
New mail in henry@melawyers.com  (Graph fetch, hourly)
      │
      ▼  [1] Claude classify: explicit action request from a CM?  (gated by BAA_SIGNED)
      │       → { type: action_required | irrelevant, action, dueDate }
      ▼  [2] Parse subject → file number (+ client name)
      │       assignment-email thread subject carries "name + file #"
      ▼  [3] File # → projectId   (cached Filevine PI project index)
      ▼  [4] GET /fv-app/v2/projects/{projectId}/forms/casesummary20164 → factsOfLoss
      ▼  [5] Extract "POC is {FirstName}" → staff-registry → Intake Specialist + AAD user
      ▼  [6] Post to chase Teams chat, @mention that intake
      │       "🔔 {client} (#{file}) — {CM} needs {action}. @{intake}"
      ▼  [7] Escalation: no thread reply in ~4 biz hrs → re-post → EOD → @mention Henry
              + once-daily digest of open items to Henry
```

Any miss in [2]–[5] (no file #, no POC line, 0 or >1 registry match) → **fall back to
@mention Henry** so the item is never silently dropped.

## Why it lives in demand-drafting-ui

It needs the **BAA-track key** (Henry's inbox is wall-to-wall PHI) and reuses this app's
`lib/graph.js`, `lib/filevine.js`, and the PHI-free `lib/state.js` discipline. It is a
sibling of `lib/monitor.js` (the litigation monitor), not a new standalone app.

## Files

| File | Status | Role |
|---|---|---|
| `lib/cm-monitor.js` | new (scaffold) | The agent: config, classify, route, post, escalate, digest, orchestrator, public API |
| `lib/cm-state.js` | new | PHI-free durable state (own state file, own whitelist) |
| `lib/graph.js` | edit | Add `resolveUserId(email)` + `postChatMessage(chatId, html, mentions)` |
| `lib/filevine.js` | reuse | `fvFetch` for the project index + `factsOfLoss` read |
| `lib/staff-registry.js` | new (bundled) | Snapshot of the Admin registry (Railway can't reach the Admin folder); refresh on regen |
| `server.js` | ✅ done | `cmMonitor.start()` + banner/env-check + `sync`/`status`/`debug` endpoints behind `requireAuth` |

## New Graph helpers (`lib/graph.js`)

- `resolveUserId(token, email)` → AAD user id, for the @mention target.
  `GET /users/{email}?$select=id,displayName`. Needs **User.Read.All** (app) — already
  used elsewhere in the ecosystem (staff registry pulls Graph users).
- `postChatMessage(token, chatId, html, mentions)` → `POST /chats/{chatId}/messages`.
  Same call the chase-list PowerShell already makes successfully, so **ChatMessage.Send**
  (app) is present. `mentions` = `[{ id, mentionText, mentioned: { user: { id, displayName, userIdentityType:'aadUser' } } }]`; the html body references each via `<at id="N">Name</at>`.

⚠️ **Canary-verify**: app-only (`ChatMessage.Send`) posting *with* an `<at>` mention.
Posting plain text is proven; the mention payload needs one live confirmation.

## Env surface (names only — add to `.env`)

```
CM_MONITOR_ENABLED       # master gate, ships false
CM_MONITOR_DRY_RUN       # Graph reads only; no Claude on bodies, no Teams posts
BAA_SIGNED               # shared with lit monitor; bodies → Claude only when true
CM_MONITOR_MAILBOX       # henry@melawyers.com
CM_TEAMS_CHAT_ID         # 19:...@thread.v2  (the existing chase chat, from config.ps1)
CM_MONITOR_SENDER        # from-address for the email digest fallback (optional)
CM_MONITOR_LOOKBACK_DAYS # default 3 (Henry's inbox is ~1,100 msgs/14d — keep the window tight)
CM_ESCALATE_HOURS        # first re-ping threshold, default 4 (business hours)
CM_MONITOR_DIGEST_HOUR   # ET hour for the daily digest, default 8
CM_MONITOR_STATE_FILE    # optional path override for cm-agent-state.json
```

Reuses existing `FV_*`, `MS_*`, `ANTHROPIC_*` already in `.env`.

## PHI-free state (`lib/cm-state.js`)

Own state file (`cm-agent-state.json`), own whitelist sanitizer — identical discipline
to `lib/state.js`. Persists ONLY opaque keys:

- `classifiedIds`: Graph msg id → `{ type, dueDate }` (dedupe classification / Claude cost)
- `routed`: Graph msg id → `{ postedAt, intakeKey, fileNumber, stage, conversationId }`
  — `stage` ∈ `posted | reminded | escalated | resolved`; `intakeKey`/`fileNumber` are
  non-PHI identifiers, not client data
- `lastDigestDate`: `YYYY-MM-DD`

Subjects, client names, actions, `factsOfLoss` text, POC display names → **memory only**
(`agentState`), re-derived from Graph/Filevine at post time. Never on disk.

## Classification (Claude, BAA-track key)

System prompt (explicit-asks-only for v1):

> You are triaging an operations manager's INCOMING email at a personal-injury firm.
> A case manager may be asking the manager or the intake team to DO something on a case.
> Classify the single email. Respond with ONLY JSON:
> `{"type":"action_required"|"irrelevant","action":<short imperative or null>,"dueDate":"YYYY-MM-DD"|null}`
> action_required = the sender explicitly asks someone to take a concrete action
> (pull/upload a document, get a signature, call the client, correct a record, etc.).
> irrelevant = FYI, thanks, scheduling noise, newsletters, anything with no explicit ask.

Same gates as the lit monitor: skip auto-replies; Claude sees bodies only when
`BAA_SIGNED` and not dry-run; cache `{type,dueDate}` per msg id.

## Routing detail

1. **Subject → file number.** Assignment-thread subjects carry `... name ... #####`.
   Parser tries leading digits and an embedded `#####` token; also captures `Last, First`.
   No parse → fallback (@mention Henry).
2. **File # → projectId.** Filevine has no server-side number search, so we keep a cached
   index of active PI projects (`projectTypeId=20164`), parsing the leading file number
   from `projectOrClientName` ("5130 - Watts, Jacque"). TTL ~6h, rebuilt lazily. (Same
   pattern as demand-drafting-ui `server.js` `buildProjectIndex`.)
3. **factsOfLoss read.** `GET /fv-app/v2/projects/{projectId}/forms/casesummary20164` →
   camelCase `factsOfLoss` (NOT the `factsofloss243755` write-selector).
4. **POC extract + map.** Regex `POC is {name}` → first name → `staff-registry.js`
   Intake Specialists. 1 match → route; 0 or >1 → fallback.
5. **@mention target.** `resolveUserId(intake.email)` → AAD id.

## Escalation ladder

- Track latest inbound reply time per `conversationId` (like the lit monitor).
- `posted` → if the CM/intake thread has no new reply after `CM_ESCALATE_HOURS`
  business hours → **re-post** (`reminded`).
- Still nothing by end of business day → **escalate**: re-post @mentioning **Henry**
  (`escalated`).
- A new inbound reply on the thread after our post → mark `resolved`, stop nagging.
- Business-hours math keeps weekends/after-hours from tripping the timers.

## Daily digest

Once per day at `CM_MONITOR_DIGEST_HOUR` (ET): a summary of still-open action items
(what's posted/reminded/escalated, by intake) to Henry. Teams post to the chat, or email
via `CM_MONITOR_SENDER` — TBD, default Teams to keep it in one place.

## Safety gates & rollout (mirror the lit monitor)

`CM_MONITOR_ENABLED` (master, false) → `CM_MONITOR_DRY_RUN` (Graph reads only, no Claude
on bodies, no posts) → `BAA_SIGNED` (bodies → Claude).

1. Ship dormant (all gates off). Code review.
2. **Dry-run**: enable + dry-run. Watch logs — subject parsing, file#→projectId hit rate,
   POC extraction rate — against real inbox volume, zero sends, zero Claude-on-bodies.
   This is where we **calibrate the subject parser** against real assignment-email format.
3. **Canary**: BAA key confirmed + `BAA_SIGNED` on, but post to a **test chat** (or DM
   Henry only) for a few days. Verify @mention renders and routes to the right intake.
4. Flip `CM_TEAMS_CHAT_ID` to the real chase chat. Live.

## Open calibration items (need real data / one live check)

- [ ] **Exact assignment-email subject format** — calibrate the file#/name parser in dry-run.
- [ ] **Intake specialists are members of the chase Teams chat** — @mention only notifies
      chat members. (Henry: leaning on @mentions — confirm membership or add them.)
- [ ] **App-only `<at>` mention** renders via `ChatMessage.Send` — one canary post.
- [ ] **`CM_TEAMS_CHAT_ID`** copied from `config.ps1` into the app `.env`.
- [ ] Confirm demand-drafting-ui points at the **BAA-track key** before `BAA_SIGNED=true`.

## Fallback guarantee

Every routing miss → @mention Henry with what we *do* know (subject, sender, file # if any).
The agent's failure mode is "Henry gets pinged," never "silently dropped."
