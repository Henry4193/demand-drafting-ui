# demand-drafting-ui — Litigation Demand Drafting + Inbox Monitors

**⛔ HIPAA GATE — READ FIRST:** This app handles real PHI. The Anthropic (2026-07-13) and Filevine (2026-07-14) BAAs are **signed** — PHI to Claude is permitted, but ONLY via the dedicated BAA-track `ANTHROPIC_API_KEY` (never reuse chase-ui's or any other key). Railway deploy stays private. Email bodies reach Claude only behind each monitor's `BAA_SIGNED` gate.

Full ecosystem context: `C:\Users\Henry Knotts\Desktop\ME Lawyers HQ\brain\` (start with `21-app-demand-drafting-ui.md`, `25-app-cm-action-router.md`, and `60-compliance.md`).

## What it does
1. **Demand drafting** — login-gated web app: search a Filevine litigation case, upload case docs + up to 3 prior demand letters (style models), add instructions → Claude (`claude-sonnet-5` default) generates a demand letter.
2. **Litigation inbox monitor** (`lib/monitor.js`, dormant) — scans lit attorneys' Outlook via Graph, classifies deadlines/servings/demand-replies, sends alerts + daily digest.
3. **CM Action Router** (`lib/cm-monitor.js` + `lib/cm-state.js`, LIVE-calibrated) — watches Henry's inbox for case managers' explicit asks, resolves the intake who signed the case up (Filevine `factsOfLoss` "POC is X" → `lib/staff-registry.js`), and @mentions them in the chase Teams chat via the **delegated** Graph token (`Admin\.graph_token` flow — app-only chat posting is forbidden by Graph). Escalation ladder + daily digest to `CM_HENRY_CHAT_ID`. Tuning toolkit in `scripts/`. Full spec: `PLAN-cm-monitor.md`.

## Layout
- `server.js` — fail-fast env validation, HTTPS/no-store/nosniff/frame-deny, session login with per-IP lockout, routes (`/api/cases/search`, `/api/generate`, monitor endpoints).
- `lib/filevine.js` (FV token cache, ported from chase-ui) · `lib/extract.js` (in-memory PDF/DOCX/TXT — PHI never hits disk) · `lib/prompt.js` (160k input budget, 15k prior-demand cap, laddered truncation, anti-hallucination `[INSERT: …]` rules) · `lib/graph.js` (MS Graph) · `lib/monitor.js` (inbox agent) · `lib/state.js` (PHI-free whitelist state serializer → `agent-state.json`).

## Safety gates (monitor)
`MONITOR_ENABLED` (master, default off) → `MONITOR_DRY_RUN` (Graph reads only) → `BAA_SIGNED` (email bodies to Claude only when true). Keep all three semantics intact in any refactor.

## Env (names only; `.env` is git-ignored and holds live secrets — never read/print it)
`FV_PAT`, `FV_CLIENT_ID`, `FV_CLIENT_SECRET`, `FV_ORG_ID`=6907, `FV_USER_ID`=90868, `FV_PROJ_TYPE_ID`=20164, `ANTHROPIC_API_KEY` (BAA-track), `ANTHROPIC_MODEL`, `APP_USERNAME`, `APP_PASSWORD`, `SESSION_SECRET`, `MS_CLIENT_ID`/`MS_CLIENT_SECRET`/`MS_TENANT_ID`, `LIT_ATTORNEY_EMAILS`, `MONITOR_*` tuning. CM router: `CM_MONITOR_ENABLED` → `CM_MONITOR_DRY_RUN` → `BAA_SIGNED` (gates), `CM_MONITOR_MAILBOX`, `CM_TEAMS_CHAT_ID`, `CM_HENRY_CHAT_ID`, `CM_MAX_POSTS_PER_SYNC`, `CM_MONITOR_LOOKBACK_DAYS`, `CM_ESCALATE_HOURS`, `CM_MONITOR_DIGEST_HOUR`, `CM_MONITOR_STATE_FILE`, `CM_STAFF_REGISTRY_PATH`, `MS_DELEGATED_TOKEN_FILE` (+ one-time `MS_DELEGATED_TOKEN_SEED`/`CM_STATE_SEED` base64 seeds for Railway volumes). See `.env.example`.

## Testing
Use synthetic fixtures only (e.g. `Desktop\SYNTHETIC-test-case-alex-testcase.txt`). Build spec: `Desktop\Client Relations\PLAN-demand-drafting-ui.md`.
