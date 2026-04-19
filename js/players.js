// ── Player tier helpers ───────────────────────────────────────────────────────
function playerTier(kdVal) {
  if (kdVal >= 3.0) return { label: 'Predator', emoji: '💀', color: '#f87171', glow: 'rgba(248,113,113,.25)' };
  if (kdVal >= 2.0) return { label: 'Slayer',   emoji: '🔥', color: '#fb923c', glow: 'rgba(251,146,60,.2)'  };
  if (kdVal >= 1.5) return { label: 'Solid',    emoji: '⚡', color: '#facc15', glow: 'rgba(250,204,21,.15)' };
  if (kdVal >= 1.0) return { label: 'Average',  emoji: '🎯', color: '#60a5fa', glow: 'rgba(96,165,250,.15)' };
  return                    { label: 'Rookie',   emoji: '🫐', color: '#94a3b8', glow: 'rgba(148,163,184,.1)' };
}

function initials(name) {
  return name.slice(0, 2).toUpperCase();
}

// ── PlayerCard — individual player card with inline match expansion ────────────
function PlayerCard({ member, sd, ld, seasonError, weaponEntry, historyEntry, lifetimeEntry, onViewProfile }) {
  const [expanded, setExpanded]         = useState(false);
  const [matches, setMatches]           = useState(null);
  const [matchLoading, setMatchLoading] = useState(false);
  const [matchError, setMatchError]     = useState(null);

  const s      = extractStats(sd);
  const l      = extractLifetimeStats(ld);
  const kdVal  = s ? s.kills / Math.max(s.losses || 1, 1) : 0;
  const tier   = playerTier(kdVal);
  const isTPP  = !!(sd?.data?.attributes?.gameModeStats?.['squad']?.roundsPlayed > 0 &&
                   !(sd?.data?.attributes?.gameModeStats?.['squad-fpp']?.roundsPlayed > 0));
  const avgDmg = s ? Math.round((s.damageDealt || 0) / Math.max(s.roundsPlayed || 1, 1)) : 0;

  const APE_IMGS = [
    '/images/ape1.png', '/images/ape2.png', '/images/ape3.png',
    '/images/img1.png', '/images/img2.png', '/images/img3.png',
    '/images/img4.png', '/images/img5.png', '/images/img6.png',
    '/images/img7.png', '/images/ape_gorilla.png',
    '/images/ape_shotgun.png', '/images/ape_tactical.png',
  ];
  const nameHash = member.name.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0);
  const imgSrc   = APE_IMGS[Math.abs(nameHash) % APE_IMGS.length];

  // Live refresh — only called via the ↻ button; cached history shows immediately
  async function fetchLiveMatches() {
    if (matchLoading) return;
    setMatchLoading(true);
    setMatchError(null);
    try {
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Request timed out — API may be rate-limited. Try again in a minute.')), 20000));
      const url = `/api/matches/player?accountId=${member.accountId}&limit=5&bust=1`;
      const d = await Promise.race([api.get(url), timeout]);
      setMatches(d.matches);
    } catch (e) {
      setMatchError(e.message);
    } finally {
      setMatchLoading(false);
    }
  }

  // Toggle expand — no fetch needed; cache renders immediately
  function handleClick() {
    setExpanded(e => !e);
  }

  // Normalise cached and live match objects to a common shape for rendering
  function normaliseMatch(m) {
    const isLive = !!m.playerStats; // live API shape
    if (isLive) {
      const ps = m.playerStats || {};
      return {
        matchId:   m.matchId,
        date:      new Date(m.createdAt).toLocaleDateString(),
        placement: m.placement,
        won:       m.placement === 1,
        kills:     ps.kills     || 0,
        assists:   ps.assists   || 0,
        dbnos:     ps.DBNOs     || 0,
        hs:        ps.headshotKills || 0,
        damage:    Math.round(ps.damageDealt || 0),
        survival:  Math.round(ps.timeSurvived || 0),
        map:       mapName(m.mapName),
        mode:      m.gameMode || '',
        teammates: [],
      };
    }
    // Cached shape (already normalised by build_match_history)
    return {
      matchId:   m.matchId,
      date:      new Date(m.date).toLocaleDateString(),
      placement: m.placement,
      won:       m.won,
      kills:     m.kills,
      assists:   m.assists,
      dbnos:     m.dbnos     || 0,
      hs:        m.hs        || 0,
      damage:    m.damage,
      survival:  m.survival,
      map:       m.map,
      mode:      m.mode,
      teammates: m.teammates || [],
    };
  }

  return (
    <div
      className="stat-card cursor-pointer select-none"
      style={{
        padding: 0, overflow: 'hidden',
        borderColor: expanded ? tier.color : 'var(--border)',
        boxShadow: expanded ? `0 0 0 1px ${tier.color}, 0 4px 24px ${tier.glow}` : undefined,
        transition: 'border-color .2s, box-shadow .2s',
      }}
      onClick={handleClick}
    >
      {/* Card header */}
      <div style={{ position: 'relative', overflow: 'hidden', padding: '14px 16px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <img src={imgSrc} alt="" aria-hidden="true" style={{ position: 'absolute', right: -10, top: 0, height: '100%', width: 90, objectFit: 'cover', objectPosition: 'center top', opacity: 0.18, maskImage: 'linear-gradient(to left, rgba(0,0,0,0.8), transparent)', WebkitMaskImage: 'linear-gradient(to left, rgba(0,0,0,0.8), transparent)', pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(135deg, ${tier.glow} 0%, transparent 100%)`, pointerEvents: 'none' }} />
        <div style={{ width: 44, height: 44, borderRadius: '50%', background: `${tier.color}22`, border: `2px solid ${tier.color}66`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 800, color: tier.color, flexShrink: 0 }}>
          {initials(member.name)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{member.name}</div>
          <div style={{ fontSize: 11, color: tier.color, fontWeight: 600, marginTop: 1, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {tier.emoji} {tier.label}
            <Tip label={isTPP ? 'Third Person Perspective' : 'First Person Perspective'}><span style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3, background: `${tier.color}22`, color: tier.color, letterSpacing: '.04em' }}>{isTPP ? 'TPP' : 'FPP'}</span></Tip>
            {(() => {
              const form = historyEntry?.form;
              if (!form || form.trend === 'steady') return null;
              const cfg = { hot: { emoji: '🔥', bg: 'rgba(251,146,60,.18)', color: '#fb923c' }, warm: { emoji: '📈', bg: 'rgba(250,204,21,.15)', color: '#facc15' }, cold: { emoji: '📉', bg: 'rgba(248,113,113,.15)', color: '#f87171' }, cool: { emoji: '🌡', bg: 'rgba(148,163,184,.15)', color: '#94a3b8' } }[form.trend];
              if (!cfg) return null;
              const sign = form.delta >= 0 ? '+' : '';
              return (
                <span title={`Last ${form.window} games: ${form.recentKills}K avg vs ${form.allKills}K overall`}
                  style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3, background: cfg.bg, color: cfg.color, letterSpacing: '.04em' }}>
                  {cfg.emoji} {sign}{Math.round(form.delta * 100)}%
                </span>
              );
            })()}
          </div>
          {/* Profile button */}
          {onViewProfile && (
            <button
              onClick={e => { e.stopPropagation(); onViewProfile(); }}
              title="View full profile"
              style={{ position: 'relative', zIndex: 2, flexShrink: 0, background: `${tier.color}18`, border: `1px solid ${tier.color}44`, borderRadius: 6, padding: '4px 8px', fontSize: 10, fontWeight: 700, color: tier.color, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              Profile ↗
            </button>
          )}
        </div>
      </div>

      {/* Stats body */}
      <div style={{ padding: '12px 16px 14px' }}>
        {s ? (
          <>
            {/* Role badge + K/D row */}
            {(() => {
              const role = playerRole(s);
              return (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    <span style={{ fontSize: 32, fontWeight: 900, color: tier.color, lineHeight: 1 }}>{kd(s.kills || 0, s.losses || 0)}</span>
                    <Tip label="Kill/Death ratio"><span style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 700, textTransform: 'uppercase' }}>K/D</span></Tip>
                  </div>
                  {role && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 99, background: `${role.color}18`, border: `1px solid ${role.color}44` }} title={role.desc}>
                      <span style={{ fontSize: 13 }}>{role.emoji}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: role.color }}>{role.label}</span>
                    </div>
                  )}
                </div>
              );
            })()}
            {/* Stat grid */}
            <div className="player-stat-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
              {[
                { label: 'Kills',      val: num(s.kills || 0) },
                { label: 'Wins',       val: num(s.wins || 0),                                                    color: s.wins > 0 ? '#f59e0b' : undefined },
                { label: 'Avg Dmg',    val: num(avgDmg),        tip: 'Average damage per match' },
                { label: 'Best Game',  val: `${num(s.roundMostKills || 0)}K`,                                    color: (s.roundMostKills||0) >= 10 ? '#4ade80' : undefined, tip: 'Most kills in a single match' },
                { label: 'Matches',    val: num(s.roundsPlayed || 0) },
                { label: 'Revives',    val: num(s.revives || 0),                                                 color: (s.revives||0) >= 10 ? '#60a5fa' : undefined, tip: 'Teammate revives this season' },
                { label: 'HS %',       val: s.kills > 0 ? pct(s.headshotKills || 0, s.kills) : '—', tip: 'Headshot kill percentage' },
                { label: 'Avg Survive',val: fmtSurvival((s.timeSurvived||0)/Math.max(s.roundsPlayed||1,1)), tip: 'Average time survived per match' },
                { label: 'Knockdowns', val: num(s.dBNOs || 0),  tip: 'Down But Not Out — enemies knocked but not finished' },
                { label: 'Top 10',     val: num(s.top10s || 0), tip: 'Number of top-10 finishes' },
                { label: 'Streak',     val: `${num(s.maxKillStreaks || 0)}`,                                     color: (s.maxKillStreaks||0) >= 5 ? '#facc15' : undefined, tip: 'Highest kill streak in a single match' },
                { label: 'Longest K',  val: `${Math.round(s.longestKill || 0)}m`, tip: 'Longest kill distance in metres' },
                { label: 'Assists',    val: num(s.assists || 0),                                                 color: (s.assists||0) >= 20 ? '#60a5fa' : undefined, tip: 'Damage dealt to enemies finished by a teammate' },
                { label: 'Boosts',     val: num(s.boosts || 0),                                                  color: (s.boosts||0) >= 50 ? '#34d399' : undefined, tip: 'Boost items used (energy drinks, painkillers)' },
                { label: 'Heals',      val: num(s.heals || 0),                                                   color: (s.heals||0) >= 50 ? '#34d399' : undefined, tip: 'Healing items used (medkits, bandages)' },
                { label: 'Veh Destr',  val: num(s.vehicleDestroys || 0),                                         color: (s.vehicleDestroys||0) >= 3 ? '#f97316' : undefined, tip: 'Vehicles destroyed' },
                { label: 'Road Kills', val: num(s.roadKills || 0),                                               color: (s.roadKills||0) >= 1 ? '#ef4444' : undefined, tip: 'Enemies run over with a vehicle' },
                { label: 'Days',       val: num(s.days || 0),                                                    color: (s.days||0) >= 10 ? '#a78bfa' : undefined, tip: 'Days played this season' },
              ].map(({ label, val, color, tip }) => (
                <div key={label}>
                  <div style={{ color: 'var(--text-3)', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                    {tip ? <Tip label={tip}>{label}</Tip> : label}
                  </div>
                  <div style={{ fontWeight: 700, fontSize: 13, color: color || 'var(--text-1)', marginTop: 1 }}>{val}</div>
                </div>
              ))}
            </div>
            {lifetimeEntry && (
              <div style={{ marginTop: 10, padding: '6px 8px', borderRadius: 6, background: 'rgba(148,163,184,.06)', border: '1px solid rgba(148,163,184,.12)', display: 'flex', flexWrap: 'wrap', gap: '4px 10px', alignItems: 'center' }}>
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-3)', textTransform: 'uppercase', marginRight: 2 }}>Career</span>
                <span style={{ fontSize: 10, color: 'var(--text-2)' }}>
                  <span style={{ fontWeight: 700, color: lifetimeEntry.kd >= 2 ? '#4ade80' : lifetimeEntry.kd >= 1 ? 'var(--text-1)' : '#f87171' }}>{lifetimeEntry.kd.toFixed(2)}</span>
                  <Tip label="Career Kill/Death ratio"><span style={{ color: 'var(--text-3)' }}> K/D</span></Tip>
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-2)' }}>
                  <span style={{ fontWeight: 600 }}>{num(lifetimeEntry.games)}</span>
                  <span style={{ color: 'var(--text-3)' }}> games</span>
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-2)' }}>
                  <span style={{ fontWeight: 600 }}>{(lifetimeEntry.winRate * 100).toFixed(1)}%</span>
                  <span style={{ color: 'var(--text-3)' }}> win</span>
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-2)' }}>
                  <span style={{ fontWeight: 600 }}>{Math.round(lifetimeEntry.avgDamage)}</span>
                  <Tip label="Average damage per match"><span style={{ color: 'var(--text-3)' }}> dmg</span></Tip>
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-2)' }}>
                  <span style={{ fontWeight: 600 }}>{(lifetimeEntry.hsRate * 100).toFixed(0)}%</span>
                  <Tip label="Headshot kill percentage"><span style={{ color: 'var(--text-3)' }}> HS</span></Tip>
                </span>
              </div>
            )}
            {(() => {
              const weapons = weaponEntry?.weapons || [];
              // Best map: highest avgKills with at least 2 games in recent history
              const bestMap = (historyEntry?.mapStats || []).filter(m => m.played >= 2).sort((a, b) => b.avgKills - a.avgKills)[0];
              const bz = weaponEntry?.blueZone;
              const bzBadge = bz && bz.matches >= 5 && bz.avgDmgPerGame > 0;
              if (weapons.length === 0 && !bestMap && !bzBadge) return null;
              const bzColor = bz?.avgDmgPerGame >= 100 ? '#f87171' : bz?.avgDmgPerGame >= 75 ? '#fb923c' : bz?.avgDmgPerGame >= 50 ? '#facc15' : '#4ade80';
              return (
                <div style={{ marginTop: 9, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {weapons.slice(0, 3).map(w => (
                    <div key={w.weaponClass} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 7px', borderRadius: 4, background: 'var(--bg-raised)', border: '1px solid var(--border)', fontSize: 10 }}>
                      <span style={{ fontWeight: 700, color: 'var(--text-1)' }}>{w.displayName}</span>
                      <span style={{ color: 'var(--text-3)' }}>{w.kills}K</span>
                      {w.hsRate > 0 && <span style={{ color: '#facc15', fontWeight: 600 }}>{Math.round(w.hsRate * 100)}%HS</span>}
                      {w.knockdowns > 0 && w.knockdowns !== w.kills && <span style={{ color: '#60a5fa', fontWeight: 600 }}>{w.knockdowns}↓</span>}
                    </div>
                  ))}
                  {bestMap && (
                    <div title={`${bestMap.played} recent games on ${bestMap.map} · ${bestMap.wins} wins`}
                      style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '2px 7px', borderRadius: 4, background: 'rgba(96,165,250,.08)', border: '1px solid rgba(96,165,250,.25)', fontSize: 10 }}>
                      <span style={{ color: '#60a5fa' }}>🗺</span>
                      <span style={{ fontWeight: 700, color: '#60a5fa' }}>{bestMap.map}</span>
                      <span style={{ color: 'var(--text-3)' }}>{bestMap.avgKills}K/g</span>
                    </div>
                  )}
                  {bzBadge && (
                    <div title={`Blue zone: ${bz.avgDmgPerGame} dmg/game avg over ${bz.matches} matches`}
                      style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '2px 7px', borderRadius: 4, background: `${bzColor}14`, border: `1px solid ${bzColor}44`, fontSize: 10 }}>
                      <span>🔵</span>
                      <span style={{ fontWeight: 700, color: bzColor }}>{bz.avgDmgPerGame}</span>
                      <span style={{ color: 'var(--text-3)' }}>dmg/g</span>
                    </div>
                  )}
                </div>
              );
            })()}
          </>
        ) : (
          <div style={{ color: 'var(--text-3)', fontSize: 13, padding: '8px 0' }}>{seasonError || 'No season data'}</div>
        )}
        <div style={{ marginTop: 10, fontSize: 10, color: expanded ? tier.color : 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 4, transition: 'color .15s' }}>
          {expanded ? '▲ hide matches' : '▼ recent matches'}
        </div>
      </div>

      {/* Inline match history — expands directly inside the card when clicked */}
      {expanded && (
        <div style={{ borderTop: `1px solid ${tier.color}44`, padding: '12px 16px 14px', background: `${tier.glow}` }} onClick={e => e.stopPropagation()}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ fontWeight: 700, fontSize: 11, color: tier.color, textTransform: 'uppercase', letterSpacing: '.07em' }}>Recent Matches</div>
              {!matches && historyEntry?.recent?.length > 0 && (
                <span style={{ fontSize: 9, color: 'var(--text-3)', fontWeight: 600 }}>cached · {historyEntry.recent.length} games</span>
              )}
              {matches && (
                <span style={{ fontSize: 9, color: tier.color, fontWeight: 600 }}>live</span>
              )}
            </div>
            <button
              onClick={e => { e.stopPropagation(); fetchLiveMatches(); }}
              disabled={matchLoading}
              title="Load live data from PUBG API"
              style={{ background: 'none', border: 'none', cursor: matchLoading ? 'default' : 'pointer', padding: '2px 4px', borderRadius: 4, color: 'var(--text-3)', fontSize: 13, lineHeight: 1, opacity: matchLoading ? 0.4 : 1, transition: 'color .15s' }}
              onMouseEnter={e => { if (!matchLoading) e.target.style.color = tier.color; }}
              onMouseLeave={e => { e.target.style.color = 'var(--text-3)'; }}
            >{matchLoading ? <Spinner size="sm" /> : '↻'}</button>
          </div>
          {matchError && <div style={{ color: '#f87171', fontSize: 12, marginBottom: 8 }}>Error: {matchError}</div>}
          {(() => {
            // Prefer live data; fall back to cache
            const rawList = matches || historyEntry?.recent || [];
            if (!rawList.length) return <div style={{ color: 'var(--text-3)', fontSize: 12 }}>No match history available.</div>;
            const displayList = rawList.map(normaliseMatch);
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {displayList.map(m => {
                  const mins  = Math.floor(m.survival / 60);
                  const secs  = String(Math.floor(m.survival % 60)).padStart(2, '0');
                  const top10 = m.placement && m.placement <= 10;
                  return (
                    <div key={m.matchId} style={{ borderRadius: 8, background: m.won ? 'rgba(245,158,11,.1)' : 'var(--bg-card)', border: `1px solid ${m.won ? 'rgba(245,158,11,.35)' : 'var(--border)'}` }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px' }}>
                        {/* Placement */}
                        <div style={{ width: 38, textAlign: 'center', flexShrink: 0 }}>
                          <div style={{ fontWeight: 900, fontSize: m.won ? 17 : 14, color: m.won ? '#f59e0b' : top10 ? '#60a5fa' : 'var(--text-2)' }}>
                            {m.won ? '🏆' : `#${m.placement || '?'}`}
                          </div>
                          <div style={{ fontSize: 8, color: 'var(--text-3)', fontWeight: 700, textTransform: 'uppercase', marginTop: 1 }}>
                            {m.won ? 'WIN' : top10 ? 'TOP10' : 'place'}
                          </div>
                        </div>
                        {/* Map + mode */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.map}</div>
                          <div style={{ fontSize: 9, color: 'var(--text-3)', textTransform: 'uppercase', marginTop: 1 }}>{m.mode} · {m.date}</div>
                        </div>
                        {/* Stats */}
                        <div className="match-stats-row" style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ fontWeight: 800, fontSize: 15, color: m.kills >= 5 ? '#4ade80' : 'var(--text-1)' }}>{m.kills}</div>
                            <div style={{ fontSize: 8, color: 'var(--text-3)', textTransform: 'uppercase' }}>kills</div>
                          </div>
                          {m.assists > 0 && (
                            <div style={{ textAlign: 'center' }}>
                              <div style={{ fontWeight: 700, fontSize: 13, color: '#60a5fa' }}>{m.assists}</div>
                              <Tip label="Assists: damage dealt on kills without the final shot"><div style={{ fontSize: 8, color: 'var(--text-3)', textTransform: 'uppercase' }}>ast</div></Tip>
                            </div>
                          )}
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ fontWeight: 700, fontSize: 13 }}>{m.damage}</div>
                            <Tip label="Total damage dealt this match"><div style={{ fontSize: 8, color: 'var(--text-3)', textTransform: 'uppercase' }}>dmg</div></Tip>
                          </div>
                          {m.hs > 0 && (
                            <div style={{ textAlign: 'center' }}>
                              <div style={{ fontWeight: 700, fontSize: 13, color: '#facc15' }}>{m.hs}</div>
                              <Tip label="Headshot kills this match"><div style={{ fontSize: 8, color: 'var(--text-3)', textTransform: 'uppercase' }}>hs</div></Tip>
                            </div>
                          )}
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-2)' }}>{`${mins}m${secs}s`}</div>
                            <div style={{ fontSize: 8, color: 'var(--text-3)', textTransform: 'uppercase' }}>survived</div>
                          </div>
                        </div>
                      </div>
                      {/* Teammates line */}
                      {m.teammates.length > 0 && (
                        <div style={{ padding: '0 12px 6px', fontSize: 9, color: 'var(--text-3)' }}>
                          🤝 {m.teammates.map(t => t.name).join(' · ')}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// ── Player Profile Modal ──────────────────────────────────────────────────────
function PlayerProfileModal({ member, sd, ld, resolvedS, weaponEntry, historyEntry, lifetimeEntry, analysisProfile, onClose }) {
  const [activeTab, setActiveTab] = useState('overview');

  // Prefer cache-computed official-only stats; fall back to raw API if not available
  const s      = resolvedS || extractStats(sd);
  const kdVal  = s ? (s.kills || 0) / Math.max(s.losses || 1, 1) : 0;
  const tier   = playerTier(kdVal);

  const APE_IMGS = [
    '/images/ape1.png', '/images/ape2.png', '/images/ape3.png',
    '/images/img1.png', '/images/img2.png', '/images/img3.png',
    '/images/img4.png', '/images/img5.png', '/images/img6.png',
    '/images/img7.png', '/images/ape_gorilla.png',
    '/images/ape_shotgun.png', '/images/ape_tactical.png',
  ];
  const nameHash = member.name.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0);
  const imgSrc   = APE_IMGS[Math.abs(nameHash) % APE_IMGS.length];

  // Season stats
  const season = s ? {
    games:     s.roundsPlayed || 0,
    kills:     s.kills        || 0,
    deaths:    s.losses       || 0,
    kd:        kdVal,
    wins:      s.wins         || 0,
    winRate:   s.roundsPlayed ? (s.wins || 0) / s.roundsPlayed : 0,
    top10Rate: s.roundsPlayed ? (s.top10s || 0) / s.roundsPlayed : 0,
    avgDmg:    s.roundsPlayed ? Math.round((s.damageDealt || 0) / s.roundsPlayed) : 0,
    hsRate:    s.kills        ? (s.headshotKills || 0) / s.kills : 0,
    revivesPg: s.roundsPlayed ? ((s.revives || 0) / s.roundsPlayed).toFixed(2) : '0',
    longestKill: Math.round(s.longestKill || 0),
  } : null;

  // Squad chemistry from recent match history
  const squadStats = useMemo(() => {
    const matches = historyEntry?.recent || [];
    const map = {};
    for (const m of matches) {
      for (const t of (m.teammates || [])) {
        if (!t.name) continue;
        if (!map[t.name]) map[t.name] = { games: 0, wins: 0 };
        map[t.name].games++;
        if (m.won) map[t.name].wins++;
      }
    }
    return Object.entries(map)
      .map(([name, d]) => ({ name, games: d.games, wins: d.wins, winRate: d.games ? d.wins / d.games : 0 }))
      .sort((a, b) => b.games - a.games)
      .slice(0, 10);
  }, [historyEntry]);

  // Recent kills sparkline (SVG)
  const sparkline = useMemo(() => {
    const matches = (historyEntry?.recent || []).slice(-25);
    if (matches.length < 3) return null;
    const kills  = matches.map(m => m.kills || 0);
    const won    = matches.map(m => m.won);
    const maxK   = Math.max(...kills, 6);
    const W = 220, H = 48, PAD = 4;
    const pts = kills.map((k, i) => [
      PAD + (i / (kills.length - 1)) * (W - PAD * 2),
      H - PAD - (k / maxK) * (H - PAD * 2),
    ]);
    const polyline = pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    return { pts, polyline, kills, won, W, H };
  }, [historyEntry]);

  const TABS = [
    { id: 'overview', label: '📋 Overview' },
    { id: 'weapons',  label: '🔫 Weapons'  },
    { id: 'maps',     label: '🗺 Maps'     },
    { id: 'squad',    label: '🤝 Squad'    },
  ];

  const pct = (n, d) => d > 0 ? (n / d * 100).toFixed(1) + '%' : '—';
  const fmt  = n => Number(n || 0).toLocaleString('en-US');

  return (
    <div className="modal-bg" onClick={e => e.target === e.currentTarget && onClose()} style={{ zIndex: 600 }}>
      <div className="modal" style={{ maxWidth: 680, padding: 0, display: 'flex', flexDirection: 'column' }}>

        {/* Header */}
        <div style={{ position: 'relative', overflow: 'hidden', padding: '20px 24px 16px', borderBottom: '1px solid var(--border)', background: `linear-gradient(135deg, ${tier.glow} 0%, transparent 60%)` }}>
          <img src={imgSrc} alt="" aria-hidden="true" style={{ position: 'absolute', right: 0, top: 0, height: '100%', width: 120, objectFit: 'cover', objectPosition: 'center top', opacity: 0.15, maskImage: 'linear-gradient(to left, rgba(0,0,0,0.7), transparent)', WebkitMaskImage: 'linear-gradient(to left, rgba(0,0,0,0.7), transparent)', pointerEvents: 'none' }} />
          <button onClick={onClose} style={{ position: 'absolute', top: 12, right: 16, background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', fontSize: 22, lineHeight: 1, padding: 4 }}>×</button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 52, height: 52, borderRadius: '50%', background: `${tier.color}22`, border: `2px solid ${tier.color}88`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 800, color: tier.color, flexShrink: 0 }}>
              {initials(member.name)}
            </div>
            <div>
              <div style={{ fontWeight: 800, fontSize: 18, color: 'var(--text-1)' }}>{member.name}</div>
              <div style={{ fontSize: 12, color: tier.color, fontWeight: 600, marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {tier.emoji} {tier.label}
                {season && <span style={{ color: 'var(--text-3)', fontWeight: 500 }}>· {fmt(season.games)} games this season</span>}
                {lifetimeEntry && <span style={{ color: 'var(--text-3)', fontWeight: 500 }}>· {fmt(lifetimeEntry.games)} career</span>}
              </div>
            </div>
          </div>
          {/* Quick stat pills */}
          {season && (
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              {[
                { label: 'K/D',    tip: 'Kill/Death ratio',         val: kdVal.toFixed(2),            bg: `${tier.color}22`, color: tier.color },
                { label: 'Kills',  tip: null,                       val: fmt(season.kills),           bg: 'rgba(96,165,250,.1)', color: '#60a5fa' },
                { label: 'Wins',   tip: null,                       val: `${season.wins} (${pct(season.wins, season.games)})`, bg: 'rgba(52,211,153,.1)', color: '#34d399' },
                { label: 'Avg DMG', tip: 'Average damage per match', val: season.avgDmg,             bg: 'rgba(251,191,36,.1)', color: '#fbbf24' },
              ].map(p => (
                <div key={p.label} style={{ background: p.bg, border: `1px solid ${p.color}33`, borderRadius: 6, padding: '3px 10px', fontSize: 12 }}>
                  {p.tip
                    ? <Tip label={p.tip}><span style={{ color: 'var(--text-3)', marginRight: 4 }}>{p.label}</span></Tip>
                    : <span style={{ color: 'var(--text-3)', marginRight: 4 }}>{p.label}</span>
                  }
                  <span style={{ fontWeight: 700, color: p.color }}>{p.val}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)', flexShrink: 0 }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setActiveTab(t.id)} style={{ flex: 1, padding: '10px 4px', fontSize: 11, fontWeight: 700, border: 'none', borderBottom: activeTab === t.id ? `2px solid var(--accent)` : '2px solid transparent', background: 'none', color: activeTab === t.id ? 'var(--accent)' : 'var(--text-3)', cursor: 'pointer', transition: 'color .15s', whiteSpace: 'nowrap' }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div style={{ overflowY: 'auto', padding: '20px 24px', flex: 1 }}>

          {/* ── OVERVIEW ── */}
          {activeTab === 'overview' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              {/* Stats grid */}
              {season ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                  {[
                    { label: 'K/D Ratio',   tip: 'Kill/Death ratio',                                val: kdVal.toFixed(2),                 sub: `${fmt(season.kills)} kills / ${fmt(season.deaths)} deaths` },
                    { label: 'Win Rate',    tip: null,                                               val: pct(season.wins, season.games),   sub: `${season.wins} wins from ${fmt(season.games)} games` },
                    { label: 'Avg Damage',  tip: 'Average damage dealt per match',                  val: fmt(season.avgDmg),               sub: `${pct(season.wins, season.games)} win rate` },
                    { label: 'HS Rate',     tip: 'Headshot kill percentage',                         val: pct(season.hsRate * season.kills, season.kills), sub: `${fmt(Math.round(season.hsRate * season.kills))} headshot kills` },
                    { label: 'Top-10 Rate', tip: 'Percentage of games finishing in the top 10',     val: pct(season.top10Rate * season.games, season.games), sub: `${Math.round(season.top10Rate * season.games)} top-10s` },
                    { label: 'Revives/g',   tip: 'Teammate revives per game',                        val: season.revivesPg,                 sub: `Longest kill: ${season.longestKill}m` },
                  ].map(item => (
                    <div key={item.label} style={{ background: 'var(--bg-raised)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 600, marginBottom: 3 }}>{item.tip ? <Tip label={item.tip}>{item.label}</Tip> : item.label}</div>
                      <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-1)' }}>{item.val}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>{item.sub}</div>
                    </div>
                  ))}
                </div>
              ) : <p style={{ color: 'var(--text-3)', fontSize: 13 }}>No season stats available yet.</p>}

              {/* Career comparison */}
              {lifetimeEntry && season && (
                <div style={{ background: 'var(--bg-raised)', borderRadius: 8, padding: '12px 14px', border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-2)', marginBottom: 10 }}>⏳ Season vs Career</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {[
                      { label: 'K/D',     tip: 'Kill/Death ratio',         season: kdVal, career: lifetimeEntry.kd, fmt: v => v.toFixed(2) },
                      { label: 'Win %',   tip: null,                       season: season.winRate * 100, career: lifetimeEntry.winRate * 100, fmt: v => v.toFixed(1) + '%' },
                      { label: 'Avg DMG', tip: 'Average damage per match', season: season.avgDmg, career: lifetimeEntry.avgDamage, fmt: v => Math.round(v) },
                    ].map(row => {
                      const delta  = row.career > 0 ? (row.season - row.career) / row.career : 0;
                      const sign   = delta >= 0 ? '+' : '';
                      const clr    = delta >= 0.05 ? '#34d399' : delta <= -0.05 ? '#f87171' : 'var(--text-3)';
                      const maxVal = Math.max(row.season, row.career, 0.01);
                      return (
                        <div key={row.label} style={{ display: 'grid', gridTemplateColumns: '60px 1fr 60px 60px', gap: 8, alignItems: 'center' }}>
                          <span style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 600 }}>{row.tip ? <Tip label={row.tip}>{row.label}</Tip> : row.label}</span>
                          <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                            <div style={{ flex: row.season / maxVal, height: 6, borderRadius: 3, background: `${tier.color}cc`, minWidth: 2 }} />
                            <div style={{ flex: (maxVal - row.season) / maxVal, height: 6, borderRadius: 3, background: 'var(--border)' }} />
                          </div>
                          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-1)', textAlign: 'right' }}>{row.fmt(row.season)}</span>
                          <span style={{ fontSize: 11, fontWeight: 600, color: clr, textAlign: 'right' }}>{sign}{Math.round(delta * 100)}%</span>
                        </div>
                      );
                    })}
                    <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 4 }}>Career: {fmt(lifetimeEntry.games)} total games across all modes · Season % change vs career avg</div>
                  </div>
                </div>
              )}

              {/* Kill sparkline */}
              {sparkline && (
                <div style={{ background: 'var(--bg-raised)', borderRadius: 8, padding: '12px 14px', border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-2)', marginBottom: 10 }}>📈 Recent Form — kills per game (last {sparkline.kills.length} games, newest right)</div>
                  <svg width="100%" viewBox={`0 0 ${sparkline.W} ${sparkline.H}`} style={{ display: 'block' }}>
                    {/* Area fill */}
                    <defs>
                      <linearGradient id={`spkGrad_${member.accountId}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={tier.color} stopOpacity="0.25" />
                        <stop offset="100%" stopColor={tier.color} stopOpacity="0.02" />
                      </linearGradient>
                    </defs>
                    <polygon
                      points={[
                        `${sparkline.pts[0][0]},${sparkline.H}`,
                        ...sparkline.pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`),
                        `${sparkline.pts[sparkline.pts.length-1][0]},${sparkline.H}`,
                      ].join(' ')}
                      fill={`url(#spkGrad_${member.accountId})`}
                    />
                    <polyline points={sparkline.polyline} fill="none" stroke={tier.color} strokeWidth="1.5" strokeLinejoin="round" />
                    {/* Dots — gold for wins */}
                    {sparkline.pts.map((p, i) => (
                      <circle key={i} cx={p[0]} cy={p[1]} r={sparkline.won[i] ? 4 : 2.5}
                        fill={sparkline.won[i] ? '#fbbf24' : tier.color}
                        stroke={sparkline.won[i] ? '#fbbf24' : 'transparent'}
                        strokeWidth="1"
                        opacity={sparkline.won[i] ? 1 : 0.7}
                      >
                        <title>{sparkline.kills[i]} kills{sparkline.won[i] ? ' 🏆' : ''}</title>
                      </circle>
                    ))}
                  </svg>
                  <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 6 }}>🏆 = chicken dinner</div>
                </div>
              )}

              {/* AI Analysis */}
              {analysisProfile && (
                <div style={{ background: 'var(--bg-raised)', borderRadius: 8, padding: '12px 14px', border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-2)', marginBottom: 8 }}>🤖 AI Analysis</div>
                  <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6, margin: '0 0 10px' }}>{analysisProfile.summary}</p>
                  <div style={{ background: 'rgba(96,165,250,.08)', border: '1px solid rgba(96,165,250,.2)', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#93c5fd' }}>
                    <span style={{ fontWeight: 700 }}>💡 Top tip: </span>{analysisProfile.tip}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── WEAPONS ── */}
          {activeTab === 'weapons' && (
            <div>
              {weaponEntry?.weapons?.length ? (
                <div style={{ overflowX: 'auto' }}>
                  {/* Blue zone badge */}
                  {(() => {
                    const bz = weaponEntry.blueZone;
                    if (!bz || bz.matches < 5) return null;
                    const clr = bz.avgDmgPerGame >= 100 ? '#f87171' : bz.avgDmgPerGame >= 75 ? '#fb923c' : bz.avgDmgPerGame >= 50 ? '#facc15' : '#4ade80';
                    return (
                      <div style={{ marginBottom: 14, padding: '8px 12px', background: `${clr}10`, border: `1px solid ${clr}33`, borderRadius: 8, fontSize: 12, color: clr, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        🔵 Blue zone: <strong>{bz.avgDmgPerGame} dmg/game</strong> avg over {bz.matches} matches
                      </div>
                    );
                  })()}
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        {[
                          { h: 'Weapon',   tip: null },
                          { h: 'Kills',    tip: null },
                          { h: 'KDs',      tip: 'Knockdowns — enemies knocked but not finished' },
                          { h: 'HS%',      tip: 'Headshot kill percentage' },
                          { h: 'Avg Dist', tip: 'Average kill distance in metres' },
                          { h: 'SPK',      tip: 'Shots per kill' },
                        ].map(({ h, tip }) => (
                          <th key={h} style={{ textAlign: h === 'Weapon' ? 'left' : 'right', padding: '6px 8px', fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
                            {tip ? <Tip label={tip}>{h}</Tip> : h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {weaponEntry.weapons.map((w, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,.04)' }}>
                          <td style={{ padding: '7px 8px', fontWeight: 700, color: 'var(--text-1)' }}>{w.displayName}</td>
                          <td style={{ padding: '7px 8px', textAlign: 'right', fontWeight: 600, color: '#60a5fa' }}>{w.kills}</td>
                          <td style={{ padding: '7px 8px', textAlign: 'right', color: 'var(--text-2)' }}>{w.knockdowns || 0}</td>
                          <td style={{ padding: '7px 8px', textAlign: 'right', color: w.hsRate >= 0.25 ? '#34d399' : 'var(--text-2)' }}>{(w.hsRate * 100).toFixed(0)}%</td>
                          <td style={{ padding: '7px 8px', textAlign: 'right', color: 'var(--text-3)' }}>{w.avgDist}m</td>
                          <td style={{ padding: '7px 8px', textAlign: 'right', color: 'var(--text-3)', fontSize: 11 }}>{w.shotsPerKill > 0 ? Math.round(w.shotsPerKill) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 10 }}>KDs = knockdowns · SPK = shots per kill</div>
                </div>
              ) : <p style={{ color: 'var(--text-3)', fontSize: 13 }}>No weapon data available yet — run the daily data pull first.</p>}
            </div>
          )}

          {/* ── MAPS ── */}
          {activeTab === 'maps' && (
            <div>
              {historyEntry?.mapStats?.length ? (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        {[
                          { h: 'Map',       tip: null },
                          { h: 'Games',     tip: null },
                          { h: 'Wins',      tip: null },
                          { h: 'Win%',      tip: 'Win percentage on this map' },
                          { h: 'Avg Kills', tip: 'Average kills per game on this map' },
                          { h: 'Avg DMG',   tip: 'Average damage per game on this map' },
                        ].map(({ h, tip }) => (
                          <th key={h} style={{ textAlign: h === 'Map' ? 'left' : 'right', padding: '6px 8px', fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
                            {tip ? <Tip label={tip}>{h}</Tip> : h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...historyEntry.mapStats].sort((a, b) => b.played - a.played).map((m, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,.04)' }}>
                          <td style={{ padding: '7px 8px', fontWeight: 700, color: 'var(--text-1)' }}>{m.map}</td>
                          <td style={{ padding: '7px 8px', textAlign: 'right', color: 'var(--text-2)' }}>{m.played}</td>
                          <td style={{ padding: '7px 8px', textAlign: 'right', color: '#34d399' }}>{m.wins}</td>
                          <td style={{ padding: '7px 8px', textAlign: 'right', color: m.winRate >= 0.15 ? '#34d399' : 'var(--text-3)' }}>{(m.winRate * 100).toFixed(1)}%</td>
                          <td style={{ padding: '7px 8px', textAlign: 'right', fontWeight: m.avgKills >= 2 ? 700 : 400, color: m.avgKills >= 2 ? '#60a5fa' : 'var(--text-2)' }}>{m.avgKills}</td>
                          <td style={{ padding: '7px 8px', textAlign: 'right', color: 'var(--text-3)' }}>{m.avgDmg}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p style={{ color: 'var(--text-3)', fontSize: 13 }}>No map stats available yet.</p>}
            </div>
          )}

          {/* ── SQUAD ── */}
          {activeTab === 'squad' && (
            <div>
              {squadStats.length ? (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', marginBottom: 12 }}>Teammates ranked by games played together (recent history)</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {squadStats.map((t, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', background: 'var(--bg-raised)', borderRadius: 8, border: '1px solid var(--border)' }}>
                        <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--bg-card)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: 'var(--text-3)', flexShrink: 0 }}>
                          {i + 1}
                        </div>
                        <div style={{ flex: 1, fontWeight: 700, fontSize: 13, color: 'var(--text-1)' }}>{t.name}</div>
                        <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
                          <span style={{ color: 'var(--text-3)' }}>{t.games}g</span>
                          <span style={{ color: '#34d399', fontWeight: 600 }}>{t.wins}W</span>
                          <span style={{ color: t.winRate >= 0.15 ? '#34d399' : 'var(--text-3)', fontWeight: t.winRate >= 0.15 ? 700 : 400 }}>{(t.winRate * 100).toFixed(0)}%</span>
                        </div>
                        {/* Mini win-rate bar */}
                        <div style={{ width: 60, height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden', flexShrink: 0 }}>
                          <div style={{ width: `${Math.min(t.winRate * 100 * 4, 100)}%`, height: '100%', background: '#34d399', borderRadius: 3 }} />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 10 }}>Based on recent cached match history · g = games together · W = shared wins</div>
                </div>
              ) : <p style={{ color: 'var(--text-3)', fontSize: 13 }}>No squad history available yet.</p>}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

// ── Players tab ───────────────────────────────────────────────────────────────
function Players({ resolvedStats, loading, weaponData, lifetimeData, analysisData }) {
  const [playerSort, setPlayerSort] = useState('kd');
  const [profileTarget, setProfileTarget] = useState(null);

  const sortedStats = useMemo(() => {
    if (!resolvedStats) return resolvedStats;
    return [...resolvedStats].sort((a, b) => {
      const sa = a.s, sb = b.s;
      if (playerSort === 'alpha')    return a.member.name.localeCompare(b.member.name);
      if (playerSort === 'kd')       return ((sb?.kills||0)/Math.max(sb?.losses||1,1)) - ((sa?.kills||0)/Math.max(sa?.losses||1,1));
      if (playerSort === 'wins')     return (sb?.wins||0) - (sa?.wins||0);
      if (playerSort === 'kills')    return (sb?.kills||0) - (sa?.kills||0);
      if (playerSort === 'damage')   return ((sb?.damageDealt||0)/Math.max(sb?.roundsPlayed||1,1)) - ((sa?.damageDealt||0)/Math.max(sa?.roundsPlayed||1,1));
      if (playerSort === 'bestgame') return (sb?.roundMostKills||0) - (sa?.roundMostKills||0);
      return 0;
    });
  }, [resolvedStats, playerSort]);

  if (loading) return (
    <div className="p-6 grid md:grid-cols-2 lg:grid-cols-3 gap-4">
      {[...Array(6)].map((_,i) => <div key={i} className="skeleton h-48 rounded-xl"/>)}
    </div>
  );

  if (!resolvedStats?.length) return (
    <div className="flex flex-col items-center justify-center h-64 gap-3" style={{ color: 'var(--text-3)' }}>
      <Icon.users /><p>No members yet. Add members in Settings.</p>
    </div>
  );

  const PLAYER_SORTS = [
    { key: 'kd',       label: 'K/D' },
    { key: 'kills',    label: 'Kills' },
    { key: 'wins',     label: 'Wins' },
    { key: 'damage',   label: 'Avg Dmg' },
    { key: 'bestgame', label: 'Best Game' },
    { key: 'alpha',    label: 'A–Z' },
  ];

  return (
    <div className="p-6 space-y-4">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700 }}>Players</h2>
        <div style={{ display: 'flex', gap: 4, background: 'var(--bg-card)', borderRadius: 8, padding: 4, border: '1px solid var(--border)', flexWrap: 'wrap' }}>
          {PLAYER_SORTS.map(s => (
            <button key={s.key} onClick={() => setPlayerSort(s.key)} style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 5, border: 'none', cursor: 'pointer', background: playerSort === s.key ? 'var(--accent)' : 'transparent', color: playerSort === s.key ? '#fff' : 'var(--text-3)', transition: 'all .15s' }}>{s.label}</button>
          ))}
        </div>
      </div>
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4" style={{ alignItems: 'start' }}>
        {sortedStats.map(({ member, s, season: sd, lifetime: ld, form, mapStats, recent, seasonError }) => {
          const historyEntry = { form, mapStats, recent };
          return (
            <PlayerCard
              key={member.accountId}
              member={member} sd={sd} ld={ld} seasonError={seasonError}
              weaponEntry={weaponData?.[member.accountId]}
              historyEntry={historyEntry}
              lifetimeEntry={lifetimeData?.players?.[member.accountId]}
              onViewProfile={() => setProfileTarget({ member, sd, ld, resolvedS: s,
                weaponEntry:  weaponData?.[member.accountId],
                historyEntry,
                lifetimeEntry: lifetimeData?.players?.[member.accountId],
              })}
            />
          );
        })}
      </div>
      {profileTarget && (
        <PlayerProfileModal
          {...profileTarget}
          analysisProfile={analysisData?.players?.find(p => p.name.toLowerCase() === profileTarget.member.name.toLowerCase()) || null}
          onClose={() => setProfileTarget(null)}
        />
      )}
    </div>
  );
}
