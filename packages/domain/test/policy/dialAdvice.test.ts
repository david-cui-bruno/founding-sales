import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { retireRoute } from '../../crm/index.ts';
import { adviseDial } from '../../dial/index.ts';
import { openPause, revokeStatePosture } from '../../policy/index.ts';
import { recordSuppression, recordingSuppressionJournal } from '../../suppression/index.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedPolicy, type SeededPolicy } from '../db/support/policyFixtures.ts';

/**
 * `adviseDial` (wave 2, S4.5): callable yes or no, with every reason that applies.
 *
 * **The vacuous-pass traps.** An adviser that always said yes would pass the first case
 * alone, and one that stopped at the first reason would pass each single-cause case. So
 * the allow is asserted with its number and URI, each cause is asserted on its own, and
 * two causes at once must both be named. Every case runs in a transaction rolled back
 * afterwards, so no cause leaks into the next.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let policy: SeededPolicy;

const contextFor = (workspace: 'alpha' | 'beta', who: 'admin' | 'salesperson'): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded[workspace].workspaceId, { kind: 'user', userId: seeded[workspace][who].userId, role: who }),
    database.session,
  );
const salesperson = (): RepositoryContext => contextFor('alpha', 'salesperson');

const advise = async (overrides: { readonly routeId?: string; readonly at?: string } = {}) =>
  await adviseDial(salesperson(), {
    firmId: crm.alpha.firmId,
    routeId: overrides.routeId ?? policy.alpha.phoneRouteId,
    at: overrides.at ?? policy.insideWindow,
  });

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, seeded);
  policy = await seedPolicy(database.session, seeded, crm);
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await database.session.query('BEGIN');
  return async () => {
    await database.session.query('ROLLBACK');
  };
});

describe('adviseDial', () => {
  it('says callable, with the number and the URI the Mac opens, when nothing stands in the way', async () => {
    expect(await advise()).toMatchObject({
      firmId: crm.alpha.firmId,
      callable: true,
      reasons: [],
      routeId: policy.alpha.phoneRouteId,
      e164: policy.alpha.e164,
      telUri: `tel:${policy.alpha.e164}`,
      firmTimeZone: 'America/New_York',
      firmLocalTime: '10:00',
      at: policy.insideWindow,
    });
    // Without a number it answers about the firm alone.
    expect(await adviseDial(salesperson(), { firmId: crm.alpha.firmId, at: policy.insideWindow })).toMatchObject({
      callable: true,
      routeId: null,
      telUri: null,
    });
  });

  it('names every reason at once: outside the window and a state off the list', async () => {
    expect((await revokeStatePosture(contextFor('alpha', 'admin'), { postureId: policy.alpha.postureId })).ok).toBe(true);
    const advice = await advise({ at: policy.outsideWindow });
    expect(advice?.callable).toBe(false);
    expect(advice?.reasons).toEqual(['posture_missing', 'outside_calling_window']);
  });

  it('says a suppressed firm is not callable, as do-not-call records it', async () => {
    const recorded = await recordSuppression(salesperson(), {
      scope: 'firm',
      firmId: crm.alpha.firmId,
      source: 'prospect_do_not_call',
      journal: recordingSuppressionJournal(),
    });
    expect(recorded.ok).toBe(true);
    expect(await advise()).toMatchObject({ callable: false, reasons: ['firm_suppressed'] });
  });

  it('says a retired number or one that is not this firm’s is not callable, and gives no URI for it', async () => {
    const retired = await retireRoute(salesperson(), {
      routeKind: 'phone',
      routeId: policy.alpha.phoneRouteId,
      reason: 'Wrong number',
    });
    expect(retired.ok).toBe(true);
    expect(await advise()).toMatchObject({ callable: false, reasons: ['route_retired'], telUri: null });
    expect(await advise({ routeId: policy.beta.phoneRouteId })).toMatchObject({
      callable: false,
      reasons: ['route_missing'],
      routeId: null,
    });
  });

  it('dials a number an older release stored as a candidate', async () => {
    const { rows } = await database.session.query<{ id: string }>(
      `INSERT INTO phone_routes (workspace_id, firm_id, e164, source, retrieved_at)
       VALUES ($1, $2, '+14015550187', 'import', now()) RETURNING id`,
      [seeded.alpha.workspaceId, crm.alpha.firmId],
    );
    expect(await advise({ routeId: rows[0]?.id ?? '' })).toMatchObject({ callable: true, telUri: 'tel:+14015550187' });
  });

  it('names an open pause of the call channel by its own reason', async () => {
    const paused = await openPause(contextFor('alpha', 'admin'), { scopeKind: 'channel', channel: 'call' });
    expect(paused.ok).toBe(true);
    expect(await advise()).toMatchObject({ callable: false, reasons: ['scoped_pause'] });
  });

  it('answers nothing about a firm the caller may not see', async () => {
    expect(await adviseDial(contextFor('alpha', 'salesperson'), { firmId: crm.beta.firmId })).toBeNull();
  });
});
