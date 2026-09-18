import { useEffect, useState, type ReactNode } from 'react';
import type { DailySnapshot } from '../../../shared/contracts/dailyContract';
import { localCompanyDetailSchema, type LocalCompanyDetail, type LocalWorkspaceApi } from '../../../shared/contracts/localWorkspaceContract';
import { findPlacesSource } from './placesLocation';

type Account = DailySnapshot['accounts'][number];
type DetailRead = { state: 'pending' } | { state: 'unavailable' } | { state: 'read'; detail: LocalCompanyDetail };

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
 */
export function CallCard({ account, api }: { account: Account; api?: Pick<LocalWorkspaceApi, 'getCompany'> }) {
  const [read, setRead] = useState<DetailRead>({ state: 'pending' });
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
  </section>;
}
