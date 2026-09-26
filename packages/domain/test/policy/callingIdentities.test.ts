import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import {
  authorizeDial,
  currentCallingIdentityId,
  disableCallingIdentity,
  listOwnCallingIdentities,
  normalizeCallingNumber,
  registerCallingIdentity,
  verifyCallingIdentity,
} from '../../dial/index.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedPolicy, type SeededPolicy } from '../db/support/policyFixtures.ts';

/**
 * Calling identities: register, attest, retire (specification 9.1; lane g60). Since
 * wave 2 (S4.3) registering is the attestation, and a number an older release left
 * unattested is usable as it stands; the attest command stays for desktop 1.0.11.
 *
 * Until this lane nothing inserted a `calling_identities` row or verified one, so no
 * salesperson could be authorized to dial and the restore drill's dial probe had no
 * subject. Everything here runs through the **application role**, because the grant
 * is part of what production needs and a superuser test cannot see it.
 *
 * ## The vacuous-pass traps, named
 *
 *   * *An attestation that recorded nothing.* `verified` alone would satisfy a test
 *     that only asked `authorizeDial`. So the row is read back and the who, how and
 *     when are asserted, and migration 0016's CHECK refuses a verified row without
 *     them (`constraints.test.ts`).
 *   * *A register that returned `existing` without inserting.* Idempotence assertions
 *     pass against a function that never writes. So the first case asserts `created`
 *     and counts the row and its audit event.
 *   * *A retirement that deleted.* `authorizeDial` would refuse a deleted identity too
 *     (`identity_missing`), so the refusal alone proves nothing about history: the row
 *     and the call log that references it are counted afterwards.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let policy: SeededPolicy;
let runtime: SessionQueryable;

const contextFor = (workspaceId: string, userId: string, role: 'admin' | 'salesperson'): RepositoryContext =>
  repositoryContext(workspaceScope(workspaceId, { kind: 'user', userId, role }), runtime);
const salesperson = (): RepositoryContext =>
  contextFor(seeded.alpha.workspaceId, seeded.alpha.salesperson.userId, 'salesperson');
const admin = (): RepositoryContext => contextFor(seeded.alpha.workspaceId, seeded.alpha.admin.userId, 'admin');
const worker = (): RepositoryContext =>
  repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), runtime);

async function countOf(sql: string, values: readonly unknown[] = []): Promise<number> {
  const { rows } = await database.session.query<{ count: string }>(sql, values);
  return Number(rows[0]?.count ?? '0');
}

/** A further member of alpha, active or not, who owns nothing yet. */
async function aMember(role: 'admin' | 'salesperson', status: 'active' | 'inactive' = 'active'): Promise<string> {
  const user = await database.session.query<{ id: string }>(
    "INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, 'Another Member') RETURNING id",
    [`sub-${randomUUID()}`, `member-${randomUUID()}@example.test`],
  );
  const userId = user.rows[0]?.id ?? '';
  await database.session.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role, status, deactivated_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'inactive' THEN now() ELSE NULL END)`,
    [seeded.alpha.workspaceId, userId, role, status],
  );
  return userId;
}

/** A number as an older release registered it: unverified, not enabled, not retired. */
async function unattestedRow(ownerUserId: string, e164: string): Promise<string> {
  const { rows } = await database.session.query<{ id: string }>(
    'INSERT INTO calling_identities (workspace_id, owner_user_id, e164) VALUES ($1, $2, $3) RETURNING id',
    [seeded.alpha.workspaceId, ownerUserId, e164],
  );
  return rows[0]?.id ?? '';
}

const dialWith = (callingIdentityId: string): Parameters<typeof authorizeDial>[1] => ({
  firmId: crm.alpha.firmId,
  contactId: crm.alpha.contactId,
  routeId: policy.alpha.phoneRouteId,
  routeVersion: policy.alpha.phoneRouteVersion,
  callingIdentityId,
  at: policy.insideWindow,
});

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, seeded);
  policy = await seedPolicy(database.session, seeded, crm);
  runtime = await database.appRuntimeSession();
}, 180_000);

afterAll(async () => {
  await database?.drop();
});

describe('normalizeCallingNumber', () => {
  it('takes E.164 with the formatting a person types, and drops the formatting', () => {
    expect(normalizeCallingNumber('+14015550131')).toEqual({ ok: true, e164: '+14015550131' });
    expect(normalizeCallingNumber('  +1 (401) 555-0131 ')).toEqual({ ok: true, e164: '+14015550131' });
    expect(normalizeCallingNumber('+1.401.555.0131')).toEqual({ ok: true, e164: '+14015550131' });
    expect(normalizeCallingNumber('+44 20 7946 0958')).toEqual({ ok: true, e164: '+442079460958' });
    // A pasted non-breaking space is a space after NFKC.
    expect(normalizeCallingNumber('+1\u00a0401\u00a0555\u00a00131')).toEqual({ ok: true, e164: '+14015550131' });
  });

  it('assumes no country and refuses what the table would refuse', () => {
    for (const value of [
      '',
      '4015550131',
      '14015550131',
      '+04015550131',
      '+1234567',
      '+1234567890123456',
      '+1 401 555 0131 ext 5',
      '+1\n4015550131',
      'tel:+14015550131',
      '++14015550131',
    ]) {
      expect(normalizeCallingNumber(value), JSON.stringify(value)).toEqual({ ok: false, reason: 'number_invalid' });
    }
  });
});

describe('registerCallingIdentity', () => {
  it('creates the owner’s number attested, once, audits it, and the dial is authorized with it at once', async () => {
    const created = await registerCallingIdentity(salesperson(), { e164: '+1 401 555 0131', label: '  Mobile ' });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) return;
    expect(created.value.outcome).toBe('created');
    expect(created.value.identity).toMatchObject({
      ownerUserId: seeded.alpha.salesperson.userId,
      e164: '+14015550131',
      label: 'Mobile',
      verificationStatus: 'verified',
      enabled: true,
      verifiedByUserId: seeded.alpha.salesperson.userId,
      verificationMethod: 'owner_attestation',
      disabledAt: null,
      usedForCalls: true,
    });
    expect(created.value.identity.verifiedAt).not.toBeNull();
    // Read back from the table: the who, how and when 0016's CHECK requires.
    const stored = await database.session.query<{ verification_status: string; enabled: boolean; verified: boolean }>(
      'SELECT verification_status, enabled, verified_at IS NOT NULL AS verified FROM calling_identities WHERE id = $1',
      [created.value.identity.id],
    );
    expect(stored.rows[0]).toEqual({ verification_status: 'verified', enabled: true, verified: true });
    expect(await countOf("SELECT count(*)::text AS count FROM calling_identities WHERE e164 = '+14015550131'")).toBe(1);
    expect(
      await countOf(
        "SELECT count(*)::text AS count FROM audit_events WHERE action = 'calling_identity.registered' AND subject_id = $1",
        [created.value.identity.id],
      ),
    ).toBe(1);
    // The audit detail never carries the number: it is the salesperson's own data.
    const detail = await database.session.query<{ detail: string }>(
      "SELECT detail::text AS detail FROM audit_events WHERE action = 'calling_identity.registered' AND subject_id = $1",
      [created.value.identity.id],
    );
    expect(detail.rows[0]?.detail).not.toContain('5550131');

    // No separate attestation before a dial (wave 2, S4.3).
    expect(await authorizeDial(salesperson(), dialWith(created.value.identity.id))).toMatchObject({
      allowed: true,
      evidence: { callingIdentityId: created.value.identity.id },
    });
  });

  it('dials from a number an older release registered and nobody attested, and a registration attests it', async () => {
    const id = await unattestedRow(seeded.alpha.salesperson.userId, '+14015550140');
    expect(await authorizeDial(salesperson(), dialWith(id))).toMatchObject({ allowed: true });
    expect(await currentCallingIdentityId(salesperson(), seeded.alpha.salesperson.userId)).toBe(id);

    const registered = await registerCallingIdentity(salesperson(), { e164: '+14015550140' });
    expect(registered).toMatchObject({
      ok: true,
      value: { outcome: 'verified', identity: { id, verificationStatus: 'verified', enabled: true } },
    });
  });

  it('is idempotent on the workspace and the number, however it is spelled, and never moves it', async () => {
    const again = await registerCallingIdentity(salesperson(), { e164: '+14015550131', label: 'Desk' });
    expect(again).toMatchObject({ ok: true, value: { outcome: 'existing', identity: { label: 'Mobile' } } });
    expect(await countOf("SELECT count(*)::text AS count FROM calling_identities WHERE e164 = '+14015550131'")).toBe(1);

    // The admin cannot take it by registering it for themselves.
    expect(await registerCallingIdentity(admin(), { e164: '+1-401-555-0131' })).toEqual({
      ok: false,
      reason: 'number_registered_to_another',
    });
    // The same number in the other workspace is a different row (section 6).
    const beta = await registerCallingIdentity(
      contextFor(seeded.beta.workspaceId, seeded.beta.salesperson.userId, 'salesperson'),
      { e164: '+14015550131' },
    );
    expect(beta).toMatchObject({ ok: true, value: { outcome: 'created' } });
  });

  it('refuses a malformed number or label with its own reason and writes nothing', async () => {
    const before = await countOf('SELECT count(*)::text AS count FROM calling_identities');
    expect(await registerCallingIdentity(salesperson(), { e164: '401-555-0132' })).toEqual({
      ok: false,
      reason: 'number_invalid',
    });
    expect(await registerCallingIdentity(salesperson(), { e164: '+14015550132', label: 'x'.repeat(81) })).toEqual({
      ok: false,
      reason: 'label_invalid',
    });
    expect(await registerCallingIdentity(salesperson(), { e164: '+14015550132', label: 'Mobile\u0007' })).toEqual({
      ok: false,
      reason: 'label_invalid',
    });
    expect(await countOf('SELECT count(*)::text AS count FROM calling_identities')).toBe(before);
    // A blank label is no label, not a refusal.
    const blank = await registerCallingIdentity(salesperson(), { e164: '+14015550132', label: '   ' });
    expect(blank).toMatchObject({ ok: true, value: { identity: { label: null } } });
  });

  it('lets a person register only their own number, and an admin any active member’s', async () => {
    expect(
      await registerCallingIdentity(salesperson(), { e164: '+14015550133', ownerUserId: seeded.alpha.admin.userId }),
    ).toEqual({ ok: false, reason: 'admin_only' });
    expect(await registerCallingIdentity(worker(), { e164: '+14015550133' })).toEqual({ ok: false, reason: 'admin_only' });

    const inactive = await aMember('salesperson', 'inactive');
    expect(await registerCallingIdentity(admin(), { e164: '+14015550133', ownerUserId: inactive })).toEqual({
      ok: false,
      reason: 'owner_not_member',
    });
    // A member of the other workspace is not a member of this one.
    expect(
      await registerCallingIdentity(admin(), { e164: '+14015550133', ownerUserId: seeded.beta.salesperson.userId }),
    ).toEqual({ ok: false, reason: 'owner_not_member' });

    const onBehalf = await registerCallingIdentity(admin(), {
      e164: '+14015550133',
      ownerUserId: seeded.alpha.salesperson.userId,
    });
    expect(onBehalf).toMatchObject({
      ok: true,
      value: { outcome: 'created', identity: { ownerUserId: seeded.alpha.salesperson.userId } },
    });
  });
});

describe('verifyCallingIdentity (deprecated: kept for desktop 1.0.11)', () => {
  it('records the owner’s attestation on a number an older release left unattested, and enables it', async () => {
    const id = await unattestedRow(seeded.alpha.salesperson.userId, '+14015550134');

    const attested = await verifyCallingIdentity(salesperson(), { identityId: id });
    expect(attested.ok, JSON.stringify(attested)).toBe(true);
    if (!attested.ok) return;
    expect(attested.value.outcome).toBe('verified');
    expect(attested.value.identity).toMatchObject({
      verificationStatus: 'verified',
      enabled: true,
      verifiedByUserId: seeded.alpha.salesperson.userId,
      verificationMethod: 'owner_attestation',
      disabledAt: null,
      usedForCalls: true,
    });
    expect(attested.value.identity.verifiedAt).not.toBeNull();
    expect(
      await countOf(
        "SELECT count(*)::text AS count FROM audit_events WHERE action = 'calling_identity.attested' AND subject_id = $1",
        [id],
      ),
    ).toBe(1);
    expect(await authorizeDial(salesperson(), dialWith(id))).toMatchObject({ allowed: true, evidence: { callingIdentityId: id } });
  });

  it('is a no-op for a number registered since wave 2: existing, nothing moved, no audit event', async () => {
    const registered = await registerCallingIdentity(salesperson(), { e164: '+14015550135' });
    if (!registered.ok) throw new Error(registered.reason);
    const id = registered.value.identity.id;
    const again = await verifyCallingIdentity(salesperson(), { identityId: id });
    expect(again).toMatchObject({ ok: true, value: { outcome: 'existing' } });
    if (!again.ok) return;
    expect(again.value.identity.verifiedAt).toBe(registered.value.identity.verifiedAt);
    expect(
      await countOf(
        "SELECT count(*)::text AS count FROM audit_events WHERE action = 'calling_identity.attested' AND subject_id = $1",
        [id],
      ),
    ).toBe(0);
    // And a re-registration does not move it either.
    expect(await registerCallingIdentity(salesperson(), { e164: '+14015550135' })).toMatchObject({
      ok: true,
      value: { outcome: 'existing', identity: { verifiedAt: registered.value.identity.verifiedAt } },
    });
  });

  it('records an admin’s registration on a member’s behalf as a different method', async () => {
    const member = await aMember('salesperson');
    const registered = await registerCallingIdentity(admin(), { e164: '+14015550136', ownerUserId: member });
    expect(registered).toMatchObject({
      ok: true,
      value: {
        outcome: 'created',
        identity: {
          ownerUserId: member,
          verifiedByUserId: seeded.alpha.admin.userId,
          verificationMethod: 'admin_attestation',
          enabled: true,
        },
      },
    });
  });

  it('answers a colleague identity_unknown, and refuses a departed owner', async () => {
    const member = await aMember('salesperson');
    const theirs = await registerCallingIdentity(contextFor(seeded.alpha.workspaceId, member, 'salesperson'), {
      e164: '+14015550137',
    });
    if (!theirs.ok) throw new Error(theirs.reason);
    expect(await verifyCallingIdentity(salesperson(), { identityId: theirs.value.identity.id })).toEqual({
      ok: false,
      reason: 'identity_unknown',
    });
    expect(await verifyCallingIdentity(salesperson(), { identityId: randomUUID() })).toEqual({
      ok: false,
      reason: 'identity_unknown',
    });
    // Another workspace's row is not in this one.
    expect(await verifyCallingIdentity(admin(), { identityId: policy.beta.callingIdentityId })).toEqual({
      ok: false,
      reason: 'identity_unknown',
    });

    await database.session.query(
      "UPDATE workspace_memberships SET status = 'inactive', deactivated_at = now() WHERE workspace_id = $1 AND user_id = $2",
      [seeded.alpha.workspaceId, member],
    );
    expect(await verifyCallingIdentity(admin(), { identityId: theirs.value.identity.id })).toEqual({
      ok: false,
      reason: 'owner_not_member',
    });
  });

  it('keeps a null-owner row disabled: the shared line is deferred (9.1)', async () => {
    const shared = await database.session.query<{ id: string }>(
      "INSERT INTO calling_identities (workspace_id, owner_user_id, e164) VALUES ($1, NULL, '+14015550138') RETURNING id",
      [seeded.alpha.workspaceId],
    );
    const id = shared.rows[0]?.id ?? '';
    expect(await verifyCallingIdentity(admin(), { identityId: id })).toEqual({
      ok: false,
      reason: 'identity_shared_line_disabled',
    });
    expect(await verifyCallingIdentity(salesperson(), { identityId: id })).toEqual({
      ok: false,
      reason: 'identity_unknown',
    });
    expect(
      await countOf("SELECT count(*)::text AS count FROM calling_identities WHERE id = $1 AND enabled = false AND verification_status = 'unverified'", [id]),
    ).toBe(1);
  });
});

describe('disableCallingIdentity', () => {
  it('retires the number, keeps the row and the call history, and can be undone by attesting again', async () => {
    const registered = await registerCallingIdentity(salesperson(), { e164: '+14015550139' });
    if (!registered.ok) throw new Error(registered.reason);
    const id = registered.value.identity.id;

    // A call placed from it, which the retirement must not orphan.
    await database.session.query(
      `INSERT INTO call_logs (workspace_id, firm_id, calling_identity_id, outcome, step_effect, occurred_at, actor_user_id)
       VALUES ($1, $2, $3, 'voicemail_left', 'complete_and_advance', now(), $4)`,
      [seeded.alpha.workspaceId, crm.alpha.firmId, id, seeded.alpha.salesperson.userId],
    );

    // A colleague cannot retire it.
    const member = await aMember('salesperson');
    expect(await disableCallingIdentity(contextFor(seeded.alpha.workspaceId, member, 'salesperson'), { identityId: id })).toEqual({
      ok: false,
      reason: 'identity_unknown',
    });

    const retired = await disableCallingIdentity(salesperson(), { identityId: id });
    expect(retired).toMatchObject({
      ok: true,
      value: {
        outcome: 'disabled',
        identity: {
          enabled: false,
          disabledByUserId: seeded.alpha.salesperson.userId,
          // The attestation is history, not undone.
          verificationStatus: 'verified',
          verificationMethod: 'owner_attestation',
          usedForCalls: false,
        },
      },
    });
    expect(await countOf('SELECT count(*)::text AS count FROM calling_identities WHERE id = $1', [id])).toBe(1);
    expect(await countOf('SELECT count(*)::text AS count FROM call_logs WHERE calling_identity_id = $1', [id])).toBe(1);
    expect(await authorizeDial(salesperson(), dialWith(id))).toEqual({
      allowed: false,
      reason: 'identity_disabled',
    });
    expect(await currentCallingIdentityId(salesperson(), seeded.alpha.salesperson.userId)).not.toBe(id);

    // Idempotent.
    expect(await disableCallingIdentity(salesperson(), { identityId: id })).toMatchObject({
      ok: true,
      value: { outcome: 'existing' },
    });
    expect(
      await countOf(
        "SELECT count(*)::text AS count FROM audit_events WHERE action = 'calling_identity.disabled' AND subject_id = $1",
        [id],
      ),
    ).toBe(1);

    // Attesting again brings it back, and the retirement stays in the audit trail.
    const back = await verifyCallingIdentity(salesperson(), { identityId: id });
    expect(back).toMatchObject({ ok: true, value: { outcome: 'verified', identity: { enabled: true, disabledAt: null } } });
    expect(await authorizeDial(salesperson(), dialWith(id))).toMatchObject({ allowed: true });
  });
});

describe('which number a person dials from', () => {
  it('is the most recently added or attested of their numbers still in use, and the list says so', async () => {
    const member = await aMember('salesperson');
    const theirs = contextFor(seeded.alpha.workspaceId, member, 'salesperson');
    expect(await currentCallingIdentityId(theirs, member)).toBeNull();
    expect(await listOwnCallingIdentities(theirs)).toEqual([]);

    const first = await registerCallingIdentity(theirs, { e164: '+14015550141', label: 'Desk' });
    if (!first.ok) throw new Error(first.reason);
    // Registered is enough since wave 2 (S4.3).
    expect(await currentCallingIdentityId(theirs, member)).toBe(first.value.identity.id);
    const second = await registerCallingIdentity(theirs, { e164: '+14015550143', label: 'Mobile' });
    if (!second.ok) throw new Error(second.reason);
    expect(await currentCallingIdentityId(theirs, member)).toBe(second.value.identity.id);

    const listed = await listOwnCallingIdentities(theirs);
    expect(listed.map(entry => [entry.label, entry.usedForCalls])).toEqual([
      ['Desk', false],
      ['Mobile', true],
    ]);
    // Only their own: nobody else's number is in the list.
    expect(listed.every(entry => entry.ownerUserId === member)).toBe(true);
    expect(await listOwnCallingIdentities(worker())).toEqual([]);

    await disableCallingIdentity(theirs, { identityId: second.value.identity.id });
    expect(await currentCallingIdentityId(theirs, member)).toBe(first.value.identity.id);
  });
});
