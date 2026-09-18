// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerritoryExpansionSection, TerritorySettings, territoryCountLine, territoryExpansionCopy } from './TerritoryExpansionSection';
import { TERRITORY_MULTI_ZONE_STATES, US_STATE_NAMES } from '../../shared/contracts/territoryClearanceContract';
import type { ResearchSetupStatus, TerritoryStatus } from '../../shared/contracts/researchSetupContract';

const NOW = '2026-09-18T14:00:00.000Z';
const counts = { computedAt: NOW, listedFirms: 97, withAuthority: 88, notYetCalled: 61, remainingNewPerMorningEstimate: 12, newFirmsPerDay: 30 };
const territory = (value: Partial<TerritoryStatus> = {}): TerritoryStatus => ({ counts, addedRevision: 0, addedStates: [], ...value });
const remote = (value: TerritoryStatus | null): ResearchSetupStatus => ({ blockers: [], pending: null, remote: {
  workspaceId: 'ws', pairingId: '00000000-0000-4000-8000-000000000001', selector: null, discoveryLedger: null, researchLedger: null,
  descriptor: null, descriptorFingerprint: null, credentialParameterDeclared: true, blockers: [], checkedAt: NOW, receipt: null,
  ...(value ? { territory: value } : {}) } });
const region = () => screen.getByRole('region', { name: territoryExpansionCopy.region });
const count = () => within(region()).getByRole('status').textContent ?? '';
const has = (element: HTMLElement | null, text: string) => expect(element?.textContent ?? '').toContain(text);
const picker = () => screen.getByLabelText(territoryExpansionCopy.addLabel) as HTMLSelectElement;
const addButton = () => screen.getByRole('button', { name: territoryExpansionCopy.add }) as HTMLButtonElement;
const choose = (state: string) => { fireEvent.change(picker(), { target: { value: state } }); fireEvent.click(addButton()); };
afterEach(cleanup);

describe('Territory expansion section', () => {
  it('shows the remaining new firms a morning in one line, with the three built-in states and their zones', () => {
    render(<TerritoryExpansionSection status={{ kind: 'read', territory: territory() }} />);
    expect(count()).toBe('Territory: 97 firms, 61 not yet called, about 12 new firms a morning at the current pace');
    expect(screen.getByText(/88 of them are enrolled on the call sequence/)).toBeTruthy();
    has(within(region()).getByRole('listitem', { name: 'Rhode Island in the territory' }), 'Rhode Island (RI) · America/New_York · in this build');
    has(within(region()).getByRole('listitem', { name: 'Texas in the territory' }), 'Texas (TX) · America/Chicago · in this build');
  });

  it('says unknown rather than zero before the worker has counted, and when the status could not be read', () => {
    render(<TerritoryExpansionSection status={{ kind: 'read', territory: territory({ counts: null }) }} />);
    expect(count()).toBe(territoryExpansionCopy.uncounted);
    cleanup();
    render(<TerritoryExpansionSection status={{ kind: 'unavailable' }} />);
    expect(count()).toBe(territoryExpansionCopy.unavailable);
    cleanup();
    render(<TerritoryExpansionSection status={{ kind: 'unread' }} />);
    expect(count()).toBe(territoryExpansionCopy.unread);
  });

  it('refuses a state that observes two zones, naming both zones', () => {
    render(<TerritoryExpansionSection status={{ kind: 'read', territory: territory() }} />);
    choose('FL');
    const alert = screen.getByRole('alert');
    has(alert, 'Refused: Florida observes two time zones (America/New_York and America/Chicago).');
    has(alert, 'records a firm\'s state but not its county');
    // Every state the contract records as two-zone is offered and refused, never silently accepted.
    for (const state of Object.keys(TERRITORY_MULTI_ZONE_STATES)) {
      expect(within(picker()).getByRole('option', { name: `${US_STATE_NAMES[state as 'FL']} (${state})` })).toBeTruthy();
    }
  });

  it('refuses a state already in the territory and a state whose zone this build does not record', () => {
    render(<TerritoryExpansionSection status={{ kind: 'read', territory: territory() }} />);
    choose('MA');
    has(screen.getByRole('alert'), 'Refused: Massachusetts is already in the territory.');
    choose('CA');
    has(screen.getByRole('alert'), 'Refused: no fixed time zone is recorded for California in this build.');
  });

  it('names the state\'s fixed zone and reports the addition as held rather than as sent', () => {
    render(<TerritoryExpansionSection status={{ kind: 'read', territory: territory() }} />);
    choose('CT');
    const alert = screen.getByRole('alert');
    has(alert, 'Connecticut (CT) uses America/New_York.');
    has(alert, territoryExpansionCopy.addHeld);
    has(alert, 'Add the state\'s regions in Cloud research and press Replace configuration.');
  });

  it('lists a state the worker already recorded and refuses adding it twice', () => {
    const added = [{ state: 'NM' as const, timezone: 'America/Denver' as const, addedAt: NOW, commandId: '00000000-0000-4000-8000-000000000002' }];
    render(<TerritoryExpansionSection status={{ kind: 'read', territory: territory({ addedRevision: 1, addedStates: added }) }} />);
    has(within(region()).getByRole('listitem', { name: 'New Mexico in the territory' }), 'New Mexico (NM) · America/Denver · added 2026-09-18 · clearance unconfirmed');
    choose('NM');
    has(screen.getByRole('alert'), 'Refused: New Mexico is already in the territory.');
  });

  it('paces the one line from the counts alone', () => {
    expect(territoryCountLine({ ...counts, listedFirms: 1, notYetCalled: 0, remainingNewPerMorningEstimate: 0 }))
      .toBe('Territory: 1 firm, 0 not yet called, about 0 new firms a morning at the current pace');
  });
});

describe('the Territory pane', () => {
  it('reads the worker status once and lists an added state as unconfirmed in Territory clearance', async () => {
    const status = vi.fn(async () => remote(territory({ addedRevision: 1,
      addedStates: [{ state: 'CT', timezone: 'America/New_York', addedAt: NOW, commandId: '00000000-0000-4000-8000-000000000003' }] })));
    render(<TerritorySettings api={{ researchSetup: { status } }} />);
    await waitFor(() => expect(count()).toContain('Territory: 97 firms'));
    const row = await screen.findByRole('listitem', { name: 'Connecticut clearance' });
    has(row, 'Unconfirmed · added 2026-09-18');
    has(row, 'cannot be confirmed here yet and nothing dials for it');
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('reports the territory as unavailable when there is no worker bridge, and calls nothing', async () => {
    render(<TerritorySettings />);
    await waitFor(() => expect(screen.getByText(territoryExpansionCopy.unavailable)).toBeTruthy());
    expect(screen.queryByRole('listitem', { name: 'Connecticut clearance' })).toBeNull();
  });
});
