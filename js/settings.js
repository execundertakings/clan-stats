// ── Settings tab ──────────────────────────────────────────────────────────────
function Settings({ members, onMembersChange }) {
  const [clanInfo, setClanInfo]   = useState(null);

  // Notifier state
  const [notifier, setNotifier]   = useState(null);
  const [scanning, setScanning]   = useState(false);
  const [scanMsg,  setScanMsg]    = useState(null);

  useEffect(() => {
    let cancelled = false;
    const fetch = () => api.get('/api/notifier/status').then(d => { if (!cancelled) setNotifier(d); }).catch(() => {});
    fetch();
    const t = setInterval(fetch, 8000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  async function triggerScan() {
    setScanning(true); setScanMsg(null);
    try {
      await api.post('/api/notifier/scan', {});
      setScanMsg('Scan triggered — log updates below');
      setTimeout(() => api.get('/api/notifier/status').then(setNotifier).catch(() => {}), 4000);
      setTimeout(() => api.get('/api/notifier/status').then(setNotifier).catch(() => {}), 12000);
    } catch (e) { setScanMsg(`Error: ${e.message}`); }
    finally     { setScanning(false); }
  }

  // Bulk import state
  const [bulkNames, setBulkNames] = useState('');
  const [bulking, setBulking]     = useState(false);
  const [bulkResult, setBulkResult] = useState(null);
  const [bulkError, setBulkError]   = useState(null);

  // Add individual member state
  const [newName, setNewName]   = useState('');
  const [adding, setAdding]     = useState(false);
  const [addError, setAddError] = useState(null);
  const [addOk, setAddOk]       = useState(null);
  const [removing, setRemoving] = useState(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    api.get('/api/clan/info').then(d => { if (d.clanId) setClanInfo(d); }).catch(() => {});
  }, []);

  async function bulkImport(e) {
    e.preventDefault();
    if (!bulkNames.trim()) return;
    setBulking(true);
    setBulkResult(null);
    setBulkError(null);
    try {
      const names = bulkNames.split(/[\n,]+/).map(n => n.trim()).filter(Boolean);
      const result = await api.post('/api/members/bulk', { names });
      setBulkResult(result);
      setBulkNames('');
      onMembersChange();
    } catch (e) {
      setBulkError(e.message);
    } finally {
      setBulking(false);
    }
  }

  async function addMember(e) {
    e.preventDefault();
    if (!newName.trim()) return;
    setAdding(true);
    setAddError(null);
    setAddOk(null);
    try {
      await api.post('/api/members', { name: newName.trim() });
      setAddOk(`${newName.trim()} added!`);
      setNewName('');
      onMembersChange();
    } catch (e) {
      setAddError(e.message);
    } finally {
      setAdding(false);
    }
  }

  async function removeMember(name) {
    setRemoving(name);
    try {
      await api.del(`/api/members/${encodeURIComponent(name)}`);
      onMembersChange('remove', { name });
    } catch (e) {
      alert(e.message);
    } finally {
      setRemoving(null);
    }
  }

  async function clearCache() {
    setClearing(true);
    try { await api.post('/api/cache/clear', {}); } catch {}
    setClearing(false);
  }

  return (
    <div className="p-6 space-y-6 max-w-lg">
      <h2 style={{ fontSize: 18, fontWeight: 700 }}>Settings</h2>

      {/* ── Clan info banner ── */}
      {clanInfo && (
        <div className="stat-card" style={{ borderColor: 'var(--accent)', display:'flex', alignItems:'center', gap:14 }}>
          <div style={{ fontSize: 28 }}>🦍</div>
          <div>
            <div style={{ fontWeight:700, fontSize:15 }}>{clanInfo.clanName} <span style={{ color:'var(--text-3)', fontWeight:400, fontSize:13 }}>[{clanInfo.clanTag}]</span></div>
            <div style={{ color:'var(--text-3)', fontSize:12 }}>Level {clanInfo.clanLevel} · {clanInfo.clanMemberCount} members · {members.length} imported</div>
          </div>
          <span className="badge badge-green" style={{ marginLeft:'auto' }}>Connected</span>
        </div>
      )}

      {/* ── Bulk Import ── */}
      <div className="stat-card space-y-3">
        <div style={{ fontWeight: 700, fontSize: 14 }}>📋 Bulk Import Members</div>
        <p style={{ color: 'var(--text-3)', fontSize: 12 }}>
          Paste your clan roster — one username per line, or comma-separated. We'll resolve all names in batches (3–4 API calls for a full 29-person roster).
        </p>
        <form onSubmit={bulkImport} className="flex flex-col gap-2">
          <textarea
            value={bulkNames}
            onChange={e => setBulkNames(e.target.value)}
            placeholder={'PlayerOne\nPlayerTwo\nPlayerThree\n...'}
            rows={6}
            style={{
              width: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '8px 12px', color: 'var(--text-1)',
              fontSize: 13, outline: 'none', resize: 'vertical', fontFamily: 'monospace',
            }}
          />
          <button
            type="submit"
            disabled={bulking || !bulkNames.trim()}
            style={{
              alignSelf: 'flex-start', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8,
              padding: '8px 18px', fontWeight: 600, fontSize: 13,
              cursor: bulking ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', gap: 6, opacity: bulking ? .6 : 1,
            }}
          >
            {bulking ? <Spinner size="sm" /> : <Icon.users />}
            {bulking ? 'Importing…' : 'Import All'}
          </button>
        </form>
        {bulking && (
          <div style={{ color:'var(--text-2)', fontSize:12 }}>
            Resolving names via PUBG API — rate-limited to 10/min, may take a moment for large rosters…
          </div>
        )}
        {bulkError && <div style={{ color: '#f87171', fontSize: 12 }}>⚠ {bulkError}</div>}
        {bulkResult && (
          <div style={{ background:'rgba(74,222,128,.08)',border:'1px solid rgba(74,222,128,.2)',borderRadius:8,padding:'10px 14px',fontSize:13 }}>
            <div style={{ fontWeight:700,color:'#4ade80' }}>✓ Import complete</div>
            <div style={{ color:'var(--text-2)',marginTop:4,fontSize:12 }}>
              {bulkResult.added} added · {bulkResult.skipped} already existed
              {bulkResult.notFound?.length > 0 && (
                <span style={{ color:'#f87171' }}> · {bulkResult.notFound.length} not found: {bulkResult.notFound.join(', ')}</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Add single member ── */}
      <div className="stat-card space-y-3">
        <div style={{ fontWeight: 600, fontSize: 14 }}>Add Single Member</div>
        <p style={{ color: 'var(--text-3)', fontSize: 12 }}>
          Add someone who isn't on the bulk list above.
        </p>
        <form onSubmit={addMember} className="flex gap-2">
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="PUBG username..."
            style={{
              flex: 1, background: 'var(--bg-raised)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '8px 12px', color: 'var(--text-1)',
              fontSize: 13, outline: 'none',
            }}
          />
          <button
            type="submit"
            disabled={adding || !newName.trim()}
            style={{
              background: 'var(--bg-raised)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 8,
              padding: '8px 16px', fontWeight: 600, fontSize: 13, cursor: adding ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', gap: 6, opacity: adding ? .6 : 1,
            }}
          >
            {adding ? <Spinner size="sm" /> : <Icon.plus />}
            Add
          </button>
        </form>
        {addError && <div style={{ color: '#f87171', fontSize: 12 }}>⚠ {addError}</div>}
        {addOk    && <div style={{ color: '#4ade80', fontSize: 12 }}>✓ {addOk}</div>}
      </div>

      {/* ── Member list ── */}
      <div className="stat-card space-y-2 p-0">
        <div style={{ padding: '16px 20px', fontWeight: 600, borderBottom: '1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <span>Clan Members ({members.length})</span>
          {members.length > 0 && clanInfo && (
            <span style={{ fontSize:11,color:'var(--text-3)' }}>from {clanInfo.clanName}</span>
          )}
        </div>
        {members.length === 0 && (
          <div style={{ padding: '20px', color: 'var(--text-3)', fontSize: 13 }}>
            No members yet — use Connect above to import the whole clan at once.
          </div>
        )}
        {members.map(m => (
          <div key={m.accountId} style={{ display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 20px',borderBottom:'1px solid var(--border-subtle)' }}>
            <div>
              <div style={{ fontWeight: 600, display:'flex', alignItems:'center', gap:6 }}>
                {m.name}
                {m.source === 'clan' && <span className="badge badge-blue" style={{ fontSize:9 }}>clan</span>}
              </div>
              <div style={{ color: 'var(--text-3)', fontSize: 11, fontFamily: 'monospace' }}>{m.accountId}</div>
            </div>
            <button
              onClick={() => removeMember(m.name)}
              disabled={removing === m.name}
              style={{ background:'rgba(239,68,68,.12)',border:'1px solid rgba(239,68,68,.25)',borderRadius:6,color:'#f87171',padding:'4px 8px',cursor:'pointer',display:'flex',alignItems:'center',gap:4,fontSize:12 }}
            >
              {removing === m.name ? <Spinner size="sm" /> : <Icon.trash />}
              Remove
            </button>
          </div>
        ))}
      </div>

      {/* ── Cache ── */}
      <div className="stat-card space-y-2">
        <div style={{ fontWeight: 600 }}>Cache</div>
        <p style={{ color: 'var(--text-3)', fontSize: 12 }}>
          API responses are cached to stay under the 10 RPM limit. Clear if you need fresh data immediately.
        </p>
        <button
          onClick={clearCache}
          disabled={clearing}
          style={{ background:'var(--bg-raised)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text-2)',padding:'8px 14px',cursor:'pointer',display:'flex',alignItems:'center',gap:6,fontSize:13 }}
        >
          {clearing ? <Spinner size="sm" /> : <Icon.refresh />}
          Clear Cache
        </button>
      </div>

      {/* ── Discord Notifier ── */}
      <div className="stat-card space-y-3">
        <div style={{ fontWeight: 600, display:'flex', alignItems:'center', gap:8 }}>
          Discord Notifier
          {notifier && (
            <span className={`badge ${notifier.running ? 'badge-blue' : 'badge-green'}`} style={{ fontSize:10 }}>
              {notifier.running ? 'scanning…' : 'idle'}
            </span>
          )}
          {notifier?.errors > 0 && (
            <span className="badge" style={{ fontSize:10, background:'rgba(239,68,68,.12)', color:'#f87171', border:'1px solid rgba(239,68,68,.25)' }}>
              {notifier.errors} err
            </span>
          )}
        </div>
        {notifier && (
          <div style={{ color:'var(--text-3)', fontSize:12, display:'flex', gap:16, flexWrap:'wrap' }}>
            <span>Last scan: {notifier.lastScan ? new Date(notifier.lastScan).toLocaleTimeString() : 'never'}</span>
            <span>Last post: {notifier.lastPost ? new Date(notifier.lastPost).toLocaleTimeString() : 'never'}</span>
            <span>Posts total: {notifier.postsTotal ?? 0}</span>
            <span style={{ color: notifier.webhookConfigured ? 'var(--text-3)' : '#f87171' }}>
              Webhook: {notifier.webhookConfigured ? '✓ configured' : '✗ not set'}
            </span>
          </div>
        )}
        <button
          onClick={triggerScan}
          disabled={scanning || notifier?.running}
          style={{ background:'var(--bg-raised)', border:'1px solid var(--border)', borderRadius:8, color:'var(--text-2)', padding:'8px 14px', cursor:(scanning || notifier?.running) ? 'not-allowed' : 'pointer', display:'flex', alignItems:'center', gap:6, fontSize:13, opacity:(scanning || notifier?.running) ? .6 : 1 }}
        >
          {scanning ? <Spinner size="sm" /> : <Icon.refresh />}
          Scan Now
        </button>
        {scanMsg && <div style={{ color:'var(--text-3)', fontSize:12 }}>{scanMsg}</div>}
        {notifier?.log?.length > 0 && (
          <div style={{ background:'var(--bg-raised)', borderRadius:8, padding:'10px 12px', fontFamily:'monospace', fontSize:11, color:'var(--text-3)', maxHeight:160, overflowY:'auto', lineHeight:1.6 }}>
            {notifier.log.slice(0, 10).map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}
      </div>
    </div>
  );
}
