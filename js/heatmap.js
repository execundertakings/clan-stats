// ── Landing Heatmap component ─────────────────────────────────────────────────
// Colour palette — one per player slot (up to 20)
const PLAYER_COLORS = [
  '#f87171','#fb923c','#facc15','#4ade80','#34d399','#22d3ee',
  '#60a5fa','#818cf8','#c084fc','#f472b6','#fbbf24','#a3e635',
  '#2dd4bf','#38bdf8','#a78bfa','#e879f9','#fb7185','#fdba74',
  '#86efac','#67e8f9',
];

// Official PUBG API assets — No_Text_Low_Res for clean overlay
// https://github.com/pubg/api-assets/tree/master/Assets/Maps
const _BASE = 'https://raw.githubusercontent.com/pubg/api-assets/master/Assets/Maps/';
const MAP_IMAGES = {
  'Erangel':    _BASE + 'Erangel_Main_No_Text_Low_Res.png',
  'Miramar':    _BASE + 'Miramar_Main_No_Text_Low_Res.png',
  'Sanhok':     _BASE + 'Sanhok_Main_No_Text_Low_Res.png',
  'Vikendi':    _BASE + 'Vikendi_Main_No_Text_Low_Res.png',
  'Taego':      _BASE + 'Taego_Main_No_Text_Low_Res.png',
  'Deston':     _BASE + 'Deston_Main_No_Text_Low_Res.png',
  'Karakin':    _BASE + 'Karakin_Main_No_Text_Low_Res.png',
  'Rondo':      _BASE + 'Rondo_Main_No_Text_Low_Res.png',
  'Haven':      _BASE + 'Haven_Main_No_Text_Low_Res.png',
  'Paramo':     _BASE + 'Paramo_Main_No_Text_Low_Res.png',
  'Boardwalk':  _BASE + 'Boardwalk_No_Text_Low_Res.png',
  // Neon, Chimera, Summerland — not yet in api-assets, will show grid fallback
};

// Module-level image cache — survives re-renders, avoids re-fetching
const _mapImgCache = {};
function loadMapImage(url) {
  if (_mapImgCache[url]) return Promise.resolve(_mapImgCache[url]);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => { _mapImgCache[url] = img; resolve(img); };
    img.onerror = () => resolve(null); // graceful fallback — draw without bg
    img.src = url;
  });
}

function LandingHeatmap({ data }) {
  const canvasRef = useRef(null);
  const galleryCanvasRef = useRef(null);
  const [selectedMap, setSelectedMap] = useState(null);
  const [selectedPlayers, setSelectedPlayers] = useState(new Set());
  const [imgLoading, setImgLoading] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);

  // Derive available maps and players from data
  const { maps, players, playerColors } = useMemo(() => {
    const landings = data?.landings || {};
    const mapSet   = new Set();
    const playerList = Object.values(landings).map((p, i) => {
      Object.keys(p.maps || {}).forEach(m => mapSet.add(m));
      return { name: p.name, accountId: Object.keys(data.landings)[i], color: PLAYER_COLORS[i % PLAYER_COLORS.length] };
    });
    const maps = [...mapSet].filter(m => MAP_IMAGES[m]).sort();
    const colorMap = {};
    playerList.forEach(p => { colorMap[p.name] = p.color; });
    return { maps, players: playerList, playerColors: colorMap };
  }, [data]);

  // Default to most-played map
  const activeMap = selectedMap || maps[0] || null;

  // Default: all players selected
  const visiblePlayers = selectedPlayers.size > 0 ? selectedPlayers : new Set(players.map(p => p.name));

  // Core draw function — takes optional map Image object and optional target canvas (defaults to inline canvas)
  const drawCanvas = useCallback((mapImg, targetCanvas) => {
    const canvas = targetCanvas || canvasRef.current;
    if (!canvas || !activeMap) return;
    const W = canvas.width  = canvas.offsetWidth  || 600;
    const H = canvas.height = canvas.offsetHeight || 600;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    if (mapImg) {
      // Draw the map image as background, dimmed so dots pop
      ctx.globalAlpha = 0.75;
      ctx.drawImage(mapImg, 0, 0, W, H);
      ctx.globalAlpha = 1;
      // Subtle dark overlay to improve dot contrast
      ctx.fillStyle = 'rgba(0,0,0,.15)';
      ctx.fillRect(0, 0, W, H);
    } else {
      // Fallback: dark background + grid
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(255,255,255,.06)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 10; i++) {
        ctx.beginPath(); ctx.moveTo(W * i / 10, 0); ctx.lineTo(W * i / 10, H); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, H * i / 10); ctx.lineTo(W, H * i / 10); ctx.stroke();
      }
    }

    // Collect spots
    const allSpots = [];
    for (const [, player] of Object.entries(data.landings || {})) {
      if (!visiblePlayers.has(player.name)) continue;
      const spots = player.maps?.[activeMap] || [];
      spots.forEach(s => allSpots.push({ x: s.x * W, y: s.y * H, color: playerColors[player.name] || '#60a5fa' }));
    }

    // Density glow pass
    allSpots.forEach(({ x, y, color }) => {
      const grad = ctx.createRadialGradient(x, y, 0, x, y, 22);
      grad.addColorStop(0, color + '22');
      grad.addColorStop(1, color + '00');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(x, y, 22, 0, Math.PI * 2); ctx.fill();
    });

    // Individual dots — larger with border for readability on map bg
    allSpots.forEach(({ x, y, color }) => {
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = color + 'dd';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.7)';
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    // Spot count watermark
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.fillText(`${allSpots.length} landings`, 8, H - 8);
  }, [activeMap, visiblePlayers, data, playerColors]);

  // Load map image then draw
  useEffect(() => {
    const imgUrl = MAP_IMAGES[activeMap];
    if (!imgUrl) { drawCanvas(null); return; }
    // If already cached, draw immediately
    if (_mapImgCache[imgUrl]) { drawCanvas(_mapImgCache[imgUrl]); return; }
    // Otherwise show placeholder then draw when loaded
    setImgLoading(true);
    drawCanvas(null); // draw dots immediately with fallback bg
    loadMapImage(imgUrl).then(img => {
      setImgLoading(false);
      drawCanvas(img);
    });
  }, [activeMap, visiblePlayers, data, playerColors, drawCanvas]);

  // Gallery (lightbox) — redraw large canvas when open, map changes, or filters change
  useEffect(() => {
    if (!galleryOpen) return;
    const imgUrl = MAP_IMAGES[activeMap];
    const render = (img) => {
      // Defer a frame so the modal canvas is mounted & sized
      requestAnimationFrame(() => drawCanvas(img, galleryCanvasRef.current));
    };
    if (!imgUrl) { render(null); return; }
    if (_mapImgCache[imgUrl]) { render(_mapImgCache[imgUrl]); return; }
    render(null);
    loadMapImage(imgUrl).then(render);
  }, [galleryOpen, activeMap, visiblePlayers, data, playerColors, drawCanvas]);

  // Keyboard: Esc closes, arrows cycle through available maps
  useEffect(() => {
    if (!galleryOpen) return;
    function onKey(e) {
      if (e.key === 'Escape') { setGalleryOpen(false); return; }
      if (!maps.length) return;
      const curIdx = Math.max(0, maps.indexOf(activeMap));
      if (e.key === 'ArrowRight') setSelectedMap(maps[(curIdx + 1) % maps.length]);
      if (e.key === 'ArrowLeft')  setSelectedMap(maps[(curIdx - 1 + maps.length) % maps.length]);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [galleryOpen, maps, activeMap]);

  if (!maps.length) return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 20px' }}>
      <div style={{ fontWeight: 700, fontSize: 14 }}>📍 Landing Heatmap</div>
      <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>No landing data yet — run <code>node scripts/build_landing_heatmap.js</code> to process telemetry (processes all 530+ matches on first run).</p>
    </div>
  );

  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <span style={{ fontWeight: 700, fontSize: 14 }}>📍 Landing Heatmap</span>
          <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-3)', marginLeft: 8 }}>parachute landing zones · {data.processedMatches} matches</span>
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {maps.map(m => (
            <button key={m} onClick={() => setSelectedMap(m)}
              style={{ padding: '3px 10px', borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: '1px solid var(--border)',
                background: activeMap === m ? 'var(--accent)' : 'var(--bg-raised)', color: activeMap === m ? '#fff' : 'var(--text-2)' }}>
              {m}
            </button>
          ))}
        </div>
      </div>

      {/* Player filter chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 10 }}>
        <button onClick={() => setSelectedPlayers(new Set())}
          style={{ padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600, cursor: 'pointer',
            border: '1px solid var(--border)', background: selectedPlayers.size === 0 ? 'rgba(96,165,250,.2)' : 'var(--bg-raised)', color: 'var(--text-2)' }}>
          All
        </button>
        {players.map(p => {
          const active = selectedPlayers.size === 0 || selectedPlayers.has(p.name);
          return (
            <button key={p.name} onClick={() => setSelectedPlayers(prev => {
              const next = new Set(prev);
              if (next.has(p.name)) next.delete(p.name); else next.add(p.name);
              return next;
            })}
              style={{ padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600, cursor: 'pointer',
                border: `1px solid ${active ? p.color + '66' : 'var(--border)'}`,
                background: active ? p.color + '18' : 'var(--bg-raised)', color: active ? p.color : 'var(--text-3)' }}>
              {p.name}
            </button>
          );
        })}
      </div>

      {/* Canvas */}
      <div style={{ maxWidth: 540, margin: '0 auto' }}>
        <div
          onClick={() => setGalleryOpen(true)}
          title="Click to view larger"
          style={{ position: 'relative', width: '100%', paddingBottom: '100%', borderRadius: 8, overflow: 'hidden', background: '#0d1117', cursor: 'zoom-in' }}
        >
          <canvas ref={canvasRef} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }} />
          {imgLoading && (
            <div style={{ position: 'absolute', top: 8, right: 10, fontSize: 10, color: 'rgba(255,255,255,.65)', pointerEvents: 'none' }}>
              loading map…
            </div>
          )}
          <div style={{ position: 'absolute', bottom: 8, right: 10, fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,.6)', textShadow: '0 1px 4px rgba(0,0,0,.9)', pointerEvents: 'none', letterSpacing: '.04em' }}>⛶ click to enlarge</div>
        </div>
      </div>
      <p style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 6 }}>Each dot = one parachute landing · colour = player · glow = density cluster · click players above to isolate · click map to enlarge · map imagery from PUBG API assets</p>

      {/* ── Gallery lightbox ── */}
      {galleryOpen && (
        <div
          onClick={() => setGalleryOpen(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.92)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(6px)' }}
        >
          {/* Close */}
          <button onClick={() => setGalleryOpen(false)}
            style={{ position: 'absolute', top: 16, right: 20, background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.15)', borderRadius: 8, color: '#fff', fontSize: 20, lineHeight: 1, padding: '4px 10px', cursor: 'pointer', zIndex: 10 }}>✕</button>

          {/* Map name + match count */}
          <div style={{ position: 'absolute', top: 16, left: 20, display: 'flex', alignItems: 'center', gap: 10, zIndex: 10 }}>
            <div style={{ fontWeight: 800, fontSize: 16, color: '#fff' }}>📍 {activeMap}</div>
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,.65)' }}>{data.processedMatches} matches · {visiblePlayers.size} of {players.length} players</div>
          </div>

          {/* Large square canvas — sized to viewport */}
          <div
            onClick={e => e.stopPropagation()}
            style={{ width: 'min(90vw, 90vh)', height: 'min(90vw, 90vh)', position: 'relative', borderRadius: 10, overflow: 'hidden', background: '#0d1117', boxShadow: '0 0 0 1px rgba(255,255,255,.1), 0 24px 80px rgba(0,0,0,.7)' }}
          >
            <canvas ref={galleryCanvasRef} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }} />
          </div>

          {/* Prev / Next — only show if multiple maps */}
          {maps.length > 1 && (
            <>
              <button
                onClick={e => { e.stopPropagation(); const i = Math.max(0, maps.indexOf(activeMap)); setSelectedMap(maps[(i - 1 + maps.length) % maps.length]); }}
                style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.15)', borderRadius: 8, color: '#fff', fontSize: 22, lineHeight: 1, padding: '10px 14px', cursor: 'pointer', zIndex: 10 }}>‹</button>
              <button
                onClick={e => { e.stopPropagation(); const i = Math.max(0, maps.indexOf(activeMap)); setSelectedMap(maps[(i + 1) % maps.length]); }}
                style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.15)', borderRadius: 8, color: '#fff', fontSize: 22, lineHeight: 1, padding: '10px 14px', cursor: 'pointer', zIndex: 10 }}>›</button>

              {/* Dot indicators */}
              <div style={{ position: 'absolute', bottom: 18, display: 'flex', gap: 7, alignItems: 'center' }}>
                {maps.map(m => (
                  <div key={m} onClick={e => { e.stopPropagation(); setSelectedMap(m); }}
                    title={m}
                    style={{ width: m === activeMap ? 20 : 7, height: 7, borderRadius: 4, background: m === activeMap ? 'var(--accent)' : 'rgba(255,255,255,.25)', transition: 'all .2s', cursor: 'pointer' }} />
                ))}
              </div>
            </>
          )}

          {/* Hint */}
          <div style={{ position: 'absolute', bottom: 44, fontSize: 10, color: 'rgba(255,255,255,.55)', letterSpacing: '.04em' }}>
            {maps.length > 1 ? '← → to switch maps · Esc to close' : 'Esc to close'}
          </div>
        </div>
      )}
    </div>
  );
}


// ── Pre-warm progress bar ─────────────────────────────────────────────────────
function PrewarmBanner({ status, onDone }) {
  // Hide if: no status, prewarm finished, or prewarm hasn't started yet
  if (!status || status.done || (!status.running && status.completed === 0 && !status.startedAt)) return null;
  const pct = status.total ? Math.round(status.completed / status.total * 100) : 0;
  return (
    <div style={{ position:'fixed', bottom: 'max(72px, env(safe-area-inset-bottom, 72px))', left: 0, right: 0, zIndex: 50, padding: '0 16px', pointerEvents:'none' }}>
      <div style={{ maxWidth: 420, margin: '0 auto', background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:12, padding:'12px 16px', boxShadow:'0 4px 24px rgba(0,0,0,.4)' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
          <span style={{ fontSize:12, fontWeight:600, color:'var(--text-2)' }}>
            {status.running ? `Loading stats…` : 'Stats loaded'}
          </span>
          <span style={{ fontSize:11, color:'var(--text-3)' }}>{pct}%</span>
        </div>
        <div style={{ height:4, background:'var(--bg-raised)', borderRadius:99, overflow:'hidden' }}>
          <div style={{ height:'100%', width: pct+'%', background:'var(--accent)', borderRadius:99, transition:'width .4s ease' }} />
        </div>
      </div>
    </div>
  );
}
