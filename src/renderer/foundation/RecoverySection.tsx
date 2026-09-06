import { useEffect, useRef, useState } from 'react';
import { RECOVERY_SESSION_MS, type RecoveryProvider, type RecoveryReadinessStatus, type RecoverySetupSession, type RestoreDrillReceipt } from '../../shared/contracts/recoveryContract';

/** Mounted only inside Settings Data & storage. All secret state is ephemeral. */
export function RecoverySection({ recovery }: { recovery: RecoveryProvider }) {
  const [status, setStatus] = useState<RecoveryReadinessStatus | null>(null);
  const [session, setSession] = useState<RecoverySetupSession | null>(null);
  const [receipt, setReceipt] = useState<RestoreDrillReceipt | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [stored, setStored] = useState(false);
  const [drillConfirmed, setDrillConfirmed] = useState(false);
  const [source, setSource] = useState<'file' | 'paste'>('file');
  const [material, setMaterial] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [message, setMessage] = useState('');
  const [now, setNow] = useState(Date.now());
  const generation = useRef(0);
  const working = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const token = ++generation.current;
    recovery.status().then((value) => { if (token === generation.current) setStatus(value); }).catch(() => { if (token === generation.current) setError(true); });
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => { mounted.current = false; generation.current++; clearInterval(timer); };
  }, [recovery]);
  useEffect(() => {
    if (session === null) return;
    const timer = setTimeout(() => {
      generation.current++; setSession(null); setStored(false); setConfirmed(false);
      setMessage('Recovery display expired. Begin a new setup to reveal it again.');
    }, Math.max(0, Date.parse(session.generatedAt) + RECOVERY_SESSION_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [session]);

  async function run(operation: (current: () => boolean) => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(true); setError(false); setMessage('');
    const token = generation.current;
    const current = () => token === generation.current;
    try { await operation(current); } catch { if (current()) setError(true); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  }
  const clear = () => {
    generation.current++; setMaterial(''); setSession(null); setConfirmed(false); setStored(false); setDrillConfirmed(false); setMessage('');
    // Pending results are invalidated, but no second action is admitted until
    // the existing native-dialog request settles.
  };
  const validSession = () => {
    if (!session || Date.now() >= Date.parse(session.generatedAt) + RECOVERY_SESSION_MS) throw new Error('Expired');
    return session;
  };
  return <section aria-label="Recovery">
    <h3>Backup and recovery</h3>
    <p>An encrypted backup without recovery material may be unrecoverable after loss of the Mac keychain. Recovery material is private. Keep your explicit export somewhere safe.</p>
    {status === null ? <p>Recovery status unavailable or loading. Completion is not confirmed.</p> : <>
      <p>{status.outreachReady ? 'Recovery setup/drill complete' : 'Recovery setup/drill incomplete'}</p>
      <p>This records recovery setup and a successful drill only, not current backup freshness or readiness of every integration.</p>
      <p>Recovery setup completed: {status.setupCompletedAt ?? 'Not completed'}</p>
      <p>Last successful restore drill: {status.lastRestoreDrillAt ?? 'Not completed'}</p>
      {status.backup.status === 'available' ? <>
        <p>Backup created: {status.backup.createdAt}</p>
        <p>Backup age: {Math.max(0, Math.floor((now - Date.parse(status.backup.createdAt)) / 3_600_000))} hours</p>
        <p>Backup verified: {status.backup.verifiedAt}</p>
        {now - Date.parse(status.backup.createdAt) >= 24 * 3_600_000 && <p>Backup is stale. Daily backups are expected while the app is open.</p>}
      </> : <p>{status.backup.status === 'missing' ? 'No verified backup is currently present.' : 'Backup availability could not be verified.'}</p>}
    </>}
    <button type="button" disabled={busy} onClick={() => void run(async (current) => {
      try { const value = await recovery.status(); if (current()) setStatus(value); }
      catch { if (current()) setStatus(null); throw new Error('Unavailable'); }
    })}>Refresh recovery status</button>
    {session === null ? <>
      <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} />I understand this reveals private recovery material</label>
      <button type="button" disabled={busy || !confirmed} onClick={() => void run(async (current) => {
        const value = await recovery.beginSetup({ founderConfirmed: true });
        if (!current()) return;
        if (Date.parse(value.generatedAt) + RECOVERY_SESSION_MS <= Date.now()) throw new Error('Expired');
        setSession(value); setStored(false); setConfirmed(false);
      })}>Begin recovery setup</button>
    </> : <>
      <p>This one-time display expires after 10 minutes. Copy or Save only when you choose.</p>
      <pre aria-label="One-time recovery material">{session.material}</pre>
      <button type="button" disabled={busy} onClick={() => void run(async (current) => {
        await navigator.clipboard.writeText(validSession().material); if (current()) setMessage('Recovery material copied. Keep the clipboard private.');
      })}>Copy recovery material</button>
      <button type="button" disabled={busy} onClick={() => void run(async (current) => {
        const result = await recovery.saveSetupMaterial({ sessionId: validSession().sessionId });
        if (current() && result.kind === 'saved') setMessage('Private recovery export saved. Setup is not complete until confirmed.');
      })}>Save recovery material</button>
      <label><input type="checkbox" checked={stored} disabled={busy} onChange={(event) => setStored(event.target.checked)} />I stored the recovery material privately</label>
      <button type="button" disabled={busy || !stored} onClick={() => void run(async (current) => {
        const value = await recovery.completeSetup({ sessionId: validSession().sessionId, founderConfirmed: true });
        if (current()) { setSession(null); setStatus(value); setStored(false); }
      })}>Complete recovery setup</button>
    </>}
    <h4>Test recovery on a temporary copy</h4>
    <label>Recovery material source<select value={source} disabled={busy} onChange={(event) => { setSource(event.target.value as 'file' | 'paste'); setMaterial(''); }}><option value="file">Saved recovery file</option><option value="paste">Paste saved recovery material</option></select></label>
    {source === 'paste' && <label>Paste saved recovery material<textarea value={material} disabled={busy} maxLength={512} autoComplete="off" spellCheck={false} onChange={(event) => setMaterial(event.target.value)} /></label>}
    <label><input type="checkbox" checked={drillConfirmed} disabled={busy} onChange={(event) => setDrillConfirmed(event.target.checked)} />I confirm this tests only a temporary backup copy</label>
    <button type="button" disabled={busy || !drillConfirmed || (source === 'paste' && material.length === 0)} onClick={() => {
      const request = source === 'file' ? { founderConfirmed: true as const, materialSource: 'file' as const } : { founderConfirmed: true as const, materialSource: 'paste' as const, recoveryMaterial: material };
      setMaterial(''); setDrillConfirmed(false);
      void run(async (current) => {
        const result = await recovery.selectAndRunRestoreDrill(request);
        if (!current() || result.kind === 'cancelled') return;
        setReceipt(result.receipt);
        const value = await recovery.status(); if (current()) setStatus(value);
      });
    }}>Select backup and run restore drill</button>
    <button type="button" disabled={busy} onClick={clear}>Clear recovery input</button>
    {receipt && <div aria-label="Restore drill receipt">
      <p>Backup timestamp: {receipt.backupTimestamp}</p><p>SHA-256: {receipt.backupSha256}</p>
      <p>Schema: {receipt.schemaVersion}. Verified: {receipt.verifiedAt}</p>
      <p>People: {receipt.aggregateCounts.people}. Prospects: {receipt.aggregateCounts.prospects}. Source events: {receipt.aggregateCounts.sourceEvents}.</p>
    </div>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">Recovery action failed. No new completion is confirmed. Error code: RECOVERY_FAILED</p>}
  </section>;
}
