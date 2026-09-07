import { useCallback, useEffect, useRef, useState } from 'react';
import type { DiscoveryApi, DiscoveryBrief as Brief, OverrideDiscoveryRequest } from '../../../shared/contracts/discoveryContract';
import { Button } from '../../components/Button';
import { DiscoveryBrief } from './DiscoveryBrief';
import { useLeadInspectorIfAvailable } from '../leadInspector/useLeadInspector';
import { staleDiscoveryError, useDiscovery } from './useDiscovery';

export function DiscoverySection({ api, onOpenPerson }: { api: DiscoveryApi; onOpenPerson(personId: string): void }) {
  const { snapshot, error, busyPersonId, refresh, begin } = useDiscovery(api);
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
      if (navigation.current === current) onOpenPerson(receipt.personId);
    } catch (failure) {
      if (active.current && !staleDiscoveryError(failure)) setRetries(previous => new Map(previous).set(brief.personId, brief));
    } finally { submitting.current = false; }
  };
  const card = (brief: Brief, prepared: boolean) => <article key={brief.personId} className="discovery-card">
    <h3>{brief.personName}</h3>
    <DiscoveryBrief brief={brief} onOverride={override} />
    <div className="discovery-card__actions">
      <Button variant="quiet" onClick={() => { navigation.current++; onOpenPerson(brief.personId); }}>View evidence for {brief.personName}</Button>
      {prepared && <Button disabled={busyPersonId !== null || brief.stale || brief.assessment === null}
        onClick={() => { void contactOptions(brief); }}>Contact options for {brief.personName}</Button>}
    </div>
  </article>;
  return <div className="discovery">
    <section aria-labelledby="prepared-conversations-heading">
      <h2 id="prepared-conversations-heading">Prepared conversations</h2>
      <p>Evidence and questions for customer discovery. Contact options prepares one Person, never sends or enriches automatically.</p>
      {error !== null && <p role="alert">{error}</p>}
      {busyPersonId !== null && <p role="status">Preparing selected contact options…</p>}
      {[...retries.values()].filter(brief => inspector?.selectedPersonId == null || inspector.selectedPersonId === brief.personId).map(brief =>
        <Button key={brief.personId} disabled={busyPersonId !== null} onClick={() => { void contactOptions(brief); }}>Retry contact options for {brief.personName}</Button>)}
      {snapshot === null || snapshot.prepared.length === 0 && (snapshot.processing === 'running' || snapshot.counts.unassessed > 0)
        ? <p role="status">Preparing your shortlist</p>
        : snapshot.prepared.length === 0 ? <p>No prepared conversations right now.</p> : null}
      {snapshot?.processing === 'paused' && <p role="status">Preparation paused. Existing evidence remains available.</p>}
      {snapshot?.processing === 'error' && <p role="status">Preparation needs attention. No automatic retry is requested here.</p>}
      {snapshot?.prepared.map(brief => card(brief, true))}
      <Button variant="quiet" onClick={() => { void refresh(); }}>Refresh shortlist</Button>
    </section>
    <section aria-label="Research"><h2>Research</h2>
      <p>{snapshot === null ? 'Research availability unknown while loading' : snapshot.researchCapability === 'available' ? 'Additional research available' : 'Additional research not configured'}</p>
      {snapshot !== null && <p>{snapshot.counts.research} records need more evidence. {snapshot.counts.unassessed} not assessed. Missing facts can be discovery questions.</p>}
    </section>
    <section aria-label="Needs your judgment"><h2>Needs your judgment</h2>
      {snapshot?.judgment.map(brief => card(brief, false))}
      {snapshot?.judgment.length === 0 && <p>No identity conflicts needing your judgment in this shortlist.</p>}
    </section>
  </div>;
}
