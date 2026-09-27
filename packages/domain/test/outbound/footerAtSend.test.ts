import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SENDING_STOP_LINE } from '@fss/contracts';
import { makeStepExecution } from '../../db/testing/stepExecutions.ts';
import { holdFence, prepareOutboundMessage, readFence, readFenceEvents, renderedHash } from '../../outbound/fence.ts';
import { composeBodyForWorkspace } from '../../outbound/footer.ts';
import { dispatchOutboundMessage, type SendReport } from '../../outbound/send.ts';
import { sendFooterBlock } from '../../src/rules/templates.ts';
import {
  TEMPLATE_BODY,
  TEMPLATE_SUBJECT,
  createOutboundWorld,
  type OutboundWorld,
} from './support/outboundWorld.ts';
import { prepareFor, seedFirm, type SeededFirm } from './support/dispatchFixtures.ts';

/**
 * The footer is composed at send, and the fence freezes what will be sent (lane W3-F;
 * the P0 list of `.context/reviews/GPT6-PR264-0019-20260926.md`).
 *
 * Five things are asserted here, each the answer to one of that review's P0s:
 *
 *   1. **Exactly one final stop line, whatever the address is doing.** The fence refuses
 *      to store a body without one, with two, or too long for its column; and a send goes
 *      out with one whether the address is set, changed or cleared.
 *   2. **The legacy block is removed and nothing else is.** `Hi Signed off` before the
 *      stop line keeps its words — the sign-off is never stripped a second time.
 *   3. **Fences prepared before the address are reconciled under the claim lock.** A
 *      `prepared` fence and a `held` one both leave with the current footer, and the
 *      ledger records the rewrite; a fence that cannot be recomposed is held for repair
 *      and nothing reaches Gmail.
 *   4. **The 4,000-character limit is a handled hold, never an exception.** Before the
 *      insert at prepare, and before the claim at dispatch.
 *   5. **Both approval shapes send.** The legacy body and the footerless one compose to
 *      the same bytes.
 *
 * ## The vacuous-pass traps, named
 *
 * **A "held" that proves nothing.** Every refusal names its reason *and* asserts Gmail was
 * not called, and each group ends with the same fence sending once the one fact is fixed.
 *
 * **Bytes asserted only where they were composed.** What Gmail received is compared with
 * what the fence stored and with `rendered_hash`, so a composition that happened after the
 * freeze would fail here.
 *
 * No real person, firm or address: `example.test` throughout, and the postal address is
 * invented.
 */

let world: OutboundWorld;

beforeAll(async () => {
  world = await createOutboundWorld();
}, 180_000);

afterAll(async () => {
  await world?.stop();
});

const ADDRESS = '1 Example Way, Suite 2\nProvidence, RI 02903';
const SIGN_OFF = 'Signed off';
const workspaceId = (): string => world.alpha.workspace.workspaceId;
const context = () => world.systemContext(workspaceId());
const why = (report: SendReport): string => `${report.outcome} ${report.refusal ?? ''} ${report.detail ?? ''}`;

/** The `postal_address` setting, as an admin's save leaves it: a new version each time. */
async function setPostalAddress(address: string | null): Promise<void> {
  await world.database.session.query(
    `UPDATE workspace_settings SET superseded_at = greatest(now(), changed_at),
            superseded_by_version = version + 1
      WHERE workspace_id = $1 AND setting_key = 'postal_address' AND superseded_at IS NULL`,
    [workspaceId()],
  );
  const { rows } = await world.database.session.query<{ next: number }>(
    `SELECT coalesce(max(version), 0) + 1 AS next FROM workspace_settings
      WHERE workspace_id = $1 AND setting_key = 'postal_address'`,
    [workspaceId()],
  );
  await world.database.session.query(
    `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, change_note, changed_by_user_id)
     VALUES ($1, 'postal_address', $2, $3::jsonb, 'fixture', $4)`,
    [workspaceId(), Number(rows[0]?.next ?? 1), JSON.stringify({ address }), world.alpha.workspace.admin.userId],
  );
}

async function dispatch(
  fenceId: string,
  overrides: Parameters<OutboundWorld['sendDeps']>[1] = {},
): Promise<{ readonly report: SendReport; readonly sent: readonly { readonly body: string }[] }> {
  const gmail = world.clientWith(world.alpha, {});
  const report = await dispatchOutboundMessage(
    context(),
    world.sendDeps(world.alpha, { gmail, ...overrides }),
    { outboundMessageId: fenceId },
  );
  return { report, sent: gmail.sends };
}

/** A fence with a body of the caller's choosing, through the real prepare. */
async function prepareBody(firm: SeededFirm, body: string): Promise<ReturnType<typeof prepareOutboundMessage>> {
  const stepExecutionId = await makeStepExecution(world.database.session, {
    workspaceId: workspaceId(),
    firmId: firm.firmId,
    opportunityId: firm.opportunityId,
    userId: world.alpha.workspace.salesperson.userId,
    templateVersionId: world.alpha.templateVersionId,
  });
  return prepareOutboundMessage(context(), {
    stepExecutionId,
    firmId: firm.firmId,
    contactId: firm.contactId,
    opportunityId: firm.opportunityId,
    ownerUserId: world.alpha.workspace.salesperson.userId,
    templateVersionId: world.alpha.templateVersionId,
    templateContentHash: world.alpha.templateContentHash,
    emailAddressId: firm.routeId,
    toAddress: firm.address,
    subject: TEMPLATE_SUBJECT,
    body,
    sendAt: '2026-09-23T09:00:00.000Z',
    sourceZone: 'UTC',
    businessDate: '2026-09-23',
  });
}

describe('the fence never freezes a body a send may not carry', () => {
  it('refuses a footerless body, a doubled stop line and one past 4,000 characters, and writes no row', async () => {
    const firm = await seedFirm(world, world.alpha, 'fence-guard');
    const before = await world.database.session.query<{ count: string }>(
      'SELECT count(*) AS count FROM outbound_messages WHERE workspace_id = $1',
      [workspaceId()],
    );
    for (const [body, detail] of [
      ['Just the words, no footer.', 'footer_missing'],
      [`${TEMPLATE_BODY}\n\n${TEMPLATE_BODY}`, 'stop_line_repeated'],
      [`${'x'.repeat(4001)}\n${SENDING_STOP_LINE}`, 'body_too_long'],
    ] as const) {
      expect(await prepareBody(firm, body), detail).toEqual({
        ok: false,
        reason: 'footer_not_composed',
        detail,
      });
    }
    const after = await world.database.session.query<{ count: string }>(
      'SELECT count(*) AS count FROM outbound_messages WHERE workspace_id = $1',
      [workspaceId()],
    );
    expect(Number(after.rows[0]?.count)).toBe(Number(before.rows[0]?.count));

    // The same firm, with bytes a send may carry: the guard refused the body and not
    // the world.
    const accepted = await prepareBody(firm, TEMPLATE_BODY);
    expect(accepted.ok).toBe(true);
  });
});

describe('a fence prepared before the address is reconciled under the claim lock', () => {
  it('rewrites the body and its hash, sends those bytes, and records the rewrite', async () => {
    await setPostalAddress(null);
    const firm = await seedFirm(world, world.alpha, 'reconcile-prepared');
    const fenceId = await prepareFor(world, world.alpha, firm);
    const frozen = await readFence(context(), fenceId);
    expect(frozen?.body).toBe(TEMPLATE_BODY);

    // The admin configures the address after the fence was prepared.
    await setPostalAddress(ADDRESS);
    await world.clearHolds(workspaceId());
    const { report, sent } = await dispatch(fenceId);
    expect(report.outcome, why(report)).toBe('sent');

    const composed = `Hello.\n\nI work with property managers nearby.\n\n${sendFooterBlock({
      signOff: SIGN_OFF,
      postalAddress: ADDRESS,
    })}`;
    expect(sent.at(-1)?.body).toBe(composed);
    expect(sent.at(-1)?.body.split(SENDING_STOP_LINE)).toHaveLength(2);

    // What left is what the fence froze, hash included.
    const after = await readFence(context(), fenceId);
    expect(after?.body).toBe(composed);
    expect(after?.renderedHash).toBe(renderedHash(TEMPLATE_SUBJECT, composed));

    const events = await readFenceEvents(context(), fenceId);
    expect(events.map(event => `${event.fromState ?? 'none'}->${event.toState}`)).toEqual([
      'none->prepared',
      'prepared->prepared',
      'prepared->dispatching',
      'dispatching->sent',
    ]);
    const ledger = await world.database.session.query<{ detail: { reason?: string } }>(
      `SELECT detail FROM outbound_message_events
        WHERE workspace_id = $1 AND outbound_message_id = $2 AND sequence_number = 2`,
      [workspaceId(), fenceId],
    );
    expect(ledger.rows[0]?.detail).toEqual({ reason: 'footer_composed_at_send' });
  });

  it('reconciles a held fence on the way through, and leaves an already-composed one untouched', async () => {
    await setPostalAddress(ADDRESS);
    const firm = await seedFirm(world, world.alpha, 'reconcile-held');
    const fenceId = await prepareFor(world, world.alpha, firm);
    expect((await holdFence(context(), { outboundMessageId: fenceId, reason: 'daily_cap' })).ok).toBe(true);
    await world.clearHolds(workspaceId());

    const { report, sent } = await dispatch(fenceId);
    expect(report.outcome, why(report)).toBe('sent');
    expect(sent.at(-1)?.body).toContain(ADDRESS);

    // A fence prepared now already carries those bytes: nothing is rewritten, and the
    // ledger has no reconciliation row.
    const second = await seedFirm(world, world.alpha, 'already-composed');
    const composed = await composeBodyForWorkspace(context(), { body: TEMPLATE_BODY, signOff: SIGN_OFF });
    expect(composed.composed).toBe(true);
    if (!composed.composed) return;
    const fresh = await prepareFor(world, world.alpha, second, { body: composed.body });
    await world.clearHolds(workspaceId());
    const again = await dispatch(fresh);
    expect(again.report.outcome, why(again.report)).toBe('sent');
    expect(again.sent.at(-1)?.body).toBe(composed.body);
    const events = await readFenceEvents(context(), fresh);
    expect(events.map(event => event.toState)).toEqual(['prepared', 'dispatching', 'sent']);
  });

  it('drops an address that was cleared, and still sends exactly one stop line', async () => {
    await setPostalAddress(ADDRESS);
    const firm = await seedFirm(world, world.alpha, 'address-cleared');
    const composed = await composeBodyForWorkspace(context(), { body: TEMPLATE_BODY, signOff: SIGN_OFF });
    expect(composed.composed && composed.body.includes(ADDRESS)).toBe(true);
    const fenceId = await prepareFor(world, world.alpha, firm, {
      body: composed.composed ? composed.body : TEMPLATE_BODY,
    });

    await setPostalAddress(null);
    await world.clearHolds(workspaceId());
    const { report, sent } = await dispatch(fenceId);
    expect(report.outcome, why(report)).toBe('sent');
    expect(sent.at(-1)?.body).toBe(TEMPLATE_BODY);
    expect(sent.at(-1)?.body).not.toContain(ADDRESS);
    expect(sent.at(-1)?.body.split(SENDING_STOP_LINE)).toHaveLength(2);
  });

  it('keeps every word of a body whose greeting ends with the sign-off (the `Hi David` bug)', async () => {
    await setPostalAddress(ADDRESS);
    const firm = await seedFirm(world, world.alpha, 'hi-david');
    const body = `Hello.\n\nHi Signed off\n${SENDING_STOP_LINE}`;
    const fenceId = await prepareFor(world, world.alpha, firm, { body });
    await world.clearHolds(workspaceId());

    const { report, sent } = await dispatch(fenceId);
    expect(report.outcome, why(report)).toBe('sent');
    expect(sent.at(-1)?.body).toBe(
      `Hello.\n\nHi Signed off\n\n${sendFooterBlock({ signOff: SIGN_OFF, postalAddress: ADDRESS })}`,
    );
    expect(sent.at(-1)?.body).toContain('Hi Signed off');
    expect(sent.at(-1)?.body.split(SENDING_STOP_LINE)).toHaveLength(2);
  });
});

describe('a body that cannot be composed is a handled hold', () => {
  it('holds the fence for repair when the address would push it past 4,000, and never calls Gmail', async () => {
    await setPostalAddress(null);
    const firm = await seedFirm(world, world.alpha, 'too-long');
    const footer = `${SIGN_OFF}\n${SENDING_STOP_LINE}`;
    const body = `${'x'.repeat(4000 - footer.length - 2)}\n\n${footer}`;
    const fenceId = await prepareFor(world, world.alpha, firm, { body });
    expect((await readFence(context(), fenceId))?.body).toHaveLength(4000);

    await setPostalAddress(ADDRESS);
    await world.clearHolds(workspaceId());
    const { report, sent } = await dispatch(fenceId);
    expect(report.outcome, why(report)).toBe('held');
    expect(report.refusal).toBe('footer_not_composed');
    expect(sent).toHaveLength(0);
    // Held for repair, with its bytes untouched: nothing was half-written.
    const held = await readFence(context(), fenceId);
    expect(held?.state).toBe('held');
    expect(held?.body).toBe(body);
    expect(held?.heldReason).toBe('footer_not_composed');

    // Clear the address and the same fence goes, with the bytes it always had: the
    // refusal was the length the address added and nothing else about this send.
    await setPostalAddress(null);
    await world.clearHolds(workspaceId());
    const again = await dispatch(fenceId);
    expect(again.report.outcome, why(again.report)).toBe('sent');
    expect(again.sent.at(-1)?.body).toBe(body);
  });
});

describe('the postal-address switch, in both positions', () => {
  it('sends without an address by default, and refuses every send when the switch is on', async () => {
    await setPostalAddress(null);
    const firm = await seedFirm(world, world.alpha, 'switch');
    const refused = await prepareFor(world, world.alpha, firm);
    await world.clearHolds(workspaceId());

    const strict = await dispatch(refused, { footerPolicy: { postalAddressRequired: true } });
    expect(strict.report.outcome, why(strict.report)).toBe('held');
    expect(strict.report.refusal).toBe('postal_address_required');
    expect(strict.sent).toHaveLength(0);

    // The default, which is what this release ships: no address, and the mail goes.
    await world.clearHolds(workspaceId());
    const { report, sent } = await dispatch(refused);
    expect(report.outcome, why(report)).toBe('sent');
    expect(sent.at(-1)?.body).toBe(TEMPLATE_BODY);

    // And the switch is about an absent address only: with one configured it sends.
    await setPostalAddress(ADDRESS);
    const second = await seedFirm(world, world.alpha, 'switch-configured');
    const fenceId = await prepareFor(world, world.alpha, second);
    await world.clearHolds(workspaceId());
    const strictWithAddress = await dispatch(fenceId, { footerPolicy: { postalAddressRequired: true } });
    expect(strictWithAddress.report.outcome, why(strictWithAddress.report)).toBe('sent');
    expect(strictWithAddress.sent.at(-1)?.body).toContain(ADDRESS);
  });

  it('answers the same at the seam the step calls, with no address configured', async () => {
    await setPostalAddress(null);
    expect(
      await composeBodyForWorkspace(context(), {
        body: TEMPLATE_BODY,
        signOff: SIGN_OFF,
        policy: { postalAddressRequired: true },
      }),
    ).toEqual({ composed: false, reason: 'postal_address_required' });
    expect(
      await composeBodyForWorkspace(context(), {
        body: TEMPLATE_BODY,
        signOff: SIGN_OFF,
        policy: { postalAddressRequired: false },
      }),
    ).toMatchObject({ composed: true, body: TEMPLATE_BODY, changed: false });
  });
});

describe('both approval shapes compose to the same bytes', () => {
  it('appends to a footerless body and dedupes a legacy one', async () => {
    await setPostalAddress(ADDRESS);
    const words = 'Hello.\n\nI work with property managers nearby.';
    const legacy = await composeBodyForWorkspace(context(), { body: TEMPLATE_BODY, signOff: SIGN_OFF });
    const footerless = await composeBodyForWorkspace(context(), { body: words, signOff: SIGN_OFF });
    expect(legacy.composed && footerless.composed).toBe(true);
    if (!legacy.composed || !footerless.composed) return;
    expect(legacy.body).toBe(footerless.body);
    expect(legacy.deduped).toBe(true);
    expect(footerless.deduped).toBe(false);
    expect(legacy.body).toBe(`${words}\n\n${sendFooterBlock({ signOff: SIGN_OFF, postalAddress: ADDRESS })}`);
  });
});
