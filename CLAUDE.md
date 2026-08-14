# 3PI Clan Stats — Project Context for Claude

## What this is

A self-hosted PUBG clan stats website for the **3PI** (Third Party Incorporated) clan on PC. Pulls data from the official PUBG API and displays it in a dark-themed, interactive single-page app. Runs locally at **localhost:3002** on Greg's Mac. **The project files live on `/Volumes/Storage/Clan stats page/`** (external drive) with a symlink at `~/Documents/Clan stats page` so all scripts, launchd agents, and Cowork tasks use the original path without change. and is exposed publicly via a Cloudflare tunnel at **https://3pi.executiveundertakings.com** for the clan to access. Use the public URL in any shared Discord posts or external links — never `localhost:3002` in messages that leave the LAN.

---

## Project goals

1. **Accuracy** — Only official FPP + TPP quad squad games count. Data is filtered at every layer of the stack.
2. **Consistency** — A single source of truth (`resolvedStats`) feeds all UI. Stats never diverge between tabs.
3. **Historical tracking** — Clan-wide records, season archives, milestones, automated weekly Discord digests.
4. **Squad intelligence** — Squad chemistry, landing heatmaps, weapon breakdowns.
5. **Actionable improvement** — The site should surface what's working and what isn't, for both the clan as a whole and for individual players, so members have concrete direction on how to improve. Features should be **prescriptive**, not just descriptive. Don't just show a stat — show what it means and what to do about it.

---

## ⚠️ AI / LLM features — scheduled tasks only, NEVER direct API calls

**Rule:** Every AI- or LLM-driven feature in this project is implemented through a **Cowork scheduled task**. Claude does the synthesis when the task runs. There are **no direct calls to api.anthropic.com**, no `ANTHROPIC_API_KEY` in `.env`, no `lib/anthropic.js`-style HTTP clients.

This applies to anything that needs LLM reasoning: spotlight insights, weekly summaries, narrative match recaps, anything generative.

**Architecture pattern for an AI-driven feature:**

1. **Deterministic data prep** lives in `scripts/*.js`. These scripts are pure Node — they read caches, summarize them, and emit a tight JSON payload to stdout (or a tmp file). No network calls except to the PUBG API and Discord.
2. **A Cowork scheduled task** (configured in the Cowork UI, with its instructions kept under `scheduled-tasks/*.skill.md` for version control) runs the prep script, reads the prepared input, performs the LLM synthesis as Claude executing the task, and writes the output JSON to `data/`.
3. **The backend** serves the resulting cache file via a plain GET endpoint — server-side code never invokes an LLM.
4. **The frontend** fetches the cache file and renders it. It never knows the data came from an LLM.

This split means: if the scheduled task hasn't run yet, the data is simply absent (the endpoint 404s, the UI shows a skeleton or fallback). It is never regenerated on a request, never tied to a user action, and never blocks the deterministic data pipeline.

**Why this rule exists:** API keys would have to live somewhere on Greg's Mac and be rotated; scheduled-task LLM calls are billed and observed centrally through Cowork; and confining LLM use to a known set of tasks keeps cost, latency, and failure modes predictable.

**If you find yourself reaching for `https.request` to `api.anthropic.com`, stop.** Move that work into a scheduled-task `SKILL.md` instead.

---

## Stack

### Frontend
- **React** (UMD global, loaded via CDN in `index.html`) — no JSX pre-processor at dev time
- **Tailwind CSS** — utility classes, config in `tailwind.config.js`
- **esbuild** — build step only (concatenates + transpiles JSX → JS, writes `dist/bundle.js`)
- **No bundler, no npm build step for development** — edit `js/*.js`, run `node build.js && npx tailwindcss ...` to rebuild

### Backend
- **Node.js only** — zero npm runtime dependencies; all pure built-ins (`http`, `fs`, `path`, `child_process`)
- Entry: `server.js` → listens on port 3002 (override with `PUBG_PORT` env var)
- Routes split into `routes/` modules; shared lib in `lib/`

### Data
All JSON files live in `data/`:
- `data/members.json` — clan roster (accountId + name + optional discordId)
- `data/stats_cache.json` — raw PUBG API season stats (full object per player)
- `data/match_history_cache.json` — official-only, squad-only match-derived stats (authoritative source for counts/totals)
- `data/match_cache/` — per-match JSON files (immutable; never re-fetched)
- `data/weapon_cache.json`, `data/squad_stats_cache.json`, `data/landing_cache.json` — feature-specific caches
- `data/milestones_cache.json`, `data/notified.json` — milestone tracking
- `data/records.json` — all-time clan records
- `data/seasons/` — archived season snapshots
- `data/ai_insights_cache.json` — spotlight cards written by the `ai-spotlights` scheduled task (see "Companion task" below)
- `data/ai_insights_history.json` — rolling 60-day log of past spotlight ids/titles, used by `summarize_for_ai.js` for anti-repetition
- `data/telemetry_insights_cache.json` — deterministic telemetry-derived coaching cards (rotation, fights, spacing, contest, clutch, etc.) built from cached official-match telemetry only
- `data/telemetry_cache/` — raw per-match telemetry, one file per matchId. **Stored as gzip-compressed JSON (`.json.gz`), not plain `.json`.** Always read via `readCachedTelemetry(matchId)` exported from `lib/telemetry.js` — never with raw `fs.readFileSync`. The function handles decompression and falls back to legacy `.json` if present. New files written by `getTelemetry()` are always `.json.gz`.
- `data/bug_reports.json` — user-submitted bug reports from `/bugreport` plus their triage status (see "Bug reports" below)

---

## Data purity — the three-layer filter

This is the most important architectural principle. Bad data (non-squad, non-official, API noise) is blocked at every layer:

### Layer 1 — API (`lib/pubg.js`)
Only two game modes are ever requested from the PUBG API: `squad-fpp` and `squad`. Solo, duo, arcade, event modes are never fetched. Both modes are batch-fetched in parallel and combined per player.

### Layer 2 — Match history cache (`scripts/build_match_history.js`)
When building `match_history_cache.json`, two hard filters apply to every match (single source of truth: `lib/match-filters.js`):
- Skip if `matchType !== 'official'` (removes casual/AI, custom, event, arcade, training games)
- Skip if `gameMode` doesn't include `'squad'` (removes solo/duo)

Only matches passing both filters are aggregated. `build_match_history.js` is the **only** writer of `match_history_cache.json`.

Two hard-won rules (see header comment in `lib/match-filters.js` for full rationale):
- **Never filter zero-impact participant entries** (0 kills / 0 damage / 0 DBNOs, died by player). Investigated 2026-06-12: telemetry confirms these are legitimate passive games, they're 19.4% of all entries, and PUBG's official API counts them — filtering would diverge from API truth.
- **`trainingroom` matches are never written to `match_cache/`** (`lib/pubg.js` `NEVER_PERSIST_MATCH_TYPES`). Their IDs go into `data/skipped_matches.json` so `fetch_recent_matches.js` doesn't re-fetch them every run.

### Layer 3 — Frontend trunk (`js/app.js` → `resolvedStats`)
All raw data converges into one pre-computed `resolvedStats` useMemo. No component derives stats independently.

---

## Build pipeline

```bash
# Full rebuild (JS + CSS) — must run on the host Mac, NOT in sandbox
cd "/Users/jean/Documents/projects/Clan stats page"
node build.js && npx tailwindcss -i ./src/styles.css -o ./dist/styles.css --minify
```

**Critical:** `node_modules` contains a macOS arm64 `esbuild` binary. The sandbox is Linux — `node build.js` will fail there. Always run builds via `mcp__Macos__Shell` on the host machine.

`build.js` concatenates these modules in order, then esbuild-transforms the whole thing:
```
helpers.js → components.js → overview.js → leaderboard.js →
players.js → settings.js → trends.js → heatmap.js → secret-keys.js → app.js
```
All JS modules share a single global scope after concatenation — no ES module imports between them.

---

## Frontend architecture

### Golden rule: `resolvedStats` is the single source of truth

`app.js` contains one `useMemo` called **`resolvedStats`** that pre-computes every derived metric for every player. **No component may derive stats independently.** All leaves read from this trunk.

```
resolvedStats (app.js useMemo)
├── s                — official-match current-season totals from match_history_cache
├── lt               — pre-resolved lifetime stats
├── raw counts       — games, kills, wins, top10, losses, hs, assists, dmg, timeSurv
├── telemetry branch — boosts, heals, revives, roadKills, vehicleDestroys, longestKill
├── history branch   — days, recent, form, mapStats, coverage
└── derived          — kdVal, winRate, top10Rate, closeOutRate, nearMissRate, hsRate,
                       avgDmg, avgSurvival, killsPg, assistsPg, boostsPg, healsPg,
                       revivesPg, dmgPerKill, score
```

`resolvedStats` is passed to every tab component as a prop. Components destructure what they need — they never call `getStats()` or `extractStats()` directly.

### Current-season truth branches
- `s` = `getStats(accountId, season, historyData)` — the official-match current-season truth trunk from `match_history_cache.json`
- Telemetry-only fields like revives, heals, boosts, road kills, vehicle destroys, and longest kill come from the telemetry-derived branch (`weapon_cache.json`) only when applicable-match capture exists
- Rule: if the telemetry branch is missing, those fields stay `0`. We do **not** fall back to broader PUBG season aggregates for current-season truth

### `computeScore()` — shared OVR formula
Defined in `helpers.js`, called once from `app.js` (trunk). Components are normalised against a clan-elite benchmark — a player who hits every benchmark lands at ~100. No clamping, so outliers can exceed.
```js
function computeScore({ kdVal, avgDmg, hsRate, top10Rate, winRate, closeOutRate, assistsPg, revivesPg, games }) {
  const combat   = (kdVal     / 2.0)  * 22       // K/D 2.0 = elite
                 + (avgDmg    / 220)  * 11       // 220 dmg/game = elite
                 + (hsRate    / 0.30) * 5;       // 30% HS = elite
  const survival = (top10Rate / 0.55) * 14;      // 55% top-10 rate = elite
  const outcomes = (winRate      / 0.12) * 21    // 12% win rate = elite
                 + (closeOutRate / 0.22) * 10;   // 22% close-out = elite
  const support  = (assistsPg / 0.70) * 20       // 0.70 assists/g = elite
                 + (revivesPg / 0.45) * 6;       // 0.45 revives/g = elite (telemetry)
  const volume   = Math.min((games || 0) / 250, 1) * 6; // commitment bonus, caps at 250 games
  return Math.round(combat + survival + outcomes + support + volume);
}
```
**Never duplicate this formula inline.** If you change weights or benchmarks, update the tooltip in `leaderboard.js` to match.

### Tab components
| File | Tab | What it reads |
|---|---|---|
| `overview.js` | Overview | `resolvedStats` totals/bests |
| `leaderboard.js` | Leaderboard | `resolvedStats` (current season); separate API call for archive seasons (approved exception) |
| `players.js` | Players | `resolvedStats` — each `entry` object passed whole to `PlayerCard` and `PlayerProfileModal` |
| `trends.js` | Trends | `resolvedStats` |
| `heatmap.js` | Heatmap | `heatmapData` (separate state — not stats) |
| `settings.js` | Settings | server state |
| `secret-keys.js` | Secret Keys | API key management |

`PlayerCard` and `PlayerProfileModal` take the **whole entry object** as a prop — not cherry-picked individual fields. Adding a new trunk stat requires no call-site changes.

### `helpers.js` — global utilities
Available to all modules (global scope after concatenation):
- `computeScore({ kdVal, avgDmg, hsRate, top10Rate, winRate, closeOutRate, assistsPg, revivesPg, games })` — OVR composite (combat + survival + outcomes + support + volume)
- `computeAnalysisFromStats(resolvedStats)` — clan-wide analysis (reads from trunk)
- `extractStats(seasonData, mode)` — FPP/TPP detection, aggregates modes if needed
- `getStats(accountId, season, historyData)` — cache-preferring stat resolver
- `extractLifetimeStats(lifetime)` — normalises lifetime API object
- Formatting: `kd()`, `pct()`, `round()`, `num()`, `playerTier()`

### When adding a new stat to the frontend
1. Add raw field to `resolvedStats` in `app.js` (read from the official-match trunk or a deterministic derived branch as appropriate)
2. Add any derived rate/metric there too
3. Destructure from `entry` in the relevant component — no other changes needed

---

## Discord Gateway — auto-add/remove via `@Memo` role

`lib/discord-gateway.js` maintains a persistent WebSocket connection to the Discord Gateway. It watches for two events:

- **GUILD_MEMBER_UPDATE** — when someone gains or loses the `@Memo` role:
  - Role **added** → bot DMs them instructions to run `/register pubg_name:TheirName`
  - Role **removed** → bot removes them from `members.json` (by `discordId`) and posts to the Discord webhook
- **GUILD_MEMBER_REMOVE** — when someone leaves the server → same removal logic

The `/register` slash command (handled in `routes/bot.js`) resolves the PUBG username via the API, adds the player to `members.json` with their `discordId` field, and busts the stats cache.

**Prerequisite:** the **Server Members** privileged intent must be enabled in the Discord Developer Portal (Bot → Privileged Gateway Intents). The role name is configured in `config/clan.config.json` and can be overridden with `DISCORD_CLAN_ROLE`. **This server uses `Memo`**. There is no `bonobo` role on the live guild — that name was the old server's role.

The Gateway starts automatically with the server. Status is available at `GET /api/gateway/status`.

---

## Backend API routes

| Method | Path | Handler | Description |
|---|---|---|---|
| GET | `/api/health` | server.js | Liveness check |
| POST | `/api/admin/verify` | server.js | Verify hidden Settings password |
| POST | `/api/cache/clear` | server.js | Clear in-memory/disk caches (admin) |
| POST | `/api/prewarm` | server.js | Trigger async stat refresh for all members (admin; direct loopback allowed for scheduled task) |
| GET | `/api/prewarm/status` | server.js | Poll prewarm progress |
| GET | `/api/members` | routes/players.js | Clan roster |
| POST | `/api/members` | routes/players.js | Add a clan member (admin) |
| DELETE | `/api/members/:name` | routes/players.js | Remove a clan member (admin) |
| GET | `/api/clan/stats` | routes/players.js | Current season stats for all members (main endpoint; 2h disk cache) |
| POST | `/api/clan/discover` | routes/players.js | Discover clan by player name (admin) |
| POST | `/api/members/bulk` | routes/players.js | Bulk import members (admin) |
| GET | `/api/seasons` | routes/seasons.js | List available seasons |
| GET | `/api/seasons/:id` | routes/seasons.js | Season stats for specific season |
| GET | `/api/match-history` | routes/matches.js | Match history cache |
| GET | `/api/weapons` | server.js | Weapon stats cache |
| GET | `/api/squad-stats` | server.js | Squad pairing stats |
| GET | `/api/lifetime` | server.js | Lifetime stats for all members |
| GET | `/api/heatmap` | server.js | Landing heatmap data |
| GET | `/api/telemetry-insights` | server.js | Telemetry-derived coaching cards |
| POST | `/interactions` | routes/bot.js | Discord slash command webhook |
| GET | `/api/gateway/status` | server.js | Discord Gateway connection status |
| GET | `/api/notifier/status` | server.js | Notifier status (admin) |
| POST | `/api/notifier/scan` | server.js | Trigger manual notifier scan (admin) |

**Removed (2026-06-10):** `/api/trends` — trends are computed client-side from `resolvedStats`; its `trends_cache.json` was dead since April. Note `/api/analysis` is NOT deprecated: it serves `analysis_cache.json` (the AI per-player profiles written by the weekly task's Phase B5) and is consumed by `app.js` for player-card profiles.

**Pipeline health:** `data/pipeline_status.json` is written atomically at the end of every `daily_clan.js` run (date, per-step results, `allOk`). The Saturday 6AM Cowork task's freshness check reads it; any failed step also posts a Discord alert. The pipeline includes a `Verify Data Integrity` step (`scripts/verify_integrity.js`) that exactly recomputes all player totals from `match_cache/` and schema-validates the AI caches, and a `Backfill Telemetry` step (`scripts/backfill_telemetry.js`, 40 fetches/run) that converges telemetry coverage. Season rollovers are detected by the prewarm (provisional boundary = most recent Wednesday 08:30 UTC) and announced on Discord — verify against patch notes and add the real boundary to `lib/season-boundaries.js`.

**Admin auth:** Hidden Settings actions are server-protected, not just UI-gated. The frontend verifies through `POST /api/admin/verify`, then sends `X-Admin-Password` for admin actions and admin-only status reads. The server compares against `ADMIN_PASSWORD_HASH` (SHA-256 hex) from process env or `.env`, with a legacy fallback only for continuity. Rotate this hash if the old frontend bundle may have exposed the password hash.

**PUBG proxy guard:** Legacy single-player lookup/stat endpoints (`/api/players/lookup`, `/api/players/season`, `/api/players/ranked`, `/api/players/lifetime`) are admin-only. `/api/matches/player` is public only for current clan member account IDs and requires admin for `bust=1` or non-member account IDs; `/api/matches/:matchId` is admin-only.

---

## Bug reports — `/bugreport` and the daily triage phase

Clan members with the `@Memo` role can submit observations via the Discord slash command `/bugreport <text>`. Reports are user feedback, **not authoritative truth** — the architecture is designed so that user text cannot directly change records, members, code, or fire external actions.

**Storage:** `data/bug_reports.json` (atomic writes via `lib/bug-reports.js`). Each report has an ID `br_<unix>_<6hex>`, sanitised text (≤2000 chars, control/zero-width chars stripped), submitter discordId, roster match, triage status, and any allow-list action that ran.

**Submission limits (enforced in `lib/bug-reports.js`):**
- Membership role (`Memo`) required (gated in `routes/bot.js` via `DISCORD_CLAN_ROLE`)
- 10 reports per user per rolling 24h window
- 10–2000 chars after sanitisation
- Identical text from same user within 24h is rejected as a duplicate
- Prompt-injection patterns (e.g. "ignore previous", "system:", `<|im_start|>`, `[INST]`, role-play directives) are accepted-and-tagged so the triage step can reject them transparently rather than silently dropping submissions

**Submitter UX:**
- Ephemeral confirmation in Discord with the report ID
- DM receipt with the full submission and the report ID
- `/bugreports` lists their own reports and triage status

**Triage:** The `daily-clan` scheduled task includes Phase D, which reads open reports via `scripts/summarize_bug_reports.js`, applies the security scope in `scheduled-tasks/daily-clan.skill.md`, and invokes `scripts/apply_bug_report_action.js` for at most three allow-listed actions per run. The allow-list is hard-coded in that script (six entries — all are cache rebuilds or per-entity invalidations that re-derive from deterministic upstream sources). Anything outside the list is refused by the script itself, not just by instructions.

**What bug reports CAN'T do, ever:**
- Edit code, configs, or `.env`
- Add new features or commands
- Modify `data/members.json`, `data/records.json`, `data/milestones_cache.json`, `data/notified.json`
- Trigger Discord posts, DMs to other users, or arbitrary HTTP requests from their content
- Expand the allow-list

If a report needs a code change or a roster change, it stays `needs_human` for Greg to handle manually.

---

## Automation — daily pipeline + weekly Cowork synthesis

The deterministic pipeline runs from launchd at **5:00 AM daily** (`com.greg.clan-daily-pipeline`). A separate Cowork scheduled task runs at **6:00 AM Saturdays** for AI synthesis and housekeeping. Its version-controlled instructions live at `scheduled-tasks/daily-clan.skill.md` and must stay in sync with the live Cowork task.

### Phase A — deterministic Node pipeline (`scripts/daily_clan.js`)

1. **Refresh PUBG Stats** — hits `/api/prewarm`, polls until done (~7 min for 29 players)
2. **Hydrate Recent Matches** — `fetch_recent_matches.js` → backfills any missing recent match JSON into `data/match_cache/`
3. **Fetch Weapon Stats** — `fetch_weapon_stats.js` → `data/weapon_cache.json`
4. **Build Match History** — `build_match_history.js` → `data/match_history_cache.json`
5. **Build Squad Stats** — `build_squad_stats.js` → `data/squad_stats_cache.json`
6. **Build Landing Heatmap** — `build_landing_heatmap.js` → `data/landing_cache.json`
7. **Build Telemetry Playbook** — `build_telemetry_insights.js` → `data/telemetry_insights_cache.json`
8. **Check Milestones** — `check_milestones.js` → posts to Discord if new milestones
9. **Recover Missed Announcements** — `recover_missed_announcements.js` → if the live notifier swallowed announce-able games during an outage (flood guard / no-webhook), posts ONE consolidated catch-up digest. Idempotent; seeds silently on first run via `data/recovery_state.json`; tracks announced matches in `notified._posted`. Added 2026-06-16 after a 3.5-day notifier swallow.
10. **Check Notifier Health** — reads `data/notifier_health.json` (written by `lib/notifier.js` each scan) and posts a Discord warning if the notifier has no webhook or hasn't scanned in >20 min — so a posting outage can't hide behind a still-fresh `match_history`.
11. **Weekly Discord Digest** *(Sundays only)* — `build_weekly_digest.js` → posts summary to Discord

**Drive-offline alerting:** the off-drive launcher (`~/Library/Application Support/clan-stats/launch-daily-pipeline.sh`) alerts via Discord (cached webhook), macOS notification, **and iMessage** (`alert_recipient.txt`) when the Storage drive is unmounted at run time or disconnects mid-run. The pipeline launchd agent also has `StartOnMount` (catches a late drive mount), guarded by a once-per-day success marker + pid lock so it can't double-run.

`compute_trends.js` and `compute_analysis.js` have been removed — trends/analysis are computed client-side from `resolvedStats`.

### Phase B — AI spotlight synthesis (Claude, in-task)

After confirming Saturday's Phase A pipeline completed successfully, Claude (executing the weekly Cowork task) synthesises three "spotlight" insight cards for the Trends tab:

1. Run `scripts/summarize_for_ai.js` → emits a compact JSON summary to stdout (player snapshots, clan aggregates, top squad pairs/trios, recent milestones, last 30 days of past spotlight themes for anti-repetition).
2. Claude reads the summary and writes 3 cards to `data/ai_insights_cache.json`.
3. Appends a record to `data/ai_insights_history.json` so the next run knows what themes to avoid.

Per the architecture rule above, this synthesis happens **only inside the scheduled-task run** — never by a Node script calling an external API. The full instructions live in `scheduled-tasks/daily-clan.skill.md`.

The frontend reads the resulting cache via `GET /api/ai-insights` and renders the cards alongside the deterministic anchors (`efficiency_killer`, `dark_horse_winners`, `closeout_crisis`, `squad_carry`) in the Trends tab's AI Insights section.

---

## Caching strategy

| Layer | TTL | Notes |
|---|---|---|
| Disk — match files | Forever | Immutable; never re-fetched |
| Disk — season stats | 2 hours | Served immediately on cache hit |
| In-memory — player stats | 25 min | Per-player per-mode |
| In-memory — player cache | 15 min | Match ID list |

Fallback chain on rate limit: fresh in-memory → disk cache (any age) → stale in-memory → error.

All PUBG requests share a cross-process sliding-window limiter (`lib/pubg-rate-limiter.js`) capped at 9 RPM, leaving one request of headroom under PUBG's 10 RPM free-tier limit. Retries also reacquire a shared slot.

---

## Clan configuration — `config/clan.config.json` (single source of truth)

All clan-specific, non-secret values live in **`config/clan.config.json`** (see `config/README.md` for field docs). Edit that one file + restart to re-skin the whole site/bot for a different clan — no code changes. Loaded and validated by `loadClanConfig()` in `lib/config.js`; the non-secret subset is exposed to the frontend via `GET /api/config` and injected into `index.html` as `window.__CLAN_CONFIG__` (read in the bundle as the global `CLAN`). The PWA `/manifest.json` is generated from it too.

What's in it: clan name/shortName/tag/emoji/member-noun/boot copy, `site.publicUrl` + port, and Discord wiring (`guildId`, `membershipRole`, `adminUserIds`, `gracePeriodDays`, `botUserAgent`, `pinnedInfo` channel/message IDs).

**Identity note:** the clan is **3PI / Third Party Incorporated** everywhere — in-game (PUBG clan name `3rdPartyINC`, tag `3PI`, `data/clan.json`) and as the public brand (`clan.config.json`). **`APES` / `AP3S` is an OLD clan the group left** (different `clanId`); it must never appear in any copy. `data/clan.json` held stale `APES` data until 2026-06-01 — re-synced via `POST /api/clan/discover` with a current member as seed. AI copy pulls the brand from `clanIdentity` (fed by `summarize_for_ai.js` from config); the daily SKILL.md naming rule guards against the old `APES` name leaking back in.

`guildId` / `membershipRole` / `adminUserIds` can still be overridden by `DISCORD_GUILD_ID` / `DISCORD_CLAN_ROLE` / `CLAN_ADMIN_DISCORD_IDS` when set in the process environment or `.env`, but config is the canonical source. Empty override values are ignored.

## Environment / secrets

Secrets stay in `.env` at project root (not committed) — kept separate from clan config:
- `PUBG_API_KEY` — PUBG developer API key
- `DISCORD_WEBHOOK_URL` — for milestone + weekly digest posts
- `DISCORD_BOT_TOKEN`, `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY` — for slash command bot + Gateway
- `PUBG_PORT` — optional port override (default 3002)
- `ADMIN_PASSWORD_HASH` — optional SHA-256 hex hash for the hidden Settings admin password
- (optional overrides) `DISCORD_GUILD_ID`, `DISCORD_CLAN_ROLE`, `CLAN_ADMIN_DISCORD_IDS` — otherwise sourced from `config/clan.config.json`

---

## Development workflow

1. Edit files in `js/` (frontend) or `server.js` / `lib/` / `routes/` / `scripts/` (backend)
2. Frontend changes → rebuild: run `node build.js` on host Mac (via `mcp__Macos__Shell`)
3. Backend changes → restart server (or it hot-reads most JSON data on each request)
4. View at `http://localhost:3002`
5. Run `npm test` for syntax and unit tests; run `npm run test:live` while the server is up for the API smoke sweep

---

## Design language
- Dark background: `#070b12`
- Font: Inter
- Accent colors: blue (`#60a5fa`), yellow (`#facc15`), green (`#34d399`), red (`#f87171`)
- Layout: left sidebar desktop / bottom nav mobile (consistent with Greg's other apps)
