// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerritoryClearanceSection } from './TerritoryClearanceSection';
import { TERRITORY_CLEARANCE_STATEMENTS, TERRITORY_FEDERAL_CITATIONS, TERRITORY_STATE_RULES, territoryReviewAt,
  type ConfirmTerritoryClearance, type RevokeTerritoryClearance, type TerritoryClearance, type TerritoryClearanceSnapshot, type TerritoryStateView, TERRITORY_RULES_REVISION } from '../../shared/contracts/territoryClearanceContract';

const NOW = '2026-09-18T14:00:00.000Z';
const NAMES = { RI: 'Rhode Island', MA: 'Massachusetts', TX: 'Texas' } as const;
const ZONES = { RI: 'America/New_York', MA: 'America/New_York', TX: 'America/Chicago' } as const;
/** An in-memory twin of the repository: one revisioned row per state, confirm bumps, revoke bumps and marks. */
function fixture(initial: Partial<Record<keyof typeof NAMES, TerritoryClearance>> = {}) {
  const rows = new Map<string, TerritoryClearance>(Object.entries(initial));
  let at = NOW;
  const view = (state: keyof typeof NAMES): TerritoryStateView => {
    const clearance = rows.get(state) ?? null;
    return { state, name: NAMES[state], timezone: ZONES[state], clearance, status: !clearance ? 'unconfirmed' : clearance.revokedAt ? 'revoked' : clearance.reviewAt <= at ? 'review_due' : 'confirmed' };
  };
  const snapshot = (): TerritoryClearanceSnapshot => ({ generatedAt: at, rulesRevision: TERRITORY_RULES_REVISION, states: (['RI', 'MA', 'TX'] as const).map(view) });
  const api = {
    readTerritoryClearance: vi.fn(async () => snapshot()),
    confirmTerritoryClearance: vi.fn(async (input: ConfirmTerritoryClearance) => {
      for (const state of input.states) {
        const previous = rows.get(state);
        rows.set(state, { state, revision: (previous?.revision ?? 0) + 1, timezone: ZONES[state as keyof typeof ZONES], confirmedAt: at, reviewAt: territoryReviewAt(at), revokedAt: null,
          statements: { businessToBusiness: true, registrationStatusChecked: true, stateDncSubscriptionChecked: true, consentRuleConfirmed: true, rulesRevision: TERRITORY_RULES_REVISION }, citation: TERRITORY_STATE_RULES[state as keyof typeof NAMES].citation });
      }
      return snapshot();
    }),
    revokeTerritoryClearance: vi.fn(async (input: RevokeTerritoryClearance) => {
      const row = rows.get(input.state);
      if (!row || row.revision !== input.expectedRevision) throw new Error('TERRITORY_CLEARANCE_STALE');
      rows.set(input.state, { ...row, revision: row.revision + 1, revokedAt: at });
      return snapshot();
    }),
  };
  return { api, rows, setTime: (value: string) => { at = value; } };
}
const state = (name: string) => screen.getByRole('listitem', { name: `${name} clearance` });
const confirmButton = () => screen.getByRole('button', { name: 'Confirm for all listed states' }) as HTMLButtonElement;
const disclosure = () => screen.getByRole('checkbox') as HTMLInputElement;
async function ready() { await waitFor(() => expect(disclosure().disabled).toBe(false)); }
afterEach(cleanup);

describe('Territory clearance section', () => {
  it('shows the statements once, the federal citations, and each listed state as unconfirmed with its summary and citation', async () => {
    const f = fixture(); render(<TerritoryClearanceSection api={f.api} />); await ready();
    for (const text of Object.values(TERRITORY_CLEARANCE_STATEMENTS)) expect(screen.getAllByText(text)).toHaveLength(1);
    for (const citation of TERRITORY_FEDERAL_CITATIONS) expect(screen.getByRole('link', { name: citation.title }).getAttribute('href')).toBe(citation.url);
    for (const key of ['RI', 'MA', 'TX'] as const) {
      const item = state(NAMES[key]);
      expect(within(item).getByText(/Unconfirmed/)).toBeTruthy();
      expect(within(item).getByText(TERRITORY_STATE_RULES[key].summary)).toBeTruthy();
      expect(within(item).getByText(TERRITORY_STATE_RULES[key].citation.quote)).toBeTruthy();
      expect(within(item).getByRole('link', { name: TERRITORY_STATE_RULES[key].citation.title }).getAttribute('href')).toBe(TERRITORY_STATE_RULES[key].citation.url);
      expect(within(item).getByText(ZONES[key])).toBeTruthy();
      expect(within(item).queryByRole('button')).toBeNull();
    }
    expect(f.api.confirmTerritoryClearance).not.toHaveBeenCalled(); expect(f.api.revokeTerritoryClearance).not.toHaveBeenCalled();
    expect(confirmButton().disabled).toBe(true);
  });
  it('confirms every listed state with one click only after the disclosure, then shows revision, dates and a per-state Revoke', async () => {
    const f = fixture(); render(<TerritoryClearanceSection api={f.api} />); await ready();
    fireEvent.click(confirmButton()); expect(f.api.confirmTerritoryClearance).not.toHaveBeenCalled();
    fireEvent.click(disclosure()); expect(confirmButton().disabled).toBe(false);
    fireEvent.click(confirmButton());
    await screen.findByText('Confirmation recorded.');
    expect(f.api.confirmTerritoryClearance).toHaveBeenCalledTimes(1);
    expect(f.api.confirmTerritoryClearance).toHaveBeenCalledWith({ states: ['RI', 'MA', 'TX'], disclosureAccepted: true, rulesRevision: TERRITORY_RULES_REVISION });
    for (const key of ['RI', 'MA', 'TX'] as const) {
      const item = state(NAMES[key]);
      expect(within(item).getByText(/Confirmed · revision 1 · confirmed 2026-09-18 · review 2027-09-18/)).toBeTruthy();
      expect(within(item).getByRole('button', { name: `Revoke ${key}` })).toBeTruthy();
    }
    expect(disclosure().checked).toBe(false); expect(confirmButton().disabled).toBe(true);
  });
  it('revokes one state with its expected revision, leaves the others confirmed, and re-confirms it at the next revision', async () => {
    const f = fixture(); render(<TerritoryClearanceSection api={f.api} />); await ready();
    fireEvent.click(disclosure()); fireEvent.click(confirmButton()); await screen.findByText('Confirmation recorded.');
    f.setTime('2026-09-19T09:00:00.000Z');
    fireEvent.click(within(state('Massachusetts')).getByRole('button', { name: 'Revoke MA' }));
    await screen.findByText('Revocation for MA recorded.');
    expect(f.api.revokeTerritoryClearance).toHaveBeenCalledWith({ state: 'MA', expectedRevision: 1 });
    expect(within(state('Massachusetts')).getByText(/Revoked · revision 2 · revoked 2026-09-19/)).toBeTruthy();
    expect(within(state('Massachusetts')).queryByRole('button')).toBeNull();
    expect(within(state('Rhode Island')).getByText(/Confirmed · revision 1/)).toBeTruthy();
    expect(within(state('Texas')).getByRole('button', { name: 'Revoke TX' })).toBeTruthy();
    fireEvent.click(disclosure()); fireEvent.click(confirmButton()); await screen.findByText('Confirmation recorded.');
    expect(within(state('Massachusetts')).getByText(/Confirmed · revision 3 · confirmed 2026-09-19 · review 2027-09-19/)).toBeTruthy();
    expect(within(state('Rhode Island')).getByText(/Confirmed · revision 2/)).toBeTruthy();
  });
  it('shows a state that arrived already confirmed and a review that fell due, and keeps a lost reply unknown', async () => {
    const stale: TerritoryClearance = { state: 'TX', revision: 4, timezone: 'America/Chicago', confirmedAt: '2025-09-01T12:00:00.000Z', reviewAt: '2026-09-01T12:00:00.000Z', revokedAt: null,
      statements: { businessToBusiness: true, registrationStatusChecked: true, stateDncSubscriptionChecked: true, consentRuleConfirmed: true, rulesRevision: TERRITORY_RULES_REVISION }, citation: TERRITORY_STATE_RULES.TX.citation };
    const f = fixture({ TX: stale }); render(<TerritoryClearanceSection api={f.api} />); await ready();
    expect(within(state('Texas')).getByText(/Review due · revision 4 · confirmed 2025-09-01 · review 2026-09-01/)).toBeTruthy();
    f.api.confirmTerritoryClearance.mockRejectedValueOnce(new Error('private database path'));
    fireEvent.click(disclosure()); fireEvent.click(confirmButton());
    await screen.findByText(/Confirmation outcome unknown\. Review the current record before another change\./);
    expect(screen.queryByText(/private database/)).toBeNull();
    expect(f.api.readTerritoryClearance).toHaveBeenCalledTimes(2);
    expect(within(state('Texas')).getByText(/Review due · revision 4/)).toBeTruthy();
  });
  it('is unavailable without the three methods and never calls a partial API', async () => {
    const f = fixture();
    const { rerender } = render(<TerritoryClearanceSection />);
    expect(screen.getByRole('status').textContent).toBe('Territory clearance is unavailable.');
    expect(confirmButton().disabled).toBe(true); expect(disclosure().disabled).toBe(true);
    rerender(<TerritoryClearanceSection api={{ readTerritoryClearance: f.api.readTerritoryClearance }} />);
    expect(screen.getByRole('status').textContent).toBe('Territory clearance is unavailable.');
    expect(f.api.readTerritoryClearance).not.toHaveBeenCalled();
    f.api.readTerritoryClearance.mockRejectedValueOnce(new Error('private read'));
    rerender(<TerritoryClearanceSection api={f.api} />);
    await screen.findByText('Territory clearance is unavailable.');
    expect(screen.queryByText(/private read/)).toBeNull();
  });
});
