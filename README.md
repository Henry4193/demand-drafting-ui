# demand-drafting-ui

> ## ⚠️ HIPAA GATE — READ FIRST
> This app will eventually handle Protected Health Information (PHI): medical
> records, injury details, client-identifying information. A Business Associate
> Agreement (BAA) with Anthropic is **being negotiated but is NOT signed yet.**
> Until the BAA is signed and Henry confirms it:
> - Build and test with **dummy/synthetic data only**. Never upload real client documents.
> - The Railway deployment stays **private** — URL and credentials unshared.
> - Do **not** point the app at any pre-existing Anthropic API key. Use only the
>   new, dedicated BAA-track key. Every key found in `Admin\config.ps1`, chase-ui,
>   or elsewhere on this machine predates the BAA and is **not HIPAA-eligible.**
>
> This blocks *using* the app with real data — not *building* it.

A standalone web app for the ME Lawyers litigation department. Pick a case
(looked up live from Filevine), attach case documents and prior demand letters,
add custom instructions, and generate a demand letter with Claude.

Separate from `chase-ui` in every way: own repo, own Railway project, own env
vars, no shared data store. Only the Filevine auth pattern and visual design are
borrowed.

## Stack
Node.js + Express + plain HTML/CSS/JS (no framework, no build step). Documents
are processed **in memory only** — never written to disk, never persisted.

## Environment variables

| Var | Source |
|---|---|
| `FV_PAT`, `FV_CLIENT_ID`, `FV_CLIENT_SECRET`, `FV_ORG_ID`, `FV_USER_ID`, `FV_API_BASE`, `FV_PROJ_TYPE_ID` | `C:\Users\Henry Knotts\Desktop\Client Relations\Admin\config.ps1` |
| `ANTHROPIC_API_KEY` | **New dedicated BAA-track key from Henry.** Never reuse another key. |
| `ANTHROPIC_MODEL` | Defaults to `claude-sonnet-5`. |
| `APP_USERNAME`, `APP_PASSWORD`, `SESSION_SECRET` | Chosen by you. Rotate `APP_PASSWORD` to a strong value before real use. |
| `PORT` | Local only (3100 default). Railway injects its own. |

The server **refuses to start** if any required variable is missing — it will
not silently fall back to another Anthropic key.

## Run locally
```
cp .env.example .env      # then fill in the values
npm install
npm start                 # http://localhost:3100
```

## Auth is a floor, not a ceiling
The single shared-credential login is the minimum viable gate. Before any real
PHI is entered, revisit this: per-user accounts, MFA, or SSO.

## Deploy (private, do NOT go live)
1. Push to a **private** GitHub repo. Confirm `.env` is not tracked
   (`git ls-files | grep .env` should show only `.env.example`).
2. Railway → **New Project** (not a service inside chase-ui) → deploy from the repo.
3. Set every variable above in the Railway service's Variables tab.
4. Confirm the `*.up.railway.app` domain serves over HTTPS and that the login
   gate blocks anonymous access.
5. **Do not** share the URL or credentials. The deployment exists so the
   BAA-day cutover is trivial — it is not in service until the BAA is signed.

## Subprocessor status
- **Anthropic** — BAA in negotiation, **NOT signed.** Do not send real PHI.
- **Filevine** — as the firm's system of record it presumably has a BAA with the
  firm, but this is **an assumption to verify**, not a confirmed fact.
