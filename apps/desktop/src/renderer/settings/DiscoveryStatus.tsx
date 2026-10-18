import { useEffect, useState } from 'react';
import type { OperationOutput } from '../../shared/operations.ts';
import { operations } from '../app/bridges.ts';

type Discovery = NonNullable<OperationOutput<'sourcing.list'>['view']>['discovery'];
type Read = { readonly binding: string; readonly status: Discovery; readonly failed: boolean };

/** Existing candidate-list read, retaining only its body-free discovery status. */
export function DiscoveryStatus({ available, privacyKey }: { readonly available: boolean; readonly privacyKey: string }) {
  const [read, setRead] = useState<Read | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    setRead(null);
    if (!available) return;
    const api = operations();
    if (!api) { setRead({ binding: privacyKey, status: null, failed: true }); return; }
    void api.read('sourcing.list', { status: 'needs_review', offset: 0 }).then(answer => {
      if (current) setRead({ binding: privacyKey, status: answer.view?.discovery ?? null, failed: answer.view === null });
    }).catch(() => { if (current) setRead({ binding: privacyKey, status: null, failed: true }); });
    return () => { current = false; };
  }, [available, privacyKey, revision]);
  const shown = read?.binding === privacyKey ? read : null;
  return <div className="mt-3 space-y-1 text-xs text-muted-foreground" data-testid="discovery-status">
    <p>Turning research off also pauses new discovery searches and candidate checks. Turning it on does not bypass discovery holds or search allowances.</p>
    {!available ? <p>Discovery status is unavailable while signed out.</p> : !shown ? <p>Reading discovery status…</p> : shown.failed ? <p role="status">Discovery status could not be read. <button className="underline" onClick={() => setRevision(value => value + 1)}>Retry discovery read</button></p> : !shown.status ? <p>No discovery schedule was returned. No discovery permission is implied.</p> : <>
      <p>Discovery schedule: {shown.status.halted ? 'needs attention' : shown.status.enabled ? 'enabled, subject to research and holds' : 'paused'} · {shown.status.dailyRemaining} searches remaining today · {shown.status.monthlyRemaining} this month.</p>
      <p>Next scheduled: {shown.status.nextRunAt.slice(0, 10)} · last result: {shown.status.lastResult ?? 'not run'}. Search allowances are separate from the research dollar budgets above.</p>
    </>}
    <p>Review candidates in Firms. Independent discovery enablement and search allowance changes are not available in this client.</p>
  </div>;
}
