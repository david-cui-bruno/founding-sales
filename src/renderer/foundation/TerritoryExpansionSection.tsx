import { useEffect, useState } from 'react';
import { researchSetupStatusSchema, type ResearchSetupApi, type TerritoryCounts, type TerritoryStatus } from '../../shared/contracts/researchSetupContract';
import { decideTerritoryStateAddition, isTerritoryAddableState, TERRITORY_ADDABLE_STATES, TERRITORY_STATES, TERRITORY_STATE_TIME_ZONES,
  US_STATE_CODES, US_STATE_NAMES, type TerritoryStateAdditionDecision } from '../../shared/contracts/territoryClearanceContract';
import { territoryAddStateRequestSchema, TERRITORY_ADD_STATE_NEXT_STEP, type TerritoryAddStateRequest } from '../../shared/contracts/territoryCallPolicyContract';
import { TerritoryClearanceSection } from './TerritoryClearanceSection';
import type { LocalWorkspaceApi } from '../../shared/contracts/localWorkspaceContract';

type Api = { researchSetup?: Pick<ResearchSetupApi, 'status'> };
type ClearanceApi = Pick<LocalWorkspaceApi, 'readTerritoryClearance' | 'confirmTerritoryClearance' | 'revokeTerritoryClearance'>;
/** `unread` is before the first read, `unavailable` is a read that failed. Neither is ever shown as a zero. */
export type TerritoryStatusState = { kind: 'unread' } | { kind: 'unavailable' } | { kind: 'read'; territory: TerritoryStatus | null };

export const territoryExpansionCopy = {
  region: 'Territory',
  intro: 'How much of the territory is left to call, and which states it covers. The worker counts this on its scheduled tick; the numbers are whatever it last counted, never an estimate this screen invented.',
  unread: 'Territory: reading the worker\'s count…',
  unavailable: 'Territory: unknown. The worker\'s research status could not be read.',
  uncounted: 'Territory: unknown. The worker has not counted the territory yet; it counts it on its next scheduled tick.',
  decide: 'David decides the next state when this falls under 30 new firms a morning.',
  states: 'States in the territory',
  addLabel: 'State to add',
  add: 'Add a state',
  addHeld: 'Held: this build\'s desktop bridge does not carry the add-a-state command yet, so the command below was prepared and nothing was sent to the worker. The worker side is ready.',
  zoneRecorded: 'Time zone recorded in this build',
  zoneNotRecorded: 'No time zone recorded in this build',
  nextStep: TERRITORY_ADD_STATE_NEXT_STEP,
  unconfirmed: 'An added state appears in Territory clearance as unconfirmed. Nothing dials for it until you confirm its clearance.',
} as const;

/** Pure. The one line Settings shows for the count, in plain prose with closed numbers. */
export function territoryCountLine(counts: TerritoryCounts): string {
  const firms = counts.listedFirms === 1 ? '1 firm' : `${counts.listedFirms} firms`;
  return `Territory: ${firms}, ${counts.notYetCalled} not yet called, about ${counts.remainingNewPerMorningEstimate} new firms a morning at the current pace`;
}

/**
 * One read of the worker's research status, for the territory block only. It reads once per mount and
 * never polls, and a failure is reported as unavailable rather than as an empty territory.
 */
export function useTerritoryStatus(api?: Api): TerritoryStatusState {
  const status = api?.researchSetup?.status;
  const usable = typeof status === 'function' ? api?.researchSetup : undefined;
  const [state, setState] = useState<TerritoryStatusState>({ kind: 'unread' });
  useEffect(() => {
    if (!usable) { setState({ kind: 'unavailable' }); return; }
    let alive = true;
    setState({ kind: 'unread' });
    void (async () => {
      try {
        const read = researchSetupStatusSchema.parse(await usable.status());
        if (alive) setState({ kind: 'read', territory: read.remote?.territory ?? null });
      } catch {
        if (alive) setState({ kind: 'unavailable' });
      }
    })();
    return () => { alive = false; };
  }, [usable]);
  return state;
}

/**
 * The Territory control (design section 8). It shows how many firms the territory still holds, how many
 * have not been called and how many new firms a morning that is at the current pace, and it lists the
 * states the territory covers. "Add a state" offers every United States postal code and takes the state's
 * time zone from the contract's fixed map: a state that observes two zones is refused by name, because a
 * calling window needs one zone. Adding a state changes no Places region and dials nothing.
 */
export function TerritoryExpansionSection({ status }: { status: TerritoryStatusState }) {
  const [selected, setSelected] = useState('');
  const [decision, setDecision] = useState<TerritoryStateAdditionDecision | null>(null);
  const [prepared, setPrepared] = useState<TerritoryAddStateRequest | null>(null);
  const territory = status.kind === 'read' ? status.territory : null;
  const added = territory?.addedStates ?? [];
  const counts = territory?.counts ?? null;
  const countLine = status.kind === 'unread' ? territoryExpansionCopy.unread
    : status.kind === 'unavailable' ? territoryExpansionCopy.unavailable
      : counts ? territoryCountLine(counts) : territoryExpansionCopy.uncounted;

  const submit = () => {
    const outcome = decideTerritoryStateAddition(selected, added.map(entry => entry.state));
    setDecision(outcome);
    // The command identity is minted once, before anything could be sent, so a retry resends the same command.
    setPrepared(outcome.kind === 'addable'
      ? territoryAddStateRequestSchema.parse({ kind: 'add-state', commandId: crypto.randomUUID(), expectedAddedRevision: territory?.addedRevision ?? 0, state: outcome.state })
      : null);
  };
  return <section className="settings__section territory-expansion" aria-label={territoryExpansionCopy.region}>
    <h2 className="settings__section-title">{territoryExpansionCopy.region}</h2>
    <p>{territoryExpansionCopy.intro}</p>
    <p role="status" className="territory-expansion__count">{countLine}</p>
    {counts && <p className="territory-expansion__decide">{counts.withAuthority} of them are enrolled on the call sequence. {territoryExpansionCopy.decide}</p>}
    <h3>{territoryExpansionCopy.states}</h3>
    <ul className="territory-expansion__states">
      {TERRITORY_STATES.map(state => <li key={state} aria-label={`${US_STATE_NAMES[state]} in the territory`}>
        {US_STATE_NAMES[state]} ({state}) · {TERRITORY_STATE_TIME_ZONES[state]} · in this build
      </li>)}
      {added.map(entry => <li key={entry.state} aria-label={`${US_STATE_NAMES[entry.state]} in the territory`}>
        {US_STATE_NAMES[entry.state]} ({entry.state}) · {entry.timezone} · added {entry.addedAt.slice(0, 10)} · clearance unconfirmed
      </li>)}
    </ul>
    <h3>{territoryExpansionCopy.add}</h3>
    <p>{territoryExpansionCopy.unconfirmed}</p>
    <label className="territory-expansion__picker">
      {territoryExpansionCopy.addLabel}
      {' '}
      <select value={selected} onChange={event => { setSelected(event.target.value); setDecision(null); setPrepared(null); }}>
        <option value="">Choose a state</option>
        <optgroup label={territoryExpansionCopy.zoneRecorded}>
          {TERRITORY_ADDABLE_STATES.map(code => <option key={code} value={code}>{US_STATE_NAMES[code]} ({code})</option>)}
        </optgroup>
        <optgroup label={territoryExpansionCopy.zoneNotRecorded}>
          {US_STATE_CODES.filter(code => !isTerritoryAddableState(code)).map(code => <option key={code} value={code}>{US_STATE_NAMES[code]} ({code})</option>)}
        </optgroup>
      </select>
    </label>
    <div className="settings__row-actions">
      <button type="button" className="settings__action" disabled={selected === ''} onClick={submit}>{territoryExpansionCopy.add}</button>
    </div>
    {decision && <p role="alert" className="territory-expansion__outcome">
      {decision.kind === 'refused' ? decision.message
        : `${decision.name} (${decision.state}) uses ${decision.timezone}. ${territoryExpansionCopy.addHeld} ${territoryExpansionCopy.nextStep}`}
      {prepared ? ` Add-a-state command: ${prepared.commandId}` : ''}
    </p>}
  </section>;
}

/**
 * The Territory pane: the expansion control above the per-state clearance. One read of the worker's
 * status serves both, so the clearance list can show an added state as unconfirmed without a second call.
 */
export function TerritorySettings({ api, localWorkspaceApi }: { api?: Api; localWorkspaceApi?: ClearanceApi }) {
  const status = useTerritoryStatus(api);
  return <>
    <TerritoryExpansionSection status={status} />
    <TerritoryClearanceSection api={localWorkspaceApi} addedStates={status.kind === 'read' ? status.territory?.addedStates ?? [] : []} />
  </>;
}
