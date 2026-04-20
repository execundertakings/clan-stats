// ── Leaderboard tab ───────────────────────────────────────────────────────────
// perGame: function that returns a formatted per-game avg string, shown as small
// grey sub-text below the total. Only set on cumulative columns (not ratios/maxes).
const LB_COLS = [
  { key: 'score', label: 'OVR', align: 'right', fmt: r => num(r.score), color: r => r.score >= 40 ? '#facc15' : r.score >= 20 ? 'var(--text-1)' : 'var(--text-2)', weight: 700,
    title: 'Overall Rating — calculated composite: K/D (×50) + Avg Dmg (×30) + Win Rate (×20). Same formula used to pick the MVP.' },
  { key: 'kd',           label: 'K/D',       align: 'right', fmt: r => r.kd.toFixed(2),           color: r => r.kd >= 2 ? '#4ade80' : r.kd >= 1 ? 'var(--text-1)' : '#f87171', weight: 700, title: 'Kill/Death ratio' },
  { key: 'matches',      label: 'Matches',   align: 'right', fmt: r => num(r.matches),             color: () => 'var(--text-2)' },
  { key: 'kills',        label: 'Kills',     align: 'right', fmt: r => num(r.kills),               perGame: r => r.matches ? round(r.kills / r.matches, 1) : null },
  { key: 'assists',      label: 'Assists',   align: 'right', fmt: r => num(r.assists),             perGame: r => r.matches ? round(r.assists / r.matches, 1) : null, title: 'Damage dealt on enemies killed by a teammate' },
  { key: 'dBNOs',        label: 'Knocks',    align: 'right', fmt: r => num(r.dBNOs),               perGame: r => r.matches ? round(r.dBNOs / r.matches, 1) : null, title: 'Knockdowns — Down But Not Out (dBNOs)' },
  { key: 'wins',         label: 'Wins',      align: 'right', fmt: r => num(r.wins),                color: r => r.wins > 0 ? '#f59e0b' : 'var(--text-2)', weight: r => r.wins > 0 ? 600 : 400 },
  { key: 'winRate',      label: 'Win%',      align: 'right', fmt: r => pct(r.wins, r.matches),     title: 'Win percentage' },
  { key: 'avgDamage',    label: 'Avg Dmg',   align: 'right', fmt: r => round(r.avgDamage, 0),      title: 'Average damage dealt per match' },
  { key: 'headshotKills',label: 'HS',        align: 'right', fmt: r => num(r.headshotKills),       perGame: r => r.matches ? round(r.headshotKills / r.matches, 2) : null, title: 'Headshot kills' },
  { key: 'hsRate',       label: 'HS%',       align: 'right', fmt: r => r.kills > 0 ? pct(r.headshotKills, r.kills) : '—', title: 'Headshot kill percentage' },
  { key: 'bestKills',    label: 'Best',      align: 'right', fmt: r => num(r.bestKills),           color: r => r.bestKills >= 10 ? '#4ade80' : undefined, title: 'Most kills in a single match' },
  { key: 'streak',       label: 'Streak',    align: 'right', fmt: r => num(r.streak),              color: r => r.streak >= 5 ? '#facc15' : undefined, title: 'Highest kill streak in a single match' },
  { key: 'revives',      label: 'Revives',   align: 'right', fmt: r => num(r.revives),             color: r => r.revives >= 10 ? '#60a5fa' : undefined, perGame: r => r.matches ? round(r.revives / r.matches, 2) : null, title: 'Teammate revives this season' },
  { key: 'top10',        label: 'Top 10',    align: 'right', fmt: r => num(r.top10),               perGame: r => r.matches ? pct(r.top10, r.matches) : null, title: 'Number of top-10 finishes (sub-value = top-10 rate)' },
  { key: 'avgSurvive',   label: 'Avg Surv',  align: 'right', fmt: r => fmtSurvival(r.avgSurvive),  title: 'Average survival time per match' },
  { key: 'longestKill',  label: 'Long K',    align: 'right', fmt: r => `${Math.round(r.longestKill)}m`, title: 'Longest kill distance in metres' },
  { key: 'boosts',       label: 'Boosts',    align: 'right', fmt: r => num(r.boosts),              perGame: r => r.matches ? round(r.boosts / r.matches, 1) : null, title: 'Boost items used (energy drinks, painkillers)' },
  { key: 'heals',        label: 'Heals',     align: 'right', fmt: r => num(r.heals),               perGame: r => r.matches ? round(r.heals / r.matches, 1) : null, title: 'Healing items used (medkits, bandages)' },
  { key: 'vehDestroys',  label: 'Veh💣',     align: 'right', fmt: r => num(r.vehDestroys),         color: r => r.vehDestroys >= 3 ? '#f97316' : undefined, perGame: r => r.matches ? round(r.vehDestroys / r.matches, 2) : null, title: 'Vehicles destroyed' },
  { key: 'roadKills',    label: '🚗💀',      align: 'right', fmt: r => num(r.roadKills),            color: r => r.roadKills >= 1 ? '#ef4444' : undefined, perGame: r => r.matches ? round(r.roadKills / r.matches, 2) : null, title: 'Road kills — enemies run over with a vehicle' },
  { key: 'distance',     label: 'Dist(km)',  align: 'right', fmt: r => num(Math.round(r.distance/1000)), perGame: r => r.matches ? `${round(r.distance/1000/r.matches, 1)}` : null, title: 'Total distance travelled (walk + ride + swim) in km' },
  { key: 'days',         label: 'Days',      align: 'right', fmt: r => num(r.days),                color: r => r.days >= 10 ? '#a78bfa' : undefined, title: 'Days played this season' },
  { key: 'sigWeapon',   label: '🔫 Weapon', align: 'left',  fmt: r => r.sigWeapon || '—',           color: () => 'var(--text-2)', title: 'Signature weapon — most kills with' },
  { key: 'formDelta',  label: 'Form',      align: 'right', fmt: r => {
    if (r.formDelta == null) return '—';
    const { trend, delta } = r._form;
    const sign = delta >= 0 ? '+' : '';
    const emoji = { hot: '🔥', warm: '📈', cold: '📉', cool: '🌡', steady: '→' }[trend] || '→';
    return `${emoji} ${sign}${Math.round(delta * 100)}%`;
  }, color: r => {
    if (!r._form) return 'var(--text-3)';
    const t = r._form.trend;
    return t === 'hot' ? '#fb923c' : t === 'warm' ? '#facc15' : t === 'cold' ? '#f87171' : t === 'cool' ? '#94a3b8' : 'var(--text-3)';
  }, title: 'Recent form — last 5 games vs overall average (kills + damage delta)' },
];

// ── Lifetime leaderboard columns ─────────────────────────────────────────────
const LT_COLS = [
  { key: 'kd',        label: 'K/D',      align: 'right', fmt: r => r.kd.toFixed(2),                    color: r => r.kd >= 2 ? '#4ade80' : r.kd >= 1 ? 'var(--text-1)' : '#f87171', weight: 700, title: 'Career Kill/Death ratio' },
  { key: 'games',     label: 'Games',    align: 'right', fmt: r => num(r.games),                        color: () => 'var(--text-2)' },
  { key: 'kills',     label: 'Kills',    align: 'right', fmt: r => num(r.kills),                        perGame: r => r.games ? round(r.kills / r.games, 1) : null },
  { key: 'wins',      label: 'Wins',     align: 'right', fmt: r => num(r.wins),                         color: r => r.wins > 0 ? '#f59e0b' : 'var(--text-2)', weight: r => r.wins > 0 ? 600 : 400 },
  { key: 'winRate',   label: 'Win%',     align: 'right', fmt: r => (r.winRate * 100).toFixed(1) + '%',  title: 'Career win percentage' },
  { key: 'avgDamage', label: 'Avg Dmg',  align: 'right', fmt: r => round(r.avgDamage, 0),               title: 'Career average damage per match' },
  { key: 'hsRate',    label: 'HS%',      align: 'right', fmt: r => (r.hsRate * 100).toFixed(1) + '%',   title: 'Career headshot kill percentage' },
  { key: 'top10Rate', label: 'Top 10%',  align: 'right', fmt: r => (r.top10Rate * 100).toFixed(1) + '%', title: 'Career top-10 finish rate' },
  { key: 'revivesPg', label: 'Rev/g',    align: 'right', fmt: r => r.revivesPg.toFixed(2),              color: r => r.revivesPg >= 0.5 ? '#60a5fa' : undefined, title: 'Teammate revives per game (career)' },
];

function Leaderboard({ resolvedStats, loading, weaponData, lifetimeData }) {
  const [sortCol, setSortCol]         = useState('kd');
  const [sortDir, setSortDir]         = useState(-1); // -1 = desc, 1 = asc
  const [ltView, setLtView]           = useState(false);
  const [seasons, setSeasons]         = useState(null);   // archived season list
  const [archiveSeason, setArchive]   = useState(null);   // currently viewing archive { seasonId, stats }
  const [archiveLoading, setArcLoad]  = useState(false);

  // Fetch season archive index once on mount
  useEffect(() => {
    api.get('/api/seasons').then(d => { if (d?.length) setSeasons(d); }).catch(() => {});
  }, []);

  // Load an archived season's full stats
  async function loadArchive(seasonId) {
    if (!seasonId) { setArchive(null); return; }
    setArcLoad(true);
    try {
      const data = await api.get(`/api/seasons/${encodeURIComponent(seasonId)}`);
      setArchive({ seasonId, stats: data.stats || [] });
    } catch { setArchive(null); }
    finally { setArcLoad(false); }
  }

  function handleSort(key) {
    if (sortCol === key) setSortDir(d => d * -1);
    else { setSortCol(key); setSortDir(-1); }
  }

  const rows = useMemo(() => {
    if (!resolvedStats?.length) return [];
    return resolvedStats
      .map(({ member, s, sApi, score, kdVal, winRate, avgDmg, avgSurvival, hsRate, boosts, heals, form }) => {
        return {
          name:          member.name,
          score,                                        // pre-computed OVR from trunk
          kills:         s?.kills || 0,
          deaths:        s?.losses || 0,
          wins:          s?.wins || 0,
          matches:       s?.roundsPlayed || 0,
          top10:         s?.top10s || 0,
          assists:       s?.assists || 0,
          headshotKills: s?.headshotKills || 0,
          kd:            kdVal,                         // pre-computed from trunk
          winRate,                                      // pre-computed from trunk
          avgDamage:     avgDmg,                        // pre-computed from trunk
          dBNOs:         s?.dBNOs || 0,
          revives:       sApi?.revives || 0,
          bestKills:     s?.roundMostKills || 0,
          streak:        sApi?.maxKillStreaks || 0,
          hsRate,                                       // pre-computed from trunk
          avgSurvive:    avgSurvival,                   // pre-computed from trunk
          longestKill:   sApi?.longestKill || 0,
          boosts,                                       // pre-computed from trunk
          heals,                                        // pre-computed from trunk
          vehDestroys:   sApi?.vehicleDestroys || 0,
          roadKills:     sApi?.roadKills || 0,
          distance:      (sApi?.walkDistance || 0) + (sApi?.rideDistance || 0) + (sApi?.swimDistance || 0),
          days:          sApi?.days || 0,
          sigWeapon:     (() => { const w = weaponData?.[member.accountId]?.weapons?.[0]; return w ? `${w.displayName} ${w.kills}K` : null; })(),
          _form:         form || null,
          formDelta:     form?.delta ?? null,
        };
      })
      .sort((a, b) => {
        if (sortCol === 'sigWeapon') return sortDir * (a.sigWeapon || '').localeCompare(b.sigWeapon || '');
        if (sortCol === 'formDelta') return sortDir * ((a.formDelta ?? -999) - (b.formDelta ?? -999));
        return sortDir * (a[sortCol] - b[sortCol]);
      });
  }, [resolvedStats, sortCol, sortDir, weaponData]);

  // Lifetime rows — built from /api/lifetime, sorted by the same sortCol where applicable
  const ltRows = useMemo(() => {
    if (!lifetimeData?.players) return [];
    return Object.values(lifetimeData.players)
      .sort((a, b) => {
        const aVal = a[sortCol] ?? 0;
        const bVal = b[sortCol] ?? 0;
        if (typeof aVal === 'string') return sortDir * aVal.localeCompare(bVal);
        return sortDir * (aVal - bVal);
      });
  }, [lifetimeData, sortCol, sortDir]);

  // Archive rows — built from a loaded historical season, same shape as `rows`
  const archiveRows = useMemo(() => {
    if (!archiveSeason?.stats) return [];
    return archiveSeason.stats
      .map(({ member, season: sd }) => {
        const s = extractStats(sd);
        if (!s) return null;
        return {
          name:          member.name,
          score:         computeScore((s.kills||0)/Math.max(s.losses||1,1), s.roundsPlayed?(s.damageDealt||0)/s.roundsPlayed:0, s.roundsPlayed?(s.wins||0)/s.roundsPlayed:0),
          kills:         s?.kills || 0,
          deaths:        s?.losses || 0,
          wins:          s?.wins || 0,
          matches:       s?.roundsPlayed || 0,
          top10:         s?.top10s || 0,
          assists:       s?.assists || 0,
          headshotKills: s?.headshotKills || 0,
          kd:            parseFloat(kd(s.kills || 0, s.losses || 0)),
          winRate:       s?.roundsPlayed ? s.wins / s.roundsPlayed : 0,
          avgDamage:     s?.roundsPlayed ? (s.damageDealt || 0) / s.roundsPlayed : 0,
          dBNOs:         s?.dBNOs || 0,
          revives:       s?.revives || 0,
          bestKills:     s?.roundMostKills || 0,
          streak:        s?.maxKillStreaks || 0,
          hsRate:        s?.kills > 0 ? (s.headshotKills || 0) / s.kills : 0,
          avgSurvive:    s?.roundsPlayed ? (s.timeSurvived || 0) / s.roundsPlayed : 0,
          longestKill:   s?.longestKill || 0,
          boosts:        s?.boosts || 0,
          heals:         s?.heals || 0,
          vehDestroys:   s?.vehicleDestroys || 0,
          roadKills:     s?.roadKills || 0,
          distance:      (s?.walkDistance || 0) + (s?.rideDistance || 0) + (s?.swimDistance || 0),
          days:          s?.days || 0,
          sigWeapon:     null,
          _form:         null,
          formDelta:     null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (sortCol === 'sigWeapon') return 0;
        if (sortCol === 'formDelta') return sortDir * ((a.formDelta ?? -999) - (b.formDelta ?? -999));
        return sortDir * (a[sortCol] - b[sortCol]);
      });
  }, [archiveSeason, sortCol, sortDir]);

  const activeCols = ltView ? LT_COLS : LB_COLS;
  const activeRows = ltView ? ltRows : archiveSeason ? archiveRows : rows;

  if (loading) return <div className="p-6"><div className="skeleton h-64 rounded-xl"/></div>;
  if (!resolvedStats?.length && !rows.length) return (
    <div className="flex flex-col items-center justify-center h-64 gap-3" style={{ color: 'var(--text-3)' }}>
      <Icon.chart /><p>No data yet. Add members in Settings.</p>
    </div>
  );

  const arrow = sortDir === -1 ? ' ↓' : ' ↑';

  return (
    <div className="p-6 space-y-4">
      <div className="lb-header" style={{ padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700 }}>
            Leaderboard
            {archiveSeason && <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-3)', marginLeft: 8 }}>
              — {seasons?.find(s => s.seasonId === archiveSeason.seasonId)?.label || archiveSeason.seasonId}
            </span>}
          </h2>
          {archiveLoading && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>loading…</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {seasons?.length > 0 && !ltView && (
            <select
              value={archiveSeason?.seasonId || ''}
              onChange={e => loadArchive(e.target.value || null)}
              style={{ fontSize: 11, padding: '4px 8px', borderRadius: 6, background: 'var(--bg-raised)', border: '1px solid var(--border)', color: 'var(--text-2)', cursor: 'pointer' }}
            >
              <option value="">Current Season</option>
              {seasons.map(s => (
                <option key={s.seasonId} value={s.seasonId}>{s.label} — {s.activePlayers} players, {num(s.totalGames)} games</option>
              ))}
            </select>
          )}
          {lifetimeData && (
            <div style={{ display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)', fontSize: 11, fontWeight: 600 }}>
              <button onClick={() => { setLtView(false); setArchive(null); }}
                style={{ padding: '4px 12px', cursor: 'pointer', background: !ltView ? 'var(--accent)' : 'var(--bg-raised)', color: !ltView ? '#fff' : 'var(--text-2)', border: 'none' }}>
                Season
              </button>
              <button onClick={() => { setLtView(true); setArchive(null); }}
                style={{ padding: '4px 12px', cursor: 'pointer', background: ltView ? 'var(--accent)' : 'var(--bg-raised)', color: ltView ? '#fff' : 'var(--text-2)', border: 'none' }}>
                Lifetime
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="stat-card p-0" style={{ overflow: 'hidden' }}>
        <div className="lb-scroll" style={{ overflowX: 'scroll', overflowY: 'visible', transform: 'rotateX(180deg)' }}>
        <table className="tbl" style={{ minWidth: 900, transform: 'rotateX(180deg)' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', width: 36 }}>#</th>
              <th style={{ textAlign: 'left', maxWidth: 130 }}>Player</th>
              {activeCols.map(col => (
                <th
                  key={col.key}
                  title={col.title}
                  style={{ textAlign: col.align, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
                    color: sortCol === col.key ? 'var(--accent)' : col.key === 'score' ? '#facc15' : undefined,
                    background: sortCol === col.key ? 'rgba(59,130,246,.06)' : undefined }}
                  onClick={() => handleSort(col.key)}
                >
                  {col.label}{sortCol === col.key ? arrow : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {activeRows.map((r, i) => (
              <tr key={r.name} style={{ background: sortCol !== 'kd' && i < 3 ? 'rgba(59,130,246,.03)' : undefined }}>
                <td>
                  <span style={{ fontWeight: 600 }}>
                    {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : <span style={{ color: 'var(--text-3)' }}>{i + 1}</span>}
                  </span>
                </td>
                <td style={{ fontWeight: 600, color: 'var(--text-1)', maxWidth: 130, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</td>
                {activeCols.map(col => {
                  const pg = col.perGame ? col.perGame(r) : null;
                  return (
                    <td key={col.key} style={{
                      textAlign: col.align,
                      fontWeight: typeof col.weight === 'function' ? col.weight(r) : col.weight,
                      color: col.color ? col.color(r) : undefined,
                      background: sortCol === col.key ? 'rgba(59,130,246,.04)' : undefined,
                      verticalAlign: 'middle',
                      lineHeight: 1.2,
                    }}>
                      {col.fmt(r)}
                      {pg !== null && pg !== undefined && (
                        <div style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 400, marginTop: 1 }}>{pg}</div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-3)' }}>
        Click any column header to sort · click again to reverse · <span style={{ opacity: 0.7 }}>grey sub-values = per-game average</span>
        {ltView && <span style={{ marginLeft: 8, color: 'var(--accent)', opacity: 0.9 }}>· Lifetime — all modes aggregated (solo + duo + squad FPP/TPP)</span>}
        {archiveSeason && !ltView && <span style={{ marginLeft: 8, color: '#f59e0b', opacity: 0.9 }}>· Archived season — read-only snapshot</span>}
      </p>
    </div>
  );
}
