# Clan configuration — single source of truth

Everything clan-specific that you'd customise for a different clan/server lives in
**`config/clan.config.json`**. Edit that one file, restart the server, and the whole
site + Discord bot re-skins itself. No code changes required.

```
launchctl kickstart -k gui/$(id -u)/com.greg.clan-server
```

Secrets do **not** live here — API keys and tokens stay in `.env` (see below). Config
and secrets are deliberately separated so this file is safe to read, diff, and (if you
strip the IDs) share.

## Fields

### `clan`
| Field | What it controls |
|---|---|
| `name` | Full clan name. Shown in DMs, the web header, the PWA name, embeds. |
| `shortName` | Short name (e.g. browser tab title `"<shortName> Stats"`, PWA short_name). |
| `tag` | Bracket prefix on every Discord embed author line, e.g. `[3PI]`. Also the bot User-Agent base. |
| `emoji` | Brand emoji used in DMs and headers. |
| `memberNoun` / `memberNounPlural` | What you call a member ("contractor"/"contractors"). Used in UI counts and copy. |
| `subtitle` | Small subtitle under the logo in the web header. |
| `restrictedLabel` | Footer text on the player profile modal. |
| `bootTitle` / `bootBody` | The loading-screen headline and paragraph shown before the app hydrates. |

### `site`
| Field | What it controls |
|---|---|
| `publicUrl` | Public site URL. Used in every Discord post/DM and the insights summary. **Never** put `localhost` here — it leaks into messages that leave the LAN. |
| `port` | Default HTTP port. Overridable at runtime with the `PUBG_PORT` env var or process environment. |

### `discord`
| Field | What it controls |
|---|---|
| `guildId` | The Discord server (guild) ID the bot + Gateway operate on. |
| `membershipRole` | The role that marks a tracked clan member. Gates `/bugreport` and drives Gateway auto-add/remove. (Live value: `Memo`.) |
| `adminUserIds` | Discord user IDs DM'd on every new `/bugreport`. |
| `gracePeriodDays` | Days a departed member's stats are kept before the daily pipeline hard-deletes them. |
| `botUserAgent` | User-Agent the bot sends to the Discord REST API. |
| `reactionRoles` | Optional message-reaction role bindings handled by the Gateway. Each entry uses `channelId`, `messageId`, `emoji`, `roleName`, optional `roleId`, and `removeOnUnreact`. |
| `pinnedInfo.channelId` / `messageId` | The pinned master "what this bot does" message the daily task keeps in sync. |
| `pinnedInfo.channelName` | Human-readable channel name (`performance-review`) for logs/docs. |

## Env-var overrides (optional)

For deployment flexibility, three non-secret fields can still be overridden by environment
variables if present, either in the process environment or `.env`. The values in
`clan.config.json` are the canonical source; env just wins if set. Empty env values are ignored:

| Env var | Overrides |
|---|---|
| `DISCORD_GUILD_ID` | `discord.guildId` |
| `DISCORD_CLAN_ROLE` | `discord.membershipRole` |
| `CLAN_ADMIN_DISCORD_IDS` (comma-separated) | `discord.adminUserIds` |

## Secrets (stay in `.env`, never here)

`PUBG_API_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_APP_ID`,
`DISCORD_WEBHOOK_URL`, `ADMIN_PASSWORD_HASH`. These are credentials or auth
material — keep them out of version control.
