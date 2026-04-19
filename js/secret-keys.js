// ── Secret Keys reference page ────────────────────────────────────────────────
const SECRET_KEY_MAPS = [
  { map: 'Erangel', rooms: 15, loot: 'Level 3 gear · Airdrop weapons (AWM, Groza)', img: 'https://pubgsecretroom.com/pubg-erangel-secret-room-map-location.webp', color: '#22d3ee', badge: 'Classic' },
  { map: 'Taego',   rooms: 15, loot: 'Level 3 gear · Airdrop guns · Self-AED · Med Kits', img: 'https://pubgsecretroom.com/pubg-taego-secret-room-map-location.webp', color: '#4ade80', badge: 'Modern' },
  { map: 'Deston',  rooms: null, loot: 'Level 3 gear · AWM · Rare crate-tier weapons', img: 'https://pubgsecretroom.com/pubg-deston-secret-room-map-location.png', color: '#f59e0b', badge: 'Fixed Loot' },
  { map: 'Vikendi', rooms: null, loot: 'Guaranteed Level 3 gear · Airdrop weapons', img: 'https://pubgsecretroom.com/pubg-vikendi-secret-room-map-location.jpg', color: '#a78bfa', badge: 'No Key' },
  { map: 'Paramo',  rooms: null, loot: 'Adrenaline Syringes · Med Kits · Level 3 armor', img: 'https://pubgsecretroom.com/pubg-paramo-secret-room-map-location.jpg', color: '#f472b6', badge: 'Dynamic' },
  { map: 'Rondo',   rooms: null, loot: 'Level 3 gear · Crate-tier weapons', img: 'https://pubgsecretroom.com/pubg-rondo-secret-room-map-location.webp', color: '#fb923c', badge: 'New' },
];

function SecretKeys() {
  const [expandedMap, setExpandedMap]   = useState(null);
  const [galleryIndex, setGalleryIndex] = useState(null); // index into SECRET_KEY_MAPS
  const isMobile = useIsMobile();

  // Close gallery on Escape, arrow-key navigate
  useEffect(() => {
    if (galleryIndex === null) return;
    function onKey(e) {
      if (e.key === 'Escape')      setGalleryIndex(null);
      if (e.key === 'ArrowRight')  setGalleryIndex(i => (i + 1) % SECRET_KEY_MAPS.length);
      if (e.key === 'ArrowLeft')   setGalleryIndex(i => (i - 1 + SECRET_KEY_MAPS.length) % SECRET_KEY_MAPS.length);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [galleryIndex]);

  const currentGallery = galleryIndex !== null ? SECRET_KEY_MAPS[galleryIndex] : null;

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1100 }}>

      {/* ── Lightbox ── */}
      {currentGallery && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.92)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(6px)' }}
          onClick={() => setGalleryIndex(null)}
        >
          {/* Close */}
          <button onClick={() => setGalleryIndex(null)} style={{ position: 'absolute', top: 16, right: 20, background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.15)', borderRadius: 8, color: '#fff', fontSize: 20, lineHeight: 1, padding: '4px 10px', cursor: 'pointer', zIndex: 10 }}>✕</button>

          {/* Map name + badge */}
          <div style={{ position: 'absolute', top: 16, left: 20, display: 'flex', alignItems: 'center', gap: 10, zIndex: 10 }}>
            <div style={{ fontWeight: 800, fontSize: 16, color: '#fff' }}>{currentGallery.map}</div>
            <div style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.1em', color: currentGallery.color, background: 'rgba(7,11,18,.8)', border: `1px solid ${currentGallery.color}55`, borderRadius: 5, padding: '3px 8px' }}>{currentGallery.badge}</div>
            {currentGallery.rooms && <div style={{ fontSize: 10, color: 'rgba(255,255,255,.65)' }}>{currentGallery.rooms} rooms</div>}
          </div>

          {/* Image */}
          <img
            src={currentGallery.img}
            alt={currentGallery.map}
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: 'calc(100vw - 120px)', maxHeight: 'calc(100vh - 120px)', objectFit: 'contain', borderRadius: 8, boxShadow: `0 0 0 1px ${currentGallery.color}33, 0 24px 80px rgba(0,0,0,.7)`, cursor: 'default' }}
          />

          {/* Prev / Next */}
          <button
            onClick={e => { e.stopPropagation(); setGalleryIndex(i => (i - 1 + SECRET_KEY_MAPS.length) % SECRET_KEY_MAPS.length); }}
            style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.15)', borderRadius: 8, color: '#fff', fontSize: 22, lineHeight: 1, padding: '10px 14px', cursor: 'pointer', zIndex: 10 }}>‹</button>
          <button
            onClick={e => { e.stopPropagation(); setGalleryIndex(i => (i + 1) % SECRET_KEY_MAPS.length); }}
            style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.15)', borderRadius: 8, color: '#fff', fontSize: 22, lineHeight: 1, padding: '10px 14px', cursor: 'pointer', zIndex: 10 }}>›</button>

          {/* Dot indicators */}
          <div style={{ position: 'absolute', bottom: 18, display: 'flex', gap: 7, alignItems: 'center' }}>
            {SECRET_KEY_MAPS.map((m, i) => (
              <div key={m.map} onClick={e => { e.stopPropagation(); setGalleryIndex(i); }}
                style={{ width: i === galleryIndex ? 20 : 7, height: 7, borderRadius: 4, background: i === galleryIndex ? currentGallery.color : 'rgba(255,255,255,.25)', transition: 'all .2s', cursor: 'pointer' }} />
            ))}
          </div>

          {/* Hint */}
          <div style={{ position: 'absolute', bottom: 44, fontSize: 10, color: 'rgba(255,255,255,.55)', letterSpacing: '.04em' }}>← → to navigate · Esc to close</div>
        </div>
      )}

      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, paddingBottom: 18, borderBottom: '1px solid var(--border)', marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.12em', color: 'var(--accent)', marginBottom: 6 }}>Game Intel</div>
          <h2 style={{ fontSize: 24, fontWeight: 900, letterSpacing: '-.03em', margin: 0, lineHeight: 1 }}>Secret Keys &amp; Rooms</h2>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6 }}>{SECRET_KEY_MAPS.length} maps · locations &amp; loot guide</div>
        </div>
        <a href="https://pubgsecretroom.com" target="_blank" rel="noopener noreferrer"
          style={{ fontSize: 11, color: 'var(--text-3)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4, padding: '5px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-card)', whiteSpace: 'nowrap' }}>
          <Icon.trend /> Full guide ↗
        </a>
      </div>

      {/* Map grid */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
        {SECRET_KEY_MAPS.map(m => {
          const isOpen = expandedMap === m.map;
          return (
            <div key={m.map} style={{ background: 'var(--bg-card)', border: `1px solid ${isOpen ? m.color + '55' : 'var(--border)'}`, borderRadius: 14, overflow: 'hidden', transition: 'border-color .2s, box-shadow .2s', boxShadow: isOpen ? `0 0 0 1px ${m.color}22, 0 8px 32px rgba(0,0,0,.3)` : 'none' }}>
              {/* Top accent */}
              <div style={{ height: 2, background: `linear-gradient(90deg, ${m.color}, ${m.color}44)` }} />

              {/* Map image — click to expand */}
              <div
                style={{ position: 'relative', cursor: isOpen ? 'zoom-in' : 'pointer', overflow: 'hidden', maxHeight: isOpen ? 'none' : 260, transition: 'max-height .3s ease', background: '#060c14' }}
                onClick={() => {
                  if (isOpen) {
                    setGalleryIndex(SECRET_KEY_MAPS.findIndex(x => x.map === m.map));
                  } else {
                    setExpandedMap(m.map);
                  }
                }}
              >
                <img
                  src={m.img}
                  alt={`${m.map} secret room locations`}
                  style={{ width: '100%', height: 'auto', display: 'block' }}
                  onError={e => { e.target.style.display = 'none'; }}
                />
                {/* Very subtle bottom fade — only when collapsed, just for the hint text */}
                {!isOpen && (
                  <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 36, background: 'linear-gradient(to bottom, transparent, rgba(6,12,20,.88))' }} />
                )}
                {/* Top-right badge */}
                <div style={{ position: 'absolute', top: 10, right: 10, fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.1em', color: m.color, background: 'rgba(7,11,18,.82)', border: `1px solid ${m.color}55`, borderRadius: 5, padding: '3px 7px', backdropFilter: 'blur(6px)' }}>
                  {m.badge}
                </div>
                {/* Expand / fullscreen hint */}
                <div style={{ position: 'absolute', bottom: 8, right: 10, fontSize: 9, color: 'rgba(255,255,255,.5)', fontWeight: 600, textShadow: '0 1px 4px rgba(0,0,0,.9)' }}>
                  {isOpen ? '⛶ fullscreen' : '▼ expand'}
                </div>
              </div>

              {/* Card body */}
              <div style={{ padding: '14px 18px 16px' }}>
                {/* Map name + room count */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <div style={{ fontWeight: 800, fontSize: 16, color: 'var(--text-1)' }}>{m.map}</div>
                  {m.rooms && (
                    <div style={{ fontSize: 11, fontWeight: 700, color: m.color, background: `${m.color}18`, border: `1px solid ${m.color}44`, borderRadius: 5, padding: '2px 8px' }}>
                      {m.rooms} rooms
                    </div>
                  )}
                </div>

                {/* Loot highlight */}
                <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5 }}>
                  <span style={{ color: m.color, fontWeight: 700 }}>Loot: </span>{m.loot}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Source credit */}
      <div style={{ marginTop: 24, padding: '10px 14px', background: 'rgba(255,255,255,.03)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 11, color: 'var(--text-3)', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        📌 Map images sourced from{' '}
        <a href="https://pubgsecretroom.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>pubgsecretroom.com</a>
        {' '}· Secret rooms only available in <strong style={{ color: 'var(--text-2)' }}>Normal Match</strong> mode · Loot resets each match.
      </div>

    </div>
  );
}
