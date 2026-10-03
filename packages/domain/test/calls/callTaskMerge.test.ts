import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { mergeFirms } from '../../crm/merges.ts';
import { withTransaction } from '../../db/queryable.ts';
import { callTaskSource } from '../../today/build.ts';
import { createApplyWorld, type ApplyWorld } from './support/applyWorld.ts';

/**
 * Slice 3a, lane B — review S3B, finding 6: a firm merge carries every call task to the firm
 * that survives. One with a contact follows it by the contact key's cascade; one with no
 * contact ("Send overview" at a firm with nobody named) used to stay on the merged source,
 * where Today never reads it.
 */
describe('a firm merge carries the call tasks', () => {
  let world: ApplyWorld;

  beforeAll(async () => {
    world = await createApplyWorld();
  });
  afterAll(async () => {
    await world.drop();
  });

  it('moves the contactless task and the contact-linked one to the target, and Today reads both there', async () => {
    const target = await world.newFirm();
    const workspaceId = world.seeded.alpha.workspaceId;
    const { rows: source } = await world.session.query<{ id: string }>(
      `INSERT INTO firms (workspace_id, name, assigned_user_id) VALUES ($1, $2, $3) RETURNING id`,
      [workspaceId, 'Merge Source Test Firm', world.seeded.alpha.salesperson.userId],
    );
    const sourceId = source[0]?.id ?? '';
    const { rows: contact } = await world.session.query<{ id: string }>(
      `INSERT INTO contacts (workspace_id, firm_id, full_name, title, is_primary) VALUES ($1, $2, 'Quinn Example', 'Partner', false) RETURNING id`,
      [workspaceId, sourceId],
    );
    const insertTask = async (contactId: string | null, text: string, key: string): Promise<string> =>
      (
        await world.session.query<{ id: string }>(
          `INSERT INTO call_tasks (workspace_id, firm_id, contact_id, quote_key, text, due_at, created_by_user_id)
           VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $6) RETURNING id`,
          [workspaceId, sourceId, contactId, key, text, world.seeded.alpha.salesperson.userId],
        )
      ).rows[0]?.id ?? '';
    const contactless = await insertTask(null, 'Send overview', `task:${'a'.repeat(16)}`);
    const withContact = await insertTask(contact[0]?.id ?? null, 'Send Quinn the pricing sheet', `task:${'b'.repeat(16)}`);

    const merged = await withTransaction(world.session, async () =>
      await mergeFirms(world.admin(), { journal: recordingSuppressionJournal(), sourceFirmId: sourceId, targetFirmId: target.firmId, resolutions: { name: 'target' } }),
    );
    expect(merged, JSON.stringify(merged)).toMatchObject({ ok: true });
    const { rows: moved } = await world.session.query<{ id: string; firm_id: string }>(
      'SELECT id, firm_id FROM call_tasks WHERE id = ANY($1::uuid[]) ORDER BY text',
      [[contactless, withContact]],
    );
    expect(moved.map(row => row.firm_id)).toEqual([target.firmId, target.firmId]);

    // Today's source finds both at the surviving firm.
    const { rows: clock } = await world.session.query<{ now: Date; date: string }>(
      "SELECT now() AS now, (now() AT TIME ZONE 'America/New_York')::date::text AS date",
    );
    const found = await callTaskSource().find(world.system(), {
      businessDate: clock[0]?.date ?? '',
      businessTimeZone: 'America/New_York',
      now: (clock[0]?.now ?? new Date()).toISOString(),
      firmId: target.firmId,
    });
    expect(new Set(found.map(item => item.sourceId))).toEqual(new Set([contactless, withContact]));
  });
});
