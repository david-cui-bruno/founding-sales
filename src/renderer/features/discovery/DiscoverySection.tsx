import { useCallback, useEffect, useRef, useState } from 'react';
import type { DiscoveryApi, DiscoveryBrief as Brief, OverrideDiscoveryRequest } from '../../../shared/contracts/discoveryContract';
import { Button } from '../../components/Button';
import { DiscoveryBrief } from './DiscoveryBrief';
import { useLeadInspectorIfAvailable } from '../leadInspector/useLeadInspector';
import { staleDiscoveryError, useDiscovery } from './useDiscovery';

export function DiscoverySection({ api, onOpenPerson, onPreparedPerson = onOpenPerson }: { api: DiscoveryApi; onOpenPerson(personId: string): void; onPreparedPerson?(personId: string): void }) {
  const { snapshot, error, busyPersonId, refresh, begin } = useDiscovery(api);
  const [showAll, setShowAll] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [reviewPersonId, setReviewPersonId] = useState<string | null>(null);
  const [retries, setRetries] = useState<ReadonlyMap<string, Brief>>(() => new Map());
  const active = useRef(true);
  const apiRef = useRef(api);
  apiRef.current = api;
  const navigation = useRef(0);
  const submitting = useRef(false);
  const inspector = useLeadInspectorIfAvailable();
  const selectedPersonId = inspector?.selectedPersonId;
  const selectionRef = useRef(selectedPersonId);
  selectionRef.current = selectedPersonId;
  useEffect(() => { navigation.current++; }, [selectedPersonId]);
  useEffect(() => { active.current = true; return () => { active.current = false; navigation.current++; }; }, [api]);
  const override = useCallback(async (request: OverrideDiscoveryRequest) => {
    const current = navigation.current;
    const isCurrent = () => active.current && navigation.current === current
      && apiRef.current === api && selectionRef.current === selectedPersonId;
    try {
      const receipt = await api.override(request);
      if (isCurrent()) await refresh();
      return receipt;
    } catch (failure) {
      if (staleDiscoveryError(failure) && isCurrent()) void refresh();
      throw failure;
    }
  }, [api, refresh, selectedPersonId]);
  const contactOptions = async (brief: Brief) => {
    if (submitting.current) return;
    submitting.current = true;
    const current = ++navigation.current;
    setRetries(previous => { const next = new Map(previous); next.delete(brief.personId); return next; });
    try {
      const receipt = await begin(brief);
      if (navigation.current !== current) return;
      // A successful command stays successful even if this read fails.
      await refresh();
      if (navigation.current === current) onPreparedPerson(receipt.personId);
    } catch (failure) {
      if (active.current && !staleDiscoveryError(failure)) setRetries(previous => new Map(previous).set(brief.personId, brief));
    } finally { submitting.current = false; }
  };
  const card = (brief: Brief, prepared: boolean) => <article key={brief.personId} className="discovery-card">
    <h3>{brief.personName}</h3>
    <p className="discovery-card__question">{brief.assessment?.questions[0] ?? 'Open the evidence to explore this person.'}</p>
    {brief.stale && <p>Evidence changed. Refresh before preparing.</p>}
    {!prepared && <p>{brief.assessment?.reasonCodes.map(code => code.replaceAll('_', ' ')).join(' · ')}</p>}
    <div className="discovery-card__actions">
      <Button variant="primary" onClick={() => { navigation.current++; onOpenPerson(brief.personId); }} aria-label={`View evidence for ${brief.personName}`}>Open brief</Button>
      {prepared && <Button variant="quiet" disabled={busyPersonId !== null || brief.stale || brief.assessment === null}
        onClick={() => { void contactOptions(brief); }} aria-label={`Contact options for ${brief.personName}`}>Contact options</Button>}
    </div>
  </article>;
  return <div className="discovery">
    <section aria-labelledby="prepared-conversations-heading">
      <div className="discovery__heading"><h2 id="prepared-conversations-heading">Prepared conversations</h2><span>{snapshot?.prepared.length ?? '…'}</span></div>
      <p>A few people worth a conversation. Open a brief to explore, or prepare contact options for one person.</p>
      {error !== null && <p role="alert">{error}</p>}
      {busyPersonId !== null && <p role="status">Preparing selected contact options…</p>}
      {[...retries.values()].filter(brief => inspector?.selectedPersonId == null || inspector.selectedPersonId === brief.personId).map(brief =>
        <Button key={brief.personId} disabled={busyPersonId !== null} onClick={() => { void contactOptions(brief); }}>Retry contact options for {brief.personName}</Button>)}
      {error === null && (snapshot === null || snapshot.prepared.length === 0 && snapshot.processing === 'running')
        ? <p role="status">Preparing your shortlist</p>
        : snapshot !== null && snapshot.prepared.length === 0 ? <p>No prepared conversations right now.</p> : null}
      {snapshot?.processing === 'paused' && <p role="status">Preparation paused. Existing evidence remains available.</p>}
      {snapshot?.processing === 'error' && <p role="alert">Preparation needs attention. No automatic retry is requested here.</p>}
      <div className="discovery__cards">{snapshot?.prepared.slice(0, showAll ? undefined : 3).map(brief => card(brief, true))}</div>
      {snapshot !== null && snapshot.prepared.length > 3 && <Button variant="quiet" aria-expanded={showAll}
        onClick={() => setShowAll(value => !value)}>{showAll ? 'Show fewer prepared people' : `Show ${snapshot.prepared.length - 3} more prepared people`}</Button>}
      <Button variant="quiet" onClick={() => { void refresh(); }}>Refresh shortlist</Button>
    </section>
    <section className="discovery__diagnostics">
      <Button variant="quiet" aria-expanded={diagnosticsOpen} onClick={() => setDiagnosticsOpen(value => !value)}>Research and diagnostics</Button>
      {diagnosticsOpen && <>
    <section aria-label="Research"><h2>Research</h2>
      <p>{snapshot === null ? 'Research availability unknown while loading' : snapshot.researchCapability === 'available' ? 'Additional research available' : 'Additional research not configured'}</p>
      {snapshot !== null && <p>{snapshot.counts.research} records need more evidence. {snapshot.counts.unassessed} not assessed. Missing facts can be discovery questions.</p>}
    </section>
      <p>Contact options prepares one Person, never sends or enriches automatically.</p>
      {[...(snapshot?.prepared ?? []), ...(snapshot?.judgment ?? [])].map(brief => <div key={brief.personId}>
        <Button variant="quiet" aria-expanded={reviewPersonId === brief.personId} onClick={() => setReviewPersonId(value => value === brief.personId ? null : brief.personId)}>Review discovery decision for {brief.personName}</Button>
        {reviewPersonId === brief.personId && <DiscoveryBrief brief={brief} onOverride={override} />}
      </div>)}
      </>}
    </section>
    {snapshot !== null && snapshot.judgment.length > 0 && <section aria-label="Needs your judgment"><h2>Needs your judgment</h2>
      {snapshot?.judgment.map(brief => card(brief, false))}
      {snapshot?.judgment.length === 0 && <p>No identity conflicts needing your judgment in this shortlist.</p>}
    </section>}
  </div>;
}
