// ── Leaderboard tab ───────────────────────────────────────────────────────────
// perGame: function that returns a formatted per-game avg string, shown as small
// grey sub-text below the total. Only set on cumulative columns (not ratios/maxes).
const LB_COLS = [
  { key: 'score', label: 'OVR', align: 'right', fmt: r => num(r.score), color: r => r.score >= 80 ? '#facc15' : r.score >= 50 ? 'var(--text-1)' : 'var(--text-2)', weight: 700,
    title: 'Overall Rating — composite of combat (K/D, dmg, HS%), survival (top-10 rate), outcomes (win rate, close-out), squad support (assists/g + revives/g), and volume (games played). 100 ≈ elite across the board.' },
  { key: 'kd',           label: 'K/D',       align: 'right', fmt: r => r.kd.toFixed(2),           color: r => r.kd >= 2 ? '#4ade80' : r.kd >= 1 ? 'var(--text-1)' : '#f87171', weight: 700, title: 'Kill/Death ratio — kills ÷ losses, where losses = (captured games − wins). PUBG\'s in-client K/D counts every round you died (including matches your team won but you didn\'t survive), so our number runs slightly higher than PUBG\'s display. Same methodology for every player, so internally consistent.' },
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
];

const LB_SORT_KEYS = new Set(LB_COLS.map(col => col.key));
const LT_SORT_KEYS = new Set(LT_COLS.map(col => col.key));

function Leaderboard({ resolvedStats, loading, weaponData, lifetimeData }) {
  const [sortCol, setSortCol] = useState('score');
  const [sortDir, setSortDir] = useState(-1); // -1 = desc, 1 = asc
  const [ltView, setLtView]   = useState(false);

  const seasonSortCol = LB_SORT_KEYS.has(sortCol) ? sortCol : 'score';
  const lifetimeSortCol = LT_SORT_KEYS.has(sortCol) ? sortCol : 'kd';
  const activeSortCol = ltView ? lifetimeSortCol : seasonSortCol;

  useEffect(() => {
    const expected = ltView ? lifetimeSortCol : seasonSortCol;
    if (sortCol !== expected && (ltView ? !LT_SORT_KEYS.has(sortCol) : !LB_SORT_KEYS.has(sortCol))) {
      setSortCol(expected);
      setSortDir(-1);
    }
  }, [ltView, sortCol, seasonSortCol, lifetimeSortCol]);

  function handleSort(key) {
    if (sortCol === key) setSortDir(d => d * -1);
    else { setSortCol(key); setSortDir(-1); }
  }

  const rows = useMemo(() => {
    if (!resolvedStats?.length) return [];
    return resolvedStats
      .map(({ member, s, score, kdVal, winRate, avgDmg, avgSurvival, hsRate,
               boosts, heals, revives, vehicleDestroys, roadKills, longestKill,
               days, streak, form, coverage }) => {
        const covSummary = historyCoverageSummary(coverage);
        const covPartial = !!(covSummary?.apiRounds && !covSummary.trusted);
        return {
          name:          member.name,
          coverage:      covSummary,
          covPartial,
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
          revives,                                      // telemetry-derived (weapon_cache)
          bestKills:     s?.roundMostKills || 0,
          streak,                                       // history-derived (roundMostKills proxy)
          hsRate,                                       // pre-computed from trunk
          avgSurvive:    avgSurvival,                   // pre-computed from trunk
          longestKill,                                  // telemetry-derived (weapon_cache)
          boosts,                                       // telemetry-derived (weapon_cache)
          heals,                                        // telemetry-derived (weapon_cache)
          vehDestroys:   vehicleDestroys,               // telemetry-derived (weapon_cache)
          roadKills,                                    // telemetry-derived (weapon_cache)
          days,                                         // history-derived (daysPlayed)
          sigWeapon:     (() => {
            const w = weaponData?.[member.accountId]?.weapons?.[0];
            return w ? `${w.displayName}${w.status?.retiringSoon ? ' (42.1)' : ''} ${w.kills}K` : null;
          })(),
          _form:         form || null,
          formDelta:     form?.delta ?? null,
        };
      })
      .filter(r => r.matches > 0)
      .sort((a, b) => {
        if (seasonSortCol === 'sigWeapon') return sortDir * (a.sigWeapon || '').localeCompare(b.sigWeapon || '');
        if (seasonSortCol === 'formDelta') return sortDir * ((a.formDelta ?? -999) - (b.formDelta ?? -999));
        return sortDir * (a[seasonSortCol] - b[seasonSortCol]);
      });
  }, [resolvedStats, seasonSortCol, sortDir, weaponData]);

  // Lifetime rows — built from /api/lifetime, sorted by the same sortCol where applicable
  const ltRows = useMemo(() => {
    if (!lifetimeData?.players) return [];
    return Object.values(lifetimeData.players)
      .sort((a, b) => {
        const aVal = a[lifetimeSortCol] ?? 0;
        const bVal = b[lifetimeSortCol] ?? 0;
        if (typeof aVal === 'string') return sortDir * aVal.localeCompare(bVal);
        return sortDir * (aVal - bVal);
      });
  }, [lifetimeData, lifetimeSortCol, sortDir]);

  const activeCols = ltView ? LT_COLS : LB_COLS;
  const activeRows = ltView ? ltRows : rows;

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
        <h2 style={{ fontSize: 18, fontWeight: 700 }}>Leaderboard</h2>
        {lifetimeData && (
          <div style={{ display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)', fontSize: 11, fontWeight: 600 }}>
            <button onClick={() => setLtView(false)}
              style={{ padding: '4px 12px', cursor: 'pointer', background: !ltView ? 'var(--accent)' : 'var(--bg-raised)', color: !ltView ? '#fff' : 'var(--text-2)', border: 'none' }}>
              Season
            </button>
            <button onClick={() => setLtView(true)}
              style={{ padding: '4px 12px', cursor: 'pointer', background: ltView ? 'var(--accent)' : 'var(--bg-raised)', color: ltView ? '#fff' : 'var(--text-2)', border: 'none' }}>
              Lifetime
            </button>
          </div>
        )}
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
                    color: activeSortCol === col.key ? 'var(--accent)' : col.key === 'score' ? '#facc15' : undefined,
                    background: activeSortCol === col.key ? 'rgba(59,130,246,.06)' : undefined }}
                  onClick={() => handleSort(col.key)}
                >
                  {col.label}{activeSortCol === col.key ? arrow : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {activeRows.map((r, i) => (
              <tr key={r.name} style={{ background: activeSortCol !== 'score' && i < 3 ? 'rgba(59,130,246,.03)' : undefined }}>
                <td>
                  <span style={{ fontWeight: 600 }}>
                    {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : <span style={{ color: 'var(--text-3)' }}>{i + 1}</span>}
                  </span>
                </td>
                <td style={{ fontWeight: 600, color: 'var(--text-1)', maxWidth: 150, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {r.name}
                  {r.covPartial && (
                    <span
                      title={`Match cache covers ${r.coverage.usedMatches}/${r.coverage.apiRounds} of this player's season squad games (joined late — PUBG only exposes the recent slice of matches). Stats shown reflect captured games only.`}
                      style={{ marginLeft: 6, fontSize: 9, fontWeight: 600, color: '#fbbf24', background: 'rgba(251,191,36,.10)', border: '1px solid rgba(251,191,36,.30)', padding: '1px 4px', borderRadius: 3, verticalAlign: 'middle', cursor: 'help' }}
                    >
                      {r.coverage.usedMatches}/{r.coverage.apiRounds}
                    </span>
                  )}
                </td>
                {activeCols.map(col => {
                  const pg = col.perGame ? col.perGame(r) : null;
                  return (
                    <td key={col.key} style={{
                      textAlign: col.align,
                      fontWeight: typeof col.weight === 'function' ? col.weight(r) : col.weight,
                      color: col.color ? col.color(r) : undefined,
                      background: activeSortCol === col.key ? 'rgba(59,130,246,.04)' : undefined,
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
        {ltView && <span style={{ marginLeft: 8, color: 'var(--accent)', opacity: 0.9 }}>· Lifetime — official squad matches only (PUBG lifetime squad stats)</span>}
      </p>
    </div>
  );
}
