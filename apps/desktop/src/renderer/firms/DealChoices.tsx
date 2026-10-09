import { useState, useRef, useEffect, type JSX } from 'react';
import { Button } from '../ui/button.tsx';
export interface DealChoice {
  readonly opportunity: { readonly id: string; readonly openedAt: string; readonly status: 'open' | 'won' | 'lost' };
  readonly displayName: string | null;
}
export interface DealChoicePorts {
  create(input: { firmId: string; name?: string }): Promise<{ opportunityId: string }>;
  reopen(input: { firmId: string; opportunityId: string; reason: string }): Promise<{ opportunityId: string }>;
}
export function DealChoices({
  firmId,
  entries,
  selectedId,
  enabled,
  ports,
  onSelect,
}: {
  firmId: string;
  entries: readonly DealChoice[];
  selectedId: string | null;
  enabled: boolean;
  ports: DealChoicePorts;
  onSelect(id: string): void;
}): JSX.Element {
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [name, setName] = useState(''),
    [reason, setReason] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const selected = entries.find((entry) => entry.opportunity.id === selectedId);
  const run = async (work: () => Promise<{ opportunityId: string }>) => {
    setBusy(true);
    setError('');
    try {
      const result = await work();
      if (!active.current) return;
      setName('');
      setReason('');
      onSelect(result.opportunityId);
    } catch {
      if (!active.current) return;
      setName('');
      setReason('');
      setError('The deal could not be updated. Refresh and choose again.');
    } finally {
      if (active.current) setBusy(false);
    }
  };
  return (
    <section aria-label="Independent deals">
      <h3>Deals</h3>
      {error ? <p role="alert">{error}</p> : null}
      <label>
        Selected deal
        <select
          aria-label="Selected deal"
          value={selectedId ?? ''}
          disabled={busy}
          onChange={(event) => {
            setName('');
            setReason('');
            setError('');
            if (event.target.value) onSelect(event.target.value);
          }}
        >
          <option value="">Choose a deal</option>
          {entries.map((entry, index) => (
            <option key={entry.opportunity.id} value={entry.opportunity.id}>
              {entry.displayName ?? `Deal ${String(index + 1)} · opened ${new Date(entry.opportunity.openedAt).toLocaleDateString()}`} ·{' '}
              {entry.opportunity.status}
            </option>
          ))}
        </select>
      </label>
      <p>Each deal has its own stage and outcome. Recording a deal does not enroll anyone.</p>
      <label>
        New deal name
        <input aria-label="New deal name" maxLength={160} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
      </label>
      <Button disabled={!enabled || busy || !name.trim()} onClick={() => void run(() => ports.create({ firmId, name: name.trim() }))}>
        Create independent deal
      </Button>
      {selected && selected.opportunity.status !== 'open' ? (
        <>
          <label>
            Reason to reopen
            <input
              aria-label="Reason to reopen"
              value={reason}
              maxLength={300}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <Button
            disabled={!enabled || busy || !reason.trim()}
            onClick={() => void run(() => ports.reopen({ firmId, opportunityId: selected.opportunity.id, reason: reason.trim() }))}
          >
            Reopen selected deal
          </Button>
        </>
      ) : null}
    </section>
  );
}
