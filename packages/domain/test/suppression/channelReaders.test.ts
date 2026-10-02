import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeStepExecution } from '../../db/testing/stepExecutions.ts';
import { readDashboard } from '../../dashboard/aggregate.ts';
import { adviseDial } from '../../dial/advise.ts';
import { authorizeDial } from '../../dial/authorize.ts';
import { readFence } from '../../outbound/fence.ts';
import { decideSend } from '../../outbound/gate.ts';
import { databaseNow } from '../../policy/clock.ts';
import { firmIsSuppressed } from '../../research/firmState.ts';
import { selectFirmsForSweep } from '../../research/sweep.ts';
import { suppressionSource } from '../../sequences/eligibility.ts';
import { consumeSuppressionStops } from '../../sequences/terminalStops.ts';
import { listEffectiveSuppressions } from '../../suppression/effective.ts';
import { claimFinalization } from '../../suppression/finalize.ts';
import { newFirmSource } from '../../today/build.ts';
import { readFirmStops } from '../../crm/firmPage.ts';
import { createOutboundWorld, type OutboundWorld } from '../outbound/support/outboundWorld.ts';
import { prepareFor, seedFirm, type SeededFirm } from '../outbound/support/dispatchFixtures.ts';
import { addPhones, insertStop, stepInput } from './support/channelWorld.ts';

/**
 * The reader table (DESIGN-S3X §1.3, §2.2, §2.5; the brief's CC3), one reader at a time on
 * real PostgreSQL, and tests P1-1, P1-3, P1-4 and P1-5 of §2.6.
 *
 * Every reader keeps its own key set and filters by its own channel:
 *
 *   | reader                                   | channel read      |
 *   |------------------------------------------|-------------------|
 *   | send gate (`decideSend`)                 | email             |
 *   | claim re-check (`decideStepPermission`)  | email             |
 *   | eligibility, e-mail step                 | email             |
 *   | eligibility, call-task step              | phone             |
 *   | terminal stops                           | email             |
 *   | dial authorisation and advice            | phone             |
 *   | Today new-firm lane                      | phone             |
 *   | research (sweep and gate)                | any               |
 *   | listing and dashboard                    | all channels      |
 *
 * Fails on revert: drop any reader's channel filter and its "not refused" case fails; take
 * the contact's addresses out of the dial keys and the address/`all` dial case fails.
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

interface Firm extends SeededFirm {
  readonly phone: string;
  readonly otherPhone: string;
  readonly phoneRouteId: string;
  readonly otherPhoneRouteId: string;
}

let labels = 0;
async function fresh(): Promise<Firm> {
  labels += 1;
  const firm = await seedFirm(world, world.alpha, `channels-${String(labels)}`);
  return { ...firm, ...(await addPhones(world.database.session, workspaceId(), firm)) };
}

type Channel = 'phone' | 'email' | 'all';
type Key = 'phone' | 'address' | 'firm';

/** One stop on the firm, the contact's number or the contact's address. */
async function stop(firm: Firm, key: Key, channel: Channel | undefined, source = 'prospect_opt_out'): Promise<string> {
  return await insertStop(world.database.session, workspaceId(), {
    scope: key === 'firm' ? 'firm' : 'handle',
    key: key === 'firm' ? firm.firmId : key === 'phone' ? firm.phone : firm.address,
    ...(channel === undefined ? {} : { channel }),
    at: new Date().toISOString(),
    source,
  });
}

describe('P1-1: the send gate and the claim re-check read the e-mail channel', () => {
  async function gate(setup: (firm: Firm) => Promise<unknown>): Promise<{ ok: boolean; reason?: string }> {
    const base = await fresh();
    const fenceId = await prepareFor(world, world.alpha, base);
    const fence = await readFence(system(), fenceId);
    if (fence === null) throw new Error('the fence disappeared');
    // The fence's own person and recipient (the world enrols a person of its own), with
    // numbers of their own.
    const contactId = fence.contactId ?? '';
    const phones = await addPhones(world.database.session, workspaceId(), { firmId: base.firmId, contactId });
    await setup({ ...base, contactId, address: fence.recipientAddress, ...phones });
    const decided = await decideSend(system(), fence, world.sendDeps(world.alpha));
    return decided.ok ? { ok: true } : { ok: false, reason: decided.reason };
  }

  it('sends with no stop at all (the baseline every refusal below is measured against)', async () => {
    expect(await gate(async () => undefined)).toEqual({ ok: true });
  });

  it('refuses the recipient address stopped for e-mail or for all', async () => {
    expect(await gate(firm => stop(firm, 'address', 'email'))).toEqual({ ok: false, reason: 'handle_suppressed' });
    expect(await gate(firm => stop(firm, 'address', 'all'))).toEqual({ ok: false, reason: 'handle_suppressed' });
  });

  it('refuses through the claim re-check when the person’s number is stopped for all', async () => {
    expect(await gate(firm => stop(firm, 'phone', 'all', 'prospect_do_not_call'))).toEqual({
      ok: false,
      reason: 'handle_suppressed',
    });
  });

  it('refuses the firm stopped for e-mail or for all', async () => {
    expect(await gate(firm => stop(firm, 'firm', 'email'))).toEqual({ ok: false, reason: 'firm_suppressed' });
    expect(await gate(firm => stop(firm, 'firm', 'all'))).toEqual({ ok: false, reason: 'firm_suppressed' });
  });

  it('refuses a stop written without the column, as an older binary writes it', async () => {
    expect(await gate(firm => stop(firm, 'address', undefined))).toEqual({ ok: false, reason: 'handle_suppressed' });
  });

  it('does not refuse for suppression when only calls are stopped, for the person or the firm', async () => {
    expect(await gate(firm => stop(firm, 'phone', 'phone', 'prospect_do_not_call'))).toEqual({ ok: true });
    expect(await gate(firm => stop(firm, 'firm', 'phone', 'prospect_do_not_call'))).toEqual({ ok: true });
  });
});

describe('P1-3: eligibility, at preparation and at the claim, reads the step’s channel', () => {
  // [key, channel, e-mail step refused as, call-task step refused as] — §2.2's rows.
  const ROWS: readonly (readonly [Key, Channel, string | null, string | null])[] = [
    ['phone', 'phone', null, 'handle_suppressed'],
    ['phone', 'all', 'handle_suppressed', 'handle_suppressed'],
    ['address', 'email', 'handle_suppressed', null],
    ['address', 'all', 'handle_suppressed', 'handle_suppressed'],
    ['firm', 'phone', null, 'firm_suppressed'],
    ['firm', 'email', 'firm_suppressed', null],
    ['firm', 'all', 'firm_suppressed', 'firm_suppressed'],
  ];
  for (const [key, channel, email, call] of ROWS) {
    it(`${key} / ${channel}: e-mail ${email ?? 'allowed'}, call task ${call ?? 'allowed'}`, async () => {
      const firm = await fresh();
      await stop(firm, key, channel);
      const asked = async (step: 'email' | 'call_task') => await suppressionSource().evaluate(system(), stepInput(firm, step));
      expect(await asked('email')).toEqual(email === null ? { ok: true } : { ok: false, reasonCode: email });
      expect(await asked('call_task')).toEqual(call === null ? { ok: true } : { ok: false, reasonCode: call });
    });
  }
});

describe('P1-4: terminal stops end an enrollment for email and all only', () => {
  async function enrolled(): Promise<{ firm: Firm; enrollmentId: string; executionId: string }> {
    const base = await fresh();
    const executionId = await makeStepExecution(world.database.session, {
      workspaceId: workspaceId(),
      firmId: base.firmId,
      opportunityId: base.opportunityId,
      userId: world.alpha.workspace.salesperson.userId,
      templateVersionId: world.alpha.templateVersionId,
    });
    const { rows } = await world.database.session.query<{ enrollment_id: string; contact_id: string; address: string }>(
      `SELECT x.enrollment_id, x.contact_id, a.address
         FROM step_executions x JOIN email_addresses a ON a.workspace_id = x.workspace_id AND a.contact_id = x.contact_id
        WHERE x.workspace_id = $1 AND x.id = $2`,
      [workspaceId(), executionId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('no enrollment');
    // The enrolled person, with numbers of their own.
    const phones = await addPhones(world.database.session, workspaceId(), { firmId: base.firmId, contactId: row.contact_id });
    return { firm: { ...base, contactId: row.contact_id, address: row.address, ...phones }, enrollmentId: row.enrollment_id, executionId };
  }
  const ended = async (enrollmentId: string): Promise<boolean> => {
    const { rows } = await world.database.session.query<{ ended: boolean }>(
      'SELECT ended_at IS NOT NULL AS ended FROM sequence_enrollments WHERE workspace_id = $1 AND id = $2',
      [workspaceId(), enrollmentId],
    );
    return rows[0]?.ended === true;
  };
  async function finalizedStop(firm: Firm, key: Key, channel: Channel): Promise<void> {
    const eventId = await stop(firm, key, channel);
    await claimFinalization(system(), { eventId, outcome: 'finalized' });
    await consumeSuppressionStops(system(), { limit: 500 });
  }

  for (const [key, channel] of [['address', 'email'], ['address', 'all'], ['phone', 'all'], ['firm', 'email'], ['firm', 'all']] as const) {
    it(`${key} / ${channel} stops the enrollment`, async () => {
      const { firm, enrollmentId } = await enrolled();
      await finalizedStop(firm, key, channel);
      expect(await ended(enrollmentId)).toBe(true);
    });
  }

  for (const [key, held] of [['phone', 'handle_suppressed'], ['firm', 'firm_suppressed']] as const) {
    it(`${key} / phone leaves the enrollment running, and its call-task step held ${held}`, async () => {
      const { firm, enrollmentId } = await enrolled();
      await finalizedStop(firm, key, 'phone');
      expect(await ended(enrollmentId)).toBe(false);
      expect(await suppressionSource().evaluate(system(), stepInput(firm, 'call_task'))).toEqual({ ok: false, reasonCode: held });
      expect(await suppressionSource().evaluate(system(), stepInput(firm, 'email'))).toEqual({ ok: true });
    });
  }
});

describe('P1-5: dialling and the dial advice read the phone channel, with the contact’s addresses as keys', () => {
  async function dial(firm: Firm, routeId: string): Promise<string> {
    const decided = await authorizeDial(salesperson(), {
      firmId: firm.firmId,
      contactId: firm.contactId,
      routeId,
      routeVersion: 1,
      // No such identity: a dial not refused for suppression is refused here instead, the
      // step after suppression, which is how "passes suppression" is told apart.
      callingIdentityId: randomUUID(),
      at: await databaseNow(system()),
    });
    if (decided.allowed) throw new Error('a dial with no identity was allowed');
    return decided.reason;
  }
  const advice = async (firm: Firm, routeId: string): Promise<readonly string[]> =>
    (await adviseDial(salesperson(), { firmId: firm.firmId, routeId }))?.reasons ?? [];

  it('refuses the dialled number stopped for calls, and the person’s other number', async () => {
    const firm = await fresh();
    await stop(firm, 'phone', 'phone', 'prospect_do_not_call');
    expect(await dial(firm, firm.phoneRouteId)).toBe('handle_suppressed');
    expect(await dial(firm, firm.otherPhoneRouteId)).toBe('handle_suppressed');
    expect(await advice(firm, firm.phoneRouteId)).toContain('handle_suppressed');
    expect(await advice(firm, firm.otherPhoneRouteId)).toContain('handle_suppressed');
  });

  it('allows a call when only the person’s e-mail is stopped (P2)', async () => {
    const firm = await fresh();
    await stop(firm, 'address', 'email');
    expect(await dial(firm, firm.phoneRouteId)).toBe('identity_missing');
    expect(await advice(firm, firm.phoneRouteId)).not.toContain('handle_suppressed');
  });

  it('refuses a call when the person’s address is stopped for all (an existing opt-out, §0.1)', async () => {
    const firm = await fresh();
    await stop(firm, 'address', 'all');
    expect(await dial(firm, firm.phoneRouteId)).toBe('handle_suppressed');
    expect(await advice(firm, firm.phoneRouteId)).toContain('handle_suppressed');
  });

  it('allows a call when the firm stopped only e-mail, refuses one when it stopped calls', async () => {
    const emailOnly = await fresh();
    await stop(emailOnly, 'firm', 'email');
    expect(await dial(emailOnly, emailOnly.phoneRouteId)).toBe('identity_missing');
    expect(await advice(emailOnly, emailOnly.phoneRouteId)).not.toContain('firm_suppressed');
    const callsOnly = await fresh();
    await stop(callsOnly, 'firm', 'phone', 'prospect_do_not_call');
    expect(await dial(callsOnly, callsOnly.phoneRouteId)).toBe('firm_suppressed');
    expect(await advice(callsOnly, callsOnly.phoneRouteId)).toContain('firm_suppressed');
  });
});

describe('the Today new-firm lane is a call list', () => {
  const listed = async (firm: Firm): Promise<boolean> => {
    const now = await databaseNow(system());
    const found = await newFirmSource().find(system(), {
      businessDate: '2026-10-02',
      businessTimeZone: 'America/New_York',
      now,
      firmId: firm.firmId,
    });
    return found.some(item => item.firmId === firm.firmId);
  };

  it('lists a firm that stopped only e-mail, and leaves out one that stopped calls or everything', async () => {
    const none = await fresh();
    expect(await listed(none)).toBe(true);
    const email = await fresh();
    await stop(email, 'firm', 'email');
    expect(await listed(email)).toBe(true);
    const phone = await fresh();
    await stop(phone, 'firm', 'phone', 'prospect_do_not_call');
    expect(await listed(phone)).toBe(false);
    const all = await fresh();
    await stop(all, 'firm', 'all');
    expect(await listed(all)).toBe(false);
  });
});

describe('research reads any channel (unchanged, conservative)', () => {
  it('treats a firm stopped on either channel as not researchable', async () => {
    for (const channel of ['phone', 'email', 'all'] as const) {
      const firm = await fresh();
      expect(await firmIsSuppressed(system(), firm.firmId)).toBe(false);
      await stop(firm, 'firm', channel);
      expect(await firmIsSuppressed(system(), firm.firmId), channel).toBe(true);
      const swept = await selectFirmsForSweep(system(), { limit: 10_000, at: await databaseNow(system()) });
      expect(swept.some(candidate => candidate.firmId === firm.firmId), channel).toBe(false);
    }
  });
});

describe('the listing, the dashboard and the firm page see every channel', () => {
  it('lists one row per (key, channel) and counts every channel on the dashboard', async () => {
    const firm = await fresh();
    const before = await readDashboard(system(), {
      window: { from: '2026-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' },
    });
    const firmCount = (counts: readonly { key: string | null; count: number }[]): number =>
      counts.find(entry => entry.key === 'firm')?.count ?? 0;
    await stop(firm, 'firm', 'phone', 'prospect_do_not_call');
    await stop(firm, 'firm', 'email');
    const listed = await listEffectiveSuppressions(system(), { scope: 'firm', limit: 10_000 });
    expect(listed.filter(entry => entry.canonicalKey === firm.firmId).map(entry => entry.channel).sort()).toEqual(['email', 'phone']);
    const after = await readDashboard(system(), {
      window: { from: '2026-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' },
    });
    expect(firmCount(after.suppressions) - firmCount(before.suppressions)).toBe(2);
  });

  it('gives the firm page each channel the firm and each contact is stopped on', async () => {
    const firm = await fresh();
    expect(await readFirmStops(system(), firm.firmId)).toEqual({ firm: [], contacts: [] });
    await stop(firm, 'firm', 'phone', 'prospect_do_not_call');
    await stop(firm, 'address', 'email');
    expect(await readFirmStops(system(), firm.firmId)).toEqual({
      firm: ['phone'],
      contacts: [{ contactId: firm.contactId, email: true, phone: false }],
    });
    await stop(firm, 'phone', 'all', 'prospect_do_not_call');
    expect(await readFirmStops(system(), firm.firmId)).toEqual({
      firm: ['phone'],
      contacts: [{ contactId: firm.contactId, email: true, phone: true }],
    });
  });
});
