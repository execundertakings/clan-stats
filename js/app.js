// ── Main App ──────────────────────────────────────────────────────────────────
function App() {
  const VALID_TABS = ['overview','leaderboard','players','trends','settings','secret_keys'];
  const hashTab = window.location.hash.replace('#','');
  const [tab, setTab] = useState(VALID_TABS.includes(hashTab) ? hashTab : 'overview');
  const navigateTab = useCallback(id => {
    setTab(id);
    window.location.hash = id;
  }, []);
  const [members, setMembers]   = useState([]);
  const [seasons, setSeasons]   = useState([]);
  const [currentSeason, setCurrentSeason] = useState(null);
  const [clanStats, setClanStats] = useState(null);
  const [weaponData, setWeaponData] = useState(null);
  const [historyData, setHistoryData] = useState(null);
  const [squadData, setSquadData] = useState(null);
  const [lifetimeData, setLifetimeData] = useState(null);
  const [heatmapData, setHeatmapData]   = useState(null);
  const [aiInsights, setAiInsights]       = useState(null);
  const [telemetryInsights, setTelemetryInsights] = useState(null);
  const [playerProfiles, setPlayerProfiles] = useState(null);
  const [seasonMismatch, setSeasonMismatch] = useState(false);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [prewarm, setPrewarm]   = useState(null);

  // ── Pull-to-refresh state (mobile) — declared here so hooks order is stable ──
  const [pullState, setPullState] = useState('idle'); // idle | pulling | ready | refreshing
  const [pullDelta, setPullDelta] = useState(0);
  const pullStartY  = useRef(0);
  const isPulling   = useRef(false);
  const lastDelta   = useRef(0);
  const loadingRef  = useRef(loading);
  const PTR_THRESHOLD = 80;

  useEffect(() => { loadingRef.current = loading; }, [loading]);

  // ── Single source of truth for player stats ───────────────────────────────
  // Builds the trunk from the official-only local match cache once at the App
  // level. Components consume resolvedStats directly — no per-component
  // derivation and no fallback to broader season aggregates.
  const resolvedStats = useMemo(() => {
    if (!clanStats?.length || historyData === null) return [];
    return clanStats.map(entry => {
      const s    = getStats(entry.member.accountId, entry.season, historyData);

      // ── Pre-compute ALL derived metrics here — the single source of truth ──
      // No component should ever derive these independently.
      const games      = s?.roundsPlayed  || 0;
      const kills      = s?.kills         || 0;
      const wins       = s?.wins          || 0;
      const top10      = s?.top10s        || 0;
      const losses     = s?.losses        ?? Math.max(games - wins, 1);
      const hs         = s?.headshotKills || 0;
      const assists    = s?.assists       || 0;
      const dmg        = s?.damageDealt   || 0;
      const timeSurv   = s?.timeSurvived  || 0;

      // Telemetry/weapon detail cache — only use values derived from applicable
      // captured matches. Missing telemetry stays at 0 rather than falling back
      // to broader PUBG season aggregates.
      const wData           = weaponData?.[entry.member.accountId] || {};
      const hData           = historyData?.[entry.member.accountId] || {};
      const coverageState   = historyCoverageSummary(hData.coverage);
      const trustedCapture  = coverageState?.trusted !== false;
      const hasTelemetry    = !!(
        (wData.weapons && wData.weapons.length > 0) ||
        (wData.blueZone?.matches > 0) ||
        wData.revives || wData.heals || wData.boosts ||
        wData.vehicleDestroys || wData.roadKills || wData.longestKill
      );
      const telemetryPreferred = trustedCapture && hasTelemetry;
      const boosts          = telemetryPreferred ? (wData.boosts || 0) : 0;
      const heals           = telemetryPreferred ? (wData.heals || 0) : 0;
      const revives         = telemetryPreferred ? (wData.revives || 0) : 0;
      const roadKills       = telemetryPreferred ? (wData.roadKills || 0) : 0;
      const vehicleDestroys = telemetryPreferred ? (wData.vehicleDestroys || 0) : 0;
      const longestKill     = telemetryPreferred ? (wData.longestKill || 0) : 0;

      // API-only field: maxKillStreaks is the highest consecutive kill streak in a single
      // life/match — not derivable from the match cache. Read directly from the PUBG season
      // API stats object (entry.season), same source as the original architecture used.
      const sApi   = extractStats(entry.season);
      const streak = sApi?.maxKillStreaks || 0;
      const days   = hData.daysPlayed || 0;

      const kdVal        = kills / Math.max(losses, 1);
      const winRate      = games > 0 ? wins  / games  : 0;
      const top10Rate    = games > 0 ? top10 / games  : 0;
      const closeOutRate = top10 > 0 ? wins  / top10  : 0;
      const nearMissRate = games > 0 ? (top10 - wins) / games : 0;
      const hsRate       = kills > 0 ? hs / kills     : 0;
      const avgDmg       = games > 0 ? dmg / games      : 0;
      const avgSurvival  = games > 0 ? timeSurv / games : 0;
      const killsPg      = games > 0 ? kills   / games  : 0;
      const assistsPg    = games > 0 ? assists / games  : 0;
      const boostsPg     = games > 0 ? boosts  / games  : 0;
      const healsPg      = games > 0 ? heals   / games  : 0;
      const revivesPg    = games > 0 ? revives / games  : 0;
      const dmgPerKill   = kills > 3  ? dmg / kills     : null;
      const score        = computeScore({ kdVal, avgDmg, hsRate, top10Rate, winRate, closeOutRate, assistsPg, revivesPg, games }); // shared formula

      return {
        member:   entry.member,
        s,
        lt:       hData.totals || null, // official-only current-season totals from match_history_cache
        season:   entry.season,    // raw season object (retained for potential future use)
        lifetime: entry.lifetime,  // raw pass-through (not used for display)
        seasonId: entry.seasonId,
        form:     hData.form     || null,
        mapStats: hData.mapStats || null,
        recent:   hData.recent   || [],
        coverage: hData.coverage || null,
        weaponMeta: wData || null,
        // ── Pre-computed fields — components must not re-derive these ──
      // Raw counts (from the official-only match-history trunk)
      games, kills, wins, top10, losses, hs, assists, dmg, timeSurv,
        // Cache-tracked counts (from match_history_cache — official matches only)
        dBNOs: s?.dBNOs || 0,
        // Telemetry-derived counts (counting-mode filtered, from weapon_cache)
        boosts, heals, revives, roadKills, vehicleDestroys, longestKill,
        // History-derived counts (official matches, from match_history_cache)
        days, streak,
        // Derived rates
        kdVal, winRate, top10Rate, closeOutRate, nearMissRate,
        hsRate, avgDmg, avgSurvival,
        killsPg, assistsPg, boostsPg, healsPg, revivesPg, dmgPerKill,
        score,
      };
    });
  }, [clanStats, historyData, weaponData]);

  // ── Clan-wide unique match/win counts (deduplicated by matchId) ─────────────
  const clanMatchTotals = useMemo(() => {
    const activeEntries = (resolvedStats || []).filter(r => r.games > 0);
    const fullCoverage = activeEntries.length > 0 && activeEntries.every(r => historyCoverageSummary(r.coverage)?.trusted !== false);
    if (!fullCoverage) return null;
    if (historyData?._summary) return historyData._summary;
    if (!resolvedStats?.length) return null;
    const seen = new Set();
    let uniqueGames = 0, uniqueWins = 0;
    for (const r of resolvedStats) {
      for (const m of (r.recent || [])) {
        if (!m.matchId || seen.has(m.matchId)) continue;
        seen.add(m.matchId);
        uniqueGames++;
        if (m.won) uniqueWins++;
      }
    }
    return { uniqueGames, uniqueWins };
  }, [historyData, resolvedStats]);

  // ── Analysis computed from resolvedStats — same source of truth as all tabs ─
  const analysisData = useMemo(() => computeAnalysisFromStats(resolvedStats), [resolvedStats]);

  // Settings gate: click logo 10× within 3s → server-verified password prompt → unlock
  const [settingsUnlocked, setSettingsUnlocked] = useState(false);
  const [showAdminPrompt, setShowAdminPrompt] = useState(false);
  const [adminPwInput, setAdminPwInput] = useState('');
  const [adminPwError, setAdminPwError] = useState(false);
  const logoClicks = useRef([]);

  async function handleAdminSubmit() {
    try {
      await api.post('/api/admin/verify', { password: adminPwInput }, { skipAdmin: true });
      api.setAdminPassword(adminPwInput);
      setShowAdminPrompt(false);
      setAdminPwInput('');
      setAdminPwError(false);
      setSettingsUnlocked(true);
    } catch {
      api.setAdminPassword('');
      setSettingsUnlocked(false);
      setAdminPwError(true);
      setAdminPwInput('');
    }
  }

  function handleLogoClick() {
    if (settingsUnlocked) {
      setSettingsUnlocked(false);
      api.setAdminPassword('');
      if (tab === 'settings') navigateTab('overview');
      return;
    }
    const now = Date.now();
    logoClicks.current = [...logoClicks.current.filter(t => now - t < 3000), now];
    if (logoClicks.current.length >= 10) {
      logoClicks.current = [];
      setAdminPwError(false);
      setAdminPwInput('');
      setShowAdminPrompt(true);
    }
  }

  // Load data immediately on mount, then keep updating as prewarm completes.
  // Prewarm poll uses exponential backoff on failures.
  useEffect(() => {
    // Always load right away so members/cached stats are visible immediately
    loadData();

    let timer;
    let failCount = 0;
    async function pollPrewarm() {
      try {
        const status = await api.get('/api/prewarm/status');
        failCount = 0;
        setPrewarm(status);
        if (status.running) {
          timer = setTimeout(pollPrewarm, 3000);
        } else if (status.completed > 0) {
          // Prewarm finished with data — refresh stats
          loadData();
        }
      } catch {
        failCount++;
        // Back off: 10s, 20s, 40s, 60s max — don't hammer on rate-limit
        const delay = Math.min(10000 * Math.pow(2, failCount - 1), 60000);
        timer = setTimeout(pollPrewarm, delay);
      }
    }
    pollPrewarm();
    return () => clearTimeout(timer);
  }, []);

  // Load baseline data — members always load; seasons/stats failures are non-fatal
  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Always load members first — independent of API rate limits
      const membersData = await api.get('/api/members');
      setMembers(membersData.members || []);

      // Seasons and stats can fail without killing the member list
      try {
        const seasonsData = await api.get('/api/seasons');
        const allSeasons = seasonsData.seasons || [];
        setSeasons(allSeasons);
        const current = allSeasons.find(s => s.attributes?.isCurrentSeason);
        setCurrentSeason(current || null);
      } catch (e) {
        setError(e.message);
      }

      if ((membersData.members || []).length > 0) {
        try {
          const statsData = await api.get('/api/clan/stats');
          setClanStats(statsData.stats || []);
        } catch (e) {
          setError(e.message);
          setClanStats([]);
        }
      } else {
        setClanStats([]);
      }
      // Supplemental data — non-blocking, best-effort
      api.get('/api/weapons').then(d => setWeaponData(d)).catch(() => {});
      try {
        const history = await api.get('/api/match-history');
        setHistoryData(history);
      } catch {
        setHistoryData({});
      }
      api.get('/api/squad-stats').then(d => setSquadData(d)).catch(() => {});
      api.get('/api/heatmap').then(d => setHeatmapData(d)).catch(() => {});
      api.get('/api/ai-insights').then(d => setAiInsights(d)).catch(() => setAiInsights(null));
      api.get('/api/telemetry-insights').then(d => setTelemetryInsights(d)).catch(() => setTelemetryInsights(null));
      api.get('/api/analysis').then(d => setPlayerProfiles(d)).catch(() => {});
      api.get('/api/lifetime').then(d => {
        setLifetimeData(d);
        // Detect season rollover: cached stats are from a different season than active
        if (d?.seasonId && clanStats?.length) {
          const activeSeasonId = clanStats[0]?.seasonId;
          if (activeSeasonId && activeSeasonId !== d.seasonId) setSeasonMismatch(true);
        }
      }).catch(() => {});

      setLastRefresh(new Date());
    } catch (e) {
      // Only truly fatal if member fetch itself fails
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // For additions/bulk imports: full reload. For removals: update local state only (avoids rate-limit crashes).
  const onMembersChange = useCallback((action, payload) => {
    if (action === 'remove' && payload?.name) {
      setMembers(prev => prev.filter(m => m.name.toLowerCase() !== payload.name.toLowerCase()));
      setClanStats(prev => prev ? prev.filter(s => s.member.name.toLowerCase() !== payload.name.toLowerCase()) : prev);
    } else {
      loadData();
    }
  }, [loadData]);

  // ── Pull-to-refresh touch handlers — placed here because loadData must be declared first ──
  useEffect(() => {
    function onTouchStart(e) {
      if (window.scrollY === 0 && !loadingRef.current) {
        pullStartY.current = e.touches[0].clientY;
        isPulling.current  = true;
        lastDelta.current  = 0;
      }
    }
    function onTouchMove(e) {
      if (!isPulling.current) return;
      const delta = e.touches[0].clientY - pullStartY.current;
      if (delta <= 0) {
        isPulling.current = false;
        setPullDelta(0);
        setPullState('idle');
        return;
      }
      lastDelta.current = delta;
      const clamped = Math.min(delta, PTR_THRESHOLD * 1.5);
      setPullDelta(clamped);
      setPullState(delta >= PTR_THRESHOLD ? 'ready' : 'pulling');
    }
    function onTouchEnd() {
      if (!isPulling.current) return;
      isPulling.current = false;
      const delta = lastDelta.current;
      if (delta >= PTR_THRESHOLD) {
        setPullState('refreshing');
        setPullDelta(0);
        loadData().finally(() => setPullState('idle'));
      } else {
        setPullDelta(0);
        setPullState('idle');
      }
    }
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove',  onTouchMove,  { passive: true });
    document.addEventListener('touchend',   onTouchEnd,   { passive: true });
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove',  onTouchMove);
      document.removeEventListener('touchend',   onTouchEnd);
    };
  }, [loadData]);

  const tabs = [
    { id: 'overview',     label: 'Overview',     Icon: Icon.home },
    { id: 'leaderboard', label: 'Leaderboard',  Icon: Icon.trophy },
    { id: 'players',     label: 'Players',      Icon: Icon.users },
    { id: 'trends',      label: 'Trends',       Icon: Icon.trend },
    { id: 'secret_keys', label: 'Secret Keys',  Icon: Icon.key },
    ...(settingsUnlocked ? [{ id: 'settings', label: 'Settings', Icon: Icon.settings }] : []),
  ];

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      {/* Sidebar */}
      <div className="sidebar" style={{ width: 220, background: 'var(--bg-surface)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', padding: '20px 12px', flexShrink: 0, position: 'fixed', top: 0, left: 0, bottom: 0, zIndex: 10, overflow: 'hidden' }}>
        {/* Sidebar background — faint operative figure */}
        <img src="/images/corp_sniper.png" aria-hidden="true" style={{ position: 'absolute', bottom: 0, left: '-10%', width: '120%', height: '70%', objectFit: 'cover', objectPosition: 'center top', opacity: 0.32, pointerEvents: 'none', zIndex: 0, maskImage: 'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,.7) 30%, rgba(0,0,0,1) 100%)' }} />
        {/* Logo — click 10× fast to unlock Settings */}
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <div style={{ padding: '0 8px 20px', borderBottom: '1px solid var(--border)', marginBottom: 8, cursor: 'default', userSelect: 'none', display: 'flex', alignItems: 'center', gap: 10 }} onClick={handleLogoClick}>
          <img src="/images/corp_emblem.png" alt={CLAN.shortName} style={{ width: 38, height: 38, objectFit: 'contain', flexShrink: 0, opacity: 0.9 }} />
          <div>
            <div style={{ fontWeight: 800, fontSize: 17, color: 'var(--text-1)', letterSpacing: '-.01em' }}>{CLAN.shortName}</div>
            <div style={{ fontSize: 11, color: settingsUnlocked ? 'var(--accent)' : 'var(--text-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em' }}>
              {settingsUnlocked ? '⚙ Admin unlocked' : CLAN.subtitle}
            </div>
          </div>
        </div>
        <div className="nav-section">Navigation</div>
        {tabs.map(t => (
          <div key={t.id} className={`nav-item ${tab === t.id ? 'active' : ''}`} onClick={() => navigateTab(t.id)}>
            <t.Icon />
            {t.label}
          </div>
        ))}
        <div style={{ flex: 1 }} />
        {/* Bottom status */}
        <div style={{ padding: '12px 8px 0', borderTop: '1px solid var(--border)', marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-3)' }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: error ? '#f87171' : '#4ade80' }} />
            {error ? 'API Error' : `${members.length} ${CLAN.memberNounPlural}`}
          </div>
          {lastRefresh && (
            <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
              Updated {lastRefresh.toLocaleTimeString()}
            </div>
          )}
          <button
            onClick={loadData}
            disabled={loading}
            style={{ marginTop: 8, display:'flex',alignItems:'center',gap:4,fontSize:11,color:'var(--text-3)',background:'none',border:'none',cursor:'pointer',padding:0 }}
          >
            {loading ? <Spinner size="sm" /> : <Icon.refresh />}
            Refresh
          </button>
        </div>
        </div>{/* end zIndex wrapper */}
      </div>

      {/* Main content */}
      <div className="main-pad" style={{ flex: 1, marginLeft: 220, minHeight: '100vh', minWidth: 0 }}>
        {/* Header */}
        <div style={{ borderBottom: '1px solid var(--border)', padding: '16px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg-surface)', position: 'sticky', top: 0, zIndex: 9 }}>
          <div>
            <span style={{ fontWeight: 700, fontSize: 15 }}>{tabs.find(t => t.id === tab)?.label}</span>
            {currentSeason && (
              <span className="badge badge-blue" style={{ marginLeft: 10 }}>
                {formatSeason(currentSeason.id)}
              </span>
            )}
          </div>
          {error && <div style={{ color: '#f87171', fontSize: 12 }}>⚠ {error}</div>}
        </div>

        {/* Season rollover warning */}
        {seasonMismatch && (
          <div style={{ margin: '0 0 8px', padding: '8px 16px', background: 'rgba(251,191,36,.08)', border: '1px solid rgba(251,191,36,.3)', borderRadius: 8, fontSize: 12, color: '#fbbf24', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>⚠️</span>
            <span>New season detected — lifetime stats are from the previous season. Season stats will fill in as games are played.</span>
            <button onClick={() => setSeasonMismatch(false)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#fbbf24', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>×</button>
          </div>
        )}

        {loading && (
          <div style={{ margin: '12px 24px 0', padding: '12px 14px', borderRadius: 14, border: '1px solid rgba(59,130,246,.22)', background: 'linear-gradient(90deg, rgba(59,130,246,.12), rgba(12,18,32,.72))', display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-2)', fontSize: 13, fontWeight: 500 }}>
            <span style={{ color: '#60a5fa', display: 'inline-flex', alignItems: 'center' }}><Spinner size="sm" /></span>
            <span>Syncing {CLAN.memberNoun} performance data. Your briefing will be ready momentarily.</span>
          </div>
        )}

        {/* Tab content */}
        {tab === 'overview'     && <ErrorBoundary label="Overview"><Overview     members={members}    resolvedStats={resolvedStats} clanMatchTotals={clanMatchTotals} season={currentSeason} loading={loading} onLogoClick={handleLogoClick} /></ErrorBoundary>}
        {tab === 'leaderboard' && <ErrorBoundary label="Leaderboard"><Leaderboard  resolvedStats={resolvedStats} loading={loading} weaponData={weaponData} lifetimeData={lifetimeData} /></ErrorBoundary>}
        {tab === 'players'     && <ErrorBoundary label="Players"><Players      resolvedStats={resolvedStats} loading={loading} weaponData={weaponData} lifetimeData={lifetimeData} analysisData={analysisData} aiInsights={aiInsights} playerProfiles={playerProfiles} /></ErrorBoundary>}
        {tab === 'trends'      && <ErrorBoundary label="Trends"><Trends       resolvedStats={resolvedStats} loading={loading} weaponData={weaponData} squadData={squadData} heatmapData={heatmapData} analysisData={analysisData} aiInsights={aiInsights} telemetryInsights={telemetryInsights} /></ErrorBoundary>}
        {tab === 'secret_keys' && <ErrorBoundary label="Secret Keys"><SecretKeys /></ErrorBoundary>}
        {tab === 'settings'    && <ErrorBoundary label="Settings"><Settings     members={members}    onMembersChange={onMembersChange} /></ErrorBoundary>}
      </div>

      <PrewarmBanner status={prewarm} />

      {/* Admin password modal */}
      {showAdminPrompt && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => { setShowAdminPrompt(false); setAdminPwError(false); setAdminPwInput(''); }}>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '28px 32px', width: 340, boxShadow: '0 24px 48px rgba(0,0,0,0.5)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-1)', marginBottom: 4 }}>Admin Access</div>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 20 }}>{CLAN.restrictedLabel}</div>
            <input
              type="password"
              autoFocus
              placeholder="Password"
              value={adminPwInput}
              onChange={e => { setAdminPwInput(e.target.value); setAdminPwError(false); }}
              onKeyDown={e => { if (e.key === 'Enter') handleAdminSubmit(); if (e.key === 'Escape') { setShowAdminPrompt(false); setAdminPwInput(''); setAdminPwError(false); } }}
              style={{ width: '100%', boxSizing: 'border-box', background: 'var(--bg)', border: `1px solid ${adminPwError ? '#f87171' : 'var(--border)'}`, borderRadius: 8, padding: '10px 14px', color: 'var(--text-1)', fontSize: 14, outline: 'none', marginBottom: adminPwError ? 8 : 16 }}
            />
            {adminPwError && <div style={{ fontSize: 12, color: '#f87171', marginBottom: 16 }}>Incorrect password.</div>}
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => { setShowAdminPrompt(false); setAdminPwInput(''); setAdminPwError(false); }}
                style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: '1px solid var(--border)', background: 'none', color: 'var(--text-2)', cursor: 'pointer', fontSize: 13 }}>
                Cancel
              </button>
              <button onClick={handleAdminSubmit}
                style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                Unlock
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pull-to-refresh indicator — mobile only, sits above sticky header */}
      {pullState !== 'idle' && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 100,
          height: 44,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border)',
          fontSize: 13,
          fontWeight: 600,
          color: pullState === 'ready' ? 'var(--accent)' : 'var(--text-2)',
          transform: pullState === 'refreshing'
            ? 'translateY(0)'
            : `translateY(${Math.min(pullDelta - 44, 0)}px)`,
          transition: pullState === 'refreshing' ? 'transform 0.2s ease' : 'none',
          pointerEvents: 'none',
        }}>
          {pullState === 'refreshing'
            ? <><div style={{ width: 20, height: 20, borderRadius: '50%', border: '2px solid currentColor', borderTopColor: 'transparent', animation: 'spin 0.7s linear infinite', opacity: 0.7, flexShrink: 0 }} /><span>Refreshing…</span></>
            : pullState === 'ready'
              ? <span>↑ Release to refresh</span>
              : <span>↓ Pull to refresh</span>
          }
        </div>
      )}

      {/* Mobile bottom nav */}
      <div className="mobile-nav" style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: 'var(--bg-surface)', borderTop: '1px solid var(--border)', padding: '8px 0', zIndex: 20, justifyContent: 'space-around' }}>
        {tabs.map(t => (
          <div key={t.id} onClick={() => navigateTab(t.id)} style={{ display:'flex',flexDirection:'column',alignItems:'center',gap:3,padding:'4px 12px',cursor:'pointer',color: tab === t.id ? 'var(--accent)' : 'var(--text-3)',fontSize:10,fontWeight:600 }}>
            <t.Icon />
            {t.label}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Boot ──────────────────────────────────────────────────────────────────────
function boot() {
  const root = document.getElementById('root');
  ReactDOM.createRoot(root).render(<App />);
}

// Scripts are deferred — DOM is ready but React CDN may still be resolving.
// Poll briefly to handle any race between React CDN and our bundle.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else if (window.React && window.ReactDOM) {
  boot();
} else {
  const check = setInterval(() => {
    if (window.React && window.ReactDOM) {
      clearInterval(check);
      boot();
    }
  }, 20);
}
