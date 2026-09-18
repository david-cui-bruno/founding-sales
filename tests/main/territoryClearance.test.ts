import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const electron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: electron }));
import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { listTerritoryClearanceRecords, TerritoryClearanceRepository } from '../../src/main/domain/compliance/territoryClearanceRepository';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { createFounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { registerLocalWorkspaceIpc } from '../../src/main/workspace/registerLocalWorkspaceIpc';
import { createLocalWorkspaceApi } from '../../src/preload/apis/localWorkspaceApi';
import { createIpcClient } from '../../src/preload/ipcClient';
import { TERRITORY_STATE_RULES, type TerritoryClearanceSnapshot, TERRITORY_RULES_REVISION } from '../../src/shared/contracts/territoryClearanceContract';
import type { LocalWorkspaceApi } from '../../src/shared/contracts/localWorkspaceContract';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';

const NOW = '2026-09-18T14:00:00.000Z';
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); });
beforeEach(() => vi.clearAllMocks());
async function fixture() {
  const temp = createTempDatabase(), key = createTestWorkspaceKey(), db = openDatabase({ path: temp.path, key });
  cleanups.push(() => { closeDatabase(db); key.bytes.fill(0); temp.cleanup(); });
  await migrateToLatest(db, { workspaceKey: key, backupDirectory: `${temp.path}.backups` });
  let at = NOW; const clock = { now: () => at };
  const repository = new TerritoryClearanceRepository({ database: db, clock });
  const tables = (database: AppDatabase) => (database.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'territory_clearances' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => ({ name, rows: database.raw.prepare(`SELECT * FROM "${name}"`).all().map(row => JSON.stringify(row)).sort() }));
  return { db, clock, repository, setTime: (value: string) => { at = value; }, otherTables: () => tables(db) };
}
const statesOf = (snapshot: TerritoryClearanceSnapshot) => snapshot.states.map(entry => [entry.state, entry.status, entry.clearance?.revision ?? null]);

describe('TerritoryClearanceRepository', () => {
  it('reads the territory as unconfirmed, confirms every requested state in one transaction with the contract citation and a one-year review, and touches nothing else', async () => {
    const f = await fixture();
    const before = f.otherTables();
    expect(f.repository.read()).toEqual({ generatedAt: NOW, rulesRevision: TERRITORY_RULES_REVISION, states: [
      { state: 'RI', name: 'Rhode Island', timezone: 'America/New_York', status: 'unconfirmed', clearance: null },
      { state: 'MA', name: 'Massachusetts', timezone: 'America/New_York', status: 'unconfirmed', clearance: null },
      { state: 'TX', name: 'Texas', timezone: 'America/Chicago', status: 'unconfirmed', clearance: null },
    ] });
    const confirmed = f.repository.confirm({ states: ['RI', 'MA', 'TX'], disclosureAccepted: true, rulesRevision: TERRITORY_RULES_REVISION });
    expect(statesOf(confirmed)).toEqual([['RI', 'confirmed', 1], ['MA', 'confirmed', 1], ['TX', 'confirmed', 1]]);
    expect(confirmed.states[2].clearance).toEqual({ state: 'TX', revision: 1, timezone: 'America/Chicago', confirmedAt: NOW, reviewAt: '2027-09-18T14:00:00.000Z', revokedAt: null,
      statements: { businessToBusiness: true, registrationStatusChecked: true, stateDncSubscriptionChecked: true, consentRuleConfirmed: true, rulesRevision: TERRITORY_RULES_REVISION }, citation: TERRITORY_STATE_RULES.TX.citation });
    expect(f.db.raw.prepare('SELECT state,revision,timezone,confirmed_at,review_at,revoked_at FROM territory_clearances ORDER BY state').all()).toEqual([
      { state: 'MA', revision: 1, timezone: 'America/New_York', confirmed_at: NOW, review_at: '2027-09-18T14:00:00.000Z', revoked_at: null },
      { state: 'RI', revision: 1, timezone: 'America/New_York', confirmed_at: NOW, review_at: '2027-09-18T14:00:00.000Z', revoked_at: null },
      { state: 'TX', revision: 1, timezone: 'America/Chicago', confirmed_at: NOW, review_at: '2027-09-18T14:00:00.000Z', revoked_at: null },
    ]);
    expect(f.otherTables()).toEqual(before);
    expect(f.db.raw.inTransaction).toBe(false);
    expect(listTerritoryClearanceRecords(f.db)).toEqual([...confirmed.states].sort((a, b) => a.state < b.state ? -1 : 1).map(entry => ({ state: entry.state, revision: 1, timezone: entry.timezone, confirmedAt: NOW, reviewAt: '2027-09-18T14:00:00.000Z', revokedAt: null as string | null })));
  });
  it('re-confirms at the next revision, revokes one state with its expected revision, refuses a stale or repeated revoke, and rolls a partial confirm back', async () => {
    const f = await fixture();
    f.repository.confirm({ states: ['RI'], disclosureAccepted: true, rulesRevision: TERRITORY_RULES_REVISION });
    f.setTime('2026-09-19T09:00:00.000Z');
    expect(statesOf(f.repository.confirm({ states: ['RI', 'MA'], disclosureAccepted: true, rulesRevision: TERRITORY_RULES_REVISION }))).toEqual([['RI', 'confirmed', 2], ['MA', 'confirmed', 1], ['TX', 'unconfirmed', null]]);
    expect(f.repository.read().states[0].clearance).toMatchObject({ confirmedAt: '2026-09-19T09:00:00.000Z', reviewAt: '2027-09-19T09:00:00.000Z' });
    f.setTime('2026-09-20T09:00:00.000Z');
    expect(() => f.repository.revoke({ state: 'RI', expectedRevision: 1 })).toThrow('TERRITORY_CLEARANCE_STALE');
    expect(statesOf(f.repository.revoke({ state: 'RI', expectedRevision: 2 }))).toEqual([['RI', 'revoked', 3], ['MA', 'confirmed', 1], ['TX', 'unconfirmed', null]]);
    expect(f.repository.read().states[0].clearance).toMatchObject({ revision: 3, revokedAt: '2026-09-20T09:00:00.000Z', confirmedAt: '2026-09-19T09:00:00.000Z' });
    expect(() => f.repository.revoke({ state: 'RI', expectedRevision: 3 })).toThrow('TERRITORY_CLEARANCE_STALE');
    expect(() => f.repository.revoke({ state: 'TX', expectedRevision: 1 })).toThrow('TERRITORY_CLEARANCE_STALE');
    expect(listTerritoryClearanceRecords(f.db).map(entry => [entry.state, entry.revokedAt])).toEqual([['MA', null], ['RI', '2026-09-20T09:00:00.000Z']]);
    // Re-confirming a revoked state clears the revocation at the next revision.
    expect(statesOf(f.repository.confirm({ states: ['RI'], disclosureAccepted: true, rulesRevision: TERRITORY_RULES_REVISION }))).toEqual([['RI', 'confirmed', 4], ['MA', 'confirmed', 1], ['TX', 'unconfirmed', null]]);
    // A state outside the territory map is refused, and the states before it in the same request are rolled back.
    const rows = f.db.raw.prepare('SELECT * FROM territory_clearances ORDER BY state').all();
    expect(() => f.repository.confirm({ states: ['TX', 'CT'], disclosureAccepted: true, rulesRevision: TERRITORY_RULES_REVISION })).toThrow('TERRITORY_STATE_NOT_LISTED:CT');
    expect(f.db.raw.prepare('SELECT * FROM territory_clearances ORDER BY state').all()).toEqual(rows);
    expect(f.db.raw.inTransaction).toBe(false);
  });
  it('reports review_due once the review date passes and refuses to confirm without the disclosure or with another rules revision', async () => {
    const f = await fixture();
    f.repository.confirm({ states: ['MA'], disclosureAccepted: true, rulesRevision: TERRITORY_RULES_REVISION });
    f.setTime('2027-09-18T14:00:00.000Z');
    expect(statesOf(f.repository.read())).toEqual([['RI', 'unconfirmed', null], ['MA', 'review_due', 1], ['TX', 'unconfirmed', null]]);
    expect(() => f.repository.confirm({ states: ['RI'], disclosureAccepted: false as never, rulesRevision: TERRITORY_RULES_REVISION })).toThrow();
    expect(() => f.repository.confirm({ states: ['RI'], disclosureAccepted: true, rulesRevision: TERRITORY_RULES_REVISION + 1 as never })).toThrow();
    expect(f.db.raw.prepare('SELECT COUNT(*) AS count FROM territory_clearances').get()).toEqual({ count: 1 });
  });
  it('drops a malformed stored row from the read and the authorization records instead of repairing it', async () => {
    const f = await fixture();
    f.repository.confirm({ states: ['RI', 'TX'], disclosureAccepted: true, rulesRevision: TERRITORY_RULES_REVISION });
    f.db.raw.prepare("UPDATE territory_clearances SET revision=2, timezone='Mars/Olympus' WHERE state='TX'").run();
    expect(statesOf(f.repository.read())).toEqual([['RI', 'confirmed', 1], ['MA', 'unconfirmed', null], ['TX', 'unconfirmed', null]]);
    expect(listTerritoryClearanceRecords(f.db).map(entry => entry.state)).toEqual(['RI']);
  });
  it('is reachable through the real domain facade', async () => {
    const f = await fixture();
    const services = createDomainServices({ database: f.db, clock: f.clock, ids: { next: randomUUID } });
    const domain = createFounderSalesDomain({ database: f.db, clock: f.clock, ids: { next: randomUUID }, services });
    expect(statesOf(domain.confirmTerritoryClearance({ states: ['RI'], disclosureAccepted: true, rulesRevision: TERRITORY_RULES_REVISION }))).toEqual([['RI', 'confirmed', 1], ['MA', 'unconfirmed', null], ['TX', 'unconfirmed', null]]);
    expect(statesOf(domain.revokeTerritoryClearance({ state: 'RI', expectedRevision: 1 }))).toEqual([['RI', 'revoked', 2], ['MA', 'unconfirmed', null], ['TX', 'unconfirmed', null]]);
  });
});

describe('territory clearance IPC channels', () => {
  const trusted = { senderFrame: { url: 'callie://app/index.html' } };
  const unavailable = async (): Promise<never> => { throw new Error('unavailable in this fixture'); };
  const base = { prepareCompanyDraft: unavailable, admitCompanyDraftEmail: unavailable, openCompanyDraft: unavailable, getCompanyDraft: unavailable, saveCompanyDraft: unavailable, getCompanyResearchSettings: unavailable, updateCompanyResearchSettings: unavailable,
    getCallSettings: unavailable, updateCallSettings: unavailable, linkCompanyPerson: unavailable, researchCompany: unavailable, getCompanyResearchStatus: unavailable, getCompany: unavailable, reviewCompany: unavailable, createCompany: unavailable,
    getCompanyCreateStatus: unavailable, get: unavailable, getCommitments: unavailable, transition: unavailable } satisfies LocalWorkspaceApi;
  it('roundtrips read, confirm and revoke through the preload namespace, validates both boundaries, and appends the three channels last', async () => {
    const f = await fixture();
    const provider: LocalWorkspaceApi = { ...base, readTerritoryClearance: async () => f.repository.read(), confirmTerritoryClearance: async input => f.repository.confirm(input), revokeTerritoryClearance: async input => f.repository.revoke(input) };
    const remove = registerLocalWorkspaceIpc(provider);
    try {
      expect(electron.handle.mock.calls.slice(-3).map(call => call[0])).toEqual(['local-workspace:territory-clearance-read', 'local-workspace:territory-clearance-confirm', 'local-workspace:territory-clearance-revoke']);
      const invoke = vi.fn(async (channel: string, ...args: unknown[]) => registeredIpcHandler(electron.handle, channel)(trusted, ...args));
      const api = createLocalWorkspaceApi(createIpcClient({ invoke }));
      expect(statesOf(await api.readTerritoryClearance!())).toEqual([['RI', 'unconfirmed', null], ['MA', 'unconfirmed', null], ['TX', 'unconfirmed', null]]);
      expect(invoke).toHaveBeenLastCalledWith('local-workspace:territory-clearance-read');
      expect(statesOf(await api.confirmTerritoryClearance!({ states: ['RI', 'MA', 'TX'], disclosureAccepted: true, rulesRevision: TERRITORY_RULES_REVISION }))).toEqual([['RI', 'confirmed', 1], ['MA', 'confirmed', 1], ['TX', 'confirmed', 1]]);
      expect(statesOf(await api.revokeTerritoryClearance!({ state: 'MA', expectedRevision: 1 }))).toEqual([['RI', 'confirmed', 1], ['MA', 'revoked', 2], ['TX', 'confirmed', 1]]);
      // Renderer-side validation refuses what the contract refuses before anything crosses the bridge.
      const calls = invoke.mock.calls.length;
      await expect(api.confirmTerritoryClearance!({ states: ['RI'], disclosureAccepted: false, rulesRevision: TERRITORY_RULES_REVISION } as never)).rejects.toThrow();
      await expect(api.confirmTerritoryClearance!({ states: ['RI'], disclosureAccepted: true, rulesRevision: TERRITORY_RULES_REVISION + 1 } as never)).rejects.toThrow();
      await expect(api.revokeTerritoryClearance!({ state: 'MA', expectedRevision: 0 })).rejects.toThrow();
      expect(invoke).toHaveBeenCalledTimes(calls);
      // Main-side: arity, sender and provider failures surface only as the safe code.
      const read = registeredIpcHandler(electron.handle, 'local-workspace:territory-clearance-read');
      await expect(read(trusted, {})).rejects.toThrow();
      await expect(read({ senderFrame: { url: 'https://evil.invalid' } })).rejects.toThrow();
      const revoke = registeredIpcHandler(electron.handle, 'local-workspace:territory-clearance-revoke');
      await expect(revoke(trusted, { state: 'MA', expectedRevision: 2 })).rejects.toThrow(/^LOCAL_TERRITORY_CLEARANCE_REVOKE_FAILED$/);
      await expect(revoke(trusted, { state: 'MA', expectedRevision: 2 }, {})).rejects.toThrow();
      const confirm = registeredIpcHandler(electron.handle, 'local-workspace:territory-clearance-confirm');
      await expect(confirm(trusted, { states: ['CT'], disclosureAccepted: true, rulesRevision: TERRITORY_RULES_REVISION })).rejects.toThrow(/^LOCAL_TERRITORY_CLEARANCE_CONFIRM_FAILED$/);
    } finally { remove(); }
    expect(electron.removeHandler.mock.calls.slice(0, 3).map(call => call[0])).toEqual(['local-workspace:territory-clearance-revoke', 'local-workspace:territory-clearance-confirm', 'local-workspace:territory-clearance-read']);
  });
  it('reports the safe code when a build has no territory clearance provider or the provider lies about the outcome', async () => {
    const remove = registerLocalWorkspaceIpc({ ...base, confirmTerritoryClearance: async () => ({ generatedAt: NOW, rulesRevision: TERRITORY_RULES_REVISION, states: [{ state: 'RI', name: 'Rhode Island', timezone: 'America/New_York', status: 'unconfirmed', clearance: null }] }) });
    try {
      await expect(registeredIpcHandler(electron.handle, 'local-workspace:territory-clearance-read')(trusted)).rejects.toThrow(/^LOCAL_TERRITORY_CLEARANCE_READ_FAILED$/);
      await expect(registeredIpcHandler(electron.handle, 'local-workspace:territory-clearance-revoke')(trusted, { state: 'RI', expectedRevision: 1 })).rejects.toThrow(/^LOCAL_TERRITORY_CLEARANCE_REVOKE_FAILED$/);
      await expect(registeredIpcHandler(electron.handle, 'local-workspace:territory-clearance-confirm')(trusted, { states: ['RI'], disclosureAccepted: true, rulesRevision: TERRITORY_RULES_REVISION })).rejects.toThrow(/^LOCAL_TERRITORY_CLEARANCE_CONFIRM_FAILED$/);
    } finally { remove(); }
  });
});
