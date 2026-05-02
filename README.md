# TPIX

A personal multi-agent build system. You describe an idea in plain language; a
Boss agent runs a Q&A until requirements are clear, gets your approval on a
plan via Telegram, and dispatches work to 24 role-specialised AI agents
(Researcher, Architect, Backend, Frontend, Tester, Ethical Hacker, Privacy
Officer, Bias Auditor, Memory Keeper, …). Online work goes through your Claude
Code subscription; offline work falls back to local Ollama models. Boss decides
the per-task model based on per-tier headroom (your reserve always preserved).

## What it does end-to-end

1. You send `/new <idea>` to your Telegram bot.
2. Boss runs a clarifying Q&A (CLAUDE.md Step 0: problem / user / output).
3. Boss generates a plan and asks you to approve via inline buttons.
4. Once approved, the dispatcher allocates models per task (Boss-driven), runs
   independent tasks in parallel, dependent tasks in series, and routes each
   call through the LLM router (Claude online, Ollama offline).
5. Reviewers (Code Reviewer, Tester, Ethical Hacker, Privacy Officer, Bias
   Auditor, Performance Engineer) auto-run on relevant tasks and gate
   completion. Failed reviews requeue with critique appended (max 3 attempts).
6. Each completed batch auto-commits to `projects/<slug>/` and pushes to
   `origin/main`. User-prompts force-commit first so the GitHub state always
   precedes a question.
7. Memory Keeper distills each project into `memory/<slug>.md` for future
   relevance.

## Stack

- **Node 20+** (uses native `--env-file-if-exists`)
- **Fastify** (HTTP), **better-sqlite3** (state), **grammy** (Telegram bot),
  **simple-git** (Boss-managed commits), **execa** (claude CLI subprocess),
  **pino** (logs), **zod** (schema), **vitest** (tests)
- **Claude Code CLI** (subscription) for the online brain
- **Ollama** (local) for offline fallback per role

## First-time setup

### 1. Install runtime
```bash
brew install ollama
brew install --cask tailscale          # only when you want phone access
ollama serve &                          # keep running in background
ollama pull llama3.2:3b                 # smallest, needed for smoke
ollama pull qwen2.5-coder:14b qwen2.5-coder:7b llama3.1:8b qwen2.5:7b
```

### 2. Authenticate
```bash
gh auth login                           # for git push
claude -p "say hi"                      # confirms Claude Code subscription is logged in
```

### 3. Telegram bot
1. In Telegram, message `@BotFather` → `/newbot` → name it → copy the token.
2. Message `@userinfobot` → `/start` → copy your numeric chat id.
3. Open your new bot, tap **Start** (Telegram requires user-initiated contact
   before the bot may send you messages).
4. `cp .env.example .env` and fill in:
   ```
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_USER_CHAT_ID=...
   ```

### 4. Install + smoke
```bash
pnpm install
pnpm test                               # all unit tests should pass
pnpm smoke:claude                       # real Claude round-trip
pnpm smoke:ollama                       # real Ollama round-trip
pnpm smoke:telegram                     # sends "TPIX online" to your phone
```

## Run

```bash
pnpm dev                                # dev mode with file-watch
# or
pnpm start                              # production mode wrapped in caffeinate
```

Once running:
- HTTP API at `http://0.0.0.0:7421` (also reachable over Tailscale)
- Telegram bot listens on long-polling — talk to it from any phone
- `GET /health` for status, `GET /roles` for the 24-role registry,
  `GET /projects` for state

## Telegram commands

| Command | What it does |
|---|---|
| `/start` | Show command list (bot replies with this menu) |
| `/new <idea>` | Create a project; Boss runs the Q&A |
| `/projects` | List recent projects; `*` marks active |
| `/status` | Active project state |
| `/budget` | Opus + Sonnet headroom, source, caps |
| `/cancel <id_prefix>` | Cancel a project |
| `/use <opus\|sonnet\|ollama\|auto>` | Manual model override on active project |
| `/sync <opus_pct> <sonnet_pct>` | Push real subscription usage (TTL 1h) |
| `/setcap <opus\|sonnet> <tokens>` | Set the period's token cap |
| `/period <YYYY-MM-DD> <length_days>` | Reset the accounting window |
| Free text | Continues active project Q&A |
| Inline buttons | Approve/Reject plans; resolve hard-stop escalations |

## Headroom math (per-tier)

The user's reserve is preserved by withholding subscription headroom early in
the period:

```
opus_reserve_pct   = days_remaining * 20%
opus_ceiling_pct   = max(0, 100 - opus_reserve_pct)
opus_headroom_pct  = max(0, opus_ceiling_pct - opus_used_pct)

sonnet_reserve_pct = days_remaining * 10%
sonnet_ceiling_pct = max(0, 100 - sonnet_reserve_pct)
sonnet_headroom_pct = max(0, sonnet_ceiling_pct - sonnet_used_pct)
```

Boss allocates models per task to stay under headroom. Tasks marked
`required_tier: opus|sonnet` hard-stop and ping you on Telegram if that tier
has zero headroom — you pick from `[Use Sonnet anyway]`, `[Use Ollama anyway]`,
`[Wait for headroom]`, `[Cancel task]`.

The system reads usage from this priority chain:
1. A recent `/sync` from you (within 1 hour)
2. The internal `tokens_log` counter, if you've set period caps via `/setcap`
3. Defaults to 0% used (full headroom — surfaced as `source: default` in `/budget`)

The `/account & usage…` slash command in Claude Code is a TUI menu and is not
pipeable in headless mode. To track real subscription usage, periodically open
Claude Code → `/account` → and `/sync` the percentages back to the bot.

## Run 24/7 on your Mac (launchd)

```bash
mkdir -p ~/Library/LaunchAgents
cp scripts/com.tpix.orchestrator.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.tpix.orchestrator.plist
launchctl start com.tpix.orchestrator
```

Logs land at `logs/tpix.{out,err}.log`. To stop / unload:

```bash
launchctl unload -w ~/Library/LaunchAgents/com.tpix.orchestrator.plist
```

## Repo layout

```
src/
  server.ts                # Fastify entrypoint, wires everything
  config.ts                # Zod-validated env-driven config
  logger.ts                # pino
  db.ts                    # SQLite + migration runner
  llm/
    claude.ts              # `claude -p` subprocess wrapper
    ollama.ts              # /api/generate HTTP client
    probe.ts               # Anthropic reachability probe (TCP, cached)
    router.ts              # Routes a (model, prompt) call to claude or ollama
  roles/
    registry.ts            # Loads + validates roles/*.yaml
  agents/
    boss.ts                # Q&A, allocateModels, watchdog, escalations
    planner.ts             # Plan JSON generation
    memory-keeper.ts       # Project memory distillation (Ollama)
  cost/
    headroom.ts            # Per-tier headroom + manual sync + caps
  repos/
    projects.ts, messages.ts, plans.ts, tasks.ts,
    settings.ts, usage.ts
  bot/
    telegram.ts            # grammy bot, long-polling, inline buttons
  reviewers.ts             # QA pipeline (code-reviewer, tester, ethical-hacker, ...)
  dispatcher.ts            # Task graph executor (parallel/serial)
  git.ts                   # Boss-managed commits + auto-push
  connectivity.ts          # 30s online/offline probe + Telegram toast
roles/
  *.yaml                   # 24 role configs (system_prompt, tier_hint, offline_model)
migrations/
  001_init.sql
scripts/
  smoke-claude.ts, smoke-ollama.ts, smoke-telegram.ts
  com.tpix.orchestrator.plist
projects/
  <slug>/                  # generated project workspaces (per-task commits)
memory/
  <slug>.md                # Memory Keeper distillations
data/
  tpix.sqlite              # state (gitignored)
```

## Security & privacy

- Runtime data stays on your Mac + phone. Accepted exceptions:
  - Anthropic Claude Code subscription (the brain)
  - Private GitHub `va-ada/TPIX` repo (orchestrator + project artifacts)
  - Telegram bot routing (you trust Telegram-the-carrier, not third-party
    snoopers)
- `.env` is gitignored. Bot allowlist locks all incoming Telegram chats to
  your `TELEGRAM_USER_CHAT_ID`.
- HTTP server binds `0.0.0.0:7421` — keep it on your Tailnet only; do NOT
  expose via Cloudflare Funnel / port-forward without adding auth.

## Troubleshooting

- **`claude -p` returns nothing** — your subscription session expired; run
  `claude` interactively once and accept the workspace prompt, then retry.
- **Ollama smoke fails** — `ollama serve` not running, or model not pulled.
- **Telegram smoke "chat not found"** — open your bot in Telegram and tap
  **Start** before running the smoke.
- **PNPM warns about ignored build scripts** — `pnpm rebuild better-sqlite3 esbuild`.
- **Git push fails** — `gh auth status` and re-login if expired.
