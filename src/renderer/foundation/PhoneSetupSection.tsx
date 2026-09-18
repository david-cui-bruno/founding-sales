import { useCallback, useEffect, useRef, useState } from 'react';
import {
  confirmPhoneSetupSchema,
  phoneSetupStatusSchema,
  type PhoneSetupApi,
  type PhoneSetupStatus,
} from '../../shared/contracts/phoneSetupContract';
import { PHONE_DIAL_MODES } from '../features/today/todayCopy';
import { Button } from '../components/Button';

const unavailable: PhoneSetupStatus = {
  state: 'unavailable', candidateFingerprint: null, confirmedAt: null,
};
const labels: Record<PhoneSetupStatus['state'], string> = {
  unconfigured: 'Unconfigured', unavailable: 'Unavailable',
  needs_confirmation: 'Needs confirmation', configured: 'Configured',
};
type Action = 'status' | 'confirm' | 'clear';
type Lifetime = { api: PhoneSetupApi; generation: number; busy: boolean };
type View = { owner: Lifetime | null; status: PhoneSetupStatus; busy: boolean; error: string | null };

/** View-owned evidence only. Setup never places a call or grants permission. */
export function PhoneSetupSection({ api }: { api?: PhoneSetupApi }) {
  const generation = useRef(0);
  const owner = useRef<Lifetime | null>(null);
  const [view, setView] = useState<View>({ owner: null, status: unavailable, busy: false, error: null });

  const run = useCallback(async (lifetime: Lifetime, action: Action, fingerprint?: string) => {
    if (owner.current !== lifetime || lifetime.busy) return;
    // This fence precedes invocation, including APIs that throw synchronously.
    lifetime.busy = true;
    const current = () => owner.current === lifetime && generation.current === lifetime.generation;
    setView(previous => ({
      owner: lifetime,
      status: action === 'status' ? unavailable : previous.status,
      busy: true, error: null,
    }));
    try {
      // The async boundary keeps a synchronous throw pending until settlement,
      // so another click in the same batch cannot start a conflicting action.
      const reply = await (async () => {
        if (action === 'status') return lifetime.api.status();
        if (action === 'clear') return lifetime.api.clear();
        return lifetime.api.confirm(confirmPhoneSetupSchema.parse({ expectedFingerprint: fingerprint }));
      })();
      if (!current()) return;
      const status = phoneSetupStatusSchema.parse(reply);
      setView({ owner: lifetime, status, busy: true, error: null });
    } catch {
      if (!current()) return;
      setView({
        owner: lifetime, status: unavailable, busy: true,
        error: action === 'status'
          ? 'Phone setup could not be read. Refresh to try again.'
          : action === 'confirm'
            ? 'Phone setup confirmation could not be verified. Refresh to review the current candidate.'
            : 'Phone setup clearing could not be verified. Refresh to check its current state or try Clear again.',
      });
    } finally {
      // A departed lifetime must neither publish evidence nor unlock new work.
      if (current()) {
        lifetime.busy = false;
        setView(previous => ({ ...previous, busy: false }));
      }
    }
  }, []);

  useEffect(() => {
    const nextGeneration = ++generation.current;
    const lifetime: Lifetime | null = api ? { api, generation: nextGeneration, busy: false } : null;
    owner.current = lifetime;
    setView({ owner: lifetime, status: unavailable, busy: false, error: null });
    if (lifetime) void run(lifetime, 'status');
    return () => {
      ++generation.current;
      owner.current = null;
    };
  }, [api, run]);

  // Hide evidence immediately on an API change, even before its effect runs.
  const lifetime = owner.current;
  const isCurrent = lifetime !== null && lifetime.api === api && view.owner === lifetime;
  const status = isCurrent ? view.status : unavailable;
  const busy = !isCurrent || view.busy;
  const confirmable = status.state === 'needs_confirmation' && status.candidateFingerprint !== null;

  return (
    <section className="settings__section" aria-label="Phone handoff">
      <h2 className="settings__section-title">Phone handoff</h2>
      <p role="status">{isCurrent && view.busy && status.state === 'unavailable' ? 'Checking phone setup…' : labels[status.state]}</p>
      {status.candidateFingerprint !== null && <p>{status.candidateFingerprint}</p>}
      {status.confirmedAt !== null && <p>{status.confirmedAt}</p>}
      {/* D6: the helper state in plain words, and what the Today call card does because of it. An
          unread or failed status is the `unavailable` state above, never a claim that Callie can dial. */}
      <p data-testid="phone-dial-mode">{PHONE_DIAL_MODES[status.state].label}. {PHONE_DIAL_MODES[status.state].card}</p>
      <p>Phone setup is handoff readiness only. It does not establish recording consent, call permission, or a connected call.</p>
      {isCurrent && view.error && <p role="alert">{view.error}</p>}
      <div className="settings__row-actions">
        <Button variant="quiet" disabled={busy} onClick={() => { if (lifetime) void run(lifetime, 'status'); }}>Refresh phone setup</Button>
        <Button disabled={busy || !confirmable} onClick={() => {
          if (lifetime && confirmable && status.candidateFingerprint !== null) {
            void run(lifetime, 'confirm', status.candidateFingerprint);
          }
        }}>Confirm phone setup</Button>
        <Button variant="danger" disabled={busy} onClick={() => { if (lifetime) void run(lifetime, 'clear'); }}>Clear phone setup</Button>
      </div>
    </section>
  );
}
