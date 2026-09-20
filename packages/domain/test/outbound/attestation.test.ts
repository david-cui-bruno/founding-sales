import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { updateSetting } from '../../settings/index.ts';
import { dispatchOutboundMessage, readFence } from '../../outbound/index.ts';
import { createOutboundWorld, type OutboundWorld, type OutboundWorldMailbox } from './support/outboundWorld.ts';

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

/** The attestation an admin writes after a rehearsal whose digests match. */
async function attest(enabled: boolean, reference: string | null): Promise<void> {
  const result = await updateSetting(adminContext(world.alpha), {
    settingKey: 'sending_enabled',
    value: { enabled, releaseGateReference: reference },
    changeNote: 'release gate fixture',
  });
  expect(result.ok).toBe(true);
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
