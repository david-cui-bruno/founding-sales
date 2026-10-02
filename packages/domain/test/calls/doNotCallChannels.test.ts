import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DoNotCallChoice } from '@fss/contracts';
import { withTransaction } from '../../db/queryable.ts';
import { authorizeDial } from '../../dial/authorize.ts';
import { logCallOutcome } from '../../dial/calls.ts';
import { readFence } from '../../outbound/fence.ts';
import { decideSend } from '../../outbound/gate.ts';
import { databaseNow } from '../../policy/clock.ts';
import { suppressionSource } from '../../sequences/eligibility.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { createOutboundWorld, type OutboundWorld } from '../outbound/support/outboundWorld.ts';
import { prepareFor, seedFirm } from '../outbound/support/dispatchFixtures.ts';
import { addPhones, insertStop, stepInput } from '../suppression/support/channelWorld.ts';

/**
 * Test P1-8 (DESIGN-S3X §2.6), David's P1 end to end, and the pause.
 *
 * "Do not call" stops phone calls only. An explicit "don't contact me again" stops both.
 * Keeping e-mail open grants no permission: a `do_not_call` log can carry no agreement, and
 * an e-mail the stop does not refuse is still refused.
 *
 * Which refusal it meets, as the code stands (reported to the coordinator, DESIGN-S3X §2.6
 * P1-8 names the pause): `do_not_call` is an outcome that sets manual mode, so logging it
 * ends every live enrollment at the firm (7.3, `applyManualModeStop`), and the claim refuses
 * the prepared e-mail as `step_ineligible` — after its suppression read passed, and before
 * the gate reaches the pause (the domain switch, held off here as in production). Never a
 * suppression refusal, and never a send.
 *
 * Through the real `logCallOutcome`, the real dial authorisation, the real eligibility read
 * and the real send gate.
 */

let world: OutboundWorld;

beforeAll(async () => {
  world = await createOutboundWorld();
}, 180_000);

afterAll(async () => {
  await world?.stop();
});

const workspaceId = (): string => world.alpha.workspace.workspaceId;
const system = () => world.systemContext(workspaceId());
const salesperson = () => world.userContext(workspaceId());

interface Called {
  readonly firmId: string;
  readonly contactId: string;
  readonly opportunityId: string;
  readonly address: string;
  readonly phoneRouteId: string;
  readonly otherPhoneRouteId: string;
  /** Somebody else at the same firm, with a number of their own. */
  readonly colleagueId: string;
  readonly colleagueRouteId: string;
  readonly fenceId: string;
  readonly callLogId: string;
}

let labels = 0;

/** A firm, a prepared e-mail to one person there, and a "Do not call" logged on their number. */
async function doNotCall(choice: { readonly doNotCall?: DoNotCallChoice; readonly doNotCallCoversAllContact?: boolean }): Promise<Called> {
  labels += 1;
  const firm = await seedFirm(world, world.alpha, `do-not-call-${String(labels)}`);
  const fenceId = await prepareFor(world, world.alpha, firm);
  const fence = await readFence(system(), fenceId);
  if (fence === null || fence.contactId === null) throw new Error('the fence names nobody');
  const phones = await addPhones(world.database.session, workspaceId(), { firmId: firm.firmId, contactId: fence.contactId });
  const colleague = await addPhones(world.database.session, workspaceId(), { firmId: firm.firmId, contactId: firm.contactId });
  const logged = await withTransaction(world.database.session, async () =>
    await logCallOutcome(salesperson(), {
      firmId: firm.firmId,
      contactId: fence.contactId ?? undefined,
      routeId: phones.phoneRouteId,
      outcome: 'do_not_call',
      commandId: randomUUID(),
      journal: recordingSuppressionJournal(),
      ...choice,
    }),
  );
  if (!logged.ok) throw new Error(logged.reason);
  return {
    firmId: firm.firmId,
    contactId: fence.contactId,
    opportunityId: firm.opportunityId,
    address: fence.recipientAddress,
    phoneRouteId: phones.phoneRouteId,
    otherPhoneRouteId: phones.otherPhoneRouteId,
    colleagueId: firm.contactId,
    colleagueRouteId: colleague.phoneRouteId,
    fenceId,
    callLogId: logged.value.callLogId,
  };
}

/** The dial's answer; an unknown identity stands for "passed suppression". */
async function dial(called: Called, routeId: string, contactId: string): Promise<string> {
  const decided = await authorizeDial(salesperson(), {
    firmId: called.firmId,
    contactId,
    routeId,
    routeVersion: 1,
    callingIdentityId: randomUUID(),
    at: await databaseNow(system()),
  });
  return decided.allowed ? 'allowed' : decided.reason;
}

/** The send gate on the prepared e-mail, with the domain switch as production has it: off. */
async function sendPaused(called: Called): Promise<string> {
  await world.database.session.query(
    'UPDATE sending_domains SET automated_sending_enabled = false, automated_sending_enabled_at = NULL WHERE workspace_id = $1',
    [workspaceId()],
  );
  try {
    const fence = await readFence(system(), called.fenceId);
    if (fence === null) throw new Error('the fence disappeared');
    const decided = await decideSend(system(), fence, world.sendDeps(world.alpha));
    return decided.ok ? 'sent' : decided.reason;
  } finally {
    await world.database.session.query(
      'UPDATE sending_domains SET automated_sending_enabled = true, automated_sending_enabled_at = now() WHERE workspace_id = $1',
      [workspaceId()],
    );
  }
}

const stopsOf = async (called: Called): Promise<readonly string[]> =>
  (
    await world.database.session.query<{ stop: string }>(
      `SELECT scope || '/' || channel AS stop FROM suppression_events
        WHERE workspace_id = $1 AND command_id IN (
          SELECT command_id || ':handle' FROM call_logs WHERE workspace_id = $1 AND id = $2
          UNION ALL SELECT command_id || ':firm' FROM call_logs WHERE workspace_id = $1 AND id = $2)
        ORDER BY scope, channel`,
      [workspaceId(), called.callLogId],
    )
  ).rows.map(row => row.stop);

describe('P1-8: a "Do not call" stops what David chose, and e-mail stays behind the pause', () => {
  it('with no choice: calls to this person stop; their e-mail passes suppression and is still refused by the pause', async () => {
    const called = await doNotCall({});
    expect(await stopsOf(called)).toEqual(['handle/phone']);
    expect(await dial(called, called.phoneRouteId, called.contactId)).toBe('handle_suppressed');
    expect(await dial(called, called.otherPhoneRouteId, called.contactId)).toBe('handle_suppressed');
    // A colleague at the same firm is not this person.
    expect(await dial(called, called.colleagueRouteId, called.colleagueId)).toBe('identity_missing');
    // Preparation and the claim read suppression on the e-mail channel: nothing stops it…
    expect(await suppressionSource().evaluate(system(), stepInput(called, 'email'))).toEqual({ ok: true });
    // …and the send is still refused, by the engaged-call stop ahead of the pause.
    expect(await sendPaused(called)).toBe('step_ineligible');
  });

  it('"all contact with this person" stops e-mail to them too', async () => {
    const called = await doNotCall({ doNotCall: { scope: 'contact', channel: 'all' } });
    expect(await stopsOf(called)).toEqual(['handle/all']);
    expect(await dial(called, called.otherPhoneRouteId, called.contactId)).toBe('handle_suppressed');
    expect(await suppressionSource().evaluate(system(), stepInput(called, 'email'))).toEqual({ ok: false, reasonCode: 'handle_suppressed' });
    expect(await sendPaused(called)).toBe('handle_suppressed');
  });

  it('"calls to anyone at this firm" stops every call there and leaves e-mail to suppression-free', async () => {
    const called = await doNotCall({ doNotCall: { scope: 'firm', channel: 'phone' } });
    expect(await stopsOf(called)).toEqual(['firm/phone', 'handle/phone']);
    expect(await dial(called, called.colleagueRouteId, called.colleagueId)).toBe('firm_suppressed');
    expect(await suppressionSource().evaluate(system(), stepInput(called, 'email'))).toEqual({ ok: true });
    expect(await sendPaused(called)).toBe('step_ineligible');
  });

  it('"all contact with this firm" stops calls and e-mail to everyone there', async () => {
    const called = await doNotCall({ doNotCall: { scope: 'firm', channel: 'all' } });
    expect(await stopsOf(called)).toEqual(['firm/all', 'handle/all']);
    expect(await dial(called, called.colleagueRouteId, called.colleagueId)).toBe('firm_suppressed');
    expect(await sendPaused(called)).toBe('firm_suppressed');
  });

  it('the 1.0.29 checkbox, "covers all contact", keeps its meaning: the number for calls, the firm for everything', async () => {
    const called = await doNotCall({ doNotCallCoversAllContact: true });
    expect(await stopsOf(called)).toEqual(['firm/all', 'handle/phone']);
    expect(await sendPaused(called)).toBe('firm_suppressed');
  });

  it('a calls-only stop with no engaged call behind it leaves e-mail to the pause, which refuses it', async () => {
    labels += 1;
    const firm = await seedFirm(world, world.alpha, `do-not-call-pause-${String(labels)}`);
    const fenceId = await prepareFor(world, world.alpha, firm);
    const fence = await readFence(system(), fenceId);
    if (fence === null || fence.contactId === null) throw new Error('the fence names nobody');
    const phones = await addPhones(world.database.session, workspaceId(), { firmId: firm.firmId, contactId: fence.contactId });
    // A stop on the person's number for calls, as Needs review or the record route writes one.
    await insertStop(world.database.session, workspaceId(), {
      scope: 'handle',
      key: phones.phone,
      channel: 'phone',
      at: new Date().toISOString(),
      source: 'prospect_do_not_call',
    });
    const called = { fenceId } as Called;
    expect(await sendPaused(called)).toBe('automated_sending_disabled');
  });

  it('grants no permission: a do-not-call log carries no agreement, through the command or the table', async () => {
    labels += 1;
    const firm = await seedFirm(world, world.alpha, `do-not-call-agreement-${String(labels)}`);
    const phones = await addPhones(world.database.session, workspaceId(), firm);
    const refused = await withTransaction(world.database.session, async () =>
      await logCallOutcome(salesperson(), {
        firmId: firm.firmId,
        contactId: firm.contactId,
        routeId: phones.phoneRouteId,
        outcome: 'do_not_call',
        commandId: randomUUID(),
        journal: recordingSuppressionJournal(),
        followUpPermission: { scope: 'single_email', templateVersionId: world.alpha.templateVersionId },
      }),
    );
    expect(refused).toMatchObject({ ok: false, reason: 'invalid_input' });

    const called = await doNotCall({});
    await expect(
      world.database.session.query(
        "UPDATE call_logs SET agreed_follow_up = 'single_email', agreed_template_version_id = $3 WHERE workspace_id = $1 AND id = $2",
        [workspaceId(), called.callLogId, world.alpha.templateVersionId],
      ),
    ).rejects.toMatchObject({ constraint: 'call_logs_agreement_needs_interest' });
  });
});
