// ── Overview tab ──────────────────────────────────────────────────────────────
const OVERVIEW_STATS = [
  { id: 'kd',       label: 'Clan K/D',     tip: 'Kill/Death ratio — total clan kills ÷ deaths', key: t => kd(t.kills, t.deaths),                                   sub: t => `${num(t.kills)} kills`,                     accent: true,  icon: '⚔️',
    detail: { title: 'K/D Ratio — Per Player', desc: 'Season kills ÷ deaths. Higher = more lethal.', playerKey: r => parseFloat(kd(r.s?.kills||0, r.s?.losses||0)), playerFmt: r => kd(r.s?.kills||0, r.s?.losses||0), playerSub: r => `${num(r.s?.kills||0)} kills / ${num(r.s?.losses||0)} deaths` } },
  { id: 'wins',     label: 'Total Wins',   tip: null, key: t => num(t.wins),                                              sub: t => pct(t.wins, t.matches) + ' win rate',         accent: false, icon: '🏆',
    detail: { title: 'Wins — Per Player', desc: 'Chicken dinners this season.', playerKey: r => r.s?.wins||0, playerFmt: r => num(r.s?.wins||0), playerSub: r => `${pct(r.s?.wins||0, r.s?.roundsPlayed||1)} win rate` } },
  { id: 'kills',    label: 'Clan Kills',   tip: null, key: t => num(t.kills),                                             sub: t => `${round(t.kills/Math.max(t.matches,1))} avg/match`, accent: false, icon: '💀',
    detail: { title: 'Kills — Per Player', desc: 'Total season kills per member.', playerKey: r => r.s?.kills||0, playerFmt: r => num(r.s?.kills||0), playerSub: r => `${round((r.s?.kills||0)/Math.max(r.s?.roundsPlayed||1,1))} avg/match` } },
  { id: 'damage',   label: 'Avg Damage',   tip: 'Average damage dealt per match across all players', key: t => num(Math.round(t.damage/Math.max(t.matches,1))),         sub: t => `${num(Math.round(t.damage))} total`,           accent: false, icon: '💥',
    detail: { title: 'Avg Damage — Per Player', desc: 'Average damage dealt per match.', playerKey: r => (r.s?.damageDealt||0)/Math.max(r.s?.roundsPlayed||1,1), playerFmt: r => num(Math.round((r.s?.damageDealt||0)/Math.max(r.s?.roundsPlayed||1,1))), playerSub: r => `${num(Math.round(r.s?.damageDealt||0))} total dmg` } },
  { id: 'top10',    label: 'Top 10 Rate',  tip: 'Percentage of matches finishing in the top 10', key: t => pct(t.top10, t.matches),                                 sub: t => `${num(t.top10)} top-10s`,                   accent: false, icon: '🎯',
    detail: { title: 'Top 10 Rate — Per Player', desc: 'How often they finish in the top 10.', playerKey: r => (r.s?.top10s||0)/Math.max(r.s?.roundsPlayed||1,1), playerFmt: r => pct(r.s?.top10s||0, r.s?.roundsPlayed||1), playerSub: r => `${num(r.s?.top10s||0)} top-10s` } },
  { id: 'matches',  label: 'Matches',      tip: null, key: t => num(t.matches),                                          sub: t => 'this season',                                accent: false, icon: '🎮',
    detail: { title: 'Matches Played — Per Player', desc: 'Season matches played.', playerKey: r => r.s?.roundsPlayed||0, playerFmt: r => num(r.s?.roundsPlayed||0), playerSub: r => `${num(r.s?.wins||0)} wins` } },
  { id: 'headshot', label: 'Headshot %',   tip: 'Percentage of kills that are headshots', key: t => t.kills > 0 ? pct(t.headshots, t.kills) : '—',          sub: t => `${num(t.headshots)} HS kills`,               accent: false, icon: '🔫',
    detail: { title: 'Headshot % — Per Player', desc: 'Share of kills that were headshots. Marker of aim precision.', playerKey: r => (r.s?.headshotKills||0)/Math.max(r.s?.kills||1,1), playerFmt: r => pct(r.s?.headshotKills||0, r.s?.kills||1), playerSub: r => `${num(r.s?.headshotKills||0)} HS / ${num(r.s?.kills||0)} kills` } },
  { id: 'survive',  label: 'Avg Survive',  tip: 'Average survival time per match', key: t => fmtSurvival(t.timeSurvived / Math.max(t.matches, 1)),   sub: t => `${num(Math.round(t.timeSurvived/60))} min total`, accent: false, icon: '⏱️',
    detail: { title: 'Avg Survival Time — Per Player', desc: 'Average minutes alive per match. Longer = better positioning.', playerKey: r => (r.s?.timeSurvived||0)/Math.max(r.s?.roundsPlayed||1,1), playerFmt: r => fmtSurvival((r.s?.timeSurvived||0)/Math.max(r.s?.roundsPlayed||1,1)), playerSub: r => `${num(Math.round((r.s?.timeSurvived||0)/60))} min total` } },
  { id: 'teamwork', label: 'Clan Revives', tip: 'Total teammate revives across all players this season', key: t => num(t.revives),                                          sub: t => `${num(t.dBNOs)} knockdowns`,                 accent: false, icon: '🤝',
    detail: { title: 'Revives — Per Player', desc: 'Teammates brought back up. A high number signals a strong team player.', playerKey: r => r.s?.revives||0, playerFmt: r => num(r.s?.revives||0), playerSub: r => `${num(r.s?.dBNOs||0)} knockdowns` } },
  { id: 'assists',  label: 'Assists',      tip: 'Damage dealt on enemies killed by a teammate', key: t => num(t.assists),                                          sub: t => 'this season',                                accent: false, icon: '🦾',
    detail: { title: 'Assists — Per Player', desc: 'Damage dealt to killed enemies without getting the kill.', playerKey: r => r.s?.assists||0, playerFmt: r => num(r.s?.assists||0), playerSub: r => `${num(r.s?.revives||0)} revives` } },
  { id: 'roadKills', label: 'Road Kills',  tip: 'Enemies run over with a vehicle', key: t => num(t.roadKills),                                      sub: t => `${num(t.vehicleDestroys)} veh destroys`,     accent: false, icon: '🚗',
    detail: { title: 'Road Kills — Per Player', desc: 'Enemies run over with a vehicle. Pure chaos metric.', playerKey: r => r.s?.roadKills||0, playerFmt: r => num(r.s?.roadKills||0), playerSub: r => `${num(r.s?.vehicleDestroys||0)} veh destroys` } },
  { id: 'daysActive', label: 'Days Active', tip: null, key: t => `${t.activePlayers} players`, sub: t => `avg ${Math.round(t.daysPlayed/Math.max(t.activePlayers,1))} days each`,  accent: false, icon: '📅',
    detail: { title: 'Days Active — Per Player', desc: 'Distinct days played this season. Shows who\'s grinding.', playerKey: r => r.s?.days||0, playerFmt: r => `${num(r.s?.days||0)} days`, playerSub: r => `${num(r.s?.roundsPlayed||0)} matches` } },
  { id: 'members', label: 'Members',       tip: null, key: (t, m) => m,                                              sub: t => 'tracked this season',                      accent: false, icon: '🦍',
    detail: null },
];

// ── Stat detail modal ─────────────────────────────────────────────────────────
function StatDetailModal({ stat, resolvedStats, onClose }) {
  if (!stat?.detail) return null;
  const { title, desc, playerKey, playerFmt, playerSub } = stat.detail;
  const rows = resolvedStats
    .map(({ member, s }) => ({ name: member.name, s }))
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
function Overview({ members, resolvedStats, season, loading, onLogoClick }) {
  const [activeStat, setActiveStat] = useState(null);
  const isMobile = useIsMobile();

  const totals = useMemo(() => {
    if (!resolvedStats?.length) return null;
    let kills = 0, deaths = 0, wins = 0, matches = 0, damage = 0, top10 = 0,
        assists = 0, headshots = 0, timeSurvived = 0, revives = 0, dBNOs = 0,
        roadKills = 0, vehicleDestroys = 0, daysPlayed = 0, activePlayers = 0;
    resolvedStats.forEach(({ s }) => {
      if (!s) return;
      kills           += s.kills           || 0;
      deaths          += s.losses          || 0;
      wins            += s.wins            || 0;
      matches         += s.roundsPlayed    || 0;
      damage          += s.damageDealt     || 0;
      top10           += s.top10s          || 0;
      assists         += s.assists         || 0;
      headshots       += s.headshotKills   || 0;
      timeSurvived    += s.timeSurvived    || 0;
      revives         += s.revives         || 0;
      dBNOs           += s.dBNOs           || 0;
      roadKills       += s.roadKills       || 0;
      vehicleDestroys += s.vehicleDestroys || 0;
      daysPlayed      += s.days            || 0;
      if ((s.roundsPlayed || 0) > 0) activePlayers++;
    });
    return { kills, deaths, wins, matches, damage, top10, assists, headshots,
             timeSurvived, revives, dBNOs, roadKills, vehicleDestroys, daysPlayed, activePlayers };
  }, [resolvedStats]);

  // Best player per category
  const bests = useMemo(() => {
    const rows = resolvedStats?.filter(r => r.s && (r.s.roundsPlayed || 0) > 0) || [];
    if (!rows.length) return {};
    const best = fn => rows.reduce((t, r) => !t || fn(r) > fn(t) ? r : t, null);
    return {
      kd:        best(r => r.s.losses ? (r.s.kills||0)/r.s.losses : (r.s.kills||0)),
      wins:      best(r => r.s.wins      || 0),
      kills:     best(r => r.s.kills     || 0),
      damage:    best(r => (r.s.damageDealt||0) / Math.max(r.s.roundsPlayed||1, 1)),
      top10:     best(r => (r.s.top10s||0)  / Math.max(r.s.roundsPlayed||1, 1)),
      headshot:  best(r => r.s.kills > 0 ? (r.s.headshotKills||0)/r.s.kills : 0),
      survive:   best(r => (r.s.timeSurvived||0) / Math.max(r.s.roundsPlayed||1, 1)),
      teamwork:  best(r => r.s.revives   || 0),
      assists:   best(r => r.s.assists   || 0),
      roadKills: best(r => r.s.roadKills || 0),
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

      {/* ── Hero banner ── */}
      <div className="hero-wrap" style={{ background: 'linear-gradient(135deg, rgba(59,130,246,.12) 0%, rgba(99,102,241,.08) 100%)', borderRadius: 18, padding: isMobile ? '24px 20px' : '32px 36px', border: '1px solid var(--border)', position: 'relative', overflow: 'hidden', cursor: onLogoClick ? 'default' : undefined }}>
        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at 80% 50%, rgba(59,130,246,.08), transparent 70%)', pointerEvents: 'none' }} />
        <div className="hero-pad" style={{ position: 'relative' }}>
          <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.16em', color: 'var(--accent)', marginBottom: 8 }}>
            {season ? formatSeason(season.id) : 'Current Season'}
          </div>
          <div className="hero-title" style={{ fontSize: isMobile ? 28 : 36, fontWeight: 800, color: 'var(--text-1)', letterSpacing: '-.03em', lineHeight: 1.05, marginBottom: 10 }}>
            APES Clan
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: 'var(--text-2)', fontWeight: 500 }}>🦍 {members.length} members</span>
            {totals.matches > 0 && <span style={{ fontSize: 13, color: 'var(--text-2)', fontWeight: 500 }}>🎮 {num(totals.matches)} matches</span>}
            {totals.wins > 0   && <span style={{ fontSize: 13, color: '#f59e0b',     fontWeight: 600 }}>🏆 {num(totals.wins)} wins</span>}
          </div>
        </div>
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

      {/* ── MVP highlights ── */}
      {Object.values(bests).some(Boolean) && (
        <div>
          <SectionHeader eyebrow="MVP Highlights" title="Best This Season" sub="One standout per stat category" />
          <div className="mvp-card stat-card" style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '18px 20px', flexWrap: 'wrap' }}>
            <div style={{ fontSize: 36, lineHeight: 1 }}>🏅</div>
            <div style={{ display: 'flex', flex: 1, flexWrap: 'wrap', gap: 14 }}>
              {[
                { label: 'Best K/D',       r: bests.kd,        val: r => kd(r.s?.kills||0, r.s?.losses||0) },
                { label: 'Most Wins',      r: bests.wins,      val: r => num(r.s?.wins||0) },
                { label: 'Most Kills',     r: bests.kills,     val: r => num(r.s?.kills||0) },
                { label: 'Avg Damage',     r: bests.damage,    val: r => num(Math.round((r.s?.damageDealt||0)/Math.max(r.s?.roundsPlayed||1,1))) },
                { label: 'Top 10 Rate',    r: bests.top10,     val: r => pct(r.s?.top10s||0, r.s?.roundsPlayed||1) },
                { label: 'HS Accuracy',    r: bests.headshot,  val: r => pct(r.s?.headshotKills||0, r.s?.kills||1) },
                { label: 'Avg Survival',   r: bests.survive,   val: r => fmtSurvival((r.s?.timeSurvived||0)/Math.max(r.s?.roundsPlayed||1,1)) },
                { label: 'Teamwork',       r: bests.teamwork,  val: r => `${num(r.s?.revives||0)} revs` },
                { label: 'Most Assists',   r: bests.assists,   val: r => num(r.s?.assists||0) },
                { label: 'Road Kills',     r: bests.roadKills, val: r => num(r.s?.roadKills||0) },
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
          <SectionHeader eyebrow="Clan Activity" title="Recent Sessions" sub="Grouped by play session" />
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
