// ── Overview tab ──────────────────────────────────────────────────────────────
const OVERVIEW_STATS = [
  { id: 'kd',       label: 'Clan K/D',     tip: 'Kill/Death ratio — total clan kills ÷ deaths', key: t => kd(t.kills, t.deaths),                                   sub: t => `${num(t.kills)} kills`,                     accent: true,  icon: '⚔️',
    detail: { title: 'K/D Ratio — Per Player', desc: 'Season kills ÷ deaths. Higher = more lethal.', playerKey: r => r.kdVal || 0, playerFmt: r => (r.kdVal||0).toFixed(2), playerSub: r => `${num(r.kills||0)} kills / ${num(r.losses||0)} deaths` } },
  { id: 'wins',     label: 'Total Wins',   tip: null, key: t => num(t.wins),                                              sub: t => `across ${num(t.activePlayers)} players`,      accent: false, icon: '🏆',
    detail: { title: 'Wins — Per Player', desc: 'Chicken dinners this season.', playerKey: r => r.wins||0, playerFmt: r => num(r.wins||0), playerSub: r => `${pct(r.wins||0, r.games||1)} win rate` } },
  { id: 'kills',    label: 'Clan Kills',   tip: null, key: t => num(t.kills),                                             sub: t => `${round(t.kills/Math.max(t.matches,1))} avg/match`, accent: false, icon: '💀',
    detail: { title: 'Kills — Per Player', desc: 'Total season kills per member.', playerKey: r => r.kills||0, playerFmt: r => num(r.kills||0), playerSub: r => `${round(r.killsPg||0)} avg/match` } },
  { id: 'damage',   label: 'Avg Damage',   tip: 'Average damage dealt per match across all players', key: t => num(Math.round(t.damage/Math.max(t.matches,1))),         sub: t => `${num(Math.round(t.damage))} total`,           accent: false, icon: '💥',
    detail: { title: 'Avg Damage — Per Player', desc: 'Average damage dealt per match.', playerKey: r => r.avgDmg||0, playerFmt: r => num(Math.round(r.avgDmg||0)), playerSub: r => `${num(Math.round(r.dmg||0))} total dmg` } },
  { id: 'top10',    label: 'Top 10 Rate',  tip: 'Percentage of matches finishing in the top 10', key: t => pct(t.top10, t.matches),                                 sub: t => `${num(t.top10)} top-10s`,                   accent: false, icon: '🎯',
    detail: { title: 'Top 10 Rate — Per Player', desc: 'How often they finish in the top 10.', playerKey: r => r.top10Rate||0, playerFmt: r => pct(r.top10||0, r.games||1), playerSub: r => `${num(r.top10||0)} top-10s` } },
  { id: 'matches',  label: 'Matches',      tip: 'Total player-match appearances (same game counts once per player)', key: t => num(t.matches),                                          sub: t => 'player-games this season',                   accent: false, icon: '🎮',
    detail: { title: 'Matches Played — Per Player', desc: 'Season matches played.', playerKey: r => r.games||0, playerFmt: r => num(r.games||0), playerSub: r => `${num(r.wins||0)} wins` } },
  { id: 'headshot', label: 'Headshot %',   tip: 'Percentage of kills that are headshots', key: t => t.kills > 0 ? pct(t.headshots, t.kills) : '—',          sub: t => `${num(t.headshots)} HS kills`,               accent: false, icon: '🔫',
    detail: { title: 'Headshot % — Per Player', desc: 'Share of kills that were headshots. Marker of aim precision.', playerKey: r => r.hsRate||0, playerFmt: r => pct(r.hs||0, r.kills||1), playerSub: r => `${num(r.hs||0)} HS / ${num(r.kills||0)} kills` } },
  { id: 'survive',  label: 'Avg Survive',  tip: 'Average survival time per match', key: t => fmtSurvival(t.timeSurvived / Math.max(t.matches, 1)),   sub: t => `${num(Math.round(t.timeSurvived/60))} min total`, accent: false, icon: '⏱️',
    detail: { title: 'Avg Survival Time — Per Player', desc: 'Average minutes alive per match. Longer = better positioning.', playerKey: r => r.avgSurvival||0, playerFmt: r => fmtSurvival(r.avgSurvival||0), playerSub: r => `${num(Math.round((r.timeSurv||0)/60))} min total` } },
  { id: 'teamwork', label: 'Clan Revives', tip: 'Total teammate revives across all players this season', key: t => num(t.revives),                                          sub: t => `${round(t.revives/Math.max(t.matches,1),2)} per match`,  accent: false, icon: '🤝',
    detail: { title: 'Revives — Per Player', desc: 'Teammates brought back up. A high number signals a strong team player.', playerKey: r => r.revives||0, playerFmt: r => num(r.revives||0), playerSub: r => `${round(r.revives/Math.max(r.games||1,1),2)} per match` } },
  { id: 'knockdowns', label: 'Knockdowns', tip: 'Enemies knocked down (downed but not yet finished)', key: t => num(t.dBNOs),                                         sub: t => `${round(t.dBNOs/Math.max(t.matches,1),1)} per match`,    accent: false, icon: '👊',
    detail: { title: 'Knockdowns — Per Player', desc: 'Enemies knocked down (dBNOs). High knocks with low kills may mean the squad is finishing your downs.', playerKey: r => r.dBNOs||0, playerFmt: r => num(r.dBNOs||0), playerSub: r => `${round((r.dBNOs||0)/Math.max(r.games||1,1),1)} per match` } },
  { id: 'assists',  label: 'Assists',      tip: 'Damage dealt on enemies killed by a teammate', key: t => num(t.assists),                                          sub: t => `${round(t.assists/Math.max(t.matches,1),1)} per match`,  accent: false, icon: '🦾',
    detail: { title: 'Assists — Per Player', desc: 'Damage dealt to killed enemies without getting the kill.', playerKey: r => r.assists||0, playerFmt: r => num(r.assists||0), playerSub: r => `${round(r.assistsPg||0,1)} per match` } },
  { id: 'roadKills', label: 'Road Kills',  tip: 'Enemies run over with a vehicle', key: t => num(t.roadKills),                                      sub: t => 'enemies run over',                            accent: false, icon: '🚗',
    detail: { title: 'Road Kills — Per Player', desc: 'Enemies run over with a vehicle. Pure chaos metric.', playerKey: r => r.roadKills||0, playerFmt: r => num(r.roadKills||0), playerSub: r => r.roadKills > 0 ? '🏆 vehicular manslaughter' : '—' } },
  { id: 'vehDestroys', label: 'Veh Destroys', tip: 'Vehicles destroyed this season', key: t => num(t.vehicleDestroys),                                  sub: t => 'vehicles destroyed',                          accent: false, icon: '💣',
    detail: { title: 'Vehicle Destroys — Per Player', desc: 'Total vehicles destroyed. Includes abandoned vehicles blown up in the zone.', playerKey: r => r.vehicleDestroys||0, playerFmt: r => num(r.vehicleDestroys||0), playerSub: r => r.vehicleDestroys > 0 ? '💥 boom' : '—' } },
  { id: 'daysActive', label: 'Days Active', tip: null, key: t => `${t.activePlayers} players`, sub: t => `avg ${Math.round(t.daysPlayed/Math.max(t.activePlayers,1))} days each`,  accent: false, icon: '📅',
    detail: { title: 'Days Active — Per Player', desc: 'Distinct days played this season. Shows who\'s grinding.', playerKey: r => r.days||0, playerFmt: r => `${num(r.days||0)} days`, playerSub: r => `${num(r.games||0)} matches` } },
  { id: 'members', label: 'Members',       tip: null, key: (t, m) => m,                                              sub: t => 'tracked this season',                      accent: false, icon: '🦍',
    detail: null },
];

// ── Stat detail modal ─────────────────────────────────────────────────────────
function StatDetailModal({ stat, resolvedStats, onClose }) {
  if (!stat?.detail) return null;
  const { title, desc, playerKey, playerFmt, playerSub } = stat.detail;
  // Spread full trunk entry so playerKey/playerFmt/playerSub can reach
  // all fields (revives, roadKills, days, etc.), not just r.s fields.
  const rows = resolvedStats
    .map(entry => ({ ...entry, name: entry.member.name }))
    .filter(r => r.s)
    .sort((a, b) => playerKey(b) - playerKey(a));
  const max = rows.length ? playerKey(rows[0]) : 1;

  return (
    <div className="modal-bg" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ padding: '24px 28px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <div style={{ fontWeight: 800, fontSize: 18 }}>{stat.icon} {title}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-3)', fontSize: 20, cursor: 'pointer', padding: '0 4px' }}>✕</button>
        </div>
        <p style={{ color: 'var(--text-3)', fontSize: 13, marginBottom: 20 }}>{desc}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map((r, i) => {
            const val = playerKey(r);
            const barPct = max > 0 ? Math.round((val / max) * 100) : 0;
            const isTop = i === 0;
            return (
              <div key={r.name}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 13, color: isTop ? 'var(--gold)' : 'var(--text-3)', fontWeight: 600, width: 20 }}>
                      {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`}
                    </span>
                    <span style={{ fontWeight: isTop ? 700 : 500, color: isTop ? '#facc15' : 'var(--text-2)', fontSize: 13 }}>{r.name}</span>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ fontWeight: 800, fontSize: 15, color: isTop ? 'var(--accent)' : 'var(--text-1)' }}>{playerFmt(r)}</span>
                    <span style={{ color: 'var(--text-3)', fontSize: 11, marginLeft: 8 }}>{playerSub(r)}</span>
                  </div>
                </div>
                <div style={{ height: 4, background: 'var(--bg-raised)', borderRadius: 99, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: barPct + '%', background: isTop ? 'var(--accent)' : 'var(--bg-card)', borderRadius: 99, transition: 'width .4s ease', border: '1px solid var(--border)' }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Activity Feed ─────────────────────────────────────────────────────────────
function ActivityFeed({ resolvedStats }) {
  const SESSION_GAP_MS = 2 * 60 * 60 * 1000; // 2h gap = new session
  const MAX_SESSIONS   = 8;

  const sessions = useMemo(() => {
    if (!resolvedStats?.length) return null;

    // Collect all matches across all players, keyed by matchId
    const matchMap = {};
    for (const { member, recent } of resolvedStats) {
      for (const m of (recent || [])) {
        if (!m.matchId || !m.date) continue;
        if (!matchMap[m.matchId]) {
          matchMap[m.matchId] = { matchId: m.matchId, date: m.date, map: m.map, players: [] };
        }
        matchMap[m.matchId].players.push({ name: member.name, kills: m.kills || 0, won: m.won, damage: m.damage || 0 });
      }
    }

    // Sort matches newest-first
    const matches = Object.values(matchMap).sort((a, b) => new Date(b.date) - new Date(a.date));
    if (!matches.length) return null;

    // Group into sessions (matches within SESSION_GAP_MS of each other)
    const groups = [];
    let current = [matches[0]];
    for (let i = 1; i < matches.length; i++) {
      const prevTime = new Date(current[current.length - 1].date).getTime();
      const currTime = new Date(matches[i].date).getTime();
      if (prevTime - currTime <= SESSION_GAP_MS) {
        current.push(matches[i]);
      } else {
        groups.push(current);
        current = [matches[i]];
      }
    }
    groups.push(current);

    // Build session summaries
    return groups.slice(0, MAX_SESSIONS).map(group => {
      const startDate = new Date(group[group.length - 1].date);
      const endDate   = new Date(group[0].date);

      // Aggregate across all matches in session
      const playerKills = {};
      let totalWins = 0, totalKills = 0;
      const mapsInSession = {};

      for (const m of group) {
        mapsInSession[m.map] = (mapsInSession[m.map] || 0) + 1;
        for (const p of m.players) {
          if (!playerKills[p.name]) playerKills[p.name] = { kills: 0, wins: 0 };
          playerKills[p.name].kills += p.kills;
          if (p.won) { playerKills[p.name].wins++; totalWins++; }
          totalKills += p.kills;
        }
      }

      // De-duplicate wins (multiple players share a win in same match)
      const uniqueWins = group.filter(m => m.players.some(p => p.won)).length;

      // Top map for session
      const topMap = Object.entries(mapsInSession).sort((a, b) => b[1] - a[1])[0]?.[0] || '?';
      const mapCount = Object.keys(mapsInSession).length;

      // Player list sorted by kills
      const players = Object.entries(playerKills)
        .map(([name, d]) => ({ name, kills: d.kills, wins: d.wins }))
        .sort((a, b) => b.kills - a.kills);

      const durationMin = Math.round((endDate - startDate) / 60000);

      return {
        date:       endDate,           // most recent match in session (for "time ago")
        games:      group.length,
        wins:       uniqueWins,
        kills:      totalKills,
        topMap,
        mapCount,
        players,
        durationMin,
      };
    });
  }, [resolvedStats]);

  function timeAgo(date) {
    const secs = Math.floor((Date.now() - date.getTime()) / 1000);
    if (secs < 60)           return 'just now';
    if (secs < 3600)         return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400)        return `${Math.floor(secs / 3600)}h ago`;
    if (secs < 86400 * 7)   return `${Math.floor(secs / 86400)}d ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  if (!sessions?.length) return null;

  return (
    <div className="stat-card" style={{ padding: '18px 20px' }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-3)', marginBottom: 14 }}>
        🕒 Recent Activity
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {sessions.map((s, i) => (
          <div key={i} style={{ display: 'flex', gap: 14, padding: '10px 0', borderBottom: i < sessions.length - 1 ? '1px solid rgba(255,255,255,.05)' : 'none', alignItems: 'flex-start' }}>
            {/* Timeline dot + line */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0, paddingTop: 3 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: s.wins > 0 ? '#34d399' : 'var(--text-3)', flexShrink: 0 }} />
              {i < sessions.length - 1 && <div style={{ width: 1, flex: 1, minHeight: 20, background: 'rgba(255,255,255,.07)', marginTop: 4 }} />}
            </div>

            {/* Content */}
            <div style={{ flex: 1, minWidth: 0 }}>
              {/* Header row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-1)' }}>
                  {s.games} {s.games === 1 ? 'game' : 'games'} · {s.topMap}{s.mapCount > 1 ? ` +${s.mapCount - 1}` : ''}
                </span>
                {s.wins > 0 && (
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#34d399', background: 'rgba(52,211,153,.12)', border: '1px solid rgba(52,211,153,.25)', borderRadius: 4, padding: '1px 6px' }}>
                    🍗 {s.wins} {s.wins === 1 ? 'win' : 'wins'}
                  </span>
                )}
                <span style={{ fontSize: 11, color: '#f87171', fontWeight: 600 }}>{s.kills}K</span>
                <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-3)', flexShrink: 0 }}>{timeAgo(s.date)}</span>
              </div>

              {/* Player pills */}
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {s.players.slice(0, 8).map(p => (
                  <span key={p.name} style={{
                    fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 4,
                    background: p.wins > 0 ? 'rgba(52,211,153,.1)' : 'var(--bg-raised)',
                    border: `1px solid ${p.wins > 0 ? 'rgba(52,211,153,.25)' : 'var(--border)'}`,
                    color: p.wins > 0 ? '#34d399' : 'var(--text-2)',
                  }}>
                    {p.name} · {p.kills}K{p.wins > 0 ? ` · ${p.wins}W` : ''}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Section header — editorial label + title + optional right slot ────────────
function SectionHeader({ eyebrow, title, sub, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginBottom: 18, paddingBottom: 14, borderBottom: '1px solid var(--border)' }}>
      <div>
        <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.14em', color: 'var(--accent)', marginBottom: 5 }}>{eyebrow}</div>
        <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-1)', letterSpacing: '-.02em', lineHeight: 1.1 }}>{title}</div>
        {sub && <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4, fontWeight: 400 }}>{sub}</div>}
      </div>
      {right && <div style={{ flexShrink: 0 }}>{right}</div>}
    </div>
  );
}

// ── Overview tab ──────────────────────────────────────────────────────────────
function Overview({ members, resolvedStats, clanMatchTotals, season, loading, onLogoClick }) {
  const [activeStat, setActiveStat] = useState(null);
  const isMobile = useIsMobile();

  const totals = useMemo(() => {
    if (!resolvedStats?.length) return null;
    let kills = 0, deaths = 0, wins = 0, matches = 0, damage = 0, top10 = 0,
        assists = 0, headshots = 0, timeSurvived = 0, revives = 0, dBNOs = 0,
        roadKills = 0, vehicleDestroys = 0, daysPlayed = 0, activePlayers = 0;
    // Read all fields from the trunk — all official-only data (no raw PUBG API)
    resolvedStats.forEach(r => {
      if (!r.s) return;
      kills           += r.kills;
      deaths          += r.losses;
      wins            += r.wins;
      matches         += r.games;
      damage          += r.dmg;
      top10           += r.top10;
      assists         += r.assists;
      headshots       += r.hs;
      timeSurvived    += r.timeSurv;
      revives         += r.revives;         // telemetry-derived (weapon_cache)
      dBNOs           += r.dBNOs     || 0;
      roadKills       += r.roadKills;       // telemetry-derived (weapon_cache)
      vehicleDestroys += r.vehicleDestroys; // telemetry-derived (weapon_cache)
      daysPlayed      += r.days;            // history-derived (match_history_cache)
      if (r.games > 0) activePlayers++;
    });
    return { kills, deaths, wins, matches, damage, top10, assists, headshots,
             timeSurvived, revives, dBNOs, roadKills, vehicleDestroys, daysPlayed, activePlayers };
  }, [resolvedStats]);

  // Best player per category
  const bests = useMemo(() => {
    const rows = resolvedStats?.filter(r => r.s && r.games > 0) || [];
    if (!rows.length) return {};
    // Only crown a winner if at least one player has a value > 0 — avoids
    // showing "best road kills: 0" when the weapon cache has no data yet.
    const best = fn => {
      const winner = rows.reduce((t, r) => !t || fn(r) > fn(t) ? r : t, null);
      return winner && fn(winner) > 0 ? winner : null;
    };
    // All derived metrics come from trunk — no inline re-derivation
    return {
      kd:        best(r => r.kdVal),
      wins:      best(r => r.wins),
      kills:     best(r => r.kills),
      damage:    best(r => r.avgDmg),
      top10:     best(r => r.top10Rate),
      headshot:  best(r => r.hsRate),
      survive:   best(r => r.avgSurvival),
      teamwork:  best(r => r.revives),    // telemetry-derived
      assists:   best(r => r.assists),
      roadKills: best(r => r.roadKills),  // telemetry-derived
    };
  }, [resolvedStats]);

  if (loading) return (
    <div style={{ padding: '24px 24px 0' }}>
      <div className="stat-grid" style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2,1fr)' : 'repeat(4,1fr)', gap: 12 }}>
        {[...Array(8)].map((_, i) => <div key={i} className="skeleton" style={{ height: 96, borderRadius: 14 }} />)}
      </div>
    </div>
  );

  if (!totals) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 256, gap: 12, color: 'var(--text-3)' }}>
      <Icon.users />
      <p>No clan stats yet. Add members in Settings to get started.</p>
    </div>
  );

  return (
    <div style={{ padding: isMobile ? '16px' : '24px', display: 'flex', flexDirection: 'column', gap: 24 }}>

      {/* ── Hero banner — two-column: text left, squad right ── */}
      <div className="hero-wrap" onClick={onLogoClick} style={{ borderRadius: 18, border: '1px solid var(--border)', overflow: 'hidden', minHeight: isMobile ? 190 : 320, cursor: onLogoClick ? 'default' : undefined, background: '#070b12', display: 'flex', position: 'relative' }}>

        {/* Left column — text */}
        <div style={{ flex: isMobile ? '1' : '0 0 42%', position: 'relative', padding: isMobile ? '30px 22px' : '52px 52px', display: 'flex', flexDirection: 'column', justifyContent: 'center', zIndex: 2 }}>
          <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at 20% 60%, rgba(59,130,246,.14), transparent 55%)', pointerEvents: 'none' }} />
          <div style={{ position: 'relative' }}>
            <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.2em', color: 'var(--accent)', marginBottom: 12 }}>
              {season ? formatSeason(season.id) : 'Current Season'}
            </div>
            <div className="hero-title" style={{ fontSize: isMobile ? 30 : 48, fontWeight: 900, color: '#fff', letterSpacing: '-.045em', lineHeight: .9, marginBottom: 20 }}>
              {CLAN.name}
            </div>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: 'rgba(255,255,255,.6)', fontWeight: 500 }}>{CLAN.emoji} {members.length} {CLAN.memberNounPlural}</span>
              {clanMatchTotals?.uniqueGames > 0 && <span style={{ fontSize: 13, color: 'rgba(255,255,255,.6)', fontWeight: 500 }}>🎮 {num(clanMatchTotals.uniqueGames)} matches</span>}
              {clanMatchTotals?.uniqueWins > 0   && <span style={{ fontSize: 13, color: '#f59e0b', fontWeight: 700 }}>🏆 {num(clanMatchTotals.uniqueWins)} wins</span>}
            </div>
          </div>
        </div>

        {/* Right column — squad portrait, visible on desktop only */}
        {!isMobile && (
          <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: '72%', overflow: 'hidden', zIndex: 0 }}>
            {/* Fade the left edge so it blends into the text column */}
            <div style={{ position: 'absolute', inset: 0, zIndex: 1, background: 'linear-gradient(to right, rgba(7,11,18,1) 0%, rgba(7,11,18,.78) 16%, rgba(7,11,18,.24) 36%, transparent 62%)', pointerEvents: 'none' }} />
            <img
              src="/images/corp_squad.png"
              alt={`${CLAN.name} field team`}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center top', opacity: 0.82, transform: 'translateY(-14%) scale(1.12)', transformOrigin: 'center top' }}
            />
          </div>
        )}

        {/* Mobile — faint full-bleed background */}
        {isMobile && (
          <img src="/images/corp_squad.png" alt="" aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center top', opacity: 0.18, pointerEvents: 'none' }} />
        )}
      </div>

      {/* ── Stat cards grid ── */}
      <div>
        <SectionHeader eyebrow="Season Stats" title="Clan Totals" />
        <div className="stat-grid" style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2,1fr)' : 'repeat(4,1fr)', gap: 12 }}>
          {OVERVIEW_STATS.map(stat => {
            const val = stat.key(totals, members.length);
            const sub = stat.sub(totals);
            return (
              <div
                key={stat.id}
                className={`stat-card${stat.detail ? ' stat-card-click' : ''}`}
                onClick={stat.detail ? () => setActiveStat(stat) : undefined}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                    {stat.tip
                      ? <span data-tip={stat.tip}>{stat.label}</span>
                      : stat.label
                    }
                  </div>
                  <span style={{ fontSize: 15 }}>{stat.icon}</span>
                </div>
                <div className="stat-val" style={{ fontSize: 22, fontWeight: 800, color: stat.accent ? 'var(--accent)' : 'var(--text-1)', lineHeight: 1.1 }}>{val}</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>{sub}</div>
                {stat.detail && <div style={{ fontSize: 10, color: 'var(--accent)', marginTop: 6, opacity: .65 }}>Click for breakdown →</div>}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Cinematic break — rooftop sniper over city ── */}
      {!isMobile && (
        <div style={{ position: 'relative', height: 110, borderRadius: 14, overflow: 'hidden', border: '1px solid var(--border)' }}>
          <img src="/images/img5.png" alt="" aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center 40%', opacity: 0.80, pointerEvents: 'none' }} />
          {/* Light gradient — just enough to keep text legible, let the image breathe */}
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to right, rgba(7,11,18,.88) 0%, rgba(7,11,18,.45) 38%, rgba(7,11,18,.2) 60%, rgba(7,11,18,.75) 100%)', pointerEvents: 'none' }} />
          <div style={{ position: 'relative', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 32px' }}>
            <div>
              <div style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.2em', color: 'var(--accent)', marginBottom: 5 }}>Season Standings</div>
              <div style={{ fontSize: 20, fontWeight: 900, color: '#fff', letterSpacing: '-.03em' }}>MVP Highlights</div>
            </div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,.5)', fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase' }}>One standout per stat</div>
          </div>
        </div>
      )}

      {/* ── MVP highlights ── */}
      {Object.values(bests).some(Boolean) && (
        <div>
          {isMobile && <SectionHeader eyebrow="MVP Highlights" title="Best This Season" sub="One standout per stat category" />}
          <div className="mvp-card stat-card" style={{ position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'flex-start', gap: 16, padding: '18px 20px', flexWrap: 'wrap' }}>
            {/* Ghost portrait — sniper on right side */}
            <img src="/images/corp_sniper.png" alt="" aria-hidden="true" style={{ position: 'absolute', right: -4, top: 0, height: '100%', width: 130, objectFit: 'cover', objectPosition: 'center top', opacity: 0.32, maskImage: 'linear-gradient(to left, rgba(0,0,0,.9) 0%, rgba(0,0,0,.5) 40%, transparent 100%)', WebkitMaskImage: 'linear-gradient(to left, rgba(0,0,0,.9) 0%, rgba(0,0,0,.5) 40%, transparent 100%)', pointerEvents: 'none' }} />
            <div style={{ fontSize: 36, lineHeight: 1 }}>🏅</div>
            <div style={{ display: 'flex', flex: 1, flexWrap: 'wrap', gap: 14 }}>
              {[
                { label: 'Best K/D',       r: bests.kd,        val: r => (r.kdVal||0).toFixed(2) },
                { label: 'Most Wins',      r: bests.wins,      val: r => num(r.wins||0) },
                { label: 'Most Kills',     r: bests.kills,     val: r => num(r.kills||0) },
                { label: 'Avg Damage',     r: bests.damage,    val: r => num(Math.round(r.avgDmg||0)) },
                { label: 'Top 10 Rate',    r: bests.top10,     val: r => pct(r.top10||0, r.games||1) },
                { label: 'HS Accuracy',    r: bests.headshot,  val: r => pct(r.hs||0, r.kills||1) },
                { label: 'Avg Survival',   r: bests.survive,   val: r => fmtSurvival(r.avgSurvival||0) },
                { label: 'Teamwork',       r: bests.teamwork,  val: r => `${num(r.revives||0)} revs` },
                { label: 'Most Assists',   r: bests.assists,   val: r => num(r.assists||0) },
                { label: 'Road Kills',     r: bests.roadKills, val: r => num(r.roadKills||0) },
              ].filter(c => c.r).map(({ label, r, val }) => (
                <div key={label} style={{ minWidth: 90 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-3)', marginBottom: 2 }}>{label}</div>
                  <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-1)' }}>{r.member?.name || r.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>{val(r)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Activity feed — only show if any player has recent matches ── */}
      {resolvedStats.some(r => r.recent?.length) && (
        <div>
          {/* Activity header — sunset sniper accent strip */}
          <div style={{ position: 'relative', height: 80, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border)', marginBottom: 16 }}>
            <img src="/images/img1.png" alt="" aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center bottom', opacity: 0.72, pointerEvents: 'none' }} />
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to right, rgba(7,11,18,.90) 0%, rgba(7,11,18,.50) 40%, rgba(7,11,18,.20) 70%, rgba(7,11,18,.65) 100%)', pointerEvents: 'none' }} />
            <div style={{ position: 'relative', height: '100%', display: 'flex', alignItems: 'center', padding: '0 24px', gap: 12 }}>
              <div>
                <div style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.2em', color: 'var(--accent)', marginBottom: 4 }}>Clan Activity</div>
                <div style={{ fontSize: 18, fontWeight: 900, color: '#fff', letterSpacing: '-.03em' }}>Recent Sessions</div>
              </div>
            </div>
          </div>
          <ActivityFeed resolvedStats={resolvedStats} />
        </div>
      )}

      {/* ── Stat detail modal ── */}
      {activeStat && (
        <StatDetailModal
          stat={activeStat}
          resolvedStats={resolvedStats}
          onClose={() => setActiveStat(null)}
        />
      )}
    </div>
  );
}
