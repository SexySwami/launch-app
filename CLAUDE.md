# Launch — Mission Control for Momentum

A gamified, ADHD-friendly task-initiation web app. The user types or speaks a single mission; Claude breaks it into four guided micro-steps (OPEN → SCAN → EXEC → PUSH); a 3-2-1-GO countdown launches them in, and a momentum score rewards completion.

This file is context for Claude Code working in this repo. Read it before making changes.

## ⚠️ READ FIRST: where the deployed frontend lives

This repo contains **two Vercel projects**:

1. **`web/`** — Vite + React app. **This is the production customer-facing frontend.** Source: `web/src/**` (e.g. checklist/folder/drag logic in `web/src/components/MissionInput.jsx`). Linked Vercel project: `web` (see `web/.vercel/project.json`).
2. **Root `index.html`** — a legacy single-file React-via-CDN prototype, deployed as a separate Vercel project (`launch-app`). **Not the user-facing app.** Kept around because the shared `/api/*.js` Edge functions deploy with it, and `web/vercel.json` rewrites `/api/*` to `launch-app-kohl.vercel.app`.

**Rule for feature work:** edit files under `web/src/**`. Do NOT edit the root `index.html` unless the user explicitly says so. If you find yourself about to change root `index.html` for a UI/feature change, stop and edit the Vite source instead.

The architecture notes below describe the legacy single-file prototype and remain accurate for the API + Redis layer, but the frontend description applies to the prototype, not production.

## Tech stack

- **Frontend:** React 18 + Babel Standalone loaded from CDN, inside a single `index.html`. No bundler, no build step, no `node_modules`. JSX runs in the browser via `<script type="text/babel">`.
- **Styling:** Inline styles + a small `<style>` block in `index.html`. Fonts: Space Grotesk + JetBrains Mono from Google Fonts. Dark, mobile-first UI (`100dvh`, viewport-fit cover, no-scroll body).
- **Backend:** Vercel **Edge** serverless functions in `/api`, each exporting `export const config = { runtime: 'edge' }`.
- **Storage:** Upstash Redis via REST (single JSON-stringified value per key). Works with either Vercel KV integration env vars (`KV_REST_API_URL` / `KV_REST_API_TOKEN`) or raw Upstash vars (`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`).
- **LLMs:**
  - **Anthropic Claude** (`ANTHROPIC_API_KEY`) — task parsing, step generation, alternative-step suggestions.
  - **OpenAI Whisper** (`OPENAI_API_KEY`) — voice transcription for mission input.
- **Hosting:** Vercel (static site + Edge functions). Project info in `.vercel/project.json`. `package.json` is intentionally minimal (`"type": "module"`, no deps).

## System architecture

```
┌────────────────────────────┐        ┌──────────────────────────┐
│  index.html (React SPA)    │        │  Vercel Edge Functions   │
│                            │  HTTP  │  /api/*                  │
│  - MissionInput            │ <────> │  - parse-tasks  (Claude) │
│  - Countdown               │        │  - generate-steps (Claude)│
│  - ExecutionStep           │        │  - generate-options (Claude)│
│  - EditStepModal           │        │  - transcribe   (Whisper)│
│  - Reward / NextPhase      │        │  - queue        (Redis)  │
│  - Dashboard               │        │  - completed    (Redis)  │
│  - CompletedSteps          │        └────────────┬─────────────┘
│  - BottomNav               │                     │
└────────────────────────────┘                     ▼
                                          ┌──────────────────┐
                                          │  Upstash Redis   │
                                          │  launch:queue    │
                                          │  launch:completed│
                                          └──────────────────┘
```

The client is the source of truth for in-progress UI state. Redis holds two persisted lists:

- `launch:queue` — pending missions (id, text, folder, created timestamp, etc.).
- `launch:completed` — finalized + in-progress completion entries: `{ id, sourceItemId, sourceItemIndex, text, microSteps: [{ tag, title, hint, completedAt }], createdAt, completedAt }`.

Local fallbacks (e.g. `generateSteps` in `index.html`) exist so the UI still works if an API call fails.

## Folder map

```
Launch-app/
├── index.html              # The entire React app, ~4.5k lines, single file.
├── api/                    # Vercel Edge functions
│   ├── parse-tasks.js      # POST: pasted text → JSON array of task strings (Claude)
│   ├── generate-steps.js   # POST: mission text → 4 micro-steps {tag,title,hint,reward} (Claude)
│   ├── generate-options.js # POST: phase + context → 3 alternative steps (Claude)
│   ├── transcribe.js       # POST multipart audio → text (OpenAI Whisper)
│   ├── queue.js            # GET/POST/DELETE: mission queue CRUD (Redis)
│   └── completed.js        # GET/POST/DELETE: completed log, supports log-step / finalize / restore (Redis)
├── package.json            # {"name":"launch-app","private":true,"type":"module"} — no deps
├── README.md               # User-facing intro
├── .vercel/project.json    # Vercel project + org IDs (auto-managed)
├── .gitignore              # ignores .vercel
└── CLAUDE.md               # this file
```

## API endpoints (quick reference)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/parse-tasks` | Body `{text}` → `{tasks: string[]}` |
| POST | `/api/generate-steps` | Body `{mission}` → `{steps:[{tag,title,hint,reward}×4]}` (rewards sum to 15) |
| POST | `/api/generate-options` | Body `{mission, phase, currentStep, allSteps}` → `{options:[string×3]}` |
| POST | `/api/transcribe` | multipart `audio` blob → `{text}` |
| GET / POST / DELETE | `/api/queue` | Mission queue CRUD; POST `action=add|reorder|update|clear` |
| GET / POST / DELETE | `/api/completed` | Completed entries; POST `action=log-step|finalize|restore` |

## Key UI components inside `index.html`

`LaunchApp` is the root. Notable subcomponents:

- `MissionInput` — text + voice input, paste-to-parse, queue/folder management.
- `Countdown` — 3-2-1-GO animation before execution starts.
- `ExecutionStep` — renders one of the 4 micro-steps with momentum bar.
- `EditStepModal` — swap a step via `/api/generate-options`.
- `Reward` / `NextPhase` — between-step + post-mission states.
- `Dashboard` — momentum + launches-today telemetry.
- `CompletedSteps` — history view (restore / delete).
- `BottomNav`, `GlowButton`, `Eyebrow`, `Telemetry`, `MarqueeText` — UI primitives.

The 4-phase taxonomy is `OPEN / SCAN / EXEC / PUSH`, with workout-variant tags `GEAR / HYDR / WARM` swapped in for physical missions. Step `reward` integers must sum to exactly 15 (typically 4-4-4-3).

## Local development

There is no build. Either:

```bash
open index.html              # quick: file:// works for UI-only changes
# or
npx vercel dev               # full: serves /api edge functions locally
```

For the API routes to work locally you need the env vars below set in `.env.local` (or in Vercel project settings for deployed previews):

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `KV_REST_API_URL` + `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`)

## Deploy

Pushed to Vercel. No framework preset — static `index.html` plus Edge functions auto-detected from `/api/*.js`. Production is the `main` branch.

## Conventions & gotchas

- **Single-file frontend is intentional.** Don't introduce a bundler, package dependencies, or split `index.html` into modules without explicit instruction — it would break the "open in browser, no build" workflow.
- **All API routes are Edge runtime.** Don't use Node-only APIs (`fs`, `Buffer` semantics differ, no native streams). Use `fetch`, `Request`, `Response`, `FormData`.
- **Redis access is REST, not a client library.** Use `fetch` against `${KV_REST_API_URL}/get/...`, `/set/...`, etc., with `Authorization: Bearer ${token}`.
- **LLM outputs must be strict JSON.** Each endpoint instructs Claude to return JSON only; the server still defensively parses and validates shape before responding.
- **Mobile-first.** UI assumes a phone viewport, locked scroll, dynamic viewport height (`100dvh`). Test changes on a narrow viewport.
- **Don't commit `.vercel/`** beyond `project.json` — `.gitignore` excludes the rest.
- **No tests** currently. Manual smoke test: type a mission, confirm 4 steps generated, step through, confirm momentum + completed entry.
