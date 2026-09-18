import { useEffect, useRef, useState } from 'react';
import type { LocalWorkspaceApi } from '../../shared/contracts/localWorkspaceContract';
import { TERRITORY_CLEARANCE_STATEMENT_KEYS, TERRITORY_CLEARANCE_STATEMENTS, TERRITORY_FEDERAL_CITATIONS, TERRITORY_RULES_REVISION, TERRITORY_STATE_RULES,
  confirmTerritoryClearanceSchema, isTerritoryState, revokeTerritoryClearanceSchema, territoryClearanceSnapshotSchema,
  type TerritoryCitation, type TerritoryClearanceSnapshot, type TerritoryStateView } from '../../shared/contracts/territoryClearanceContract';

type Api = Pick<LocalWorkspaceApi, 'readTerritoryClearance' | 'confirmTerritoryClearance' | 'revokeTerritoryClearance'>;
const STATUS_LABEL: Record<TerritoryStateView['status'], string> = { unconfirmed: 'Unconfirmed', confirmed: 'Confirmed', review_due: 'Review due', revoked: 'Revoked' };
const day = (instant: string) => instant.slice(0, 10);

function Citation({ citation }: { citation: TerritoryCitation }) {
  return <figure className="territory-clearance__citation">
    <blockquote>{citation.quote}</blockquote>
    <figcaption><a href={citation.url} target="_blank" rel="noreferrer noopener">{citation.title}</a></figcaption>
  </figure>;
}

/**
 * One compliance clearance per state (design D4). The statements and citations
 * are the contract's text, shown once; each listed state shows its rule summary,
 * citation, and stored clearance. One disclosure checkbox and one button confirm
 * every listed state at once; storage stays per state, so each confirmed state
 * keeps its own Revoke control and revision. Confirming records David's
 * attestation; it never dials. A failed response is shown as unknown and the
 * section re-reads before offering another write.
 */
export function TerritoryClearanceSection({ api }: { api?: Api }) {
  const usable = api && typeof api.readTerritoryClearance === 'function' && typeof api.confirmTerritoryClearance === 'function' && typeof api.revokeTerritoryClearance === 'function' ? api : undefined;
  const [snapshot, setSnapshot] = useState<TerritoryClearanceSnapshot | null>(null);
  const [disclosure, setDisclosure] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const generation = useRef(0);
  const busy = useRef(false);

  const read = async (request: number, after: string | null) => {
    if (!usable?.readTerritoryClearance) return;
    try {
      const result = territoryClearanceSnapshotSchema.parse(await usable.readTerritoryClearance());
      if (request !== generation.current) return;
      setSnapshot(result);
      setMessage(after ?? '');
    } catch {
      if (request === generation.current) { setSnapshot(null); setMessage(after ? `${after} The current record could not be read.` : 'Territory clearance is unavailable.'); }
    } finally {
      if (request === generation.current) { busy.current = false; setPending(false); }
    }
  };
  useEffect(() => {
    const request = ++generation.current;
    busy.current = !!usable;
    setPending(!!usable);
    setSnapshot(null);
    setDisclosure(false);
    setMessage(usable ? 'Loading territory clearance…' : 'Territory clearance is unavailable.');
    if (usable) void read(request, null);
    return () => { generation.current++; };
  // `read` closes over `usable`, which is the only value this effect keys on.
  }, [usable]);

  const write = async (label: string, operation: () => Promise<unknown>) => {
    if (!usable || !snapshot || busy.current) return;
    const request = generation.current;
    busy.current = true;
    setPending(true);
    setMessage(`${label}…`);
    let after: string;
    try {
      const result = territoryClearanceSnapshotSchema.parse(await operation());
      if (request !== generation.current) return;
      setSnapshot(result);
      after = `${label} recorded.`;
    } catch {
      if (request !== generation.current) return;
      after = `${label} outcome unknown. Review the current record before another change.`;
    }
    setDisclosure(false);
    await read(request, after);
  };
  const confirmAll = () => {
    if (!snapshot || !usable?.confirmTerritoryClearance) return;
    const states = snapshot.states.filter(entry => isTerritoryState(entry.state)).map(entry => entry.state);
    let input;
    try { input = Object.freeze(confirmTerritoryClearanceSchema.parse({ states, disclosureAccepted: disclosure, rulesRevision: TERRITORY_RULES_REVISION })); }
    catch { setMessage('Read the statements and tick the disclosure before confirming.'); return; }
    void write('Confirmation', () => usable.confirmTerritoryClearance!(input));
  };
  const revoke = (entry: TerritoryStateView) => {
    if (!entry.clearance || !usable?.revokeTerritoryClearance) return;
    const input = Object.freeze(revokeTerritoryClearanceSchema.parse({ state: entry.state, expectedRevision: entry.clearance.revision }));
    void write(`Revocation for ${entry.state}`, () => usable.revokeTerritoryClearance!(input));
  };

  const listed = snapshot?.states.filter(entry => isTerritoryState(entry.state)) ?? [];
  const canConfirm = !!usable && !!snapshot && !pending && disclosure && listed.length > 0;
  return <section className="settings__section territory-clearance" aria-label="Territory clearance">
    <h2 className="settings__section-title">Territory clearance</h2>
    <p>Before the Mac dials a listed business number, the firm's state must carry a clearance you confirmed. One click confirms every listed state; each state keeps its own record, review date and Revoke control. Confirming records your statement. It never places a call.</p>
    <h3>What you confirm</h3>
    <ol className="territory-clearance__statements">
      {TERRITORY_CLEARANCE_STATEMENT_KEYS.map(key => <li key={key}>{TERRITORY_CLEARANCE_STATEMENTS[key]}</li>)}
    </ol>
    <h3>Federal basis</h3>
    {TERRITORY_FEDERAL_CITATIONS.map(citation => <Citation key={citation.url} citation={citation} />)}
    <h3>Listed states</h3>
    <p role="status">{message}</p>
    <ul className="territory-clearance__states">
      {listed.map(entry => {
        const rule = isTerritoryState(entry.state) ? TERRITORY_STATE_RULES[entry.state] : null;
        const clearance = entry.clearance;
        return <li key={entry.state} className="territory-clearance__state" aria-label={`${entry.name} clearance`}>
          <h4>{entry.name} ({entry.state}) <span className="territory-clearance__zone">{entry.timezone}</span></h4>
          <p className="territory-clearance__status">{STATUS_LABEL[entry.status]}{clearance ? ` · revision ${clearance.revision}` : ''}{clearance && entry.status !== 'revoked' ? ` · confirmed ${day(clearance.confirmedAt)} · review ${day(clearance.reviewAt)}` : ''}{clearance?.revokedAt ? ` · revoked ${day(clearance.revokedAt)}` : ''}</p>
          {rule && <p>{rule.summary}</p>}
          {rule && <Citation citation={rule.citation} />}
          {rule?.furtherCitations.map(citation => <Citation key={citation.url} citation={citation} />)}
          {clearance && entry.status !== 'revoked' && <button type="button" className="settings__action" disabled={pending} onClick={() => revoke(entry)}>Revoke {entry.state}</button>}
        </li>;
      })}
    </ul>
    <label className="territory-clearance__disclosure">
      <input type="checkbox" checked={disclosure} disabled={!usable || !snapshot || pending} onChange={event => setDisclosure(event.target.checked)} />
      {' '}I have read the statements above and each quoted passage at its source, and I confirm them for every listed state.
    </label>
    <div className="settings__row-actions">
      <button type="button" className="settings__action" disabled={!canConfirm} onClick={confirmAll}>Confirm for all listed states</button>
    </div>
  </section>;
}
