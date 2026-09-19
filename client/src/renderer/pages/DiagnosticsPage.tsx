import { useCallback, useEffect, useState } from 'react';
import type { AttemptKind, DiagnosticsView } from '../../../../src/shared/contracts/v1Contract';
import { ATTEMPT_KINDS, type ClientStatus } from '../../shared/clientContract';

/**
 * `GET /v1/diagnostics` as a page: the last twenty attempts newest first (at, kind, outcome, reason and
 * the closed detail as key: value chips), a kind filter that re-reads through the worker, the devices
 * with Revoke this device on every other active device, the as-of stamp, and a re-read every 60 seconds
 * and after any command. Instants are shown as the worker sent them.
 */
const REFRESH_MS = 60_000;

type Reading = { view: DiagnosticsView; fetchedAt: string };

export function DiagnosticsPage({ status, onStatusChanged }: { status: ClientStatus; onStatusChanged: () => Promise<void> }) {
  const [kind, setKind] = useState<AttemptKind | ''>('');
  const [reading, setReading] = useState<Reading | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [busyDevice, setBusyDevice] = useState<string | null>(null);

  const read = useCallback(async (selected: AttemptKind | '') => {
    try {
      const result = await window.callie.get(selected === '' ? { view: '/v1/diagnostics' } : { view: '/v1/diagnostics', kind: selected });
      if (result.outcome === 'ok') {
        setReading({ view: result.view, fetchedAt: result.fetchedAt });
        setProblem(null);
        return;
      }
      setProblem(result.sentence);
      if (result.outcome === 'unauthenticated' && result.cleared) await onStatusChanged();
    } catch {
      setProblem('The client could not read Diagnostics.');
    }
  }, [onStatusChanged]);

  useEffect(() => {
    void read(kind);
    const timer = window.setInterval(() => { void read(kind); }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [read, kind]);

  const revoke = async (deviceId: string) => {
    setBusyDevice(deviceId);
    setReceipt(null);
    try {
      // A fresh UUID v4 per command; a retry inside the main process reuses it, this page never mints twice for one click.
      const result = await window.callie.command({ commandId: crypto.randomUUID(), kind: 'revoke_device', deviceId });
      if (result.outcome === 'ok') {
        setReceipt(`revoke_device: ${result.receipt.outcome}${result.receipt.reason === null ? '' : ` (${result.receipt.reason})`}`);
      } else {
        setProblem(result.sentence);
        if (result.outcome === 'unauthenticated' && result.cleared) {
          await onStatusChanged();
          return;
        }
      }
      await read(kind);
    } catch {
      setProblem('The client could not send the command.');
    } finally {
      setBusyDevice(null);
    }
  };

  const view = reading?.view ?? null;
  return (
    <section className="page page--diagnostics">
      <header className="page__header">
        <h1>Diagnostics</h1>
        <p className="page__stamp">
          {reading === null
            ? 'Not read yet.'
            : <>as of <time dateTime={view!.asOf}>{view!.asOf}</time>, read at <time dateTime={reading.fetchedAt}>{reading.fetchedAt}</time></>}
        </p>
        <div className="page__controls">
          <label htmlFor="kind-filter">Kind</label>
          <select id="kind-filter" value={kind} onChange={(event) => setKind(event.target.value as AttemptKind | '')}>
            <option value="">all kinds</option>
            {ATTEMPT_KINDS.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
          <button type="button" onClick={() => { void read(kind); }}>Refresh</button>
        </div>
      </header>
      {problem && <p role="alert" className="error">{problem}</p>}
      {receipt && <p role="status" className="notice">{receipt}</p>}
      {view && (
        <>
          <p className="page__tick">
            {view.lastTick === null
              ? 'Last tick: none recorded.'
              : <>Last tick: {view.lastTick.status} at <time dateTime={view.lastTick.at}>{view.lastTick.at}</time>, {view.lastTick.durationMs} ms.</>}
          </p>
          <h2>Attempts</h2>
          {view.attempts.length === 0 ? <p>No attempts recorded{kind === '' ? '' : ` of kind ${kind}`}.</p> : (
            <table className="grid" aria-label="Attempts">
              <thead>
                <tr><th>At</th><th>Kind</th><th>Outcome</th><th>Reason</th><th>Detail</th><th>Duration</th><th>Ref</th></tr>
              </thead>
              <tbody>
                {view.attempts.map((attempt, index) => (
                  <tr key={`${attempt.at}-${index}`}>
                    <td><time dateTime={attempt.at}>{attempt.at}</time></td>
                    <td>{attempt.kind}</td>
                    <td><span className={`outcome outcome--${attempt.outcome}`}>{attempt.outcome}</span></td>
                    <td>{attempt.reason ?? '-'}</td>
                    <td>
                      {attempt.detail === null ? '-' : (
                        <ul className="chips">
                          {Object.entries(attempt.detail).map(([key, value]) => <li className="chip" key={key}>{`${key}: ${String(value)}`}</li>)}
                        </ul>
                      )}
                    </td>
                    <td>{attempt.durationMs === null ? '-' : `${attempt.durationMs} ms`}</td>
                    <td>{attempt.ref ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h2>Devices</h2>
          <table className="grid" aria-label="Devices">
            <thead>
              <tr><th>Label</th><th>Created</th><th>Expires</th><th>Last seen</th><th>Status</th><th><span className="visually-hidden">Action</span></th></tr>
            </thead>
            <tbody>
              {view.devices.map((device) => {
                const own = device.deviceId === status.deviceId;
                return (
                  <tr key={device.deviceId}>
                    <td>{device.label}{own ? ' (this Mac)' : ''}</td>
                    <td><time dateTime={device.createdAt}>{device.createdAt}</time></td>
                    <td><time dateTime={device.expiresAt}>{device.expiresAt}</time></td>
                    <td>{device.lastSeenAt === null ? 'never' : <time dateTime={device.lastSeenAt}>{device.lastSeenAt}</time>}</td>
                    <td>{device.revokedAt === null ? 'active' : `revoked ${device.revokedAt}`}</td>
                    <td>
                      {device.revokedAt === null && !own && (
                        <button type="button" disabled={busyDevice !== null} onClick={() => { void revoke(device.deviceId); }}>
                          Revoke this device
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
