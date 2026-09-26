import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { SETTINGS_REFUSAL_CODES, readSetting, updateSetting } from '../../settings/store.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { CI_GATE_MAIN_POLICY } from '@fss/contracts';
import {
  FIXTURE_API_DIGEST,
  FIXTURE_WORKER_DIGEST,
  fixtureDigest,
  storeFixtureCiGateRecord,
  storeFixtureRecord,
} from '../release/support/releaseRecords.ts';

/**
 * Enabling production sending names a release record that binds to this API
 * (specification 16.2; lane g71).
 *
 * Until g71 `sending_enabled = { enabled: true, releaseGateReference: <anything> }`
 * was accepted: "the deployed commit/image digests match the rehearsal artifacts" was
 * something the admin was asked to check and nothing checked. Now the save is refused
 * unless the reference is a stored, passing record whose API digest is the digest of
 * the API image taking the write.
 *
 * ## The vacuous-pass trap, named
 *
 * Every refusal below would also be produced by a command that refused every enable,
 * so the first case is the positive control, and each refusal differs from it in
 * exactly one fact: the reference, the suite, the running digest, or its absence.
 * Removing the suite comparison turns this file red.
 */

describe('enabling production sending', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let admin: RepositoryContext;

  const PASSING = 'fss-rh-enable-2026-09-25T07:20:44Z';
  const FAILED = 'fss-rh-enable-failed-2026-09-25T07:20:44Z';

  const enable = async (reference: string, runningApiDigest?: string) =>
    await updateSetting(admin, {
      settingKey: 'sending_enabled',
      value: { enabled: true, releaseGateReference: reference },
      changeNote: `rehearsal ${reference} passed; digests match production`,
      ...(runningApiDigest === undefined ? {} : { runningApiDigest }),
    });

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    admin = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      database.session,
    );
    await storeFixtureRecord(database.session, PASSING);
    await storeFixtureRecord(database.session, FAILED, { suite: 'fail' });
  });

  afterAll(async () => {
    await database.drop();
  });

  it('accepts a passing record whose API digest is the running API’s', async () => {
    const outcome = await enable(PASSING, FIXTURE_API_DIGEST);
    expect(outcome).toMatchObject({ ok: true, value: { current: { settingKey: 'sending_enabled', version: 1 } } });
    expect((await readSetting(admin, 'sending_enabled')).value).toEqual({
      enabled: true,
      releaseGateReference: PASSING,
    });
  });

  it('refuses a reference no record carries, and writes nothing', async () => {
    const before = (await readSetting(admin, 'sending_enabled')).version;
    expect(await enable('fss-rh-nobody-rehearsed-this', FIXTURE_API_DIGEST)).toEqual({
      ok: false,
      reason: 'release_record_unknown',
    });
    expect((await readSetting(admin, 'sending_enabled')).version).toBe(before);
  });

  it('refuses a record whose suite did not pass', async () => {
    expect(await enable(FAILED, FIXTURE_API_DIGEST)).toEqual({ ok: false, reason: 'release_record_not_passing' });
  });

  it('refuses when the running API is not the image the rehearsal certified', async () => {
    expect(await enable(PASSING, fixtureDigest('e'))).toEqual({ ok: false, reason: 'release_record_digest_mismatch' });
    // The worker's digest is not the API's: each side compares its own half.
    expect(await enable(PASSING, FIXTURE_WORKER_DIGEST)).toEqual({
      ok: false,
      reason: 'release_record_digest_mismatch',
    });
  });

  it('refuses, failing closed, when the API cannot say which image it is running', async () => {
    expect(await enable(PASSING, 'unknown')).toEqual({ ok: false, reason: 'release_record_identity_unknown' });
    expect(await enable(PASSING)).toEqual({ ok: false, reason: 'release_record_identity_unknown' });
  });

  it('always accepts turning sending off, whatever the API is running', async () => {
    const outcome = await updateSetting(admin, {
      settingKey: 'sending_enabled',
      value: { enabled: false, releaseGateReference: null },
      changeNote: 'withdrawn',
      runningApiDigest: 'unknown',
    });
    expect(outcome.ok).toBe(true);
    expect((await readSetting(admin, 'sending_enabled')).value).toEqual({ enabled: false, releaseGateReference: null });
  });

  it('still refuses a salesperson before it looks at any record', async () => {
    const salesperson = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, {
        kind: 'user',
        userId: seeded.alpha.salesperson.userId,
        role: 'salesperson',
      }),
      database.session,
    );
    expect(
      await updateSetting(salesperson, {
        settingKey: 'sending_enabled',
        value: { enabled: true, releaseGateReference: PASSING },
        changeNote: 'trying it on',
        runningApiDigest: FIXTURE_API_DIGEST,
      }),
    ).toEqual({ ok: false, reason: 'admin_only' });
  });

  it('accepts the process form, ci-gate:main, only from an API a passing ci-gate record names (lane g100)', async () => {
    // Its own API digests, so the records the other cases stored cannot answer for it.
    const ciApi = fixtureDigest('5');
    const rehearsedApi = fixtureDigest('6');
    const failedApi = fixtureDigest('7');
    await storeFixtureCiGateRecord(database.session, '41000000101', { api: ciApi, worker: fixtureDigest('8') });
    await storeFixtureRecord(database.session, 'fss-rh-enable-policy-rehearsal', { api: rehearsedApi });
    await storeFixtureCiGateRecord(database.session, '41000000102', { api: failedApi, suite: 'fail' });

    // Refused: no record at all names this API, only a rehearsal record does, the only
    // ci-gate record did not pass, and an API that cannot say what it runs.
    expect(await enable(CI_GATE_MAIN_POLICY, fixtureDigest('9'))).toEqual({ ok: false, reason: 'release_record_unknown' });
    expect(await enable(CI_GATE_MAIN_POLICY, rehearsedApi)).toEqual({ ok: false, reason: 'release_record_unknown' });
    expect(await enable(CI_GATE_MAIN_POLICY, failedApi)).toEqual({ ok: false, reason: 'release_record_not_passing' });
    expect(await enable(CI_GATE_MAIN_POLICY, 'unknown')).toEqual({ ok: false, reason: 'release_record_identity_unknown' });

    // The positive control: a passing ci-gate record names the running API. What is
    // stored is the policy's name, not the record's reference.
    expect(await enable(CI_GATE_MAIN_POLICY, ciApi)).toMatchObject({ ok: true });
    expect((await readSetting(admin, 'sending_enabled')).value).toEqual({
      enabled: true,
      releaseGateReference: CI_GATE_MAIN_POLICY,
    });
  });

  it('names all four binding refusals among the settings refusal codes', () => {
    for (const code of [
      'release_record_unknown',
      'release_record_not_passing',
      'release_record_identity_unknown',
      'release_record_digest_mismatch',
    ]) {
      expect(SETTINGS_REFUSAL_CODES).toContain(code);
    }
  });
});
