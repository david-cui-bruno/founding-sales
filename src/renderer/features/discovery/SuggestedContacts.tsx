import { useEffect } from 'react';
import type { DiscoveryApi } from '../../../shared/contracts/discoveryContract';
import { supportsContactPreparation } from './contactPreparationEligibility';
import { useDiscovery } from './useDiscovery';

/** A small read-only projection, not a second queue or a preparation command. */
export function SuggestedContacts({ api, onOpenPerson }: { api: DiscoveryApi; onOpenPerson(personId: string): void }) {
  const { snapshot, error, refresh } = useDiscovery(api);
  useEffect(() => {
    const update = () => { void refresh(); };
    window.addEventListener('focus', update);
    window.addEventListener('callie:contact-prepared', update);
    return () => { window.removeEventListener('focus', update); window.removeEventListener('callie:contact-prepared', update); };
  }, [refresh]);
  const candidates = snapshot?.prepared.filter(supportsContactPreparation).slice(0, 3) ?? [];
  return <section className="today-suggestions" aria-label="Suggested contacts">
    <div className="today-work-heading"><h2>Suggested contacts</h2><span>{candidates.length}</span></div>
    {error !== null && <p role="alert">Suggested contacts could not refresh. Existing evidence may be out of date.</p>}
    {snapshot === null && error === null && <p role="status">Checking suggested contacts…</p>}
    {snapshot?.processing === 'paused' && <p role="status">Contact preparation is paused.</p>}
    {snapshot?.processing === 'error' && <p role="status">Contact preparation needs attention.</p>}
    {snapshot !== null && candidates.length === 0 && <p>{snapshot.processing === 'running' ? 'Checking source evidence for suggested contacts…' : 'No suggested contacts right now.'}</p>}
    {candidates.length > 0 && <ul className="today-work-list">{candidates.map(brief => <li key={brief.personId}>
      <button type="button" onClick={() => onOpenPerson(brief.personId)}>{brief.personName}</button>
      <span>Source-backed candidate · open portfolio</span>
    </li>)}</ul>}
  </section>;
}
