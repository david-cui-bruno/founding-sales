import { useEffect, useRef, useState, type JSX } from 'react';
import { firmListResponseSchema, type FirmIdentityDto } from '@fss/contracts';
import type { BrowserClient } from './BrowserClient.ts';
import type { CallingQueueEntry } from './CallingQueue.tsx';

/** Existing company identities only. Selecting one opens the normal current Firm read. */
export function CallingRecordedFirms({ client, disabled, onSelect }: {
  client: BrowserClient; disabled: boolean; onSelect: (entry: CallingQueueEntry) => void;
}): JSX.Element {
  const [firms, setFirms] = useState<readonly FirmIdentityDto[]>([]);
  const [filter, setFilter] = useState(''), [limit, setLimit] = useState(8), [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const epoch = useRef(client.epoch);
  useEffect(() => {
    let mounted = true;
    const readEpoch = client.epoch;
    epoch.current = readEpoch;
    const current = (): boolean => mounted && client.isCurrent(readEpoch) && client.current?.status === 'signed_in';
    const guard = (): void => { if (!current()) throw Error('Company list changed'); };
    setFirms([]); setBusy(true); setNotice('Loading recorded companies…'); setLimit(8);
    if (client.current?.status !== 'signed_in') {
      setBusy(false); setNotice('Sign in to read recorded companies.');
      return () => { mounted = false; };
    }
    void client.request('/firms', firmListResponseSchema, undefined, guard).then(answer => {
      if (current()) { setFirms(answer.firms.filter(firm => firm.status === 'active')); setNotice(''); }
    }, () => {
      if (current()) setNotice('Recorded companies are unavailable. Refresh this list to try again.');
    }).finally(() => { if (current()) setBusy(false); });
    const unsubscribe = client.subscribe(() => {
      if (!current()) { setFirms([]); setFilter(''); setBusy(false); setNotice('Current sign-in required.'); }
    });
    return () => { mounted = false; unsubscribe(); };
  }, [client, reload]);

  const query = filter.trim().toLocaleLowerCase();
  const matches = firms.filter(firm => [firm.name, firm.locality, firm.regionCode, firm.website].some(value => value?.toLocaleLowerCase().includes(query)));
  const select = (firm: FirmIdentityDto): void => {
    if (disabled || busy || !client.isCurrent(epoch.current) || client.current?.status !== 'signed_in' || !firms.includes(firm)) return;
    onSelect({ subject: { kind: 'firm', firmId: firm.id }, label: firm.name });
  };
  return <section className="calling-recorded-firms" aria-label="Recorded companies" aria-busy={busy}>
    <p>Open a company already recorded in your workspace. This does not link a kept prospect or grant call permission.</p>
    <label>Find in this company list<input type="search" value={filter} disabled={busy} onChange={event => { setFilter(event.target.value); setLimit(8); }} /></label>
    <button type="button" disabled={busy || disabled || client.current?.status !== 'signed_in'} onClick={() => setReload(value => value + 1)}>Refresh recorded companies</button>
    {notice ? <p role="status">{notice}</p> : null}
    {!busy && !notice && matches.length === 0 ? <p>No matching recorded companies in this list.</p> : null}
    <ul>{matches.slice(0, limit).map(firm => <li key={firm.id}><button type="button" disabled={busy || disabled} onClick={() => select(firm)}>
      <strong>{firm.name}</strong><small>{[firm.locality, firm.regionCode].filter(Boolean).join(', ') || 'Location unknown'}</small>
    </button></li>)}</ul>
    {matches.length > limit ? <button type="button" onClick={() => setLimit(value => value + 8)}>Show more recorded companies</button> : null}
    {firms.length >= 200 ? <p>This list contains the first 200 recorded companies by name. The filter searches this list only.</p> : null}
  </section>;
}
