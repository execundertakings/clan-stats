// ── Shared hooks ──────────────────────────────────────────────────────────────
function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= breakpoint);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= breakpoint);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);
  return isMobile;
}

// ── Error boundary ────────────────────────────────────────────────────────────
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('[3PI] ErrorBoundary caught:', error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '40px 32px', textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-1)', marginBottom: 8 }}>
            {this.props.label || 'This section'} crashed
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 20, maxWidth: 360, margin: '0 auto 20px' }}>
            {this.state.error.message}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ padding: '7px 18px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-raised)', color: 'var(--text-2)', fontSize: 12, cursor: 'pointer' }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Loading spinner ───────────────────────────────────────────────────────────
function Spinner({ size = 'md' }) {
  const s = size === 'sm' ? 'w-4 h-4' : size === 'lg' ? 'w-8 h-8' : 'w-6 h-6';
  return (
    <svg className={`${s} spin`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.37 0 0 5.37 0 12h4z"/>
    </svg>
  );
}

// ── Stat cell ─────────────────────────────────────────────────────────────────
function StatCell({ label, value, sub, accent = false }) {
  return (
    <div className="stat-card flex flex-col gap-1">
      <div style={{ color: 'var(--text-3)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: accent ? 'var(--accent)' : 'var(--text-1)', lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ color: 'var(--text-3)', fontSize: 12 }}>{sub}</div>}
    </div>
  );
}

// ── Player role classifier ────────────────────────────────────────────────────
// Analyses a player's season stats and returns their dominant play style.
function playerRole(s) {
  if (!s || !s.roundsPlayed) return null;
  const kdVal      = (s.kills || 0) / Math.max(s.losses || 1, 1);
  const hsRatio    = (s.headshotKills || 0) / Math.max(s.kills || 1, 1);
  const assistsPerMatch = (s.assists || 0) / s.roundsPlayed;
  const revivesPerMatch = (s.revives || 0) / s.roundsPlayed;
  const dbnosPerMatch   = (s.dBNOs   || 0) / s.roundsPlayed;
  const avgSurviveSecs  = (s.timeSurvived || 0) / s.roundsPlayed;
  const top10Rate  = (s.top10s || 0) / s.roundsPlayed;

  // Fragger: high K/D + high knockdowns per match
  if (kdVal >= 2.5 || (kdVal >= 2.0 && dbnosPerMatch >= 1.5))
    return { label: 'Fragger',      emoji: '💀', color: '#f87171', desc: 'High K/D, aggressive engager' };
  // Sharpshooter: headshot ratio ≥ 25%
  if (hsRatio >= 0.25 && s.kills >= 30)
    return { label: 'Sharpshooter', emoji: '🎯', color: '#facc15', desc: 'High headshot accuracy' };
  // Support: revives + assists are main contribution
  if ((revivesPerMatch >= 0.4 || assistsPerMatch >= 1.2) && kdVal < 1.5)
    return { label: 'Support',      emoji: '🛡️', color: '#60a5fa', desc: 'Revives & assists the team' };
  // Survivor: high top-10 rate + long survival time but fewer kills
  if (top10Rate >= 0.45 && avgSurviveSecs >= 1400)
    return { label: 'Survivor',     emoji: '🏃', color: '#4ade80', desc: 'Consistently survives late game' };
  return             { label: 'All-Rounder',  emoji: '⚡', color: '#a78bfa', desc: 'Balanced across all categories' };
}

// ── Avg survival time formatter ───────────────────────────────────────────────
function fmtSurvival(secs) {
  if (!secs || secs < 0) return '—';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}m${s < 10 ? '0' : ''}${s}s`;
}

// ── Abbreviation tooltip ──────────────────────────────────────────────────────
// Wrap any abbreviation text in <Tip label="explanation">ABBR</Tip>
function Tip({ label, children, style }) {
  return (
    <span data-tip={label} style={style}>{children}</span>
  );
}
