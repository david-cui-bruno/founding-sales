import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  googleConsentOpenedSchema, googleConnectionStatusReason, type GoogleConnectionStatusReason, type RemoteGoogleConnectionsApi,
} from '../../shared/contracts/remoteGoogleConnectionsContract';
import {
  remoteGoogleGrantBeginSchema, remoteGoogleGrantDisclosureSchema,
  remoteGoogleGrantStatusSchema, type RemoteGoogleGrantStatus,
} from '../../shared/contracts/remoteGoogleGrantContract';
import {
  googleGrantDisclosure, personalGoogleGrantDisclosure, type GoogleGrantPurpose,
} from '../../shared/contracts/googleGrantCapabilities';
import { Button } from '../components/Button';

const purposes = ['permitted_correspondence', 'personal_availability'] as const;
type Panel = {
  input: string; acknowledged: boolean; confirmed: boolean; revokeAcknowledged: boolean;
  status: RemoteGoogleGrantStatus | null; disclosure: string | null; fresh: boolean; message: string;
};
type Lifetime = { api: RemoteGoogleConnectionsApi; busy: boolean };
const emptyPanel = (): Panel => ({ input: '', acknowledged: false, confirmed: false,
  revokeAcknowledged: false, status: null, disclosure: null, fresh: false, message: '' });
const emptyPanels = (): Record<GoogleGrantPurpose, Panel> => ({
  permitted_correspondence: emptyPanel(), personal_availability: emptyPanel(),
});
const disclosureFor = (purpose: GoogleGrantPurpose) => purpose === 'personal_availability'
  ? personalGoogleGrantDisclosure : googleGrantDisclosure;
const cleanupPending = (status: RemoteGoogleGrantStatus | null) => status?.state === 'revoked' && status.providerRevocation !== 'confirmed';
const canRequestRevoke = (status: RemoteGoogleGrantStatus | null) => status?.state === 'ready' || cleanupPending(status);
const resetAcknowledgments = { acknowledged: false, confirmed: false, revokeAcknowledged: false };
const connectionInstruction = 'Connect or pair your Worker in Worker connection, then explicitly Refresh here. A newly paired Worker may require a normal app restart before these controls can use it. If already paired, check Worker connection and refresh again.';
/** The two worker reasons a refused status read can carry (`remoteGoogleConnectionsContract`). Neither is a grant
 * state, and only the first has a remedy on this Mac: the pairing credential is rotated in Worker connection. */
export const scopeDeniedInstruction = 'This Mac\'s pairing was issued without the google:grant scope, so the worker refuses to read or create Google grants for it. Remedy: in Worker connection, use Rotate pairing credential with a rotation code that carries google:grant, restart the application normally, then Refresh here.';
export const googleUnconfiguredInstruction = 'This worker deployment has no Google client, so cloud mail and calendar grants are not available. Nothing on this Mac changes that; it is a worker deployment setting.';
const readFailureMessage = (reason: GoogleConnectionStatusReason | null) => reason === 'worker_scope_denied' ? scopeDeniedInstruction
  : reason === 'google_unconfigured' ? googleUnconfiguredInstruction : `Status and disclosure could not be verified. ${connectionInstruction}`;

function requestFor(purpose: GoogleGrantPurpose, panel: Panel) {
  if (purpose === 'permitted_correspondence') {
    // Named company mailbox only. No pre-filled identity or implicit domain conversion.
    if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@usecallie\.com$/.test(panel.input)) return null;
    const parsed = remoteGoogleGrantBeginSchema.safeParse({ purpose,
      expectedEmail: panel.input, capabilities: ['send', 'relevant_read'],
      disclosureVersion: googleGrantDisclosure.version });
    return parsed.success ? parsed.data : null;
  }
  const parsed = remoteGoogleGrantBeginSchema.safeParse({ purpose, capabilities: ['availability'],
    disclosureVersion: personalGoogleGrantDisclosure.version,
    availabilityCalendars: { calendarIds: panel.input.split('\n').map(id => id.trim()), confirmed: true } });
  return parsed.success ? parsed.data : null;
}

/** Cloud grants only. The main process owns consent URL validation and browser opening. */
export function RemoteGoogleConnectionsSection({ api }: { api?: RemoteGoogleConnectionsApi }) {
  const owner = useRef<Lifetime | null>(null);
  const [view, setView] = useState<{ owner: Lifetime | null; panels: ReturnType<typeof emptyPanels>; busy: boolean }>(
    () => ({ owner: null, panels: emptyPanels(), busy: false }));
  const current = useCallback((lifetime: Lifetime) => owner.current === lifetime, []);
  const update = useCallback((lifetime: Lifetime, purpose: GoogleGrantPurpose, patch: Partial<Panel>) => {
    if (!current(lifetime)) return;
    setView(previous => previous.owner === lifetime ? { ...previous,
      panels: { ...previous.panels, [purpose]: { ...previous.panels[purpose], ...patch } } } : previous);
  }, [current]);
  const read = useCallback(async (lifetime: Lifetime, purpose: GoogleGrantPurpose) => {
    update(lifetime, purpose, { ...resetAcknowledgments, fresh: false, status: null, disclosure: null, message: 'Checking cloud grant status and disclosure…' });
    // The one allowlisted worker reason a refused status read carries; anything else stays the generic hold.
    let reason: GoogleConnectionStatusReason | null = null;
    try {
      const [rawStatus, rawDisclosure] = await Promise.allSettled([
        Promise.resolve().then(() => lifetime.api.status({ purpose })),
        Promise.resolve().then(() => lifetime.api.disclosure({ purpose })),
      ]);
      if (!current(lifetime)) return;
      if (rawStatus.status === 'rejected') reason = googleConnectionStatusReason(rawStatus.reason);
      if (rawStatus.status !== 'fulfilled' || rawDisclosure.status !== 'fulfilled') throw new Error('read');
      const status = remoteGoogleGrantStatusSchema.parse(rawStatus.value);
      const disclosure = remoteGoogleGrantDisclosureSchema.parse(rawDisclosure.value);
      if ((status.grant && status.grant.purpose !== purpose) || disclosure.version !== disclosureFor(purpose).version) throw new Error('purpose');
      update(lifetime, purpose, { status, disclosure: disclosure.text, fresh: true, message: '' });
    } catch {
      update(lifetime, purpose, { message: readFailureMessage(reason) });
    }
  }, [current, update]);
  const run = useCallback(async (lifetime: Lifetime, targets: readonly GoogleGrantPurpose[],
    action: 'read' | 'begin' | 'revoke' = 'read', panel?: Panel) => {
    if (!current(lifetime) || lifetime.busy) return;
    const purpose = targets[0];
    const request = panel && requestFor(purpose, panel);
    if (action !== 'read' && (!panel?.fresh || !panel.disclosure)) return;
    if (action === 'begin' && (!panel?.acknowledged || !panel.confirmed || !request || cleanupPending(panel.status))) return;
    if (action === 'revoke' && (!panel?.revokeAcknowledged || !canRequestRevoke(panel.status))) return;
    // One synchronous lock covers both panels and all reads, including same-tick clicks.
    lifetime.busy = true;
    setView(previous => previous.owner === lifetime ? { ...previous, busy: true } : previous);
    try {
      if (action === 'read') { await Promise.all(targets.map(target => read(lifetime, target))); return; }
      update(lifetime, purpose, { ...resetAcknowledgments, fresh: false, status: null,
        message: action === 'begin' ? 'Opening Google consent… Outcome pending.' : 'Revocation requested… Outcome pending. Provider access may remain.' });
      try {
        if (action === 'begin' && request) {
          const raw = await lifetime.api.begin(request);
          if (!current(lifetime)) return;
          const receipt = googleConsentOpenedSchema.parse(raw);
          if (receipt.purpose !== purpose) throw new Error('purpose');
          update(lifetime, purpose, { message: 'Google consent opened. This is not a connected grant. Complete Google consent in your browser, then explicitly Refresh. No automatic checks will run.' });
        } else {
          const raw = await lifetime.api.revoke({ purpose });
          if (!current(lifetime)) return;
          const status = remoteGoogleGrantStatusSchema.parse(raw);
          if ((status.grant && status.grant.purpose !== purpose) || status.state !== 'revoked') throw new Error('purpose');
          update(lifetime, purpose, { status, message: 'Revocation response received. Refresh for a fresh status before another action.' });
        }
      } catch {
        update(lifetime, purpose, { message: action === 'begin'
          ? 'Consent outcome unknown. Google may have opened or the request may have taken effect. Complete any open Google flow, then Refresh before a new explicit attempt.'
          : 'Revocation outcome unknown. Access may remain. Refresh to inspect status before another explicit attempt.' });
      }
    } finally {
      if (current(lifetime)) {
        lifetime.busy = false;
        setView(previous => previous.owner === lifetime ? { ...previous, busy: false } : previous);
      }
    }
  }, [current, read, update]);
  useLayoutEffect(() => {
    const lifetime = api ? { api, busy: false } : null;
    owner.current = lifetime;
    setView({ owner: lifetime, panels: emptyPanels(), busy: false });
    if (lifetime) void run(lifetime, purposes);
    return () => {
      // Invalidates results, not transport. An in-flight mutation cannot be undone here.
      owner.current = null;
    };
  }, [api, run]);
  const lifetime = owner.current;
  const isCurrent = !!lifetime && lifetime.api === api && view.owner === lifetime;
  const panels = isCurrent ? view.panels : emptyPanels();
  const busy = !isCurrent || view.busy;
  return (
    <section className="settings__section settings-google-connections" aria-label="Remote Google connections">
      <h2 className="settings__section-title">Remote Google connections</h2>
      <p>Cloud grants for your Worker, separate from local Desktop Gmail and AI provider settings. A ready cloud grant does not authorize campaigns or prove live mailbox or selected calendar access.</p>
      {!api && <p role="status">{connectionInstruction}</p>}
      <p>Only explicit controls start consent or revoke access. Leaving this screen does not undo a pending network request. Personal information is not saved in browser storage.</p>
      {purposes.map(purpose => {
        const panel = panels[purpose];
        const personal = purpose === 'personal_availability';
        const valid = requestFor(purpose, panel) !== null;
        const editable = !busy;
        const change = (patch: Partial<Panel>) => {
          if (lifetime && current(lifetime) && !lifetime.busy) update(lifetime, purpose, patch);
        };
        return <section key={purpose} className="settings__section" aria-label={personal ? 'Personal calendar availability' : 'Work email'}>
          <h3>{personal ? 'Personal calendar availability' : 'Work email'}</h3>
          <p>{personal ? 'Availability only. No personal mail, event details, or event edits.' : 'Send and relevant read only for your named @usecallie.com mailbox. No calendar permission requested.'}</p>
          <p role="status">{panel.status?.state === 'ready' ? 'Cloud grant ready (last verified status)' : panel.status?.state === 'revoked' ? 'Cloud grant revocation requested' : panel.status?.state === 'unconfigured' ? 'No cloud grant configured' : 'Cloud grant status unverified'}</p>
          {panel.status?.state === 'revoked' && <p>{panel.status.providerRevocation === 'confirmed'
            ? 'Provider revocation confirmed.' : 'Provider revocation pending or unconfirmed. Provider access may remain. Refresh, then explicitly retry cleanup if needed. Cleanup may remain held for operational reconciliation.'}</p>}
          {panel.status?.state === 'ready' && panel.status.grant && <dl className="settings__counters">
            <div><dt>Verified Google identity</dt><dd>{panel.status.grant.email}</dd></div>
            <div><dt>Granted capabilities</dt><dd>{panel.status.grant.capabilities.join(', ') || 'None'}</dd></div>
            {panel.status.grant.purpose === 'personal_availability' && <div><dt>Confirmed calendar IDs (not access proof)</dt><dd>{panel.status.grant.availabilityCalendars.calendarIds.join(', ')}</dd></div>}
          </dl>}
          {panel.message && <p role="status">{panel.message}</p>}
          {personal ? <label className="settings__row">Calendar IDs, one per line
            <textarea value={panel.input} autoComplete="off" spellCheck={false} disabled={!editable}
              onChange={event => change({ input: event.target.value, ...resetAcknowledgments })} />
          </label> : <label className="settings__row">Named work email (@usecallie.com)
            <input type="email" required value={panel.input} autoComplete="off" spellCheck={false} disabled={!editable}
              onChange={event => change({ input: event.target.value, ...resetAcknowledgments })} />
          </label>}
          {!valid && <p>{personal ? 'Enter 1–20 distinct explicit lowercase calendar email IDs. Aliases such as primary, blank lines and duplicates are not accepted.' : 'Enter a named lowercase @usecallie.com email address. This field is required.'}</p>}
          {panel.disclosure ? <div><h4>{personal ? 'Personal availability disclosure' : 'Legacy work email disclosure'}</h4><p>{panel.disclosure}</p></div>
            : <p>Disclosure unavailable. Refresh to verify it before continuing.</p>}
          <label className="settings__row"><input type="checkbox" checked={panel.confirmed} disabled={busy || !valid || !panel.fresh}
            onChange={event => change({ confirmed: event.target.checked, acknowledged: false })} />
            {personal ? 'I confirm these exact calendar IDs' : 'I confirm this named work mailbox'}</label>
          <label className="settings__row"><input type="checkbox" checked={panel.acknowledged} disabled={busy || !panel.disclosure || !panel.fresh}
            onChange={event => change({ acknowledged: event.target.checked })} />I have reviewed and acknowledge this disclosure</label>
          <div className="settings__row-actions">
            <Button disabled={busy || !panel.fresh || !valid || !panel.confirmed || !panel.acknowledged || cleanupPending(panel.status)}
              onClick={() => { if (lifetime) void run(lifetime, [purpose], 'begin', panel); }}>Continue to Google</Button>
            <Button variant="quiet" disabled={busy} onClick={() => { if (lifetime) void run(lifetime, [purpose]); }}>Refresh</Button>
          </div>
          <label className="settings__row"><input type="checkbox" checked={panel.revokeAcknowledged} disabled={busy || !panel.fresh || !canRequestRevoke(panel.status)}
            onChange={event => change({ revokeAcknowledged: event.target.checked })} />I acknowledge this revocation request may affect other Google grants for the same account and app</label>
          <Button variant="danger" disabled={busy || !panel.fresh || !canRequestRevoke(panel.status) || !panel.revokeAcknowledged}
            onClick={() => { if (lifetime) void run(lifetime, [purpose], 'revoke', panel); }}>Revoke cloud grant</Button>
        </section>;
      })}
    </section>
  );
}
