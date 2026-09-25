import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { updateSetting } from '../../settings/index.ts';
import { dispatchOutboundMessage, readFence } from '../../outbound/index.ts';
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
 * remove exactly one fact and assert the refusal *names* it. Remove the positive
 * control and the mutation check in `scripts/releaseMutationCheck.mjs` fails.
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
 * The attestation an admin writes after a rehearsal whose digests match.
 *
 * Since lane g71 that is two acts: the release record is stored, and the enable names
 * it from an API whose digest the record carries. Both are done here through the real
 * functions, so the attestation in these cases is one the enable rule accepted.
 */
async function attest(enabled: boolean, reference: string | null): Promise<void> {
  if (enabled && reference !== null) await storeFixtureRecord(world.database.session, reference);
  const result = await updateSetting(adminContext(world.alpha), {
    settingKey: 'sending_enabled',
    value: { enabled, releaseGateReference: reference },
    changeNote: 'release gate fixture',
    runningApiDigest: FIXTURE_API_DIGEST,
  });
  expect(result.ok).toBe(true);
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
    await attest(true, 'rehearsal-fixture-1');
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
    await attest(true, 'rehearsal-fixture-2');
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
    await attest(true, 'rehearsal-fixture-3');
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
    await attest(true, 'rehearsal-fixture-4');
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
    await attest(true, 'fss-rh-binding-sends');
    const report = await dispatchWith(FIXTURE_WORKER_DIGEST);
    expect(report.outcome).toBe('sent');
  });

  it('sends under a record from the CI gate, which carries no drill evidence (lane g96)', async () => {
    // The record the release puts since axiom 10B: `release-record-from-ci.sh`'s shape,
    // no rehearsalPrefix, carryDrill or rehearsalScenarios. The enable rule accepts it
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

    // And it binds exactly as a rehearsal's does: another worker image holds.
    const mismatched = await dispatchWith(fixtureDigest('e'));
    expect(mismatched.outcome).toBe('held');
    expect(mismatched.detail).toBe('release_record_digest_mismatch');
  });

  it('holds when a different worker image is running than the rehearsal certified', async () => {
    const reference = 'fss-rh-binding-mismatch';
    await attest(true, reference);
    const report = await dispatchWith(fixtureDigest('e'));
    expect(report.outcome).toBe('held');
    expect(report.refusal).toBe('workspace_sending_not_attested');
    expect(report.detail).toBe('release_record_digest_mismatch');
    expect(JSON.stringify(report)).not.toContain(reference);
  });

  it('holds when the worker runs the API’s image, because each side compares its own half', async () => {
    await attest(true, 'fss-rh-binding-api-half');
    const report = await dispatchWith(FIXTURE_API_DIGEST);
    expect(report.outcome).toBe('held');
    expect(report.detail).toBe('release_record_digest_mismatch');
  });

  it('holds, failing closed, when the worker cannot say which image it is running', async () => {
    await attest(true, 'fss-rh-binding-identity');
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
    const reference = 'fss-rh-binding-failed-suite';
    await storeFixtureRecord(world.database.session, reference, { suite: 'fail' });
    await storeAttestationDirectly(reference);
    const report = await dispatchWith(FIXTURE_WORKER_DIGEST);
    expect(report.outcome).toBe('held');
    expect(report.detail).toBe('release_record_not_passing');
  });
});
