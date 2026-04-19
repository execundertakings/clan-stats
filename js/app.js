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
  const [seasonMismatch, setSeasonMismatch] = useState(false);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [prewarm, setPrewarm]   = useState(null);

  // ── Single source of truth for player stats ───────────────────────────────
  // Merges PUBG API season data + official-only local match cache once at the
  // App level. Components consume resolvedStats directly — no more per-component
  // getStats() calls or dual useMemo deps on both clanStats + historyData.
  const resolvedStats = useMemo(() => {
    if (!clanStats?.length) return [];
    return clanStats.map(entry => ({
      member:   entry.member,
      s:        getStats(entry.member.accountId, entry.season, historyData), // cache-preferred
      sApi:     extractStats(entry.season),                                  // always API (for non-trackable fields)
      lt:       extractLifetimeStats(entry.lifetime),                        // pre-resolved lifetime
      season:   entry.season,    // raw — needed by PlayerCard / archive rows
      lifetime: entry.lifetime,  // raw — needed by PlayerCard
      seasonId: entry.seasonId,
      form:     historyData?.[entry.member.accountId]?.form     || null,
      mapStats: historyData?.[entry.member.accountId]?.mapStats || null,
      recent:   historyData?.[entry.member.accountId]?.recent   || [],
    }));
  }, [clanStats, historyData]);

  // ── Analysis computed from resolvedStats — same source of truth as all tabs ─
  const analysisData = useMemo(() => computeAnalysisFromStats(resolvedStats), [resolvedStats]);

  // Settings gate: click logo 10× within 3s to unlock
  const [settingsUnlocked, setSettingsUnlocked] = useState(false);
  const logoClicks = useRef([]);
  function handleLogoClick() {
    const now = Date.now();
    logoClicks.current = [...logoClicks.current.filter(t => now - t < 3000), now];
    if (logoClicks.current.length >= 10) {
      logoClicks.current = [];
      setSettingsUnlocked(u => {
        const next = !u;
        if (!next && tab === 'settings') navigateTab('overview');
        return next;
      });
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
      api.get('/api/match-history').then(d => setHistoryData(d)).catch(() => {});
      api.get('/api/squad-stats').then(d => setSquadData(d)).catch(() => {});
      api.get('/api/heatmap').then(d => setHeatmapData(d)).catch(() => {});
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
      <div className="sidebar" style={{ width: 220, background: 'var(--bg-surface)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', padding: '20px 12px', flexShrink: 0, position: 'fixed', top: 0, left: 0, bottom: 0, zIndex: 10 }}>
        {/* Logo — click 10× fast to unlock Settings */}
        <div style={{ padding: '0 8px 20px', borderBottom: '1px solid var(--border)', marginBottom: 8, cursor: 'default', userSelect: 'none' }} onClick={handleLogoClick}>
          <div style={{ fontWeight: 800, fontSize: 17, color: 'var(--text-1)', letterSpacing: '-.01em' }}>APES</div>
          <div style={{ fontSize: 11, color: settingsUnlocked ? 'var(--accent)' : 'var(--text-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em' }}>
            {settingsUnlocked ? '⚙ Admin unlocked' : 'Clan Stats'}
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
            {error ? 'API Error' : `${members.length} members`}
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

        {/* Tab content */}
        {tab === 'overview'     && <ErrorBoundary label="Overview"><Overview     members={members}    resolvedStats={resolvedStats} season={currentSeason} loading={loading} onLogoClick={handleLogoClick} /></ErrorBoundary>}
        {tab === 'leaderboard' && <ErrorBoundary label="Leaderboard"><Leaderboard  resolvedStats={resolvedStats} loading={loading} weaponData={weaponData} lifetimeData={lifetimeData} /></ErrorBoundary>}
        {tab === 'players'     && <ErrorBoundary label="Players"><Players      resolvedStats={resolvedStats} loading={loading} weaponData={weaponData} lifetimeData={lifetimeData} analysisData={analysisData} /></ErrorBoundary>}
        {tab === 'trends'      && <ErrorBoundary label="Trends"><Trends       resolvedStats={resolvedStats} loading={loading} weaponData={weaponData} squadData={squadData} heatmapData={heatmapData} analysisData={analysisData} /></ErrorBoundary>}
        {tab === 'secret_keys' && <ErrorBoundary label="Secret Keys"><SecretKeys /></ErrorBoundary>}
        {tab === 'settings'    && <ErrorBoundary label="Settings"><Settings     members={members}    onMembersChange={onMembersChange} /></ErrorBoundary>}
      </div>

      <PrewarmBanner status={prewarm} />

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
