import { afterEach, describe, expect, it } from 'vitest';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { readFirmStops } from '../../crm/firmPage.ts';
import { mergeFirms } from '../../crm/merges.ts';
import { withTransaction } from '../../db/queryable.ts';
import { createTestDatabase } from '../../db/testing/testDatabase.ts';
import { adviseDial } from '../../dial/advise.ts';
import { runMailRecovery } from '../../mail/recover.ts';
import { runMailSync } from '../../mail/sync.ts';
import { firstSuppressed } from '../../suppression/effective.ts';
import { suppressionSource } from '../../sequences/eligibility.ts';
import { seedTwoWorkspaces } from '../db/support/fixtures.ts';
import { createMailWorld, fixtureMessage, type MailWorld } from '../mail/support/mailWorld.ts';
import { insertStop, seedChannelFirm, stepInput, userContext } from './support/channelWorld.ts';

/**
 * Tests P1-9 and P1-10 (DESIGN-S3X §2.6).
 *
 * P1-9, David's P2 end to end: an imported opt-out ("Please stop emailing me.") matched to one
 * firm writes a handle stop and a firm stop, both `email`. E-mail to the person and the firm
 * is refused; calling them is not; the firm page says "Email stopped" (the desktop turns
 * `{ email: true, phone: false }` into those words).
 *
 * P1-10: a firm merge carries each firm stop to the target with its own channel.
 */

let world: MailWorld | null = null;

afterEach(async () => {
  await world?.stop();
  world = null;
});

const PROSPECT = 'reception@northwind.example.test';

describe('P1-9: an e-mail opt-out stops e-mail only (P2)', () => {
  it('writes handle/email and firm/email; e-mail is refused, calling is not, and the firm page says so', async () => {
    world = await createMailWorld();
    const w = world;
    const workspaceId = w.alpha.workspace.workspaceId;
    const context = w.systemContext(workspaceId);
    const baseline = await runMailRecovery(context, w.syncDeps(w.alpha), { mailboxId: w.alpha.mailboxId, generation: 1 });
    expect(baseline.outcome).toBe('completed');

    w.alpha.messages.push(fixtureMessage({ id: 'optout-channels', historyId: '1013', from: PROSPECT, to: w.alpha.address, body: 'Please stop emailing me.' }));
    const report = await runMailSync(context, w.syncDeps(w.alpha), { mailboxId: w.alpha.mailboxId });
    expect(report.suppressionsRecorded).toBe(2);

    const { rows } = await w.database.session.query<{ stop: string }>(
      "SELECT scope || '/' || channel AS stop FROM suppression_events WHERE workspace_id = $1 ORDER BY scope",
      [workspaceId],
    );
    expect(rows.map(row => row.stop)).toEqual(['firm/email', 'handle/email']);
    // The journal carries the channel too.
    expect(w.journal.appended.map(record => record.channel)).toEqual(['email', 'email']);

    const firm = w.crm.alpha;
    // E-mail: the gate's keys and the step's union both refuse.
    expect(
      await firstSuppressed(context, [{ scope: 'firm', canonicalKey: firm.firmId }, { scope: 'handle', canonicalKey: PROSPECT }], 'email'),
    ).not.toBeNull();
    expect(await suppressionSource().evaluate(context, stepInput({ firmId: firm.firmId, contactId: firm.contactId }, 'email'))).toEqual({
      ok: false,
      reasonCode: 'firm_suppressed',
    });
    // Calling: neither the person nor the firm is stopped for it.
    const route = await w.database.session.query<{ id: string }>(
      'SELECT id FROM phone_routes WHERE workspace_id = $1 AND firm_id = $2 LIMIT 1',
      [workspaceId, firm.firmId],
    );
    const advice = await adviseDial(w.userContext(workspaceId), { firmId: firm.firmId, routeId: route.rows[0]?.id ?? '' });
    expect(advice?.reasons ?? []).not.toContain('handle_suppressed');
    expect(advice?.reasons ?? []).not.toContain('firm_suppressed');
    expect(await suppressionSource().evaluate(context, stepInput({ firmId: firm.firmId, contactId: firm.contactId }, 'call_task'))).toEqual({
      ok: true,
    });
    // The firm page: "Email stopped" on the firm and on the person.
    expect(await readFirmStops(context, firm.firmId)).toEqual({
      firm: ['email'],
      contacts: [{ contactId: firm.contactId, email: true, phone: false }],
    });
  });
});

describe('P1-10: a merge keeps each firm stop’s channel', () => {
  it('re-asserts phone and email stops on the target as phone and email', async () => {
    const database = await createTestDatabase();
    try {
      const seeded = await seedTwoWorkspaces(database.session);
      const source = await seedChannelFirm(database.session, seeded.alpha);
      const target = await seedChannelFirm(database.session, seeded.alpha);
      for (const channel of ['phone', 'email'] as const) {
        await insertStop(database.session, seeded.alpha.workspaceId, {
          scope: 'firm',
          key: source.firmId,
          channel,
          at: new Date().toISOString(),
          source: channel === 'phone' ? 'prospect_do_not_call' : 'prospect_opt_out',
        });
      }
      const merged = await withTransaction(database.session, async () =>
        await mergeFirms(userContext(database.session, seeded.alpha, 'admin'), { journal: recordingSuppressionJournal(), sourceFirmId: source.firmId, targetFirmId: target.firmId }),
      );
      expect(merged.ok, JSON.stringify(merged)).toBe(true);
      const { rows } = await database.session.query<{ channel: string; source: string }>(
        `SELECT channel, source FROM suppression_events
          WHERE workspace_id = $1 AND scope = 'firm' AND canonical_key = $2 ORDER BY channel`,
        [seeded.alpha.workspaceId, target.firmId],
      );
      expect(rows).toEqual([
        { channel: 'email', source: 'prospect_opt_out' },
        { channel: 'phone', source: 'prospect_do_not_call' },
      ]);
      // And so the target is stopped exactly as the source was: e-mail and calls, separately.
      expect(await readFirmStops(userContext(database.session, seeded.alpha), target.firmId)).toMatchObject({ firm: ['email', 'phone'] });
    } finally {
      await database.drop();
    }
  });
});
