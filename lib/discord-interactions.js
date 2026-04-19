'use strict';
// ── lib/discord-interactions.js — Discord HTTP Interactions ───────────────────
// Handles signature verification and embed building for slash commands.
// Uses only Node.js built-ins (crypto module) — zero npm deps.
//
// Required .env vars (add to .env):
//   DISCORD_APP_ID      — from Discord Developer Portal → General Information
//   DISCORD_PUBLIC_KEY  — from Discord Developer Portal → General Information
//   DISCORD_BOT_TOKEN   — from Discord Developer Portal → Bot → Token
//
// How it works:
//   Discord sends HTTP POST to /interactions for every slash command.
//   We verify the ed25519 signature, parse the command, look up stats
//   from disk cache (instant) or live API, and return a Discord embed.

const crypto = require('crypto');

// ── Signature verification ────────────────────────────────────────────────────
// Discord signs every interaction with ed25519. If verification fails we
// return HTTP 401 — Discord will stop delivering interactions to this URL.
//
// Node 22 doesn't support format:'raw' in crypto.verify, so we wrap the
// 32-byte raw public key in a standard Ed25519 SPKI DER envelope first.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function verifySignature(publicKey, timestamp, rawBody, signature) {
  try {
    const msgBuffer = Buffer.concat([
      Buffer.from(timestamp, 'utf8'),
      Buffer.from(rawBody,   'utf8'),
    ]);
    const spki     = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey, 'hex')]);
    const keyObj   = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const sigBuffer = Buffer.from(signature, 'hex');
    return crypto.verify(null, msgBuffer, keyObj, sigBuffer);
  } catch {
    return false;
  }
}

// ── Stat helpers ──────────────────────────────────────────────────────────────
// Mirror the logic in index.html: try squad-fpp first, fall back to squad (TPP)
function extractStats(seasonData) {
  if (!seasonData?.data?.attributes?.gameModeStats) return null;
  const gms = seasonData.data.attributes.gameModeStats;
  if (gms['squad-fpp']?.roundsPlayed > 0) return { mode: 'Squad FPP', s: gms['squad-fpp'] };
  if (gms['squad']?.roundsPlayed     > 0) return { mode: 'Squad TPP', s: gms['squad'] };
  return null;
}

// Convert match-history cache totals to a seasonEntry-compatible object.
// Prefers official-only local cache; falls back to API if no cache available.
function getStatsEntry(accountId, seasonData, historyTotals) {
  const t = historyTotals?.[accountId];
  if (t && t.roundsPlayed > 0) {
    return {
      mode: 'Official (cached)',
      s: {
        roundsPlayed:  t.roundsPlayed,
        kills:         t.kills         || 0,
        losses:        t.losses        || 0,
        wins:          t.wins          || 0,
        damageDealt:   t.damageDealt   || 0,
        headshotKills: t.headshotKills || 0,
        assists:       t.assists       || 0,
        dBNOs:         t.dBNOs         || 0,
        top10s:        t.top10s        || 0,
        timeSurvived:  t.timeSurvived  || 0,
        revives:       0, longestKill: 0,
      },
    };
  }
  return extractStats(seasonData);
}

function extractLifetimeStats(lifetimeData) {
  if (!lifetimeData?.data?.attributes?.gameModeStats) return null;
  const gms = lifetimeData.data.attributes.gameModeStats;

  // Aggregate across ALL game modes — lifetime spans solo/duo/squad/fpp/tpp
  const totals = {
    roundsPlayed: 0, kills: 0, losses: 0, wins: 0, top10s: 0,
    damageDealt: 0, headshotKills: 0, timeSurvived: 0, revives: 0,
  };
  let hasAny = false;
  for (const mode of Object.values(gms)) {
    if (!mode?.roundsPlayed) continue;
    hasAny = true;
    for (const key of Object.keys(totals)) totals[key] += mode[key] || 0;
  }
  return hasAny ? totals : null;
}

function kd(kills, deaths) {
  if (!deaths) return kills.toFixed(2);
  return (kills / deaths).toFixed(2);
}

function pct(num, denom) {
  if (!denom) return '0%';
  return Math.round((num / denom) * 100) + '%';
}

function num(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function fmtTime(secs) {
  const m = Math.floor((secs || 0) / 60);
  const s = Math.floor((secs || 0) % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Colour palette (matches the notifier) ────────────────────────────────────
const APES_BLUE  = 0x5865F2; // Discord blurple — default
const APES_GOLD  = 0xFFD700; // high K/D
const APES_GREEN = 0x2ECC71; // wins / positive

function tierColor(kdVal) {
  if (kdVal >= 3)   return 0xFF2222; // red — elite
  if (kdVal >= 2)   return APES_GOLD;
  if (kdVal >= 1)   return APES_GREEN;
  return APES_BLUE;
}

// ── Embed: /stats <player> ────────────────────────────────────────────────────
function buildStatsEmbed(member, seasonEntry, lifetimeData, seasonId) {
  if (!seasonEntry) {
    return {
      title:       `[APES] ${member.name}`,
      description: '⚠️  No season stats available — cache may still be warming up.',
      color:       0x95A5A6,
      footer:      { text: 'Try again in a few minutes' },
    };
  }

  const { mode, s } = seasonEntry;
  const kdVal   = s.losses ? (s.kills || 0) / s.losses : (s.kills || 0);
  const avgDmg  = s.roundsPlayed ? Math.round((s.damageDealt || 0) / s.roundsPlayed) : 0;
  const avgKills = s.roundsPlayed ? ((s.kills || 0) / s.roundsPlayed).toFixed(1) : '0';

  const seasonDesc = [
    `**${num(s.roundsPlayed)}** matches · **${num(s.wins)}** wins (${pct(s.wins, s.roundsPlayed)}) · **${num(s.top10s || 0)}** top-10s`,
    `**K/D ${kd(s.kills, s.losses)}** · ${num(s.kills)} kills · ${avgKills}/match`,
    `**${num(avgDmg)} avg dmg** · ${pct(s.headshotKills, s.kills)} headshots · ${num(s.revives || 0)} revives`,
    s.longestKill >= 50 ? `Longest kill: **${Math.round(s.longestKill)}m**` : null,
    s.roundsPlayed ? `Avg survival: ${fmtTime((s.timeSurvived || 0) / s.roundsPlayed)}` : null,
  ].filter(Boolean).join('\n');

  const fields = [
    {
      name:   `📊 This Season — ${mode}`,
      value:  seasonDesc,
      inline: false,
    },
  ];

  // Lifetime stats if available
  const lt = extractLifetimeStats(lifetimeData);
  if (lt && lt.roundsPlayed > 0) {
    const ltKd  = lt.losses ? (lt.kills || 0) / lt.losses : (lt.kills || 0);
    const ltAvgDmg = lt.roundsPlayed ? Math.round((lt.damageDealt || 0) / lt.roundsPlayed) : 0;
    fields.push({
      name: '⏳ Lifetime',
      value: [
        `${num(lt.roundsPlayed)} matches · ${num(lt.wins)} wins (${pct(lt.wins, lt.roundsPlayed)})`,
        `K/D ${ltKd.toFixed(2)} · ${num(lt.kills)} kills · ${num(ltAvgDmg)} avg dmg`,
      ].join('\n'),
      inline: false,
    });
  }

  const shortSeason = seasonId ? seasonId.split('.').pop() : '?';

  return {
    author:    { name: `[APES] ${member.name}` },
    title:     null,
    color:     tierColor(kdVal),
    fields,
    footer:    { text: `Season ${shortSeason}` },
    timestamp: new Date().toISOString(),
  };
}

// ── Embed: /help ─────────────────────────────────────────────────────────────
function buildHelpEmbed() {
  return {
    author:      { name: '[APES] Bot Commands' },
    color:       APES_BLUE,
    fields: [
      { name: '`/stats [player]`',   value: 'Season + lifetime stats for a clan member. Leave blank for the full leaderboard.', inline: false },
      { name: '`/leaderboard`',      value: 'Top 5 members ranked by K/D, kills, and wins this season.', inline: false },
      { name: '`/anal <player>`',    value: 'AI analysis and top improvement tip for a clan member.', inline: false },
      { name: '`/roster`',           value: 'List all current APES clan members.', inline: false },
      { name: '`/help`',             value: 'Show this message.', inline: false },
    ],
    footer:      { text: 'Stats update every 2 hours · Data from PUBG API' },
    timestamp:   new Date().toISOString(),
  };
}

// ── Embed: /roster ────────────────────────────────────────────────────────────
function buildRosterEmbed(members) {
  const sorted = [...members].sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  );
  return {
    author:      { name: '[APES] Clan Roster' },
    color:       APES_BLUE,
    description: sorted.map(m => `• ${m.name}`).join('\n') || '*(no members)*',
    footer:      { text: `${members.length} member${members.length !== 1 ? 's' : ''}` },
    timestamp:   new Date().toISOString(),
  };
}

// ── Embed: /leaderboard ───────────────────────────────────────────────────────
function buildLeaderboardEmbed(statsArr, seasonId, historyTotals) {
  // Flatten to rows with computed stats — prefer official-only cache when available
  const rows = statsArr
    .map(entry => {
      const se = getStatsEntry(entry.member?.accountId, entry.season, historyTotals);
      if (!se || !se.s.roundsPlayed) return null;
      const s    = se.s;
      const kdVal = s.losses ? (s.kills || 0) / s.losses : (s.kills || 0);
      return {
        name:     entry.member.name,
        kdVal,
        kills:    s.kills || 0,
        wins:     s.wins  || 0,
        matches:  s.roundsPlayed,
        avgDmg:   s.roundsPlayed ? Math.round((s.damageDealt || 0) / s.roundsPlayed) : 0,
        winRate:  s.roundsPlayed ? (s.wins || 0) / s.roundsPlayed : 0,
      };
    })
    .filter(Boolean);

  if (!rows.length) {
    return {
      author:      { name: '[APES] Leaderboard' },
      color:       APES_BLUE,
      description: '⚠️  No stats available yet — cache may still be warming.',
    };
  }

  const MEDALS = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];

  function buildField(title, sorted, fmtVal, fmtSub) {
    const top5 = sorted.slice(0, 5);
    return {
      name:  title,
      value: top5.map((r, i) => `${MEDALS[i]} **${r.name}** — ${fmtVal(r)}\n> ${fmtSub(r)}`).join('\n'),
      inline: true,
    };
  }

  const byKd    = [...rows].sort((a, b) => b.kdVal - a.kdVal);
  const byKills = [...rows].sort((a, b) => b.kills - a.kills);
  const byWins  = [...rows].sort((a, b) => b.wins  - a.wins);

  const shortSeason = seasonId ? seasonId.split('.').pop() : '?';

  return {
    author: { name: `[APES] Season ${shortSeason} Leaderboard` },
    color:  APES_GOLD,
    fields: [
      buildField(
        '⚔️  K/D Ratio',
        byKd,
        r => r.kdVal.toFixed(2),
        r => `${num(r.kills)} kills in ${num(r.matches)} matches`
      ),
      buildField(
        '💀 Total Kills',
        byKills,
        r => num(r.kills),
        r => `${(r.kills / r.matches).toFixed(1)}/match`
      ),
      buildField(
        '🍗 Wins',
        byWins,
        r => `${num(r.wins)} (${pct(r.wins, r.matches)})`,
        r => `${num(r.matches)} matches played`
      ),
    ],
    footer:    { text: `${rows.length} active member${rows.length !== 1 ? 's' : ''}` },
    timestamp: new Date().toISOString(),
  };
}

// ── Embed: /anal <player> ─────────────────────────────────────────────────────
function buildAnalysisEmbed(playerName, profile, seasonId, weaponSummary, historyEntry, lifetimeData) {
  const kdVal       = profile.kd || 0;
  const shortSeason = seasonId ? seasonId.split('.').pop() : '?';

  if (!profile.summary) {
    return {
      author:      { name: `[APES] ${playerName} — Analysis` },
      color:       0x95A5A6,
      description: '⚠️  No analysis available yet — run the daily task first.',
      footer:      { text: `Season ${shortSeason}` },
    };
  }

  return {
    author: { name: `[APES] ${playerName} — Analysis` },
    color:  tierColor(kdVal),
    fields: [
      {
        name:   '📋 Overview',
        value:  profile.summary,
        inline: false,
      },
      {
        name:   '💡 Top Improvement',
        value:  profile.tip || '_No tip available_',
        inline: false,
      },
      {
        name:   '📊 Key Stats',
        value: [
          `K/D **${profile.kd}** · Win rate **${(profile.winRate * 100).toFixed(1)}%** · **${profile.games}** games`,
          `Top-10 rate **${(profile.top10Rate * 100).toFixed(1)}%** · Close-out **${(profile.closeOutRate * 100).toFixed(1)}%**`,
          `HS% **${(profile.hsRate * 100).toFixed(1)}%** · Assists/game **${profile.assistsPg}**`,
        ].join('\n'),
        inline: false,
      },
      // Season vs Career comparison
      ...(() => {
        const lt = lifetimeData ? extractLifetimeStats(lifetimeData) : null;
        if (!lt || !lt.roundsPlayed) return [];
        const ltKd      = lt.losses ? lt.kills / lt.losses : lt.kills;
        const ltWinRate = lt.roundsPlayed ? lt.wins / lt.roundsPlayed : 0;
        const ltHsRate  = lt.kills > 0 ? lt.headshotKills / lt.kills : 0;
        const ltAvgDmg  = lt.roundsPlayed ? Math.round(lt.damageDealt / lt.roundsPlayed) : 0;
        const sKd       = profile.kd || 0;
        const sWinRate  = profile.winRate || 0;

        const kdDelta = ltKd > 0 ? (sKd - ltKd) / ltKd : 0;
        const kdSign  = kdDelta >= 0 ? '+' : '';
        const kdTrend = kdDelta >=  0.15 ? '🔥'
                      : kdDelta >=  0.05 ? '📈'
                      : kdDelta <= -0.15 ? '📉'
                      : kdDelta <= -0.05 ? '🌡️'
                      : '→';

        const wrDelta = ltWinRate > 0 ? (sWinRate - ltWinRate) / ltWinRate : 0;
        const wrSign  = wrDelta >= 0 ? '+' : '';
        const wrTrend = wrDelta >= 0.1 ? '📈' : wrDelta <= -0.1 ? '📉' : '→';

        const lines = [
          `K/D: **${sKd.toFixed(2)}** this season vs **${ltKd.toFixed(2)}** career ${kdTrend} (${kdSign}${Math.round(kdDelta * 100)}%)`,
          `Win rate: **${(sWinRate * 100).toFixed(1)}%** vs **${(ltWinRate * 100).toFixed(1)}%** career ${wrTrend} (${wrSign}${Math.round(wrDelta * 100)}%)`,
          `HS%: **${(sKd > 0 ? (profile.hsRate * 100).toFixed(1) : '—')}%** this season vs **${(ltHsRate * 100).toFixed(1)}%** career · Lifetime: **${num(lt.roundsPlayed)}** games`,
        ];
        return [{ name: '📈 Season vs Career', value: lines.join('\n'), inline: false }];
      })(),
      ...(weaponSummary?.weapons?.length ? [{
        name:   '🔫 Top Weapons',
        value:  weaponSummary.weapons.slice(0, 4).map(w => {
          const hs   = w.hsRate > 0       ? ` · ${Math.round(w.hsRate * 100)}% HS` : '';
          const dist = w.avgDist > 0      ? ` · ${w.avgDist}m avg` : '';
          const spk  = w.shotsPerKill > 0 ? ` · ${w.shotsPerKill} SPK` : '';
          const kd   = w.knockdowns > 0   ? ` · ${w.knockdowns}↓` : '';
          return `**${w.displayName}** — ${w.kills}K${kd}${hs}${dist}${spk}`;
        }).join('\n'),
        inline: false,
      }] : []),
      ...(() => {
        // Map affinity — best map by avg kills (min 2 recent games)
        const maps   = (historyEntry?.mapStats || []).filter(m => m.played >= 2);
        if (!maps.length) return [];
        const best   = [...maps].sort((a, b) => b.avgKills - a.avgKills)[0];
        const worst  = [...maps].sort((a, b) => a.avgKills - b.avgKills)[0];
        // Knockdown conversion from weapons
        const weapons = weaponSummary?.weapons || [];
        const totKills  = weapons.reduce((s, w) => s + w.kills, 0);
        const totKnocks = weapons.reduce((s, w) => s + (w.knockdowns || 0), 0);
        const finishRate = totKnocks > 5 ? (totKills / totKnocks).toFixed(2) : null;
        const lines = [];
        if (best && best !== worst) lines.push(`🗺 Best map: **${best.map}** (${best.avgKills}K/g, ${best.played} games) — Worst: **${worst.map}** (${worst.avgKills}K/g)`);
        else if (best) lines.push(`🗺 Most active map: **${best.map}** (${best.avgKills}K/g, ${best.played} games)`);
        if (finishRate) lines.push(`💀 Knockdown finish rate: **${finishRate}×** (${totKills}K from ${totKnocks}↓)`);
        const bz = weaponSummary?.blueZone;
        if (bz && bz.matches >= 5) {
          const bzIcon = bz.avgDmgPerGame >= 100 ? '🔴' : bz.avgDmgPerGame >= 75 ? '🟠' : bz.avgDmgPerGame >= 50 ? '🟡' : '🟢';
          const bzNote = bz.avgDmgPerGame >= 100 ? ' — rotate earlier!'
                       : bz.avgDmgPerGame >= 75  ? ' — zone discipline needs work'
                       : bz.avgDmgPerGame >= 50  ? ' — acceptable but improvable'
                       : ' — excellent zone discipline';
          lines.push(`🔵 Zone damage: **${bz.avgDmgPerGame}** dmg/game ${bzIcon}${bzNote} (${bz.matches} games)`);
        }
        const form = historyEntry?.form;
        if (form && form.trend !== 'steady') {
          const icon = { hot: '🔥', warm: '📈', cold: '📉', cool: '🌡' }[form.trend] || '→';
          const sign = form.delta >= 0 ? '+' : '';
          lines.push(`${icon} Recent form: **${sign}${Math.round(form.delta * 100)}%** vs overall (last ${form.window} games)`);
        }
        if (!lines.length) return [];
        return [{ name: '📍 Context', value: lines.join('\n'), inline: false }];
      })(),
    ],
    footer:    { text: `Season ${shortSeason} · Updated daily` },
    timestamp: new Date().toISOString(),
  };
}

// ── Discord response helpers ──────────────────────────────────────────────────
const INTERACTION_RESPONSE_TYPES = {
  PONG:                        1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE:    5, // ← use for slow lookups; then PATCH with followup
};

function pong() {
  return { type: INTERACTION_RESPONSE_TYPES.PONG };
}

function ephemeralMessage(content) {
  return {
    type: INTERACTION_RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: 64 }, // 64 = ephemeral
  };
}

function embedResponse(embed, ephemeral = false) {
  return {
    type: INTERACTION_RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [embed],
      ...(ephemeral ? { flags: 64 } : {}),
    },
  };
}

function deferredResponse(ephemeral = false) {
  return {
    type: INTERACTION_RESPONSE_TYPES.DEFERRED_CHANNEL_MESSAGE,
    data: ephemeral ? { flags: 64 } : {},
  };
}

module.exports = {
  verifySignature,
  extractStats,
  getStatsEntry,
  extractLifetimeStats,
  buildStatsEmbed,
  buildRosterEmbed,
  buildLeaderboardEmbed,
  buildHelpEmbed,
  buildAnalysisEmbed,
  pong,
  ephemeralMessage,
  embedResponse,
  deferredResponse,
};
