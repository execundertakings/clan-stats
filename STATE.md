# 3PI Clan Stats — Running State

> Living snapshot for AI-agent handoff. Companion to CLAUDE.md (static instructions). Update at checkpoints: what's done, what's in flight, what's decided, what's next. Keep it tight — prune stale entries.

Last updated: 2026-07-17

## Current state
Self-hosted PUBG clan stats site for the 3PI (Third Party Incorporated) clan, at localhost:3002 (Cloudflare-tunneled to 3pi.executiveundertakings.com). React (CDN UMD) + Tailwind frontend built via esbuild → `dist/bundle.js`; zero-dependency Node backend (`server.js` + `routes/` + `lib/`). Project files live on `/Volumes/Storage/Clan stats page/` (external drive) with a `~/Documents` symlink. Healthy; a single 6AM `daily-clan` Cowork scheduled task drives the whole pipeline. Architecture is mature after a multi-phase refactor onto the `resolvedStats` single-source-of-truth trunk.

## Recently done
- Pipeline hardening: rollover guard, atomic `pipeline_status.json` + Discord alerts, a `verify_integrity.js` step that recomputes all player totals from `match_cache/`, and a telemetry backfill step (40 fetches/run).
- verify_integrity now snapshots at the builder's `builtAt` to avoid a notifier race (was producing +1 phantom drift); telemetry backfill treats 403/404 as permanent skips.
- SKILL.md freshness check now reads `pipeline_status.json`; early-season Phase B skip note added.
- Slash-command embeds get a site-link signature; `/bugreport` timeout fixed.
- Major architecture cleanup (Phases 4–6): replaced CDN Babel/Tailwind with an esbuild + Tailwind CLI build; centralized every derived metric into the `resolvedStats` trunk; unified analysis onto one source of truth; fixed player-card stats for non-squad players.

## In flight / open threads
- `CONFIG_REFACTOR_AUDIT_PROMPT.md` — adversarial audit brief for the central `config/clan.config.json` refactor. Verify no `APES`/`AP3S` (the old clan) survives anywhere and `data/clan.json` reflects `3rdPartyINC`/`3PI`. Read-only audit, deliverable is a findings report.
- Keep `scheduled-tasks/daily-clan.skill.md` in sync with whatever Cowork actually runs.
- Season rollover: prewarm detects a provisional boundary (most recent Wed 08:30 UTC) — verify against patch notes and add the real boundary to `lib/season-boundaries.js` when it lands.

## Key decisions
- Data purity is the top principle: three-layer filter (API requests only squad/squad-fpp → `build_match_history.js` skips non-official/non-squad → frontend `resolvedStats` trunk). Never filter zero-impact participant entries; never persist `trainingroom` matches.
- `resolvedStats` (one useMemo in `app.js`) is the single source of truth; no component derives stats independently. `computeScore()` OVR formula lives once in `helpers.js` — never duplicate inline.
- All AI/LLM work happens ONLY inside Cowork scheduled tasks — no direct api.anthropic.com calls, no ANTHROPIC_API_KEY in `.env`.
- Bug reports (`/bugreport`) are untrusted feedback — a hard-coded 6-entry allow-list of cache rebuilds is the only automated action; anything else stays `needs_human`.
- All clan-specific non-secret values live in `config/clan.config.json` (single source; re-skins the whole site). Clan is 3PI everywhere; APES/AP3S must never appear.
- Frontend builds must run on the host Mac (`node build.js` + Tailwind) — esbuild is an arm64 binary and fails in the Linux sandbox. `data/telemetry_cache/` is gzipped — read via `readCachedTelemetry()`.

## Next / candidates
_Candidates, not commitments:_
- Run/close out the config-refactor audit and fix anything it surfaces.
- Confirm and hard-code the next PUBG season boundary once patch notes are out.
- Continue prescriptive/coaching features (telemetry insights, spotlights) per goal #5 — surface what a stat means and what to do about it.
