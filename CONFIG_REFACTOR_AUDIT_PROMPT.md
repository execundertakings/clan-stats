# Audit brief — central clan-config refactor (3PI stats site)

You are a meticulous, adversarial code reviewer. Your job is to audit a recently-completed
refactor on a self-hosted PUBG clan stats site and find bugs **before users hit them**. Be
skeptical. Read every changed line. Trace data flow end to end. Assume the previous author
made mistakes and it's your job to catch them. Do **not** rubber-stamp.

## Ground rules

- **Read-only / non-destructive.** You may run `node --check`, `grep`, load modules, hit the
  running server's HTTP endpoints, and do a frontend build **in a throwaway copy** if you must.
  Do **not** edit source files, do not change config, do not restart the production server
  unless you first confirm with the user. Your deliverable is a findings report, not a fix.
- **Verify, don't assume.** If you claim something works or is broken, back it with a command
  you ran, a file:line you read, or a reproduction. No hand-waving.
- The project root on disk is `/Volumes/Storage/Clan stats page/` (a symlink exists at
  `~/Documents/Clan stats page`). In the Linux shell sandbox it's mounted under
  `/sessions/.../mnt/Storage--Clan stats page/`. The host Mac runs the live server as launchd
  service `com.greg.clan-server` on `localhost:3002`. The frontend build (`node build.js` +
  Tailwind) must run on the **host** (esbuild is an arm64 binary; it fails in the Linux sandbox).

## What the refactor did (context)

All clan-specific, non-secret values were moved into a single new file
**`config/clan.config.json`**, loaded + validated by a new `loadClanConfig()` in `lib/config.js`.
Goal: re-skin the whole site/bot for a different clan by editing one file. Secrets stayed in
`.env`. Three env vars (`DISCORD_GUILD_ID`, `DISCORD_CLAN_ROLE`, `CLAN_ADMIN_DISCORD_IDS`) were
moved into the config and commented out of `.env` (still honored as overrides if set).

A second concern: the clan is **3PI / Third Party Incorporated** everywhere — in-game (PUBG clan
name `3rdPartyINC`, tag `3PI`) and as the public brand. **`APES` / `AP3S` is an OLD clan the
group left** (a different `clanId`). `data/clan.json` held stale `APES` data (synced 2026-04-12)
and was re-synced from the live PUBG API to `3rdPartyINC`/`3PI`. AI-generated copy had been
calling the clan "APES"; the refactor cleaned the caches and added rules so synthesis only ever
uses "3PI". When you audit, confirm no `APES`/`AP3S` survives anywhere except possibly historical
notes, and confirm `data/clan.json` reflects the current `3rdPartyINC`/`3PI` clan (NOT the old
one).

### Files changed (review all of these against `git diff`)
- `config/clan.config.json` (new), `config/README.md` (new)
- `lib/config.js` — `loadClanConfig`, `frontendClanConfig`, `validateClanConfig`, `_deepMerge`, defaults, TTL cache
- `server.js` — `serveIndex()` (token replace + `window.__CLAN_CONFIG__` injection), dynamic `/manifest.json`, `/api/config`, gateway startup now reads config
- `index.html` — `{{CLAN_TITLE}}`, `{{CLAN_NAME}}`, `{{CLAN_BOOT_TITLE}}`, `{{CLAN_BOOT_BODY}}` tokens
- `js/helpers.js` — `CLAN` global from `window.__CLAN_CONFIG__`
- `js/app.js`, `js/overview.js` — branding reads from `CLAN`
- `lib/discord.js` — User-Agent from config
- `lib/discord-gateway.js` — welcome DM, grace period, webhook text from config
- `lib/discord-interactions.js` — `TAG`/`NOUN`/`NOUNS`/`CLAN_NAME` consts, embed authors/footers
- `routes/bot.js` — admin IDs from config, `CTAG`/`CSHORT`, registration/bug-report strings
- `lib/notifier.js` — `NTAG`, embed authors, member-noun
- `scripts/register-commands.js` — `GUILD_ID` + command descriptions from config
- `scripts/check_milestones.js`, `scripts/build_weekly_digest.js` — embed authors from config
- `scripts/post_insights_summary.js` — `SITE_URL` from config
- `scripts/summarize_for_ai.js` — emits `clanIdentity` + a `notes.naming` rule
- `scripts/build_telemetry_insights.js` — rebrand pass over output before write
- `.env` — three keys commented out
- `CLAUDE.md` / `AGENTS.md` — config section + dual-identity note
- `scheduled-tasks/daily-clan.skill.md` and the runtime `~/Documents/Claude/Scheduled/apes-daily-clan/SKILL.md` — naming rule added; pinned-message IDs

## Specific things to scrutinize (high-suspicion list)

Work through each of these and prove it's correct or file a finding:

1. **Stale-config / restart coupling.** Many modules capture config into a *module-level const
   at require time* (`TAG`, `GRACE_PERIOD_DAYS` in discord-gateway, `CLAN`/`CTAG`/`CSHORT` in
   bot.js, `_C`/`NOUN` in discord-interactions, `NTAG` in notifier, `MTAG`, `_WC`, `_RC`,
   `SHORT`). Meanwhile `loadClanConfig()` has a 60s TTL cache implying hot-reload. Is there an
   inconsistency where editing `clan.config.json` updates some strings live but not others until
   restart? Does anything actually depend on hot-reload? Confirm the documented "edit + restart"
   story is the only supported one, and that nothing is half-cached in a confusing way.

2. **`_deepMerge` correctness.** Trace it for: array fields (`adminUserIds`), nested objects
   (`discord.pinnedInfo`), a config file that omits a whole section, a config file that omits one
   leaf, and a malformed/empty config file. Does every path fall back to `CLAN_DEFAULTS`
   sensibly? Can it throw? Can it mutate `CLAN_DEFAULTS` by reference (shared-object aliasing
   across calls)?

3. **Env-override layering.** With the three keys commented out in `.env`, confirm the live
   values come from the JSON. Then confirm that *uncommenting* an env override actually wins.
   Check empty-string env values (`DISCORD_GUILD_ID=`) don't blank out the config. Confirm no
   other code path still reads `env.DISCORD_GUILD_ID` / `env.DISCORD_CLAN_ROLE` /
   `env.CLAN_ADMIN_DISCORD_IDS` directly (grep the whole tree).

4. **`index.html` injection + escaping.** `serveIndex()` does string `.replace()` of tokens and
   injects `<script>window.__CLAN_CONFIG__ = ${JSON.stringify(fe)}</script>` before `</head>`.
   Check: (a) what happens if a config value contains `</script>` or HTML-special chars — can it
   break out of the script tag or the page? (b) `{{CLAN_*}}` tokens are HTML-escaped via
   `escapeHtml` — does that double-escape anything or mangle the em-dash / emoji? (c) is there
   exactly one `</head>`? (d) confirm no `{{CLAN_*}}` token leaks to the client (curl `/`), and
   that the static on-disk `index.html` is never served raw (which would show literal tokens).

5. **Concatenation order / `CLAN` global availability.** `js/helpers.js` defines `const CLAN`.
   `build.js` concatenates modules in a fixed order. Confirm `helpers.js` is concatenated
   **before** every module that references `CLAN` (app.js, overview.js), so there's no TDZ /
   "used before defined" error in the bundle. Load the page in a browser and read the console for
   errors — do not trust curl alone for the React layer.

6. **Discord embed tag spacing.** The author previously introduced a bug where `[3PI]` lost its
   trailing space (`[3PI]Bot Commands`). Render **every** embed builder and confirm correct
   spacing and content: `buildHelpEmbed`, roster, leaderboard, analysis, bug-reports,
   registration, milestone, weekly digest, notifier achievement embeds. Check the `${TAG}` vs
   inline-shortName usages are right (bracketed where it should be bracketed).

7. **Dynamic `/manifest.json` vs the static file.** A static `manifest.json` still exists on disk
   with hardcoded branding, now shadowed by a route. Confirm the route always wins, and flag the
   stale static file as a re-skin foot-gun (it would be served if the route were ever removed, and
   it's confusing to have two sources). Validate the generated manifest is spec-valid.

8. **`build_telemetry_insights.js` rebrand pass.** It does
   `serialized.split('3PI').join(SHORT)` over the whole JSON when `SHORT !== '3PI'`. Could this
   corrupt legitimate data that contains the substring "3PI" — player names, match IDs, map
   names, weapon names? Assess the blast radius and whether the replacement should be scoped to
   specific fields instead. Confirm it's a true no-op when `SHORT === '3PI'`.

9. **`register-commands.js` behavior change.** `GUILD_ID` now comes from config. If config is
   missing/invalid, `guildId` is `''` → commands register **globally** (~1h propagation) instead
   of instantly to the guild. Confirm current behavior registers to the guild, and that this
   failure mode is acceptable / documented.

10. **AI cache cleanliness + prevention.** Confirm `data/ai_insights_cache.json`,
    `ai_insights_history.json`, `analysis_cache.json`, `telemetry_insights_cache.json` contain no
    `APES`/`AP3S`. Confirm `data/clan.json` reflects the **current** clan (`clanName`
    `3rdPartyINC`, `clanTag` `3PI`, `clanId clan.23b8f701...`) and NOT the old `APES`/`AP3S` clan
    (`clan.3570597...`). Confirm `summarize_for_ai.js` emits `clanIdentity` and the `notes.naming`
    rule, and that both the mirror and runtime daily SKILL.md carry the naming rule.

11. **Circular `require` / load-time crashes.** Several modules now `require('./config')` and call
    `loadClanConfig()` at module top-level. Confirm there's no require cycle and no module that
    throws at load if `config/clan.config.json` is absent (the loader should degrade to defaults,
    not crash the server). Test by temporarily pointing at a missing/garbage config in a throwaway
    copy.

12. **`validateClanConfig` quality.** Does it actually catch the realistic mistakes (missing
    guildId, `localhost` in publicUrl, non-array adminUserIds, missing name/tag)? Does it only
    warn, or can it wedge startup? Is warn-not-crash the right call here? Are there required fields
    it *should* check but doesn't (e.g. membershipRole empty)?

13. **Secrets hygiene.** Confirm `frontendClanConfig()` / `/api/config` / the injected global
    expose **no** secrets, and that nothing secret leaked into `config/clan.config.json` or got
    logged. Confirm `.env` still holds the real secrets and they weren't accidentally moved.

14. **Leftover hardcoded branding.** Grep the shipped runtime (`js/`, `lib/`, `routes/`,
    `server.js`, `scripts/`) for `3PI`, `Third Party`, `executiveundertakings`, `contractor`,
    `Memo`, and the known IDs. Separate genuine leftovers from intentional ones (the `3PI`
    placeholders in `build_telemetry_insights.js`, `'Memo'` default fallbacks, `useMemo` false
    positives, const definitions). Report anything a re-skin would miss.

15. **Dirty worktree / diff hygiene.** Start with `git status --short` and distinguish committed
    baseline, refactor changes, generated artifacts, and any user edits that are already present.
    Do not assume every dirty file belongs to the refactor. If findings rely on a diff hunk,
    identify the hunk and note whether the file also contains unrelated local changes.

16. **Operational docs and scripts drift.** Check `package.json`, shell scripts, launchd-facing
    docs, `config/README.md`, `AGENTS.md`, and `CLAUDE.md` for stale paths, ports, service names,
    build commands, or config instructions introduced by the refactor. Confirm the documented
    "edit config + restart/rebuild" workflow is internally consistent.

17. **Public URL behavior.** If it is safe to hit the public Cloudflare URL, compare
    `https://3pi.executiveundertakings.com/`, `/api/config`, and `/manifest.json` against
    localhost. Confirm no localhost-only URLs leak into public-facing Discord copy, manifests,
    or frontend config.

18. **Dual instruction file consistency.** `AGENTS.md` and `CLAUDE.md` both document this project.
    Confirm they agree on the current clan identity, Cowork/AI architecture, config workflow,
    public URL, role name, and daily task behavior. Call out any divergence that could send a
    future agent down the wrong path.

## Suggested method

1. `git status --short` / `git diff` to see the exact change set; read every hunk and separate
   refactor changes from unrelated dirty files.
2. `node --check` every changed `.js`. Load `lib/config.js` and dump `loadClanConfig()` +
   `frontendClanConfig()`.
3. Render every Discord embed builder via a small throwaway `node -e` and eyeball output.
4. Hit the live endpoints: `/api/config`, `/manifest.json`, `/`, `/api/gateway/status`,
   `/api/ai-insights`, `/api/health`. Diff what they return against the config.
5. Open `localhost:3002` in a real browser (Chrome MCP) and read the JS console + the rendered
   header/overview — confirm no errors and the brand renders (not generic "Clan" fallback, not
   raw tokens).
6. Stress the edge cases in a **copied** working dir: missing config, malformed JSON, a config
   with a different `shortName`/`tag` (does the telemetry rebrand pass + frontend + embeds all
   follow?), an env override set.

## Output format

Produce a findings report:

- **Severity-ranked list** (Critical / High / Medium / Low / Nit). For each: a one-line title,
  `file:line`, what's wrong, how to reproduce or where you saw it, and a concrete suggested fix.
- **A "verified correct" section** — the things you checked that are genuinely fine (so the user
  knows coverage was real, not skipped).
- **Re-skin readiness verdict** — if someone dropped in a brand-new `clan.config.json` for a
  different clan and restarted (+ rebuilt frontend), what would still show the old branding or
  break? List every gap.
- Call out anything ambiguous where you'd want the user's intent before recommending a change.

Be thorough. A missed bug here becomes a user-facing bug later.
