import { useEffect, useState, type ReactNode } from 'react';
import type { DailySnapshot } from '../../../shared/contracts/dailyContract';
import { localCompanyDetailSchema, type LocalCompanyDetail, type LocalWorkspaceApi } from '../../../shared/contracts/localWorkspaceContract';
import { phoneSetupStatusSchema, type PhoneSetupApi } from '../../../shared/contracts/phoneSetupContract';
import { findPlacesSource } from './placesLocation';
import { MANUAL_DIAL_NOT_WIRED, PHONE_DIAL_MODES, type PhoneDialState } from './todayCopy';

type Account = DailySnapshot['accounts'][number];
type DetailRead = { state: 'pending' } | { state: 'unavailable' } | { state: 'read'; detail: LocalCompanyDetail };
type DialRead = { state: 'hidden' } | { state: 'reading' } | { state: 'read'; mode: PhoneDialState };

/** The verification word next to a phone, as a plain statement of where the number came from. It is never call permission. */
export const PHONE_VERIFICATION_WORDS: Record<Account['routes'][number]['verification'], string> = {
  published: 'published on the firm\'s own site',
  confirmed: 'confirmed',
  listed: 'listed in a business directory',
  unverified: 'unverified',
};

/**
 * D2/D5 call card: what David reads before he dials. Firm name, each business
 * phone with its verification word, the website, city and state from the saved
 * Places listing, the portfolio count and residential line when the evidence
 * has them, and the sources behind the phone. It reads the local company detail
 * once per selection; that read is a local database read and the only side
 * effect here. Nothing on this card dials, navigates or sends.
 *
 * D6 adds the show-number fallback: an explicit "Show number" control that reads
 * the saved phone setup once per click, says in plain words whether Callie can
 * dial from this Mac, and repeats the firm's business number with a copy control
 * so a call is never impossible. There is no `tel:` link, nothing is opened, and
 * the clipboard is written only by the copy click.
 */
export function CallCard({ account, api, phoneSetup }: {
  account: Account; api?: Pick<LocalWorkspaceApi, 'getCompany'>; phoneSetup?: Pick<PhoneSetupApi, 'status'>;
}) {
  const [read, setRead] = useState<DetailRead>({ state: 'pending' });
  const [dial, setDial] = useState<DialRead>({ state: 'hidden' });
  const [copied, setCopied] = useState(false);
  const accountId = account.account.id;
  const phones = account.routes.filter(route => route.channel === 'phone' && route.purpose === 'business');
  // The listing is read only for a firm with a saved business phone: that is the firm David may dial, and the
  // read explains where its number came from. A firm without a phone has nothing to look up.
  const wantsListing = phones.length > 0;
  const readListing = !!api && wantsListing;
  useEffect(() => {
    if (!api || !readListing) { setRead({ state: 'unavailable' }); return; }
    let alive = true;
    setRead({ state: 'pending' });
    void Promise.resolve().then(() => api.getCompany({ accountId })).then(raw => {
      if (!alive) return;
      const detail = localCompanyDetailSchema.parse(raw);
      if (detail.snapshot.account.id !== accountId) throw new Error('detail_identity_mismatch');
      setRead({ state: 'read', detail });
    }).catch(() => { if (alive) setRead({ state: 'unavailable' }); });
    return () => { alive = false; };
  }, [api, readListing, accountId]);
  // One explicit read per click. No timer, no retry, no automatic inspection: mounting this card
  // must stay free of phone setup reads, and a failed read is reported as unreadable, never as ready.
  const primary = phones[0] ?? null;
  const showNumber = () => {
    if (!primary || dial.state === 'reading') return;
    setDial({ state: 'reading' }); setCopied(false);
    if (!phoneSetup) { setDial({ state: 'read', mode: 'unreadable' }); return; }
    void Promise.resolve().then(() => phoneSetup.status())
      .then(raw => setDial({ state: 'read', mode: phoneSetupStatusSchema.parse(raw).state }))
      .catch(() => setDial({ state: 'read', mode: 'unreadable' }));
  };
  // Written inside the click itself, as the clipboard requires, and only then.
  const copyNumber = () => {
    if (!primary) return;
    setCopied(false);
    try { void Promise.resolve(navigator.clipboard?.writeText(primary.value)).then(() => setCopied(true), () => setCopied(false)); }
    catch { setCopied(false); }
  };
  const mode = dial.state === 'read' ? PHONE_DIAL_MODES[dial.mode] : null;
  const residential = account.claims.find(claim => claim.kind === 'fact' && claim.key === 'residential_scope' && typeof claim.value === 'string');
  const detail = read.state === 'read' ? read.detail : null;
  const places = detail ? findPlacesSource(detail.sources) : null;
  const phoneEvidence = new Set(phones.flatMap(route => route.evidenceIds));
  const phoneSources = detail ? detail.sources.filter(source => phoneEvidence.has(source.id)) : [];
  const location = places?.location;
  const locationText = location && (location.city || location.state)
    ? [location.city, location.state].filter(Boolean).join(', ')
    : null;
  return <section className="native-desk__call-card" aria-label="Call card">
    <h3>{account.account.name}</h3>
    {phones.length === 0
      ? <p>No business phone is saved for this firm.</p>
      : phones.map(route => <p key={route.id}><strong>{route.value}</strong> · {PHONE_VERIFICATION_WORDS[route.verification]}</p>)}
    <p>Website: {account.account.domain ? <code>{`https://${account.account.domain}/`}</code> : 'not recorded'}</p>
    <p>Location: {read.state === 'pending' ? 'reading the saved listing…' : locationText ?? (read.state === 'unavailable'
      ? wantsListing ? 'unavailable (local company detail could not be read)' : 'not read (no saved business phone)'
      : 'not found in the saved sources')}</p>
    <p>Portfolio: {account.portfolio.length ? account.portfolio.map(item => `${item.count} ${item.scope} ${item.measure}`).join(' · ') : 'count not found'}</p>
    <p>Residential: {residential && typeof residential.value === 'string' ? residential.value : 'scope not found'}</p>
    <p>Source: {read.state === 'pending' ? 'reading…' : phoneSources.length
      ? phoneSources.map(source => <code key={source.id}>{source.url}</code>).reduce<ReactNode[]>((nodes, node, index) => index ? [...nodes, ' · ', node] : [node], [])
      : read.state === 'unavailable' ? 'unavailable' : 'no saved source backs this phone'}</p>
    <p className="native-desk__hint">Reading this card places no call. The handoff below asks you to confirm first.</p>
    {primary && <div className="native-desk__dial">
      {dial.state === 'hidden' && <button onClick={showNumber}>Show number</button>}
      {dial.state === 'reading' && <p role="status">Reading phone setup…</p>}
      {dial.state === 'read' && mode && <>
        <p role="status">{mode.reason === null ? mode.card
          : `Callie cannot dial from this Mac: ${mode.reason}. Dial it yourself and log the outcome below.`}</p>
        {mode.reason !== null && <p>{MANUAL_DIAL_NOT_WIRED}</p>}
        <p><strong data-testid="dial-number">{primary.value}</strong> · {PHONE_VERIFICATION_WORDS[primary.verification]}</p>
        <button onClick={copyNumber}>Copy number</button>
        {copied && <p role="status">Number copied. Copying is not a call.</p>}
        {phones.length > 1 && <p>The firm&apos;s other saved business numbers are listed above.</p>}
      </>}
    </div>}
  </section>;
}
