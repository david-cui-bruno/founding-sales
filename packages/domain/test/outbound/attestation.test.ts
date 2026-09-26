import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CI_GATE_MAIN_POLICY } from '@fss/contracts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { updateSetting } from '../../settings/store.ts';
import { readFence } from '../../outbound/fence.ts';
import { dispatchOutboundMessage } from '../../outbound/send.ts';
import { createOutboundWorld, type OutboundWorld, type OutboundWorldMailbox } from './support/outboundWorld.ts';
import {
  FIXTURE_API_DIGEST,
  FIXTURE_WORKER_DIGEST,
  fixtureDigest,
  storeFixtureCiGateRecord,
  storeFixtureRecord,
} from '../release/support/releaseRecords.ts';

/**
 * 16.2's sending switch is two facts, and both are read on the dispatch path
 * (Appendix G 42; `docs/decisions/g12-the-send-gate-reads-both-switches.md`).
 *
 * G7-2 shipped the first: `sending_domains.automated_sending_enabled`, the DNS
 * authentication gate, whose CHECK forbids it without SPF, DKIM, DMARC and a
 * Postmaster review. G9 shipped the second: `workspace_settings.sending_enabled`,
 * the admin attestation carrying the `releaseGateReference` of the rehearsal whose
 * digests match the deployment. Until this lane, nothing read the second one before
 * sending, so a workspace whose DNS passed could send from an artifact nobody had
 * rehearsed — which is precisely the sentence 16.2 exists to forbid.
 *
 * ## The vacuous-pass trap, named
 *
 * A suite that asserted only "no attestation holds the send" would pass in a world
 * where *nothing* can send: a stale hold, a closed window, an unauthenticated domain
 * would each produce the same `held`. So every case here is paired. The first test
 * proves the world sends when all three facts are true, and the refusal tests each
 * remove exactly one fact and assert the refusal *names* it. The positive control is
 * what keeps the refusal tests honest.
 */

let world: OutboundWorld;

/** The admin scope a route builds for the workspace's administrator. */
function adminContext(mailbox: OutboundWorldMailbox) {
  return repositoryContext(
    workspaceScope(mailbox.workspace.workspaceId, {
      kind: 'user',
      userId: mailbox.workspace.admin.userId,
      role: 'admin',
    }),
    world.database.session,
  );
}

/**
 * The attestation an admin writes after a CI gate run whose digests match.
 *
 * Since lane g71 that is two acts: the release record is stored, and the enable names
 * it from an API whose digest the record carries. Both are done here through the real
 * functions, so the attestation in these cases is one the enable rule accepted. The
 * record is the CI gate's (`gateRunId` names the run), because that is the only kind a
 * production deployment binds; answers the reference the enable named.
 */
async function attest(enabled: boolean, gateRunId: string | null): Promise<string | null> {
  const reference =
    enabled && gateRunId !== null ? await storeFixtureCiGateRecord(world.database.session, gateRunId) : null;
  const result = await updateSetting(adminContext(world.alpha), {
    settingKey: 'sending_enabled',
    value: { enabled, releaseGateReference: reference },
    changeNote: 'release gate fixture',
    runningApiDigest: FIXTURE_API_DIGEST,
  });
  expect(result.ok).toBe(true);
  return reference;
}

/**
 * An attestation the enable rule would refuse today, written the way one written
 * before lane g71 would already be stored. The gate must not trust that the enable
 * rule ran, so these are how its own refusals are reached.
 */
async function storeAttestationDirectly(reference: string): Promise<void> {
  await attest(false, null);
  await world.database.session.query(
    `UPDATE workspace_settings SET value = $2::jsonb
      WHERE workspace_id = $1 AND setting_key = 'sending_enabled' AND superseded_at IS NULL`,
    [world.alpha.workspace.workspaceId, JSON.stringify({ enabled: true, releaseGateReference: reference })],
  );
}

beforeAll(async () => {
  world = await createOutboundWorld();
}, 180_000);

afterAll(async () => {
  await world?.stop();
});

beforeEach(async () => {
  await world.clearHolds(world.alpha.workspace.workspaceId);
});

describe('the send gate reads both halves of 16.2', () => {
  it('sends when the domain is authenticated, the admin attested and the deployment agrees', async () => {
    await attest(true, '41000000401');
    const fenceId = await world.prepare(world.alpha);
    const report = await dispatchOutboundMessage(
      world.systemContext(world.alpha.workspace.workspaceId),
      world.sendDeps(world.alpha, { deploymentSendingEnabled: true }),
      { outboundMessageId: fenceId },
    );
    expect(report.outcome).toBe('sent');
  });

  it('holds a domain-enabled workspace that has no admin attestation', async () => {
    await attest(false, null);
    const fenceId = await world.prepare(world.alpha);
    const report = await dispatchOutboundMessage(
      world.systemContext(world.alpha.workspace.workspaceId),
      world.sendDeps(world.alpha, { deploymentSendingEnabled: true }),
      { outboundMessageId: fenceId },
    );
    expect(report.outcome).toBe('held');
    expect(report.refusal).toBe('workspace_sending_not_attested');
    const fence = await readFence(world.systemContext(world.alpha.workspace.workspaceId), fenceId);
    expect(fence?.state).toBe('held');
  });

  it('holds an attested workspace when the deployment flag is off', async () => {
    await attest(true, '41000000402');
    const fenceId = await world.prepare(world.alpha);
    const report = await dispatchOutboundMessage(
      world.systemContext(world.alpha.workspace.workspaceId),
      world.sendDeps(world.alpha, { deploymentSendingEnabled: false }),
      { outboundMessageId: fenceId },
    );
    expect(report.outcome).toBe('held');
    expect(report.refusal).toBe('workspace_sending_not_attested');
  });

  it('still refuses on the domain half, so the two are not one switch', async () => {
    await attest(true, '41000000403');
    await world.database.session.query(
      `UPDATE sending_domains SET automated_sending_enabled = false, automated_sending_enabled_at = NULL
        WHERE workspace_id = $1`,
      [world.alpha.workspace.workspaceId],
    );
    const fenceId = await world.prepare(world.alpha);
    const report = await dispatchOutboundMessage(
      world.systemContext(world.alpha.workspace.workspaceId),
      world.sendDeps(world.alpha, { deploymentSendingEnabled: true }),
      { outboundMessageId: fenceId },
    );
    expect(report.outcome).toBe('held');
    expect(report.refusal).toBe('automated_sending_disabled');
    await world.database.session.query(
      `UPDATE sending_domains SET automated_sending_enabled = true, automated_sending_enabled_at = now()
        WHERE workspace_id = $1`,
      [world.alpha.workspace.workspaceId],
    );
  });

  it('reads the attestation of the sending workspace, not of any other', async () => {
    // Alpha stays attested; beta withdraws. One workspace's release gate is not
    // another's, and `readSetting` is workspace-scoped, so beta must be held.
    await attest(true, '41000000404');
    await updateSetting(adminContext(world.beta), {
      settingKey: 'sending_enabled',
      value: { enabled: false, releaseGateReference: null },
      changeNote: 'beta has not rehearsed this release',
    });
    const fenceId = await world.prepare(world.beta);
    const report = await dispatchOutboundMessage(
      world.systemContext(world.beta.workspace.workspaceId),
      world.sendDeps(world.beta, { deploymentSendingEnabled: true }),
      { outboundMessageId: fenceId },
    );
    expect(report.outcome).toBe('held');
    expect(report.refusal).toBe('workspace_sending_not_attested');
  });
});

/**
 * Lane g71: the attestation binds to the worker that is about to send.
 *
 * 16.2's "the deployed commit/image digests match the rehearsal artifacts", on the
 * dispatch path. The record the attestation names must be stored, must have passed,
 * and must name this worker's own image digest. Each case below differs from the
 * positive control above ("sends when the domain is authenticated ...") in one fact,
 * and each asserts the refusal names that fact without naming the reference.
 */
describe('the send gate binds the attestation to the running worker', () => {
  const dispatchWith = async (workerImageDigest: string | undefined) => {
    const fenceId = await world.prepare(world.alpha);
    return await dispatchOutboundMessage(
      world.systemContext(world.alpha.workspace.workspaceId),
      world.sendDeps(world.alpha, { deploymentSendingEnabled: true, workerImageDigest }),
      { outboundMessageId: fenceId },
    );
  };

  it('sends when the record names this worker’s digest', async () => {
    await attest(true, '41000000405');
    const report = await dispatchWith(FIXTURE_WORKER_DIGEST);
    expect(report.outcome).toBe('sent');
  });

  it('sends under a record from the CI gate, which carries no drill evidence (lane g96)', async () => {
    // The record the release puts since axiom 10B: `release-record-from-ci.sh`'s shape,
    // no rehearsalPrefix or rehearsalScenarios. The enable rule accepts it
    // from an API running its api digest, and the worker sends under it.
    const reference = await storeFixtureCiGateRecord(world.database.session, '41000000011');
    const enabled = await updateSetting(adminContext(world.alpha), {
      settingKey: 'sending_enabled',
      value: { enabled: true, releaseGateReference: reference },
      changeNote: 'ci gate fixture',
      runningApiDigest: FIXTURE_API_DIGEST,
    });
    expect(enabled.ok).toBe(true);
    expect((await dispatchWith(FIXTURE_WORKER_DIGEST)).outcome).toBe('sent');

    // And it binds to its own worker half: another worker image holds.
    const mismatched = await dispatchWith(fixtureDigest('e'));
    expect(mismatched.outcome).toBe('held');
    expect(mismatched.detail).toBe('release_record_digest_mismatch');
  });

  it('holds when a different worker image is running than the CI gate certified', async () => {
    const reference = await attest(true, '41000000408');
    const report = await dispatchWith(fixtureDigest('e'));
    expect(report.outcome).toBe('held');
    expect(report.refusal).toBe('workspace_sending_not_attested');
    expect(report.detail).toBe('release_record_digest_mismatch');
    expect(JSON.stringify(report)).not.toContain(reference);
  });

  it('holds when the worker runs the API’s image, because each side compares its own half', async () => {
    await attest(true, '41000000406');
    const report = await dispatchWith(FIXTURE_API_DIGEST);
    expect(report.outcome).toBe('held');
    expect(report.detail).toBe('release_record_digest_mismatch');
  });

  it('holds, failing closed, when the worker cannot say which image it is running', async () => {
    await attest(true, '41000000407');
    for (const running of ['unknown', undefined]) {
      const report = await dispatchWith(running);
      expect(report.outcome, String(running)).toBe('held');
      expect(report.detail, String(running)).toBe('release_record_identity_unknown');
    }
  });

  it('holds an attestation naming a reference no record carries', async () => {
    await storeAttestationDirectly('fss-rh-binding-nobody-stored-this');
    const report = await dispatchWith(FIXTURE_WORKER_DIGEST);
    expect(report.outcome).toBe('held');
    expect(report.refusal).toBe('workspace_sending_not_attested');
    expect(report.detail).toBe('release_record_unknown');
  });

  it('holds an attestation naming a record whose suite did not pass', async () => {
    const reference = await storeFixtureCiGateRecord(world.database.session, '41000000409', { suite: 'fail' });
    await storeAttestationDirectly(reference);
    const report = await dispatchWith(FIXTURE_WORKER_DIGEST);
    expect(report.outcome).toBe('held');
    expect(report.detail).toBe('release_record_not_passing');
  });
});

/**
 * A production worker binds only the CI gate's records, under a named reference too
 * (26 September 2026). A record a `full` rehearsal stored before W3-S8 — passing, and
 * naming this very worker — holds every send in production exactly as a reference
 * nobody stored does, while a rehearsal stack still sends under it. The attestation is
 * written directly: a production enable would refuse to name that record.
 *
 * Digests of their own (`6` the API, `2` the worker), so no record stored above answers.
 */
describe('the send gate under a named rehearsal record, in production and in a rehearsal stack', () => {
  const API = fixtureDigest('6');
  const WORKER = fixtureDigest('2');
  const REHEARSAL_REFERENCE = 'fss-rh-named-2026-09-24T10:00:00Z';

  beforeAll(async () => {
    await storeFixtureRecord(world.database.session, REHEARSAL_REFERENCE, { api: API, worker: WORKER });
  });

  const dispatchAs = async (production: boolean | undefined) => {
    const fenceId = await world.prepare(world.alpha);
    return await dispatchOutboundMessage(
      world.systemContext(world.alpha.workspace.workspaceId),
      world.sendDeps(world.alpha, { deploymentSendingEnabled: true, workerImageDigest: WORKER, production }),
      { outboundMessageId: fenceId },
    );
  };

  it('holds in production, with the refusal a missing record gets, and when the flag is absent', async () => {
    await storeAttestationDirectly(REHEARSAL_REFERENCE);
    for (const production of [true, undefined]) {
      const report = await dispatchAs(production);
      expect(report.outcome, String(production)).toBe('held');
      expect(report.refusal, String(production)).toBe('workspace_sending_not_attested');
      expect(report.detail, String(production)).toBe('release_record_unknown');
      expect(JSON.stringify(report)).not.toContain(REHEARSAL_REFERENCE);
    }
  });

  it('sends in a rehearsal stack, admitted by the reference', async () => {
    await storeAttestationDirectly(REHEARSAL_REFERENCE);
    const report = await dispatchAs(false);
    expect(report.outcome).toBe('sent');
    const { rows } = await world.database.session.query<{ detail: unknown }>(
      `SELECT detail FROM outbound_message_events
        WHERE workspace_id = $1 AND outbound_message_id = $2 AND to_state = 'dispatching'`,
      [world.alpha.workspace.workspaceId, report.outboundMessageId],
    );
    expect(rows.map(row => row.detail)).toEqual([
      { releaseAdmission: { attestation: 'reference', releaseGateReference: REHEARSAL_REFERENCE } },
    ]);
  });

  it('sends in production under a passing ci-gate record named by its reference', async () => {
    const reference = await storeFixtureCiGateRecord(world.database.session, '41000000410', { api: API, worker: WORKER });
    const enabled = await updateSetting(adminContext(world.alpha), {
      settingKey: 'sending_enabled',
      value: { enabled: true, releaseGateReference: reference },
      changeNote: 'named ci-gate record',
      runningApiDigest: API,
      production: true,
    });
    expect(enabled.ok).toBe(true);
    expect((await dispatchAs(true)).outcome).toBe('sent');
  });
});

/**
 * Lane g100: the attestation may name the release process, `ci-gate:main`, rather than
 * one record. The CI deploy puts a `ci-gate` record for every worker it rolls, so under
 * the process attestation sending stays on across automatic deploys; a worker with no
 * ci-gate record still holds, a rehearsal record is not admitted by the policy, and a
 * named reference still binds only the record it names. Every email that leaves says,
 * on the claim's ledger row, which attestation admitted it.
 *
 * Digests of their own (`5` the API, `8` and `9` two successive CI workers, `7` a worker
 * only a rehearsal certified), so the records the cases above stored cannot answer here.
 */
describe('the send gate under the process attestation, ci-gate:main', () => {
  const API = fixtureDigest('5');
  const FIRST_CI_WORKER = fixtureDigest('8');
  const NEXT_CI_WORKER = fixtureDigest('9');
  const REHEARSED_WORKER = fixtureDigest('7');
  let firstReference = '';

  beforeAll(async () => {
    firstReference = await storeFixtureCiGateRecord(world.database.session, '41000000301', { api: API, worker: FIRST_CI_WORKER });
    await storeFixtureRecord(world.database.session, 'fss-rh-policy-rehearsal-only', { api: API, worker: REHEARSED_WORKER });
  });

  const enableWith = async (releaseGateReference: string): Promise<void> => {
    const enabled = await updateSetting(adminContext(world.alpha), {
      settingKey: 'sending_enabled',
      value: { enabled: true, releaseGateReference },
      changeNote: 'process attestation fixture',
      runningApiDigest: API,
    });
    expect(enabled.ok).toBe(true);
  };

  const dispatchWith = async (workerImageDigest: string) => {
    const fenceId = await world.prepare(world.alpha);
    return await dispatchOutboundMessage(
      world.systemContext(world.alpha.workspace.workspaceId),
      world.sendDeps(world.alpha, { deploymentSendingEnabled: true, workerImageDigest }),
      { outboundMessageId: fenceId },
    );
  };

  /** The claim's ledger row: `prepared -> dispatching`, with the admission on it. */
  const claimDetail = async (outboundMessageId: string): Promise<unknown> => {
    const { rows } = await world.database.session.query<{ detail: unknown }>(
      `SELECT detail FROM outbound_message_events
        WHERE workspace_id = $1 AND outbound_message_id = $2 AND to_state = 'dispatching'`,
      [world.alpha.workspace.workspaceId, outboundMessageId],
    );
    expect(rows).toHaveLength(1);
    return rows[0]?.detail;
  };

  it('sends under a ci-gate record for this worker, and keeps sending after the next CI deploy puts its own', async () => {
    await enableWith(CI_GATE_MAIN_POLICY);
    const first = await dispatchWith(FIRST_CI_WORKER);
    expect(first.outcome).toBe('sent');
    expect(await claimDetail(first.outboundMessageId)).toEqual({
      releaseAdmission: { attestation: CI_GATE_MAIN_POLICY, releaseGateReference: firstReference },
    });

    // The next app-only merge: CI rolls another worker and puts its record. Nobody
    // attests again, and the new worker sends.
    const nextReference = await storeFixtureCiGateRecord(world.database.session, '41000000302', {
      api: API,
      worker: NEXT_CI_WORKER,
    });
    const next = await dispatchWith(NEXT_CI_WORKER);
    expect(next.outcome).toBe('sent');
    expect(await claimDetail(next.outboundMessageId)).toEqual({
      releaseAdmission: { attestation: CI_GATE_MAIN_POLICY, releaseGateReference: nextReference },
    });
  });

  it('holds a worker no record names: a deploy whose record was not put', async () => {
    await enableWith(CI_GATE_MAIN_POLICY);
    const report = await dispatchWith(fixtureDigest('f'));
    expect(report.outcome).toBe('held');
    expect(report.refusal).toBe('workspace_sending_not_attested');
    expect(report.detail).toBe('release_record_unknown');
  });

  it('holds a worker only a rehearsal record names: the policy admits ci-gate records alone', async () => {
    await enableWith(CI_GATE_MAIN_POLICY);
    const report = await dispatchWith(REHEARSED_WORKER);
    expect(report.outcome).toBe('held');
    expect(report.detail).toBe('release_record_unknown');
  });

  it('under a named reference, a ci-gate record for another reference admits nothing', async () => {
    // The owner attested to the first CI record by name. The next worker has a ci-gate
    // record of its own, which the named attestation does not reach.
    await enableWith(firstReference);
    const other = await dispatchWith(NEXT_CI_WORKER);
    expect(other.outcome).toBe('held');
    expect(other.detail).toBe('release_record_digest_mismatch');
    expect(JSON.stringify(other)).not.toContain(firstReference);

    const named = await dispatchWith(FIRST_CI_WORKER);
    expect(named.outcome).toBe('sent');
    expect(await claimDetail(named.outboundMessageId)).toEqual({
      releaseAdmission: { attestation: 'reference', releaseGateReference: firstReference },
    });
  });
});
