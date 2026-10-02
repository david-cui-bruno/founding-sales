import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionQueryable } from '../../db/queryable.ts';
import { withTransaction } from '../../db/queryable.ts';
import { logCallOutcome } from '../../dial/calls.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { createApplyWorld, type ApplyWorld } from './support/applyWorld.ts';

/**
 * S3X contract check CC4 (DESIGN-S3X §5): one UPDATE can change a logged outcome and clear
 * the agreement under migration 0036's `call_logs_agreement_needs_interest`, with
 * `app_runtime`'s privileges.
 *
 *   * `interested` → `no_answer` with the agreement kept: refused by that CHECK;
 *   * the same UPDATE with `agreed_*` set to NULL in the same statement: accepted.
 *
 * Real PostgreSQL, as the application role (not the superuser).
 */
describe('CC4: the outcome UPDATE and the agreement CHECK, as app_runtime', () => {
  let world: ApplyWorld;
  let runtime: SessionQueryable;
  let templateVersionId: string;

  beforeAll(async () => {
    world = await createApplyWorld();
    runtime = await world.connection();
    const firm = await world.newFirm();
    const { rows } = await world.session.query<{ id: string }>(
      `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body,
                                      content_hash, footer_sign_off, approved_at, approved_by_user_id)
       SELECT w.workspace_id, gen_random_uuid(), 1, 'The overview', 'A question about {firm_name}',
              'Hello {contact_first_name}.', encode(sha256(random()::text::bytea), 'hex'), 'Sam Example', now(), w.user_id
         FROM workspace_memberships w
        WHERE w.workspace_id = (SELECT workspace_id FROM firms WHERE id = $1) AND w.role = 'admin'
        LIMIT 1
       RETURNING id`,
      [firm.firmId],
    );
    templateVersionId = rows[0]?.id ?? '';
  });
  afterAll(async () => {
    await world.drop();
  });

  async function interestedLogWithAgreement(): Promise<string> {
    const firm = await world.newFirm();
    const logged = await withTransaction(runtime, async () =>
      await logCallOutcome(world.salesperson(runtime), {
        firmId: firm.firmId,
        contactId: firm.contactId,
        routeId: firm.routeId,
        outcome: 'interested',
        followUpPermission: { scope: 'single_email', templateVersionId },
        commandId: `cc4-${firm.firmId}`,
        journal: recordingSuppressionJournal(),
      }),
    );
    if (!logged.ok) throw new Error(logged.reason);
    const { rows } = await world.session.query<{ agreed_follow_up: string | null }>(
      'SELECT agreed_follow_up FROM call_logs WHERE id = $1',
      [logged.value.callLogId],
    );
    expect(rows[0]?.agreed_follow_up).toBe('single_email');
    return logged.value.callLogId;
  }

  it('refuses interested → no_answer while the agreement is kept', async () => {
    const id = await interestedLogWithAgreement();
    await expect(
      withTransaction(runtime, async () =>
        await runtime.query("UPDATE call_logs SET outcome = 'no_answer' WHERE workspace_id = $1 AND id = $2", [
          world.seeded.alpha.workspaceId,
          id,
        ]),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'call_logs_agreement_needs_interest' });
    const { rows } = await world.session.query<{ outcome: string }>('SELECT outcome FROM call_logs WHERE id = $1', [id]);
    expect(rows[0]?.outcome).toBe('interested');
  });

  it('accepts the same UPDATE when the agreement columns are cleared in the same statement', async () => {
    const id = await interestedLogWithAgreement();
    const updated = await withTransaction(runtime, async () =>
      await runtime.query(
        `UPDATE call_logs
            SET outcome = 'no_answer', agreed_follow_up = NULL, agreed_template_version_id = NULL, agreed_sequence_version_id = NULL
          WHERE workspace_id = $1 AND id = $2`,
        [world.seeded.alpha.workspaceId, id],
      ),
    );
    expect(updated.rowCount).toBe(1);
    const { rows } = await world.session.query<{ outcome: string; agreed_follow_up: string | null; current_user: string }>(
      'SELECT outcome, agreed_follow_up FROM call_logs WHERE id = $1',
      [id],
    );
    expect(rows[0]).toMatchObject({ outcome: 'no_answer', agreed_follow_up: null });
    // The runtime session really is the application role.
    const { rows: role } = await runtime.query<{ role: string }>('SELECT current_user AS role');
    expect(role[0]?.role).toBe('app_runtime');
  });
});
