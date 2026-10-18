import { useEffect, useState } from 'react';
import type { SocialWorkspace } from '@fss/contracts';
import { operations } from '../app/bridges.ts';
import { SocialAccounts } from '../social/SocialAccounts.tsx';

/** Account connection only. No policy, browser preparation, posting or outreach controls. */
export function LinkedinConnection({ enabled, privacyKey }: { readonly enabled: boolean; readonly privacyKey: string }) {
  const [accounts, setAccounts] = useState<SocialWorkspace['accounts'] | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState(false);
  useEffect(() => {
    let current = true;
    setAccounts(null);
    setError(false);
    const api = operations();
    if (enabled && api === undefined) setError(true);
    if (enabled && api !== undefined) void api.read('social.workspace', {}).then(answer => {
      if (!current) return;
      if (answer.view) setAccounts(answer.view.accounts.filter(account => account.platform === 'linkedin'));
      else setError(true);
    }).catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [enabled, privacyKey, revision]);
  return <div className="text-sm">
    <p className="mb-3 text-muted-foreground">Connection only. Connecting does not authorize outreach or posting.</p>
    {!enabled ? <p>Connection controls are unavailable while this session is read-only.</p> : error ? <p role="status">Could not read LinkedIn accounts. <button className="underline" onClick={() => setRevision(value => value + 1)}>Retry account read</button></p> : accounts === null ? <p>Reading account connection…</p> : <SocialAccounts key={privacyKey} accounts={accounts} onChanged={() => setRevision(value => value + 1)} />}
  </div>;
}
