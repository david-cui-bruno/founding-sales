import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { readFence } from '../../outbound/fence.ts';
import { recordAuthenticationChecklist, setAutomatedSendingEnabled } from '../../outbound/domainGuard.ts';
import { dispatchOutboundMessage, type SendReport } from '../../outbound/send.ts';
import { updateSetting } from '../../settings/store.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { FIXTURE_API_DIGEST } from '../release/support/releaseRecords.ts';
import {
  RELEASE_GATE_REFERENCE,
  SENDING_DOMAIN,
  createOutboundWorld,
  type OutboundWorld,
} from './support/outboundWorld.ts';
import {
  backendPid,
  openExtraSession,
  pausingAtTokenRefresh,
  prepareFor,
  seedFirm,
  settle,
  tracked,
  waitUntilBlocked,
  type ExtraSession,
} from './support/dispatchFixtures.ts';

/**
 * Slice P1, invariant I1, on the e-mail path: a sending switch turned OFF holds queued
 * work, and no Gmail request starts after the turn-off is ordered.
 *
 * The two sending switches are the domain's `automated_sending_enabled` (with the DNS
 * checklist it depends on) and the workspace attestation `sending_enabled`. The claim
 * reads both under the send gate SHARED (`send.ts`, `recheckAndClaim`). Before this slice
 * their writers took no gate, so a turn-off could commit between the claim's read of a
 * switch and the claim's own commit, and the message left after "off" had committed.
 * Now every writer of either switch takes the gate EXCLUSIVE, and the order is total:
 *
 *   * a turn-off that commits while a dispatch is between its first read and its claim
 *     (here, during the token refresh) is read by the claim, which holds the fence — and
 *     the fence, `held`, sends exactly once when the switch comes back on;
 *   * a turn-off issued while a claim's transaction is open waits for that claim, which
 *     commits and sends: that message was already submitted, and is the one the
 *     "finishing" line counts. The next claim reads "off".
 */

let world: OutboundWorld;
let second: ExtraSession;
let third: ExtraSession;

beforeAll(async () => {
  world = await createOutboundWorld();
  second = await openExtraSession(world);
  third = await openExtraSession(world);
}, 180_000);

afterAll(async () => {
  await second?.close();
  await third?.close();
  await world?.stop();
});

const workspaceId = (): string => world.alpha.workspace.workspaceId;
const context = (): RepositoryContext => world.systemContext(workspaceId());

/** The workspace administrator's scope on one connection, as a route builds it. */
function adminOn(session: SessionQueryable): RepositoryContext {
  return repositoryContext(
    workspaceScope(workspaceId(), { kind: 'user', userId: world.alpha.workspace.admin.userId, role: 'admin' }),
    session,
  );
}

async function setDomainSwitch(session: SessionQueryable, enabled: boolean): Promise<void> {
  const outcome = await withTransaction(
    session,
    async () => await setAutomatedSendingEnabled(adminOn(session), { domain: SENDING_DOMAIN, enabled }),
  );
  expect(outcome.ok).toBe(true);
}

async function setAttestation(session: SessionQueryable, enabled: boolean): Promise<void> {
  const outcome = await withTransaction(
    session,
    async () =>
      await updateSetting(adminOn(session), {
        settingKey: 'sending_enabled',
        value: { enabled, releaseGateReference: enabled ? RELEASE_GATE_REFERENCE : null },
        changeNote: enabled ? 'P1 fixture: back on' : 'P1 fixture: pause',
        runningApiDigest: FIXTURE_API_DIGEST,
      }),
  );
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
}

/** Both switches back on, and no hold left behind, whatever a test did. */
afterEach(async () => {
  await second?.session.query('ROLLBACK');
  await third?.session.query('ROLLBACK');
  await setDomainSwitch(world.database.session, true);
  await setAttestation(world.database.session, true);
  await world.clearHolds(workspaceId());
});

async function dispatchPausing(
  fenceId: string,
  during: () => Promise<void>,
): Promise<{ readonly report: SendReport; readonly sends: number; readonly refreshes: number; readonly gmail: ReturnType<OutboundWorld['clientWith']> }> {
  const gmail = world.clientWith(world.alpha, {});
  const paused = pausingAtTokenRefresh(gmail, during);
  const report = await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail: paused.client }), {
    outboundMessageId: fenceId,
  });
  return { report, sends: gmail.sends.length, refreshes: paused.refreshes(), gmail };
}

describe('I1: a sending switch turned off before the claim holds the fence, and it sends once when back on', () => {
  it('the control: a pause that turns nothing off sends', async () => {
    const firm = await seedFirm(world, world.alpha, 'p1-control');
    const fenceId = await prepareFor(world, world.alpha, firm);
    const { report, sends, refreshes } = await dispatchPausing(fenceId, async () => {
      await Promise.resolve();
    });
    expect(refreshes).toBe(1);
    expect(report.outcome, `${report.refusal ?? ''} ${report.detail ?? ''}`).toBe('sent');
    expect(sends).toBe(1);
  });

  for (const which of ['domain', 'attestation'] as const) {
    it(`the ${which} switch turned off during the token refresh: no Gmail call, the fence held; on again, sent exactly once`, async () => {
      const firm = await seedFirm(world, world.alpha, `p1-off-${which}`);
      const fenceId = await prepareFor(world, world.alpha, firm);

      const { report, sends, refreshes } = await dispatchPausing(fenceId, async () => {
        if (which === 'domain') await setDomainSwitch(second.session, false);
        else await setAttestation(second.session, false);
      });
      // The precheck passed (the refresh ran only on a sendable fence), and the claim read "off".
      expect(refreshes).toBe(1);
      expect(report.outcome).toBe('held');
      expect(report.refusal).toBe(which === 'domain' ? 'automated_sending_disabled' : 'workspace_sending_not_attested');
      expect(sends).toBe(0);
      expect((await readFence(context(), fenceId))?.state).toBe('held');

      // Still off: a second run holds again and sends nothing.
      const gmail = world.clientWith(world.alpha, {});
      const again = await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail }), {
        outboundMessageId: fenceId,
      });
      expect(again.outcome).toBe('held');
      expect(gmail.sends).toHaveLength(0);

      // Back on: the held fence is released and sent, once.
      if (which === 'domain') await setDomainSwitch(world.database.session, true);
      else await setAttestation(world.database.session, true);
      const sent = await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail }), {
        outboundMessageId: fenceId,
      });
      expect(sent.outcome, `${sent.refusal ?? ''} ${sent.detail ?? ''}`).toBe('sent');
      const replay = await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail }), {
        outboundMessageId: fenceId,
      });
      expect(replay.outcome).toBe('already_terminal');
      expect(gmail.sends).toHaveLength(1);
      expect((await readFence(context(), fenceId))?.state).toBe('sent');
    });
  }
});

describe('I1: a switch write waits for an in-flight claim (the send gate)', () => {
  const writers = {
    domain: async (session: SessionQueryable) => {
      await setDomainSwitch(session, false);
    },
    attestation: async (session: SessionQueryable) => {
      await setAttestation(session, false);
    },
    checklist: async (session: SessionQueryable) => {
      const outcome = await withTransaction(
        session,
        async () =>
          await recordAuthenticationChecklist(adminOn(session), {
            domain: SENDING_DOMAIN,
            adminUserId: world.alpha.workspace.admin.userId,
            spfPass: true,
            dkimPass: true,
            dmarcPass: false,
            postmasterReviewed: true,
          }),
      );
      expect(outcome.ok).toBe(true);
    },
  } as const;
  const refusalAfter = {
    domain: 'automated_sending_disabled',
    attestation: 'workspace_sending_not_attested',
    checklist: 'automated_sending_disabled',
  } as const;

  for (const which of ['domain', 'attestation', 'checklist'] as const) {
    it(`turning off the ${which} waits for the claim, which sends; the next claim holds`, async () => {
      const firm = await seedFirm(world, world.alpha, `p1-gate-${which}`);
      const fenceId = await prepareFor(world, world.alpha, firm);
      const fence = await readFence(context(), fenceId);
      const mainPid = await backendPid(world.database.session);

      // Hold the claim inside its transaction: the enrollment row is locked here without
      // the gate, so the claim takes the gate SHARED and the fence, then waits.
      await second.session.query('BEGIN');
      await second.session.query(
        `SELECT n.id FROM sequence_enrollments n
           JOIN step_executions e ON e.workspace_id = n.workspace_id AND e.enrollment_id = n.id
          WHERE e.workspace_id = $1 AND e.id = $2 FOR UPDATE OF n`,
        [workspaceId(), fence?.stepExecutionId],
      );
      const gmail = world.clientWith(world.alpha, {});
      const dispatch = tracked(
        dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail }), { outboundMessageId: fenceId }),
      );
      await waitUntilBlocked(third.session, mainPid);

      // The turn-off, on a third connection: it must wait on the send gate.
      const turnOff = tracked(writers[which](third.session));
      await waitUntilBlocked(second.session, third.pid, 'advisory');
      await settle(100);
      expect(turnOff.settled()).toBe(false);

      // The claim commits first, so its message linearizes before the turn-off.
      await second.session.query('COMMIT');
      const report = await dispatch.promise;
      await turnOff.promise;
      expect(report.outcome, `${report.refusal ?? ''} ${report.detail ?? ''}`).toBe('sent');
      expect(gmail.sends).toHaveLength(1);

      // Everything after the turn-off holds.
      const later = await prepareFor(world, world.alpha, firm);
      const held = await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail }), {
        outboundMessageId: later,
      });
      expect(held.outcome).toBe('held');
      expect(held.refusal).toBe(refusalAfter[which]);
      expect(gmail.sends).toHaveLength(1);

      if (which === 'checklist') {
        const restored = await withTransaction(
          world.database.session,
          async () =>
            await recordAuthenticationChecklist(adminOn(world.database.session), {
              domain: SENDING_DOMAIN,
              adminUserId: world.alpha.workspace.admin.userId,
              spfPass: true,
              dkimPass: true,
              dmarcPass: true,
              postmasterReviewed: true,
            }),
        );
        expect(restored.ok).toBe(true);
      }
    });
  }
});
