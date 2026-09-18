import { useEffect, useRef, useState } from 'react';
import type { LocalWorkspaceApi } from '../../shared/contracts/localWorkspaceContract';
import { TERRITORY_CLEARANCE_STATEMENT_KEYS, TERRITORY_CLEARANCE_STATEMENTS, TERRITORY_FEDERAL_CITATIONS, TERRITORY_RULES_REVISION, TERRITORY_STATE_RULES,
  US_STATE_NAMES, confirmTerritoryClearanceSchema, isTerritoryState, revokeTerritoryClearanceSchema, territoryClearanceSnapshotSchema,
  type TerritoryCitation, type TerritoryClearanceSnapshot, type TerritoryStateView } from '../../shared/contracts/territoryClearanceContract';
import type { TerritoryAddedState } from '../../shared/contracts/territoryCallPolicyContract';

type Api = Pick<LocalWorkspaceApi, 'readTerritoryClearance' | 'confirmTerritoryClearance' | 'revokeTerritoryClearance'>;
const STATUS_LABEL: Record<TerritoryStateView['status'], string> = { unconfirmed: 'Unconfirmed', confirmed: 'Confirmed', review_due: 'Review due', revoked: 'Revoked' };
/** What a state without a usable clearance means for Today. Mirrors the `state_clearance_missing` hold; the dial path decides, this only says so. */
const OFF_TODAY: Record<Exclude<TerritoryStateView['status'], 'confirmed'>, string> = {
  unconfirmed: 'Not confirmed: firms in this state stay off Today and nothing dials them.',
  revoked: 'Revoked: firms in this state stay off Today and nothing dials them until you confirm it again.',
  review_due: 'Review due: firms in this state stay off Today and nothing dials them until you confirm it again.',
};
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
 * citation, and stored clearance. One disclosure checkbox gates every Confirm
 * control: each state has its own "Confirm for {state}" beneath its citations,
 * which records the four statements for that state alone, and "Confirm for all
 * listed states" remains for the case where every statement holds everywhere.
 * Storage stays per state, so each confirmed state keeps its own Revoke control
 * and revision. Confirming records David's attestation; it never dials. A failed
 * response is shown as unknown and the section re-reads before offering another
 * write.
 *
 * `addedStates` are the states David added in the Territory control above. They are
 * listed here as unconfirmed with the reason they cannot yet be confirmed, and they
 * have no Confirm control: the controls here cover the built-in states only.
 */
export function TerritoryClearanceSection({ api, addedStates = [] }: { api?: Api; addedStates?: readonly TerritoryAddedState[] }) {
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
  /** One request naming exactly the states the clicked control covers; the disclosure and the rules revision travel with it. */
  const confirm = (label: string, states: readonly string[]) => {
    if (!snapshot || !usable?.confirmTerritoryClearance) return;
    let input;
    try { input = Object.freeze(confirmTerritoryClearanceSchema.parse({ states, disclosureAccepted: disclosure, rulesRevision: TERRITORY_RULES_REVISION })); }
    catch { setMessage('Read the statements and tick the disclosure before confirming.'); return; }
    void write(label, () => usable.confirmTerritoryClearance!(input));
  };
  const confirmAll = () => confirm('Confirmation', (snapshot?.states ?? []).filter(entry => isTerritoryState(entry.state)).map(entry => entry.state));
  const confirmOne = (entry: TerritoryStateView) => confirm(`Confirmation for ${entry.state}`, [entry.state]);
  const revoke = (entry: TerritoryStateView) => {
    if (!entry.clearance || !usable?.revokeTerritoryClearance) return;
    const input = Object.freeze(revokeTerritoryClearanceSchema.parse({ state: entry.state, expectedRevision: entry.clearance.revision }));
    void write(`Revocation for ${entry.state}`, () => usable.revokeTerritoryClearance!(input));
  };

  const listed = snapshot?.states.filter(entry => isTerritoryState(entry.state)) ?? [];
  const canConfirm = !!usable && !!snapshot && !pending && disclosure && listed.length > 0;
  return <section className="settings__section territory-clearance" aria-label="Territory clearance">
    <h2 className="settings__section-title">Territory clearance</h2>
    <p>Before the Mac dials a listed business number, the firm's state must carry a clearance you confirmed. Confirm each state on its own once every statement holds for it, or every listed state at once; each state keeps its own record, review date and Revoke control. Confirming records your statement. It never places a call.</p>
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
        const olderRules = clearance && entry.status !== 'revoked' && clearance.statements.rulesRevision < TERRITORY_RULES_REVISION ? clearance.statements.rulesRevision : null;
        return <li key={entry.state} className="territory-clearance__state" aria-label={`${entry.name} clearance`}>
          <h4>{entry.name} ({entry.state}) <span className="territory-clearance__zone">{entry.timezone}</span></h4>
          <p className="territory-clearance__status">{STATUS_LABEL[entry.status]}{clearance ? ` · revision ${clearance.revision}` : ''}{clearance && entry.status !== 'revoked' ? ` · confirmed ${day(clearance.confirmedAt)} · review ${day(clearance.reviewAt)}` : ''}{clearance?.revokedAt ? ` · revoked ${day(clearance.revokedAt)}` : ''}</p>
          {entry.status !== 'confirmed' && <p className="territory-clearance__hold">{OFF_TODAY[entry.status]}</p>}
          {olderRules !== null && <p className="territory-clearance__hold">Confirmed against rules revision {olderRules}; the texts shown here are revision {TERRITORY_RULES_REVISION}. Read them again and confirm {entry.state} to record the current revision.</p>}
          {rule && <p>{rule.summary}</p>}
          {rule && <Citation citation={rule.citation} />}
          {rule?.furtherCitations.map(citation => <Citation key={citation.url} citation={citation} />)}
          <div className="settings__row-actions">
            {rule && <button type="button" className="settings__action" disabled={!canConfirm} onClick={() => confirmOne(entry)}>Confirm for {entry.state}</button>}
            {clearance && entry.status !== 'revoked' && <button type="button" className="settings__action" disabled={pending} onClick={() => revoke(entry)}>Revoke {entry.state}</button>}
          </div>
        </li>;
      })}
      {addedStates.map(entry => <li key={entry.state} className="territory-clearance__state territory-clearance__state--added" aria-label={`${US_STATE_NAMES[entry.state]} clearance`}>
        <h4>{US_STATE_NAMES[entry.state]} ({entry.state}) <span className="territory-clearance__zone">{entry.timezone}</span></h4>
        <p className="territory-clearance__status">{STATUS_LABEL.unconfirmed} · added {day(entry.addedAt)}</p>
        <p>Added to the territory in the Territory control above. This build carries no rule summary or citation for {US_STATE_NAMES[entry.state]}, so it cannot be confirmed here yet and nothing dials for it.</p>
      </li>)}
    </ul>
    <label className="territory-clearance__disclosure">
      <input type="checkbox" checked={disclosure} disabled={!usable || !snapshot || pending} onChange={event => setDisclosure(event.target.checked)} />
      {' '}I have read the statements above and each quoted passage at its source, and I confirm them for the state or states named on the Confirm control I click.
    </label>
    <div className="settings__row-actions">
      <button type="button" className="settings__action" disabled={!canConfirm} onClick={confirmAll}>Confirm for all listed states</button>
    </div>
  </section>;
}
