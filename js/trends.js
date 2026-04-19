// ── Shared Trends sub-components (module scope — stable refs, no remount) ─────
function SectionCard({ label, title, subtitle, accentColor = '#60a5fa', children }) {
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 2, background: `linear-gradient(90deg, ${accentColor}, ${accentColor}44)` }} />
      <div style={{ padding: '20px 22px 18px' }}>
        <div style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.1em', color: accentColor, marginBottom: 5 }}>{label}</div>
        <div style={{ fontWeight: 800, fontSize: 15, letterSpacing: '-.01em', marginBottom: subtitle ? 5 : 14, color: 'var(--text-1)', lineHeight: 1.2 }}>{title}</div>
        {subtitle && <div style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.55, marginBottom: 16 }}>{subtitle}</div>}
        {children}
      </div>
    </div>
  );
}

function SectionRule({ label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '4px 0' }}>
      <div style={{ height: 1, width: 20, background: 'var(--border)', flexShrink: 0 }} />
      <div style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.12em', color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{label}</div>
      <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
    </div>
  );
}

// ── Insight card helpers (module scope — stable refs) ─────────────────────────
const insightAccentColor = t => t === 'counterintuitive' ? '#f87171' : t === 'warning' ? '#fb923c' : '#60a5fa';

const APE_CARD_IMGS = {
  efficiency_killer:  '/images/img7.png',
  headshot_trap:      '/images/ape_sniper.png',
  dark_horse_winners: '/images/img5.png',
  closeout_crisis:    '/images/img3.png',
  vicsgmg_anomaly:    '/images/img4.png',
  boosts_vs_wins:     '/images/img6.png',
};

// data and viz are pre-computed by Trends and passed in so InsightCard has no closures
function InsightCard({ ins, data, viz }) {
  const color = insightAccentColor(ins.type);
  const img   = APE_CARD_IMGS[ins.id];
  const typeLabel = ins.type === 'counterintuitive' ? 'Surprising' : ins.type === 'warning' ? 'Warning' : 'Insight';
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>

      {/* ── Image header ─────────────────────────────── */}
      <div style={{ position: 'relative', height: 165, overflow: 'hidden', flexShrink: 0 }}>
        <img src={img} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center 18%' }} />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(135deg, rgba(7,11,18,.92) 0%, rgba(7,11,18,.50) 60%, rgba(7,11,18,.78) 100%)' }} />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, transparent 38%, var(--bg-card) 100%)' }} />
        {/* Top accent bar */}
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg, ${color}, transparent)` }} />

        <div style={{ position: 'relative', zIndex: 1, padding: '14px 20px', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', boxSizing: 'border-box' }}>
          {/* Top row: category label + type badge */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontSize: 17, filter: 'drop-shadow(0 1px 6px rgba(0,0,0,.9))' }}>{ins.icon}</span>
              <span style={{ fontWeight: 800, fontSize: 13.5, color: '#fff', lineHeight: 1.25, textShadow: '0 1px 12px rgba(0,0,0,.95)', letterSpacing: '-.01em' }}>{ins.title}</span>
            </div>
            <div style={{ fontSize: 8.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.1em', color, background: 'rgba(7,11,18,.8)', border: `1px solid ${color}44`, borderRadius: 6, padding: '3px 8px', flexShrink: 0, backdropFilter: 'blur(8px)' }}>
              {typeLabel}
            </div>
          </div>
          {/* Bottom: hero stat */}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
            <div style={{ fontSize: 52, fontWeight: 900, color, lineHeight: 1, letterSpacing: '-.04em', textShadow: `0 0 50px ${color}66, 0 2px 12px rgba(0,0,0,.95)` }}>{data.hero}</div>
            <div style={{ paddingBottom: 4 }}>
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,.85)', fontWeight: 700, textShadow: '0 1px 6px rgba(0,0,0,.8)', letterSpacing: '-.01em' }}>{data.heroUnit}</div>
              {data.heroSub && <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,.65)', marginTop: 2, fontWeight: 400 }}>{data.heroSub}</div>}
            </div>
          </div>
        </div>
      </div>

      {/* ── Visualization ─────────────────────────────── */}
      {viz && (
        <div style={{ padding: '16px 22px 8px', borderBottom: '1px solid var(--border)' }}>
          {viz}
        </div>
      )}

      {/* ── Finding + tip + players ───────────────────── */}
      <div style={{ padding: '16px 22px 20px', display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-2)', lineHeight: 1.7, fontWeight: 400 }}>{ins.finding}</p>
        <div style={{ background: `${color}0d`, border: `1px solid ${color}22`, borderRadius: 8, padding: '10px 14px', fontSize: 12, color: 'var(--text-3)', lineHeight: 1.6 }}>
          {ins.tip}
        </div>
        {ins.players?.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {ins.players.map(p => (
              <span key={p} style={{ fontSize: 10.5, fontWeight: 700, padding: '3px 10px', borderRadius: 7, color, background: `${color}12`, border: `1px solid ${color}30`, letterSpacing: '-.01em' }}>{p}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Trends ────────────────────────────────────────────────────────────────────

function Trends({ resolvedStats, loading, weaponData, squadData, heatmapData }) {
  const [insights, setInsights] = useState(null);
  const isMobile = useIsMobile();

  useEffect(() => {
    api.get('/api/analysis').then(d => { if (d.insights?.length) setInsights(d); }).catch(() => {});
  }, []);

  const players = useMemo(() => {
    if (!resolvedStats?.length) return [];
    return resolvedStats.map(({ member, s, sApi }) => {
      if (!s || (s.roundsPlayed || 0) < 5) return null;
      return {
        name: member.name,
        kd: s.kills / Math.max(s.losses || 1, 1),
        winRate: s.wins / s.roundsPlayed,
        top10Rate: s.top10s / s.roundsPlayed,
        closeOutRate: s.top10s > 0 ? s.wins / s.top10s : 0,
        hsRate: s.kills > 3 ? s.headshotKills / s.kills : 0,
        dmgPerKill: s.kills > 3 ? s.damageDealt / s.kills : null,
        boostsPerGame: (sApi?.boosts || 0) / s.roundsPlayed,
        matches: s.roundsPlayed, wins: s.wins, top10s: s.top10s,
      };
    }).filter(Boolean);
  }, [resolvedStats]);

  // Clan-wide map performance aggregated from match history (via resolvedStats.recent)
  const clanMapStats = useMemo(() => {
    if (!resolvedStats?.length) return null;
    const maps = {};
    for (const { recent } of resolvedStats) {
      for (const m of recent || []) {
        if (!maps[m.map]) maps[m.map] = { played: 0, wins: 0, kills: 0, damage: 0 };
        maps[m.map].played++;
        if (m.won) maps[m.map].wins++;
        maps[m.map].kills  += m.kills;
        maps[m.map].damage += m.damage;
      }
    }
    return Object.entries(maps)
      .map(([map, s]) => ({ map, played: s.played, wins: s.wins, winRate: +(s.wins / s.played).toFixed(3), avgKills: +(s.kills / s.played).toFixed(2), avgDmg: Math.round(s.damage / s.played) }))
      .sort((a, b) => b.played - a.played);
  }, [resolvedStats]);

  // Form leaderboard — include ALL players so chart shows full distribution
  const formRanking = useMemo(() => {
    if (!resolvedStats?.length) return null;
    return resolvedStats
      .filter(e => e.form)
      .map(e => ({ name: e.member.name, form: e.form }))
      .sort((a, b) => b.form.delta - a.form.delta);
  }, [resolvedStats]);

  // Knockdown conversion: per player, total knocks vs kills from weapon cache
  const knockdownStats = useMemo(() => {
    if (!weaponData) return null;
    return Object.values(weaponData)
      .map(p => {
        const totalKills  = p.weapons.reduce((s, w) => s + w.kills, 0);
        const totalKnocks = p.weapons.reduce((s, w) => s + (w.knockdowns || 0), 0);
        if (totalKnocks < 5) return null;
        return {
          name:         p.name,
          kills:        totalKills,
          knockdowns:   totalKnocks,
          finishRate:   totalKnocks > 0 ? +(totalKills / totalKnocks).toFixed(2) : 0,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.finishRate - b.finishRate); // ascending: worst finishers first
  }, [weaponData]);

  // Blue zone damage ranking from weapon cache
  const blueZoneRanking = useMemo(() => {
    if (!weaponData) return null;
    return Object.values(weaponData)
      .filter(p => p.blueZone?.matches >= 5)
      .map(p => ({ name: p.name, ...p.blueZone }))
      .sort((a, b) => b.avgDmgPerGame - a.avgDmgPerGame);
  }, [weaponData]);

  // Compute hero stat + bar rows for each insight id
  function cardData(id) {
    switch (id) {
      case 'efficiency_killer': {
        const rows = players.filter(p => p.dmgPerKill && p.matches >= 8).sort((a, b) => a.dmgPerKill - b.dmgPerKill);
        const best = rows[0];
        return {
          hero: Math.round(best?.dmgPerKill || 0),
          heroUnit: 'dmg / kill',
          heroSub: best?.name,
          rows: rows.slice(0, 8).map(p => ({ name: p.name, val: p.dmgPerKill, max: rows[rows.length-1]?.dmgPerKill || 1, label: Math.round(p.dmgPerKill), winRate: p.winRate, best: p.wins === (Math.max(...rows.map(x=>x.wins))) })),
          rowUnit: 'Win%',
        };
      }
      case 'headshot_trap': {
        const rows = players.filter(p => p.hsRate > 0 && p.matches >= 8).sort((a, b) => b.hsRate - a.hsRate);
        const topHsZeroWins = rows.filter(p => p.wins === 0).length;
        return {
          hero: topHsZeroWins,
          heroUnit: 'zero-win HS leaders',
          heroSub: 'among players with highest HS%',
          rows: rows.slice(0, 8).map(p => ({ name: p.name, val: p.hsRate, max: rows[0]?.hsRate || 1, label: (p.hsRate * 100).toFixed(0) + '%', winRate: p.winRate })),
          rowUnit: 'Win%',
        };
      }
      case 'dark_horse_winners': {
        const pool = players.filter(p => p.matches >= 10);
        const byKd  = [...pool].sort((a, b) => b.kd - a.kd);
        const byWin = [...pool].sort((a, b) => b.winRate - a.winRate);
        const best  = byKd.reduce((b, p, ki) => { const wi = byWin.findIndex(x => x.name === p.name); return (ki - wi) > b.flip ? { flip: ki-wi, name: p.name, kdR: ki+1, winR: wi+1 } : b; }, { flip: 0 });
        return {
          hero: `#${best.winR}`,
          heroUnit: 'win rank',
          heroSub: `${best.name} (K/D rank #${best.kdR})`,
          kdRows: byKd.slice(0, 9).map((p, ki) => ({ name: p.name, ki, wi: byWin.findIndex(x => x.name === p.name), kd: p.kd, winRate: p.winRate })),
          byWin,
        };
      }
      case 'closeout_crisis': {
        const valid = players.filter(p => p.top10s > 0 && p.matches >= 8).sort((a, b) => b.closeOutRate - a.closeOutRate);
        const avg = valid.reduce((s, p) => s + p.closeOutRate, 0) / (valid.length || 1);
        return {
          hero: (avg * 100).toFixed(0) + '%',
          heroUnit: 'clan close-out rate',
          heroSub: 'top-10s that become wins',
          rows: valid.slice(0, 9).map(p => ({ name: p.name, top10Pct: p.top10Rate * 100, winPct: p.winRate * 100, closeOut: p.closeOutRate })),
        };
      }
      case 'vicsgmg_anomaly': {
        const vic = players.find(p => p.name === 'Vicsgmg');
        if (!vic) return { hero: '—', heroUnit: '', heroSub: '', peerRows: [] };
        const peers = [...players].filter(p => p.name !== 'Vicsgmg' && p.matches >= 8 && Math.abs(p.kd - vic.kd) < 0.4)
          .sort((a,b) => Math.abs(a.kd-vic.kd)-Math.abs(b.kd-vic.kd)).slice(0, 4);
        return {
          hero: vic.wins,
          heroUnit: `wins from ${vic.matches} games`,
          heroSub: `${(vic.winRate * 100).toFixed(1)}% win rate`,
          peerRows: [vic, ...peers],
        };
      }
      case 'boosts_vs_wins': {
        const rows = players.filter(p => p.matches >= 8).sort((a, b) => b.boostsPerGame - a.boostsPerGame);
        const top = rows[0];
        return {
          hero: top?.boostsPerGame.toFixed(1),
          heroUnit: 'boosts / game',
          heroSub: top?.name + ' · ' + (top?.winRate * 100).toFixed(1) + '% wins',
          rows: rows.slice(0, 8).map(p => ({ name: p.name, val: p.boostsPerGame, max: top?.boostsPerGame || 1, label: p.boostsPerGame.toFixed(1), winRate: p.winRate })),
          rowUnit: 'Win%',
        };
      }
      default: return { hero: '—', heroUnit: '', heroSub: '' };
    }
  }

  // ── Viz components ────────────────────────────────────────────────────────

  // Bar rows: primary metric drives bar width, win rate colors the bar
  function SimpleBarViz({ rows }) {
    if (!rows?.length) return null;
    const maxVal = Math.max(...rows.map(r => r.val));
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map(r => {
          const w  = Math.min((r.val / maxVal) * 100, 100);
          const wc = r.winRate > 0.15 ? '#4ade80' : r.winRate > 0.07 ? '#facc15' : '#94a3b8';
          return (
            <div key={r.name}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                <div style={{ width: 90, fontSize: 11.5, fontWeight: 500, color: 'var(--text-2)', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>{r.name}</div>
                <div style={{ flex: 1, height: 18, background: 'var(--bg-surface)', borderRadius: 5, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: w + '%', background: wc, opacity: 0.75, borderRadius: 5, transition: 'width .4s' }} />
                </div>
                <div style={{ width: 40, fontSize: 13, color: 'var(--text-1)', fontWeight: 700, textAlign: 'right', flexShrink: 0 }}>{r.label}</div>
              </div>
              <div style={{ paddingLeft: 98, fontSize: 9.5, color: wc }}>
                {(r.winRate * 100).toFixed(0)}% win rate
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // Rank divergence: K/D rank vs win rank — shows overachievers / underachievers
  function RankViz({ kdRows, byWin }) {
    if (!kdRows?.length) return null;
    const maxDelta = Math.max(...kdRows.map(r => Math.abs(r.ki - r.wi)), 1);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {/* Column headers */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, paddingBottom: 6, marginBottom: 2, borderBottom: '1px solid var(--border)' }}>
          <div style={{ width: 22, flexShrink: 0 }} />
          <div style={{ flex: 1, fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--text-3)' }}>Player</div>
          <div style={{ width: 36, fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--text-3)', textAlign: 'right', flexShrink: 0 }}><Tip label="Kill/Death ratio">K/D</Tip></div>
          <div style={{ width: 52, fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--text-3)', textAlign: 'right', flexShrink: 0 }}><Tip label="Win percentage">Win%</Tip></div>
          <div style={{ width: 52, fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--text-3)', textAlign: 'right', flexShrink: 0, paddingRight: 4 }}><Tip label="Win rank minus K/D rank — positive = wins more than kill stats suggest">Shift</Tip></div>
        </div>
        {kdRows.map(({ name, ki, wi, kd, winRate }) => {
          const delta = ki - wi; // positive = wins better than K/D rank
          const dc = delta >= 3 ? '#4ade80' : delta >= 1 ? '#a3e635' : delta <= -2 ? '#f87171' : 'var(--text-3)';
          const shiftW = Math.min(Math.abs(delta) / maxDelta * 100, 100);
          return (
            <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 0, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              {/* K/D rank chip */}
              <div style={{ width: 22, height: 18, borderRadius: 4, background: 'var(--bg-surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: 'var(--text-3)', flexShrink: 0, marginRight: 6 }}>{ki+1}</div>
              {/* Name */}
              <div style={{ flex: 1, fontSize: 12.5, fontWeight: Math.abs(delta) >= 3 ? 700 : 400, color: delta >= 3 ? '#4ade80' : delta <= -2 ? '#f87171' : 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
              {/* K/D */}
              <div style={{ width: 36, fontSize: 11, color: 'var(--text-3)', textAlign: 'right', flexShrink: 0 }}>{kd.toFixed(2)}</div>
              {/* Win% */}
              <div style={{ width: 52, fontSize: 12, color: dc, fontWeight: 600, textAlign: 'right', flexShrink: 0 }}>{(winRate * 100).toFixed(1)}%</div>
              {/* Shift bar */}
              <div style={{ width: 52, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 3, flexShrink: 0, paddingRight: 2 }}>
                <div style={{ width: 28, height: 6, background: 'var(--bg-surface)', borderRadius: 3, overflow: 'hidden', position: 'relative' }}>
                  <div style={{ position: 'absolute', width: shiftW + '%', height: '100%', background: dc, borderRadius: 3, left: delta >= 0 ? 0 : 'auto', right: delta < 0 ? 0 : 'auto' }} />
                </div>
                <span style={{ fontSize: 11, color: dc, fontWeight: 700, minWidth: 16, textAlign: 'right' }}>{delta >= 0 ? '+' : ''}{delta}</span>
              </div>
            </div>
          );
        })}
        <div style={{ fontSize: 9.5, color: 'var(--text-3)', marginTop: 8 }}>Shift = win rank minus K/D rank · positive means outperforming their kill stats</div>
      </div>
    );
  }

  // Stacked closeout bars: ghost bar = top-10 rate, solid bar = win rate, callout = close-out rate
  function CloseoutViz({ rows }) {
    if (!rows?.length) return null;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map(r => {
          const cc = r.closeOut > 0.28 ? '#4ade80' : r.closeOut > 0.14 ? '#facc15' : '#f87171';
          return (
            <div key={r.name}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                <div style={{ width: 90, fontSize: 11.5, color: 'var(--text-2)', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>{r.name}</div>
                <div style={{ flex: 1, height: 18, background: 'var(--bg-surface)', borderRadius: 5, overflow: 'hidden', position: 'relative' }}>
                  <div style={{ position: 'absolute', left: 0, height: '100%', width: Math.min(r.top10Pct, 100) + '%', background: '#3b82f6', opacity: 0.18, borderRadius: 5 }} />
                  <div style={{ position: 'absolute', left: 0, height: '100%', width: Math.min(r.winPct, 100) + '%', background: cc, opacity: 0.82, borderRadius: 5, transition: 'width .4s' }} />
                </div>
                <div style={{ width: 36, fontSize: 13, color: cc, fontWeight: 700, textAlign: 'right', flexShrink: 0 }}>{(r.closeOut * 100).toFixed(0)}%</div>
              </div>
              <div style={{ paddingLeft: 98, fontSize: 9.5, color: 'var(--text-3)' }}>
                closes {(r.closeOut * 100).toFixed(0)}% of top-10s · {r.top10Pct.toFixed(1)}% top-10 rate
              </div>
            </div>
          );
        })}
        <div style={{ display: 'flex', gap: 14, paddingLeft: 98, marginTop: 4, fontSize: 9.5, color: 'var(--text-3)', alignItems: 'center' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ display: 'inline-block', width: 10, height: 6, background: '#3b82f6', opacity: 0.35, borderRadius: 2 }} /> Top 10 rate</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ display: 'inline-block', width: 10, height: 6, background: '#4ade80', borderRadius: 2 }} /> Win rate</span>
          <span style={{ marginLeft: 'auto' }}>% shown = close-out rate</span>
        </div>
      </div>
    );
  }

  // Peer comparison: focus player highlighted, mini sparkbars for each metric
  function PeerViz({ peerRows }) {
    if (!peerRows?.length) return null;
    const metrics = [
      { k: 'kd',           label: 'K/D',    tip: 'Kill/Death ratio',                              fmt: v => v.toFixed(2) },
      { k: 'top10Rate',    label: 'Top 10', tip: 'Top-10 finish rate',                            fmt: v => (v*100).toFixed(0)+'%' },
      { k: 'winRate',      label: 'Win%',   tip: 'Win percentage',                                fmt: v => (v*100).toFixed(1)+'%' },
      { k: 'closeOutRate', label: 'Close',  tip: 'Close-out rate — top-10s converted to wins',    fmt: v => (v*100).toFixed(0)+'%' },
    ];
    const maxes = {};
    metrics.forEach(m => { maxes[m.k] = Math.max(...peerRows.map(p => p[m.k] || 0), 0.01); });
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 6, borderBottom: '1px solid var(--border)', marginBottom: 2 }}>
          <div style={{ flex: 1 }} />
          {metrics.map(m => (
            <div key={m.k} style={{ width: 52, fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--text-3)', textAlign: 'right', flexShrink: 0 }}>
              {m.tip ? <Tip label={m.tip}>{m.label}</Tip> : m.label}
            </div>
          ))}
        </div>
        {peerRows.map((p, i) => {
          const isFocus = i === 0;
          return (
            <div key={p.name} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '7px 0', borderBottom: i < peerRows.length-1 ? '1px solid var(--border)' : 'none', background: isFocus ? 'rgba(250,204,21,.04)' : 'transparent', borderRadius: isFocus ? 6 : 0, margin: isFocus ? '2px -4px' : 0, padding: isFocus ? '7px 4px' : '7px 0' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12.5, fontWeight: isFocus ? 700 : 400, color: isFocus ? '#facc15' : 'var(--text-2)' }}>{p.name}</div>
                {isFocus && <div style={{ fontSize: 9.5, color: 'var(--text-3)', marginTop: 1 }}>focus player</div>}
              </div>
              {metrics.map(m => {
                const val  = p[m.k] || 0;
                const pct  = (val / maxes[m.k]) * 100;
                const isWR = m.k === 'winRate';
                const valColor = isFocus && isWR ? '#f87171' : 'var(--text-1)';
                return (
                  <div key={m.k} style={{ width: 52, textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: isFocus && isWR ? 800 : 500, color: valColor }}>{m.fmt(val)}</div>
                    <div style={{ height: 3, background: 'var(--bg-surface)', borderRadius: 2, overflow: 'hidden', marginTop: 3 }}>
                      <div style={{ width: pct + '%', height: '100%', background: isFocus && isWR ? '#f87171' : isFocus ? '#facc15' : 'var(--border)', borderRadius: 2, transition: 'width .4s' }} />
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  }

  function buildViz(id, data) {
    switch (id) {
      case 'efficiency_killer':  return <SimpleBarViz rows={data.rows} />;
      case 'headshot_trap':      return <SimpleBarViz rows={data.rows} />;
      case 'dark_horse_winners': return <RankViz kdRows={data.kdRows} byWin={data.byWin} />;
      case 'closeout_crisis':    return <CloseoutViz rows={data.rows} />;
      case 'vicsgmg_anomaly':    return <PeerViz peerRows={data.peerRows} />;
      case 'boosts_vs_wins':     return <SimpleBarViz rows={data.rows} />;
      default: return null;
    }
  }

  if (loading) return <div className="p-6"><div className="skeleton h-64 rounded-xl" /></div>;
  if (!players.length) return (
    <div className="flex flex-col items-center justify-center h-64 gap-3" style={{ color: 'var(--text-3)' }}>
      <Icon.trend /><p>No data yet — add members in Settings.</p>
    </div>
  );

  const col1ids = ['efficiency_killer', 'dark_horse_winners', 'boosts_vs_wins'];
  const col2ids = ['headshot_trap', 'closeout_crisis', 'vicsgmg_anomaly'];

  const col1 = insights?.insights?.filter(i => col1ids.includes(i.id)).sort((a,b) => col1ids.indexOf(a.id)-col1ids.indexOf(b.id)) || [];
  const col2 = insights?.insights?.filter(i => col2ids.includes(i.id)).sort((a,b) => col2ids.indexOf(a.id)-col2ids.indexOf(b.id)) || [];

  return (
    <div className="p-6" style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>

      {/* ── Page Header ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, paddingBottom: 4, borderBottom: '1px solid var(--border)' }}>
        <div>
          <div style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.12em', color: 'var(--accent)', marginBottom: 6 }}>Season Report</div>
          <h2 style={{ fontSize: 24, fontWeight: 900, letterSpacing: '-.03em', margin: 0, lineHeight: 1 }}>Trends &amp; Insights</h2>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6 }}>{players.length} active members · AI-powered analysis</div>
        </div>
        {insights?.computedAt && (() => {
          const m = Math.round((Date.now() - new Date(insights.computedAt)) / 60000);
          return (
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--text-3)', marginBottom: 3 }}>Last updated</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-2)' }}>{m < 60 ? `${m}m ago` : `${Math.round(m/60)}h ago`}</div>
            </div>
          );
        })()}
      </div>

      {/* ── Section: AI Insights ─────────────────────────────────────────────── */}
      <SectionRule label="AI Insights" />

      {insights ? (
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexDirection: isMobile ? 'column' : 'row' }}>
          <div style={{ flex: isMobile ? 'none' : '11', width: isMobile ? '100%' : undefined, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {col1.map(ins => { const d = cardData(ins.id); return <InsightCard key={ins.id} ins={ins} data={d} viz={buildViz(ins.id, d)} />; })}
          </div>
          <div style={{ flex: isMobile ? 'none' : '9', width: isMobile ? '100%' : undefined, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {col2.map(ins => { const d = cardData(ins.id); return <InsightCard key={ins.id} ins={ins} data={d} viz={buildViz(ins.id, d)} />; })}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 14 }}>
          <div style={{ flex: 11, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {[280, 320, 260].map((h, i) => <div key={i} className="skeleton" style={{ height: h, borderRadius: 14 }} />)}
          </div>
          <div style={{ flex: 9, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {[260, 310, 240].map((h, i) => <div key={i} className="skeleton" style={{ height: h, borderRadius: 14 }} />)}
          </div>
        </div>
      )}

      {/* ── Section: Player Analytics ────────────────────────────────────────── */}
      {(formRanking?.length > 0 || clanMapStats?.length > 0 || blueZoneRanking?.length > 0) && (
        <SectionRule label="Player Analytics" />
      )}

      {/* ── Recent Form — full width ─────────────────────────────────────────── */}
      {formRanking && formRanking.length > 0 && (() => {
        const maxAbs = Math.max(...formRanking.map(e => Math.abs(e.form.delta)), 0.01);
        const hot  = formRanking.filter(e => e.form.delta >= 0.25).length;
        const cold = formRanking.filter(e => e.form.delta <= -0.25).length;
        return (
          <SectionCard
            label="Recent Form"
            title="Who's Hot, Who's Not"
            subtitle={`Last ${formRanking[0]?.form?.window || 5} games vs season avg (kills + damage composite). ${hot > 0 ? `${hot} player${hot > 1 ? 's' : ''} trending up strongly.` : ''} ${cold > 0 ? `${cold} in a slump.` : ''}`}
            accentColor="#fb923c"
          >
            {/* Axis labels */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <div style={{ width: 96, flexShrink: 0 }} />
              <div style={{ flex: 1, display: 'flex', justifyContent: 'space-between', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--text-3)' }}>
                <span>← Declining</span><span>Improving →</span>
              </div>
              <div style={{ width: 118, flexShrink: 0 }} />
            </div>
            {/* Diverging bar chart — 2-col on desktop */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr',
              gap: isMobile ? '8px' : '8px 28px',
            }}>
              {formRanking.map(e => {
                const f = e.form;
                const delta = f.delta;
                const isPos = delta >= 0;
                const barPct = Math.min(Math.abs(delta) / maxAbs * 50, 50);
                const color = delta >= 0.25 ? '#4ade80' : delta >= 0.08 ? '#a3e635' : delta >= 0 ? '#94a3b8' : delta >= -0.08 ? '#fb923c' : '#f87171';
                const sign = delta >= 0 ? '+' : '';
                const trendLabel = delta >= 0.25 ? '🔥' : delta >= 0.08 ? '📈' : delta >= -0.08 ? '→' : delta >= -0.25 ? '📉' : '🥶';
                return (
                  <div key={e.name} title={`Last ${f.window}g: ${f.recentKills?.toFixed(1) ?? '?'}K / ${f.recentDamage ? Math.round(f.recentDamage) : '?'}dmg  vs  ${f.allKills?.toFixed(1) ?? '?'}K / ${f.allDamage ? Math.round(f.allDamage) : '?'}dmg avg`}
                    style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 96, fontSize: 11.5, fontWeight: Math.abs(delta) >= 0.15 ? 700 : 400, color: Math.abs(delta) >= 0.2 ? 'var(--text-1)' : 'var(--text-2)', textAlign: 'right', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</div>
                    <div style={{ flex: 1, height: 20, position: 'relative', display: 'flex', alignItems: 'center' }}>
                      <div style={{ position: 'absolute', inset: 0, background: 'var(--bg-surface)', borderRadius: 4 }} />
                      <div style={{ position: 'absolute', left: isPos ? '50%' : `${50 - barPct}%`, width: `${barPct}%`, height: 14, background: color, opacity: 0.85, borderRadius: isPos ? '0 3px 3px 0' : '3px 0 0 3px' }} />
                      <div style={{ position: 'absolute', left: '50%', top: 2, bottom: 2, width: 1, background: 'var(--border)', zIndex: 2 }} />
                    </div>
                    <div style={{ width: 38, fontSize: 12, fontWeight: 700, color, textAlign: 'right', flexShrink: 0 }}>{sign}{Math.round(delta * 100)}%</div>
                    <div style={{ width: 18, fontSize: 14, textAlign: 'center', flexShrink: 0 }}>{trendLabel}</div>
                    <div style={{ width: 60, fontSize: 9.5, color: 'var(--text-3)', textAlign: 'right', flexShrink: 0 }}>{f.recentKills?.toFixed(1) ?? '?'}K · {f.recentDamage ? Math.round(f.recentDamage) : '?'}d</div>
                  </div>
                );
              })}
            </div>
          </SectionCard>
        );
      })()}

      {/* ── Row: Map Performance + Squad Chemistry ────────────────────────────── */}
      {(clanMapStats?.length > 0 || (squadData?.topPairs?.length > 0 || squadData?.topTrios?.length > 0)) && (
        <div style={{ display: isMobile ? 'flex' : 'grid', gridTemplateColumns: '58fr 42fr', flexDirection: 'column', gap: 14 }}>

          {/* Map Performance */}
          {clanMapStats && clanMapStats.length > 0 && (() => {
            const sorted = [...clanMapStats].sort((a, b) => b.winRate - a.winRate);
            const refScale = Math.max(sorted[0].winRate * 100, 12);
            const best = sorted[0]; const worst = sorted[sorted.length - 1];
            return (
              <SectionCard
                label="Map Performance"
                title="Win Rate by Map"
                subtitle={<>Best: <strong style={{ color: 'var(--text-1)' }}>{best.map}</strong> at {(best.winRate*100).toFixed(1)}%{worst.map !== best.map ? <> · Weakest: <strong style={{ color: 'var(--text-1)' }}>{worst.map}</strong> at {(worst.winRate*100).toFixed(1)}%</> : ''}. Last 10 games per player, clan-wide.</>}
                accentColor="#22d3ee"
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {sorted.map(m => {
                    const winPct = m.winRate * 100;
                    const barW = winPct / refScale * 100;
                    const color = winPct >= 10 ? '#4ade80' : winPct >= 5 ? '#facc15' : winPct >= 2 ? '#fb923c' : '#94a3b8';
                    return (
                      <div key={m.map}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 3 }}>
                          <div style={{ width: 68, fontSize: 12, fontWeight: 600, color: 'var(--text-1)', flexShrink: 0 }}>{m.map}</div>
                          <div style={{ flex: 1, height: 9, background: 'var(--bg-surface)', borderRadius: 4, overflow: 'hidden' }}>
                            <div style={{ width: barW + '%', height: '100%', background: color, borderRadius: 4, transition: 'width .4s' }} />
                          </div>
                          <div style={{ width: 38, fontSize: 12, fontWeight: 700, color, textAlign: 'right', flexShrink: 0 }}>{winPct > 0 ? winPct.toFixed(1) + '%' : '—'}</div>
                        </div>
                        <div style={{ display: 'flex', gap: 10, paddingLeft: 78, fontSize: 10, color: 'var(--text-3)' }}>
                          <span>{m.played}g</span>
                          <span style={{ color: '#f59e0b' }}>{m.wins}W</span>
                          <span><Tip label="Kills per game on this map">{m.avgKills}K/g</Tip></span>
                          <span>{m.avgDmg}dmg</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </SectionCard>
            );
          })()}

          {/* Squad Chemistry */}
          {squadData && (squadData.topPairs?.length > 0 || squadData.topTrios?.length > 0) && (() => {
            const bestDuo  = squadData.topPairs?.[0];
            const bestTrio = squadData.topTrios?.[0];
            const maxPairWR = Math.max(...(squadData.topPairs  || []).map(c => c.winRate), 0.01);
            const maxTrioWR = Math.max(...(squadData.topTrios  || []).map(c => c.winRate), 0.01);
            const maxMostG  = Math.max(...(squadData.mostPlayedPairs || []).map(c => c.games), 1);
            return (
              <SectionCard
                label="Squad Chemistry"
                title="Best Combinations"
                subtitle={bestDuo ? `${bestDuo.players.join(' + ')} leads duos at ${(bestDuo.winRate*100).toFixed(0)}% across ${bestDuo.games} games` : undefined}
                accentColor="#a78bfa"
              >
                {/* Duos */}
                {squadData.topPairs?.length > 0 && (
                  <div style={{ marginBottom: squadData.topTrios?.length > 0 ? 16 : 0 }}>
                    <div style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.1em', color: 'var(--text-3)', marginBottom: 8 }}>Duos</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {squadData.topPairs.slice(0, 5).map((c, i) => {
                        const barW = (c.winRate / maxPairWR) * 100;
                        return (
                          <div key={i}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                              <span style={{ fontSize: 9, color: 'var(--text-3)', width: 12, flexShrink: 0 }}>{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i+1}</span>
                              <div style={{ flex: 1, fontSize: 11.5, fontWeight: i === 0 ? 700 : 400, color: i === 0 ? 'var(--text-1)' : 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.players.join(' + ')}</div>
                              <div style={{ fontSize: 12, fontWeight: 700, color: i === 0 ? '#a78bfa' : 'var(--text-2)', flexShrink: 0 }}>{(c.winRate*100).toFixed(0)}%</div>
                            </div>
                            <div style={{ marginLeft: 18, height: 3, background: 'var(--bg-surface)', borderRadius: 2, overflow: 'hidden' }}>
                              <div style={{ width: barW + '%', height: '100%', background: i === 0 ? '#a78bfa' : 'var(--border)', borderRadius: 2, transition: 'width .4s' }} />
                            </div>
                            <div style={{ marginLeft: 18, marginTop: 2, fontSize: 9, color: 'var(--text-3)' }}>{c.games}g · {c.wins}W · <Tip label="Average kills per game together">{c.avgKills} K/g</Tip></div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {/* Trios */}
                {squadData.topTrios?.length > 0 && (
                  <div style={{ marginBottom: squadData.mostPlayedPairs?.length > 0 ? 16 : 0 }}>
                    <div style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.1em', color: 'var(--text-3)', marginBottom: 8 }}>Trios</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {squadData.topTrios.slice(0, 4).map((c, i) => {
                        const barW = (c.winRate / maxTrioWR) * 100;
                        return (
                          <div key={i}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                              <span style={{ fontSize: 9, color: 'var(--text-3)', width: 12, flexShrink: 0 }}>{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i+1}</span>
                              <div style={{ flex: 1, fontSize: 11, fontWeight: i === 0 ? 700 : 400, color: i === 0 ? 'var(--text-1)' : 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.players.join(' + ')}</div>
                              <div style={{ fontSize: 12, fontWeight: 700, color: i === 0 ? '#4ade80' : 'var(--text-2)', flexShrink: 0 }}>{(c.winRate*100).toFixed(0)}%</div>
                            </div>
                            <div style={{ marginLeft: 18, height: 3, background: 'var(--bg-surface)', borderRadius: 2, overflow: 'hidden' }}>
                              <div style={{ width: barW + '%', height: '100%', background: i === 0 ? '#4ade80' : 'var(--border)', borderRadius: 2, transition: 'width .4s' }} />
                            </div>
                            <div style={{ marginLeft: 18, marginTop: 2, fontSize: 9, color: 'var(--text-3)' }}>{c.games}g · {c.wins}W</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {/* Most played */}
                {squadData.mostPlayedPairs?.length > 0 && (
                  <div>
                    <div style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.1em', color: 'var(--text-3)', marginBottom: 8 }}>Most Time Together</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {squadData.mostPlayedPairs.slice(0, 4).map((c, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ flex: 1, fontSize: 11, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.players.join(' + ')}</div>
                          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-2)', flexShrink: 0 }}>{c.games}g</div>
                          <div style={{ fontSize: 10, color: 'var(--text-3)', flexShrink: 0 }}>{(c.winRate*100).toFixed(0)}%W</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </SectionCard>
            );
          })()}
        </div>
      )}

      {/* ── Row: Blue Zone + Knockdown ───────────────────────────────────────── */}
      {(blueZoneRanking?.length > 0 || knockdownStats?.length > 0) && (
        <div style={{ display: isMobile ? 'flex' : 'grid', gridTemplateColumns: '1fr 1fr', flexDirection: 'column', gap: 14 }}>

          {blueZoneRanking && blueZoneRanking.length > 0 && (() => {
            const worst  = blueZoneRanking[0];
            const best   = blueZoneRanking[blueZoneRanking.length - 1];
            const maxDmg = Math.max(worst.avgDmgPerGame, 1);
            return (
              <SectionCard
                label="Zone Discipline"
                title="Blue Zone Damage"
                subtitle={<><strong style={{ color: 'var(--text-1)' }}>{worst.name}</strong> absorbs the most ({worst.avgDmgPerGame} <Tip label="Average blue zone damage per game">dmg/g</Tip>) · <strong style={{ color: 'var(--text-1)' }}>{best.name}</strong> rotates cleanest ({best.avgDmgPerGame} <Tip label="Average blue zone damage per game">dmg/g</Tip>).</>}
                accentColor="#38bdf8"
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {blueZoneRanking.map(p => {
                    const pct   = Math.min(p.avgDmgPerGame / maxDmg, 1) * 100;
                    const color = p.avgDmgPerGame >= 100 ? '#f87171' : p.avgDmgPerGame >= 65 ? '#fb923c' : p.avgDmgPerGame >= 40 ? '#facc15' : '#4ade80';
                    return (
                      <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ width: 100, fontSize: 12, fontWeight: 500, color: 'var(--text-1)', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                        <div style={{ flex: 1, height: 8, background: 'var(--bg-surface)', borderRadius: 4, overflow: 'hidden' }}>
                          <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 4, transition: 'width .4s' }} />
                        </div>
                        <div style={{ width: 40, textAlign: 'right', fontSize: 12, fontWeight: 700, color, flexShrink: 0 }}>{p.avgDmgPerGame}</div>
                        <div style={{ width: 30, textAlign: 'right', fontSize: 10, color: 'var(--text-3)', flexShrink: 0 }}>{p.matches}g</div>
                      </div>
                    );
                  })}
                </div>
              </SectionCard>
            );
          })()}

          {knockdownStats && knockdownStats.length > 0 && (() => {
            const sorted  = [...knockdownStats].sort((a, b) => b.finishRate - a.finishRate);
            const best    = sorted[0];
            const worst   = sorted[sorted.length - 1];
            const maxRate = Math.max(best.finishRate, 1.5);
            return (
              <SectionCard
                label="Execution"
                title="Knockdown Conversion"
                subtitle={<><strong style={{ color: 'var(--text-1)' }}>{best.name}</strong> finishes at {best.finishRate}× · <strong style={{ color: 'var(--text-1)' }}>{worst.name}</strong> at {worst.finishRate}×. Above 1.0 = closing teammates' knocks too.</>}
                accentColor="#f472b6"
              >
                {/* Reference line header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <div style={{ width: 100, flexShrink: 0 }} />
                  <div style={{ flex: 1, position: 'relative', height: 8 }}>
                    <div style={{ position: 'absolute', left: `${(1.0 / maxRate) * 100}%`, top: -2, bottom: -2, width: 1, background: 'var(--border)' }} />
                    <div style={{ position: 'absolute', left: `${(1.0 / maxRate) * 100 + 1}%`, top: '50%', transform: 'translateY(-50%)', fontSize: 8.5, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>1.0×</div>
                  </div>
                  <div style={{ width: 72, flexShrink: 0 }} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {sorted.map(p => {
                    const pct   = Math.min(p.finishRate / maxRate, 1) * 100;
                    const color = p.finishRate >= 1.2 ? '#4ade80' : p.finishRate >= 0.9 ? '#60a5fa' : p.finishRate >= 0.7 ? '#fb923c' : '#f87171';
                    return (
                      <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ width: 100, fontSize: 12, fontWeight: 500, color: 'var(--text-1)', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                        <div style={{ flex: 1, height: 8, background: 'var(--bg-surface)', borderRadius: 4, overflow: 'hidden', position: 'relative' }}>
                          <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 4, transition: 'width .4s' }} />
                          <div style={{ position: 'absolute', left: `${(1.0 / maxRate) * 100}%`, top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,.2)' }} />
                        </div>
                        <div style={{ width: 30, textAlign: 'right', fontSize: 12, fontWeight: 700, color, flexShrink: 0 }}>{p.finishRate}×</div>
                        <div style={{ width: 40, textAlign: 'right', fontSize: 10, color: 'var(--text-3)', flexShrink: 0 }}><Tip label="Kills / knockdowns from telemetry">{p.kills}K/{p.knockdowns}↓</Tip></div>
                      </div>
                    );
                  })}
                </div>
              </SectionCard>
            );
          })()}
        </div>
      )}

      {/* ── Landing Heatmap ──────────────────────────────────────────────────── */}
      {heatmapData && <SectionRule label="Landing Zones" />}
      {heatmapData ? <LandingHeatmap data={heatmapData} /> : null}

    </div>
  );
}
