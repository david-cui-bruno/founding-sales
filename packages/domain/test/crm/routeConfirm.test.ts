import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { ROUTE_ELIGIBILITY_POLICY_VERSION } from '../../crm/routePolicy.ts';
import { addPhoneRoute, confirmPhoneRoute, retireRoute } from '../../crm/index.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';

/**
 * "Confirm this number" (lane g88): a person confirms a captured phone number reaches the
 * firm, and the route policy makes it usable.
 *
 * A firm added or imported from the Mac arrives with `candidate` routes (lane g84), and
 * `authorizeDial` step 3 refuses a candidate — so until g88 a freshly added firm could not
 * be called by anyone. The confirmation is the smallest honest way through: the person
 * vouches for the number, the command records who and when, the policy decides, and the
 * version moves so a card showing the old version is refused.
 *
 * **The vacuous-pass trap.** A number added as `salesperson` with a confidence is usable
 * the moment it is added, so a test built on one would pass with no confirmation at all.
 * Every number here is added the way g84's import adds one — `import`, no validation, no
 * confidence — and each assertion starts by requiring it to be a candidate.
 *
 * Numbers are in the NANP 555-01XX fictional block.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;

const contextFor = (workspace: 'alpha' | 'beta', who: 'admin' | 'salesperson'): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded[workspace].workspaceId, { kind: 'user', userId: seeded[workspace][who].userId, role: who }),
    database.session,
  );

async function importedNumber(e164: string, extra: { readonly technicalValidation?: 'failed' } = {}) {
  const added = await addPhoneRoute(contextFor('alpha', 'salesperson'), {
    firmId: crm.alpha.firmId,
    contactId: crm.alpha.contactId,
    e164,
    source: 'import',
    ...extra,
  });
  if (!added.ok) throw new Error(`the route fixture was refused: ${added.reason}`);
  return added.value;
}

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, seeded);
});

afterAll(async () => {
  await database.drop();
});

describe('confirmPhoneRoute', () => {
  it('makes an imported candidate usable under the policy, bumps its version, and records who', async () => {
    const route = await importedNumber('+14015550111');
    expect(route.eligibility).toBe('candidate');
    expect(Number(route.version)).toBe(1);

    const confirmed = await confirmPhoneRoute(contextFor('alpha', 'salesperson'), { routeId: route.id, routeVersion: 1 });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.eligibility).toBe('usable');
    expect(Number(confirmed.value.version)).toBe(2);
    expect(confirmed.value.technical_validation).toBe('passed');
    expect(Number(confirmed.value.association_confidence)).toBe(1);
    expect(confirmed.value.eligibility_policy_version).toBe(ROUTE_ELIGIBILITY_POLICY_VERSION);
    // The source is what it was: a person vouching is not a person having typed it.
    expect(confirmed.value.source).toBe('import');

    const { rows } = await database.session.query<{ actor_user_id: string; detail: Record<string, unknown> }>(
      `SELECT actor_user_id, detail FROM audit_events
        WHERE workspace_id = $1 AND action = 'route.phone.confirmed' AND subject_id = $2`,
      [seeded.alpha.workspaceId, route.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_user_id).toBe(seeded.alpha.salesperson.userId);
    expect(rows[0]?.detail).toMatchObject({ method: 'person_confirmed', fromVersion: 1, version: 2 });
  });

  it('answers a usable number as it is, without another bump', async () => {
    const route = await importedNumber('+14015550112');
    await confirmPhoneRoute(contextFor('alpha', 'salesperson'), { routeId: route.id, routeVersion: 1 });
    const again = await confirmPhoneRoute(contextFor('alpha', 'admin'), { routeId: route.id, routeVersion: 2 });
    expect(again.ok && Number(again.value.version)).toBe(2);
  });

  it('refuses the version the person was not looking at, a retired number and one tested dead', async () => {
    const stale = await importedNumber('+14015550113');
    expect(await confirmPhoneRoute(contextFor('alpha', 'salesperson'), { routeId: stale.id, routeVersion: 3 })).toEqual({
      ok: false,
      reason: 'route_version_stale',
    });

    const retired = await importedNumber('+14015550114');
    await retireRoute(contextFor('alpha', 'salesperson'), { routeKind: 'phone', routeId: retired.id, reason: 'Wrong number' });
    expect(
      await confirmPhoneRoute(contextFor('alpha', 'salesperson'), { routeId: retired.id, routeVersion: 2 }),
    ).toEqual({ ok: false, reason: 'route_retired' });

    const dead = await importedNumber('+14015550115', { technicalValidation: 'failed' });
    expect(dead.eligibility).toBe('invalid');
    expect(await confirmPhoneRoute(contextFor('alpha', 'salesperson'), { routeId: dead.id, routeVersion: 1 })).toEqual({
      ok: false,
      reason: 'route_invalid',
    });
  });

  it('cannot reach another workspace’s number', async () => {
    const route = await importedNumber('+14015550116');
    expect(await confirmPhoneRoute(contextFor('beta', 'admin'), { routeId: route.id, routeVersion: 1 })).toEqual({
      ok: false,
      reason: 'route_unknown',
    });
  });
});
