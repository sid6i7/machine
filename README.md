# machine

A WhatsApp-resident PM assistant for BeyondChats. Runs as Sid's personal WhatsApp account, watches monitored team groups, and surfaces a unified backlog of work that needs attention — across the product sheet, GitLab MRs, WhatsApp task asks, meeting requests, status checks, progress updates, and unreplied mentions.

Built on top of the original Baileys skeleton (`MakeLiveAction` still works exactly as before).

## What it does today

| Phase | What it ships |
|---|---|
| **P0 Foundation** | SQLite + migrations + repos, Gemini client (with `LLM_DRY_RUN`), node-cron scheduler, Hook + Job + Action triumvirate, hardened WhatsApp service (raw proto, mentions, isFromMe, canonical sender JID across LID and `@s.whatsapp.net`), pushName capture, team config, CLI runner |
| **P1 Morning tasklist** | Classifies meetings-group messages as tasklists; at 12:00 IST DMs members who haven't shared; stateful 2-step DM follow-up; auto-resolves when the tasklist arrives |
| **P2 EOD standup** | At 19:00 IST DMs each member 3 questions (done/left/blockers); at 20:30 IST aggregates with done-vs-plan comparison and posts to meetings group + DMs the PM |
| **P3 Backlog** | Hourly classification of `org-level` / `csm` / `bugs` / `webdev` group messages into 5 intents (task / connect / task_update / status_check / noise) with image vision fallback; 6-hourly Sheets + GitLab MR sync; 15-min unreplied-mention sweep; 9 AM IST morning digest DM; `@<keyword> backlog` command |
| **P4 Web dashboard** | Fastify + HTMX + Tailwind on `127.0.0.1:7777`. Today view, filterable backlog with link chips, in-place resolve, recent messages debug view |
| **P5 intent + linkage upgrades** | `task_update` and `status_check` intents (added after backfill analysis showed 49 + 30 missed signals in 2 days); pre-clustering of consecutive same-sender messages; backfill persistence + dashboard toggle; **MR ↔ task linkage** (sheet-column scrape + LLM fuzzy match — 27 links from real data) |

## Quick start

```bash
# 1. Install
npm install

# 2. Configure (interactive — populates .env, picks hooks/jobs/actions)
npm run setup

# 3. Edit team config (one-time; future: Baileys-aware wizard)
#    Use the helper to fetch group participants without spamming:
npm run team:list-members <groupJid>     # writes data/discovery.json
#    Then hand-edit src/config/team.json with userJid + group JIDs + members.

# 4. Start the bot
npm start
#    Scan QR on first run. Bot logs every group it's in (helpful for team.json).

# 5. Open the dashboard
open http://127.0.0.1:7777
```

## Architecture

```
WhatsApp messages
        │
        ▼
WhatsAppService (raw Baileys proto in)
        │ emit('message')
        ▼
HookDispatcher.run(msg)              ActionDispatcher.dispatch(msg)
  ├─ PersistMessageHook              (only if !isFromMe; existing
  ├─ ClassifyTasklistHook              MakeLiveAction path)
  ├─ TasklistFollowupHook
  └─ EodResponseHook                Cron jobs (Scheduler)
                                      ├─ MorningTasklistReminderJob (12:00)
                                      ├─ EodKickoffJob (19:00)
                                      ├─ EodAggregateJob (20:30)
                                      ├─ MorningBacklogDigestJob (9:00)
                                      ├─ SyncProductSheetJob (hourly)
                                      ├─ SyncGitlabMrsJob (hourly+5m)
                                      ├─ ClassifyWaInboxJob (hourly)
                                      ├─ UnrepliedMentionsJob (every 15m)
                                      └─ PruneMessagesJob (03:00)
                                                │
SQLite (data/machine.db) ◀─────────────────────┘
        │
        ▼
Web dashboard (Fastify, 127.0.0.1:7777)  +  WhatsApp digest (BacklogAction)
```

**Three discoverable patterns** (all auto-loaded by class name from env, mirroring the original `Action` pattern):
- **Action** — explicit `@<keyword> <verb>` commands. `ENABLED_ACTIONS=BacklogAction,...`
- **Hook** — passive per-message side-effects. Run via `Promise.allSettled` so a hook crash never blocks an action. `ENABLED_HOOKS=PersistMessageHook,...`
- **Job** — cron-driven units. `ENABLED_JOBS=PruneMessagesJob,...`

Plus pure-function **Conversations** (`src/conversations/`) for stateful DM threads, **Repos** (`src/db/repos/`) for thin SQL access, and **Integrations** (`src/integrations/`) wrapping Sheets/GitLab/(Calendar).

## Env vars (in `.env`, all gitignored)

Run `npm run setup` to populate interactively. Key ones:

| Var | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | (secret) | Google AI Studio key |
| `LLM_MODEL_FAST` | `gemini-2.5-flash` | Classification + most LLM calls |
| `LLM_MODEL_SMART` | `gemini-2.5-pro` | EOD aggregate, plan-day |
| `LLM_DRY_RUN` | `false` | If `true`, GeminiClient returns canned shapes (no API calls) |
| `SCHEDULER_TZ` | `Asia/Kolkata` | All cron schedules in this TZ |
| `WORKING_DAYS` | `mon,tue,wed,thu,fri` | Reminders/EOD/digest skip non-workdays |
| `WORKING_HOURS_START/END` | `09:00`/`19:00` | For working-hours math (mention SLA) |
| `MENTION_REPLY_SLA_HOURS` | `4` | Surface mentions Sid hasn't replied to after this |
| `ENABLED_HOOKS` | (all P0–P5) | Comma-separated Hook class names |
| `ENABLED_JOBS` | (all P0–P5) | Comma-separated Job class names |
| `ENABLED_ACTIONS` | `BacklogAction` | Comma-separated Action class names |
| `INBOUND_SERVICE` | `WhatsAppService` | Pluggable inbound shim |
| `MENTION_KEYWORD` | `@siddhant` | What triggers mention-based commands |
| `DB_PATH` | `data/machine.db` | SQLite file |
| `MESSAGE_RETENTION_DAYS` | `7` | PruneMessagesJob cutoff |
| `WA_CLASSIFY_GROUPS` | `org-level,csm,bugs` | team.json group labels scanned by ClassifyWaInboxJob |
| `WA_CLASSIFY_BATCH_SIZE` | `20` | Max msgs per LLM batch |
| `WA_PREDOWNLOAD_MEDIA` | `false` | Pre-download images at receipt (WA URLs expire ~14d) |
| `PRODUCT_SHEET_ID` | — | Google Sheet ID |
| `PRODUCT_SHEET_RANGE` | `All Tasks!A:Z` | A1 range to read |
| `PRODUCT_SHEET_STATUS_COL` | `Status` | Header (case-sensitive) |
| `PRODUCT_SHEET_TITLE_COL` | `SA` | Header for backlog title |
| `PRODUCT_SHEET_DESCRIPTION_COL` | `Task Details` | Header for description |
| `GITLAB_BASE_URL` | `https://gitlab.com` | |
| `GITLAB_TOKEN` | (secret) | PAT, `read_api` scope |
| `GITLAB_PROJECT_IDS` | — | CSV of numeric project IDs to scan for staging/prod MRs |
| `GITLAB_TARGET_BRANCHES` | `staging,prod` | Filter MR target branches |
| `WEB_HOST` | `127.0.0.1` | Dashboard bind |
| `WEB_PORT` | `7777` | Dashboard port |
| `WEB_USER`/`WEB_PASS` | — | Optional HTTP basic auth (omit → loopback only) |

## CLI commands

```bash
npm start                                      # Bot + scheduler + web dashboard
npm run setup                                  # Interactive .env + ENABLED_* config
npm run job <JobClassName>                     # Run any cron job once (no scheduling)
npm run team:list-members <groupJid> [...]     # Dump group participants to data/discovery.json
npm run team:names [--apply]                   # Show / fill empty member names from observed pushName
npm run backfill:analyze [-- --days=N --persist --dry-run]
                                               # Parse data/backfill/*.zip exports → data/backfill/report.md (+ raw.json);
                                               # --persist also upserts into backlog_items with origin_jid='backfill:<label>'
node --loader ts-node/esm src/cli/smoke-gemini.ts  # One-shot live Gemini classification
node --loader ts-node/esm src/db/migrate.ts    # Apply pending SQL migrations
```

## Dashboard endpoints

- `GET /` — today's tasklist + EOD + backlog dashboard. Query: `?backfill=1` includes backfill items.
- `GET /backlog` — filterable list. Query: `?source=<src>&dev=1&backfill=1`.
- `POST /backlog/:id/resolve` — mark resolved (HTMX swap).
- `GET /messages` — last 100 messages with `classified_intent` badges.
- `GET /healthz` — `{"ok": true}`.

## Daily ops cycle

| IST | What happens |
|---|---|
| 09:00 | `MorningBacklogDigestJob` DMs you the unified backlog |
| 09:00–12:00 | `ClassifyTasklistHook` watches the meetings group; logs each tasklist as members post |
| 12:00 | `MorningTasklistReminderJob` DMs members who haven't posted; opens stateful DM follow-up |
| Hourly :00 | `SyncProductSheetJob` (sheet rows + sheet-column MR linkage), `ClassifyWaInboxJob` (org/csm/bugs intent classification) |
| Hourly :05 | `SyncGitlabMrsJob` (open MRs targeting staging/prod + LLM linkage for new MRs) |
| Every 15 min | `UnrepliedMentionsJob` (resolve replied + surface unreplied >4 working hrs) |
| 19:00 | `EodKickoffJob` DMs each member Q1 of the EOD |
| 19:00–20:30 | `EodResponseHook` advances each EOD conversation through Q1→Q2→Q3 |
| 20:30 | `EodAggregateJob` runs done-vs-plan comparison per member, posts overview to meetings group, DMs PM the full breakdown |
| 03:00 | `PruneMessagesJob` deletes messages older than `MESSAGE_RETENTION_DAYS` |

## Backfill workflow

You can analyze existing WhatsApp chat exports (zips placed in `data/backfill/`) without polluting live data, then optionally promote results to the backlog:

```bash
# 1. Drop iOS WhatsApp exports into data/backfill/
#    Filenames must match: "WhatsApp Chat - <Group>.zip" where <Group> ∈
#    Meetings | Org-level | CSM | Bugs | WebDev.

# 2. Analyze (no DB writes, just a markdown report)
npm run backfill:analyze -- --days=2

# 3. Inspect data/backfill/report.md and data/backfill/raw.json

# 4. Promote into backlog (origin_jid='backfill:<label>', identifiable + filterable)
npm run backfill:analyze -- --days=2 --persist

# 5. View in dashboard with the toggle
open "http://127.0.0.1:7777/?backfill=1"
```

## Backlog link types

`backlog_links` joins items across sources with a `(parent_id, child_id, link_type)` PK and a `source` field showing how the link was inferred:

| `link_type` | `source` | Meaning |
|---|---|---|
| `sheet_mr` | `sheet_column` | Sheet row's "MR Link" cell contained a gitlab.com MR URL → linked to the corresponding gitlab item |
| `sheet_mr` | `llm` | New MR's title/branch was LLM-matched against open sheet items (≥0.7 confidence) |
| `wa_task_mr` | `llm` | New MR linked to a WhatsApp-task backlog item via LLM |

Dashboard backlog rows render link chips: orange = child MRs on a parent task; blue = parent task on an MR row. WhatsApp digest mirrors this in plain text.

## Testing philosophy

Real-time only. No mocked external systems. The `npm run job <name>` runner exercises the same code path as cron tick → easy to validate end-to-end against real Sheets/GitLab/Gemini in seconds.

## Heads-up

- The Gemini API key + GitLab PAT in `.env` were both initially shared over chat during development — **rotate them** for production use.
- The original `creds/machine-*.json` Google service account was committed at one point in the repo's history — also worth rotating.
- WhatsApp uses LIDs (`<digits>@lid`) for group participants on newer accounts. `team.json` uses LIDs for members; the top-level `userJid` uses the older `<digits>@s.whatsapp.net` form (canonicalized by `WhatsAppService.canonicalJid`).
- The bot runs as YOUR WhatsApp account. Bot-sent replies are indistinguishable from manual ones to recipients.

## Plan + history

The full design plan with all phase details, schemas, and decision rationale lives at `~/.claude/plans/i-want-to-use-abundant-robin.md`.

Memory the assistant has saved about this repo: `~/.claude/projects/-Users-sid6i7-Desktop-work-machine/memory/`.
