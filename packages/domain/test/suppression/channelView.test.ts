import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { firstSuppressed } from '../../suppression/effective.ts';
import { suppressionSource } from '../../sequences/eligibility.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { insertStop, seedChannelFirm, stepInput, userContext, type ChannelFirm } from './support/channelWorld.ts';

/**
 * Contract check CC1 and test P1-2 (DESIGN-S3X §2.3, §2.6): `effective_suppressions` keeps
 * one row per (key, channel), so a key with a `phone` stop and a later `email` stop still
 * shows the `email` one to an e-mail reader. With the view's DISTINCT ON over the key
 * alone, the earlier `phone` row would hide it and an e-mail would leave.
 *
 * Fails on revert: put 0006's DISTINCT ON (workspace, scope, key) back in 0037 and the
 * first three cases fail.
 */
describe('effective_suppressions keeps one row per (key, channel)', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
  });

  afterAll(async () => {
    await database.drop();
  });

  const fresh = async (): Promise<ChannelFirm> => await seedChannelFirm(database.session, seeded.alpha);
  const stop = async (input: Parameters<typeof insertStop>[2]): Promise<string> =>
    await insertStop(database.session, seeded.alpha.workspaceId, input);
  const context = () => userContext(database.session, seeded.alpha);
  const emailRefusal = async (firm: ChannelFirm) =>
    await firstSuppressed(context(), [
      { scope: 'firm', canonicalKey: firm.firmId },
      { scope: 'handle', canonicalKey: firm.address },
    ], 'email');
  const dialRefusal = async (firm: ChannelFirm) =>
    await firstSuppressed(context(), [
      { scope: 'firm', canonicalKey: firm.firmId },
      { scope: 'handle', canonicalKey: firm.phone },
    ], 'phone');

  it('a firm with phone at t1 and email at t2 refuses e-mail and dialling', async () => {
    const firm = await fresh();
    await stop({ scope: 'firm', key: firm.firmId, channel: 'phone', at: '2026-10-01T10:00:00Z' });
    await stop({ scope: 'firm', key: firm.firmId, channel: 'email', at: '2026-10-01T11:00:00Z' });

    const { rows } = await database.session.query<{ channel: string }>(
      'SELECT channel FROM effective_suppressions WHERE workspace_id = $1 AND canonical_key = $2 ORDER BY channel',
      [seeded.alpha.workspaceId, firm.firmId],
    );
    expect(rows.map(row => row.channel)).toEqual(['email', 'phone']);

    expect(await emailRefusal(firm)).toMatchObject({ scope: 'firm', channel: 'email' });
    expect(await suppressionSource().evaluate(context(), stepInput(firm, 'email'))).toEqual({
      ok: false,
      reasonCode: 'firm_suppressed',
    });
    expect(await dialRefusal(firm)).toMatchObject({ scope: 'firm', channel: 'phone' });
    expect(await suppressionSource().evaluate(context(), stepInput(firm, 'call_task'))).toEqual({
      ok: false,
      reasonCode: 'firm_suppressed',
    });
  });

  it('the reverse order, email at t1 and phone at t2, refuses both as well', async () => {
    const firm = await fresh();
    await stop({ scope: 'firm', key: firm.firmId, channel: 'email', at: '2026-10-01T10:00:00Z' });
    await stop({ scope: 'firm', key: firm.firmId, channel: 'phone', at: '2026-10-01T11:00:00Z' });

    expect(await emailRefusal(firm)).toMatchObject({ scope: 'firm', channel: 'email' });
    expect(await dialRefusal(firm)).toMatchObject({ scope: 'firm', channel: 'phone' });
    expect(await suppressionSource().evaluate(context(), stepInput(firm, 'email'))).toMatchObject({ ok: false });
    expect(await suppressionSource().evaluate(context(), stepInput(firm, 'call_task'))).toMatchObject({ ok: false });
  });

  it('a number with phone then all refuses e-mail to the same person', async () => {
    const firm = await fresh();
    await stop({ scope: 'handle', key: firm.phone, channel: 'phone', at: '2026-10-01T10:00:00Z', source: 'prospect_do_not_call' });
    await stop({ scope: 'handle', key: firm.phone, channel: 'all', at: '2026-10-01T11:00:00Z', source: 'prospect_do_not_call' });

    expect(await suppressionSource().evaluate(context(), stepInput(firm, 'email'))).toEqual({
      ok: false,
      reasonCode: 'handle_suppressed',
    });
    expect(
      await firstSuppressed(context(), [{ scope: 'handle', canonicalKey: firm.phone }], 'email'),
    ).toMatchObject({ channel: 'all' });
  });

  it('a phone-only stop on the number leaves e-mail to the same person unrefused (the separation)', async () => {
    const firm = await fresh();
    await stop({ scope: 'handle', key: firm.phone, channel: 'phone', at: '2026-10-01T10:00:00Z', source: 'prospect_do_not_call' });
    expect(await suppressionSource().evaluate(context(), stepInput(firm, 'email'))).toEqual({ ok: true });
    expect(await emailRefusal(firm)).toBeNull();
    expect(await suppressionSource().evaluate(context(), stepInput(firm, 'call_task'))).toMatchObject({ ok: false });
  });

  it('after an admin supersedes the all row, e-mail is allowed and dialling is still refused', async () => {
    const firm = await fresh();
    await stop({ scope: 'handle', key: firm.phone, channel: 'phone', at: '2026-10-01T10:00:00Z', source: 'prospect_do_not_call' });
    const all = await stop({ scope: 'handle', key: firm.phone, channel: 'all', at: '2026-10-01T11:00:00Z', source: 'prospect_do_not_call' });
    expect(await suppressionSource().evaluate(context(), stepInput(firm, 'email'))).toMatchObject({ ok: false });

    await stop({ scope: 'handle', key: firm.phone, channel: 'all', at: '2026-10-01T12:00:00Z', supersedes: all });

    expect(await suppressionSource().evaluate(context(), stepInput(firm, 'email'))).toEqual({ ok: true });
    expect(await firstSuppressed(context(), [{ scope: 'handle', canonicalKey: firm.phone }], 'email')).toBeNull();
    expect(await dialRefusal(firm)).toMatchObject({ scope: 'handle', channel: 'phone' });
    expect(await suppressionSource().evaluate(context(), stepInput(firm, 'call_task'))).toEqual({
      ok: false,
      reasonCode: 'handle_suppressed',
    });
  });

  it('a row written without the column (an older binary) reads all and refuses every channel', async () => {
    const firm = await fresh();
    await stop({ scope: 'handle', key: firm.address, at: '2026-10-01T10:00:00Z' });
    expect(await emailRefusal(firm)).toMatchObject({ channel: 'all' });
    expect(await suppressionSource().evaluate(context(), stepInput(firm, 'call_task'))).toMatchObject({ ok: false });
  });
});
