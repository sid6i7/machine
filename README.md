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
  └─ EodResponseHook                Cron jobs (Scheduler — see "Jobs reference" below)
                                      ├─ Morning:  MorningEodCatchupJob,
                                      │            MorningBacklogDigestJob,
                                      │            MorningTasklistReminderJob
                                      ├─ EOD:      EodKickoffJob, EodAggregateJob,
                                      │            DailyMemberSummaryJob
                                      ├─ Sync:     SyncProductSheetJob, SyncGitlabMrsJob,
                                      │            ClassifyWaInboxJob, UnrepliedMentionsJob
                                      ├─ Weekly:   WeeklyTeamSummaryJob,
                                      │            WeeklyEvaluationPrefillJob
                                      └─ Nightly:  PruneMessagesJob, SuggestFeaturesJob
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

## Daily / weekly ops cycle

All times in `SCHEDULER_TZ` (default `Asia/Kolkata`). Most jobs run weekdays only (`* * * * 1-5`).

| Time | Job | What happens |
|---|---|---|
| 03:00 daily | `PruneMessagesJob` | Deletes messages older than `MESSAGE_RETENTION_DAYS` |
| 03:00 daily | `SuggestFeaturesJob` | Clusters orphan tasks/MRs into proposed features for the dashboard |
| 08:00 Tue–Fri | `MorningEodCatchupJob` | DMs Sid any EOD replies that landed AFTER yesterday's aggregate |
| 09:00 Mon–Fri | `MorningBacklogDigestJob` | DMs Sid the unified backlog digest |
| 09:00–12:00 | `ClassifyTasklistHook` (passive) | Watches meetings group; logs tasklists as members post |
| 12:00 Mon–Fri | `MorningTasklistReminderJob` | Drafts a single group nudge tagging members who haven't shared (approval UI) |
| every minute Mon–Fri | `SyncGitlabMrsJob` | Pulls open MRs targeting staging/prod + LLM linkage for new MRs + merged-log capture |
| hourly :00 Mon–Fri | `SyncProductSheetJob` | Pulls open sheet rows + scrapes MR Link column → sheet↔MR links |
| hourly :00 | `ClassifyWaInboxJob` | Classifies monitored-group messages into 5 intents (vision fallback for image clusters) |
| every 15 min Mon–Fri | `UnrepliedMentionsJob` | Resolves replied; surfaces mentions unreplied past `MENTION_REPLY_SLA_HOURS` working hrs |
| 19:00 Mon–Fri | `EodKickoffJob` | Queues per-member EOD prompts (DM or one combined group post per `eodChannel`) |
| 19:00–20:00 | `EodResponseHook` (passive) | Advances each EOD DM conversation Q1 → Q2 → Q3 |
| 20:00 Mon–Fri | `EodAggregateJob` | Parses replies, runs done-vs-plan, queues group overview for approval, auto-DMs Sid |
| 20:30 Mon–Fri | `DailyMemberSummaryJob` | Per-member day recap (tasklist + EOD + self-updates + MR/sheet activity) |
| 21:00 Fri | `WeeklyTeamSummaryJob` | Per-member + team-level weekly summary + made-live MRs (DM digest, queued for approval) |
| 21:05 Fri | `WeeklyEvaluationPrefillJob` | Pre-fills the rubric for `/evaluations`; PM finalizes in the UI |

## Jobs reference

Jobs are TypeScript classes in `src/jobs/`, auto-loaded from `ENABLED_JOBS`. Each class declares `name`, `schedule` (cron, in `SCHEDULER_TZ`), and `description`. A run-once CLI exists for every job (no scheduler, no live WhatsApp socket — useful for backfills, debugging, and one-off regenerations):

```bash
npm run job <JobClassName>
# examples
npm run job SyncProductSheetJob
npm run job MorningBacklogDigestJob
npm run job DailyMemberSummaryJob -- --date=2026-05-06   # job-specific flags
npm run job WeeklyTeamSummaryJob   -- --week=2026-04-27  # Monday of target week
```

Notes on CLI runs:
- The job runs end-to-end against the real DB, real Sheets/GitLab/Gemini.
- `inboundService` is undefined under the CLI, so jobs that need to send WhatsApp messages either queue them to `outbound_queue` (preferred) or skip cleanly. Group-membership validation in `EodKickoffJob` is also skipped.
- The runner forces the job into `ENABLED_JOBS` for this invocation, so you don't have to toggle it on permanently to test it.

| Job | Schedule | What it does |
|---|---|---|
| `ClassifyWaInboxJob` | `0 * * * *` | Hourly: classify monitored-group messages into backlog tasks / connects / updates / status-checks. Pre-clusters consecutive same-sender messages within 3 min. Vision fallback for low-confidence image-only clusters. |
| `SyncProductSheetJob` | `0 * * * 1-5` | Hourly weekdays: pull open product-sheet rows into `backlog_items source=sheet`. Scrapes any cell value for gitlab MR URLs and links to the matching gitlab item. |
| `SyncGitlabMrsJob` | `* * * * 1-5` | Every minute weekdays: pull open MRs targeting staging/prod into `backlog_items source=gitlab`. LLM-fuzzy-matches new MRs against open sheet/wa_task items. Captures merged MRs into `gitlab_merged_log`. |
| `UnrepliedMentionsJob` | `*/15 * * * 1-5` | Every 15 min weekdays: resolve mentions that were since replied to; surface mentions older than `MENTION_REPLY_SLA_HOURS` working hours. |
| `MorningEodCatchupJob` | `0 8 * * 2-5` | 08:00 Tue–Fri: DM Sid the late EOD replies that arrived after yesterday's aggregate post. |
| `MorningBacklogDigestJob` | `0 9 * * 1-5` | 09:00 weekdays: DM Sid the morning backlog digest. |
| `MorningTasklistReminderJob` | `0 12 * * 1-5` | 12:00 weekdays: draft ONE group nudge tagging members who haven't shared. Sid picks the final recipient set in the approval UI. |
| `EodKickoffJob` | `0 19 * * 1-5` | 19:00 weekdays: queue EOD prompts. Members bucketed by `eodChannel` (DM or group); members missing from a configured group fall back to DM. |
| `EodAggregateJob` | `0 20 * * 1-5` | 20:00 weekdays: parse each member's raw EOD reply, compare vs morning plan, queue group post for approval, auto-DM Sid the breakdown. |
| `DailyMemberSummaryJob` | `30 20 * * 1-5` | 20:30 weekdays: per-member day recap from tasklist + EOD + self-updates + MR/sheet activity. `--date=YYYY-MM-DD` flag regenerates any past day. |
| `WeeklyTeamSummaryJob` | `0 21 * * 5` | 21:00 Fri: per-member weekly summary + team-level summary + made-live MRs. Queues a DM digest for approval. `--week=YYYY-MM-DD` (Monday) overrides. |
| `WeeklyEvaluationPrefillJob` | `5 21 * * 5` | 21:05 Fri: pre-fill the weekly evaluation rubric for each member from raw signals. PM edits + finalizes in `/evaluations`. Once a row's `saved_at` is set, this job leaves it alone. |
| `SuggestFeaturesJob` | `0 3 * * *` | 03:00 daily: cluster orphan backlog items into proposed features (suggestions only — accept/reject in `/backlog`). |
| `PruneMessagesJob` | `0 3 * * *` | 03:00 daily: delete messages older than `MESSAGE_RETENTION_DAYS`. |

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
