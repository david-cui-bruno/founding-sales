import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { enrollContact } from '../../sequences/enrollments.ts';
import { commitDeletion, previewDeletion } from '../../retention/deletion.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedMail, type SeededMail } from '../db/support/mailFixtures.ts';
import { seedSequences, type SeededSequences } from '../sequences/support/sequenceFixtures.ts';

/**
 * What the deletion workflow does to the tables three other lanes brought
 * (specification 10.3, 11.2, 12.5).
 *
 * `deletion.test.ts` covers the sentence itself against the CRM and the mail tables.
 * This file covers the part that could only be written once G7b, G8 and G7-2 were on
 * main, and each case is one of the three things those tables made true (a fourth, the
 * recorded LinkedIn reply, went with its table in migration 0018):
 *
 *   - a reply confirmation is removed *before* the callback it references, because
 *     otherwise the callback delete fails on a foreign key;
 *   - a live enrollment and its unexecuted steps are terminally stopped rather than
 *     deleted, because 11.1 requires executed history preserved and nothing may act
 *     on the plan again;
 *   - an email address frozen into a dispatched fence cannot be removed, so the
 *     preview says so rather than letting the commit fail or lie.
 *
 * Every one of those was a line in `PENDING_RETENTION_TABLES` before it was a test.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let mail: SeededMail;
let sequences: SeededSequences;
let enrollmentId: string;
let pinnedRouteId: string;
let detachableRouteId: string;
let dispatchedFenceId: string;
let preparedFenceId: string;
let callbackId: string;

const adminContext = (workspaceId: string, userId: string): RepositoryContext =>
  repositoryContext(workspaceScope(workspaceId, { kind: 'user', userId, role: 'admin' }), database.session);

const count = async (sql: string, values: readonly unknown[]): Promise<number> => {
  const { rows } = await database.session.query<{ count: string }>(sql, values);
  return Number(rows[0]?.count ?? '0');
};

const one = async (sql: string, values: readonly unknown[]): Promise<string> => {
  const { rows } = await database.session.query<{ id: string }>(sql, values);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`the fixture insert returned no row: ${sql.slice(0, 60)}`);
  return id;
};

/**
 * One fence, with the envelope columns 0010 requires and a route pinned into it.
 *
 * `dispatched` is what makes the difference this file is about: a fence with an
 * attempt token has a frozen envelope and `DELETE` on the table is revoked, so the
 * route it names cannot go. A prepared fence has neither, so the route can.
 */
async function fence(
  label: string,
  routeId: string,
  address: string,
  dispatched: boolean,
): Promise<string> {
  return one(
    `INSERT INTO outbound_messages
       (workspace_id, mailbox_id, state, origin_kind, draft_id, firm_id, contact_id,
        recipient_address, recipient_route_id, recipient_route_version,
        subject, body, rendered_hash, provider_message_id_header, send_at, source_zone,
        placement_rule_version, attempt_token, dispatch_started_at, sent_at, provider_message_id)
     VALUES ($1, $2, $3, 'draft', gen_random_uuid(), $4, $5,
             $6, $7, 1,
             $8, 'The fence that pinned a route.', $9, $10, now(), 'America/New_York',
             'placement.1',
             CASE WHEN $11 THEN gen_random_uuid() END,
             CASE WHEN $11 THEN now() END,
             CASE WHEN $11 THEN now() END,
             CASE WHEN $11 THEN 'provider-' || $8 END)
     RETURNING id`,
    [
      seeded.alpha.workspaceId,
      mail.alpha.mailboxId,
      dispatched ? 'sent' : 'prepared',
      crm.alpha.firmId,
      crm.alpha.contactId,
      address,
      routeId,
      label,
      'd'.repeat(64),
      `<fss.${label}.alpha@example.test>`,
      dispatched,
    ],
  );
}

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, seeded);
  mail = await seedMail(database.session, seeded, crm);
  sequences = await seedSequences(database.session, seeded);

  // G8: a live enrollment with its unexecuted steps, made by the real command so the
  // rows are the ones the lane writes rather than the ones this file imagines.
  const enrolled = await enrollContact(
    repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, {
        kind: 'user',
        userId: seeded.alpha.salesperson.userId,
        role: 'salesperson',
      }),
      database.session,
    ),
    {
      sequenceVersionId: sequences.alpha.publishedVersionId,
      opportunityId: crm.alpha.opportunityId,
      firmId: crm.alpha.firmId,
      contactId: crm.alpha.contactId,
    },
  );
  if (!enrolled.ok) throw new Error(`the enrollment fixture was refused: ${enrolled.reason}`);
  enrollmentId = enrolled.value.enrollmentId;

  // G7b: a confirmation whose consequence was a committed callback, which is the
  // ordering this file exists to pin.
  callbackId = await one(
    `INSERT INTO callbacks
       (workspace_id, firm_id, contact_id, opportunity_id, assigned_user_id, requested_local_date,
        source_time_zone, due_at, confirmed_at, confirmed_by_user_id)
     VALUES ($1, $2, $3, $4, $5, DATE '2026-10-01', 'America/New_York',
             TIMESTAMPTZ '2026-10-01T14:00:00Z', now(), $5)
     RETURNING id`,
    [
      seeded.alpha.workspaceId,
      crm.alpha.firmId,
      crm.alpha.contactId,
      crm.alpha.opportunityId,
      seeded.alpha.salesperson.userId,
    ],
  );
  await database.session.query(
    `INSERT INTO mail_reply_confirmations
       (workspace_id, mail_message_id, firm_id, opportunity_id, disposition, suggested_disposition,
        suggested_by, corrected, confirmed_by_user_id, consequences, callback_id)
     VALUES ($1, $2, $3, $4, 'follow_up_later', 'follow_up_later', 'model', false, $5,
             ARRAY['callback_committed']::text[], $6)`,
    [
      seeded.alpha.workspaceId,
      mail.alpha.messageId,
      crm.alpha.firmId,
      crm.alpha.opportunityId,
      seeded.alpha.salesperson.userId,
      callbackId,
    ],
  );

  // G7-2: two routes, one pinned into a dispatched fence and one into a prepared one.
  pinnedRouteId = await one(
    `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at)
     VALUES ($1, $2, $3, 'pinned@northwind.example.test', 'salesperson', now()) RETURNING id`,
    [seeded.alpha.workspaceId, crm.alpha.firmId, crm.alpha.contactId],
  );
  detachableRouteId = await one(
    `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at)
     VALUES ($1, $2, $3, 'detachable@northwind.example.test', 'salesperson', now()) RETURNING id`,
    [seeded.alpha.workspaceId, crm.alpha.firmId, crm.alpha.contactId],
  );
  dispatchedFenceId = await fence('sent-fence', pinnedRouteId, 'pinned@northwind.example.test', true);
  preparedFenceId = await fence('prepared-fence', detachableRouteId, 'detachable@northwind.example.test', false);
});

afterAll(async () => {
  await database.drop();
});

describe('the preview tells an approver about the rows the other lanes brought', () => {
  it('counts the stops separately from the removals, and names the routes it cannot remove', async () => {
    const outcome = await previewDeletion(adminContext(seeded.alpha.workspaceId, seeded.alpha.admin.userId), {
      targetKind: 'firm',
      firmId: crm.alpha.firmId,
    });
    expect(outcome.ok, outcome.reason).toBe(true);
    const preview = outcome.value;

    // Stops are their own map: stopping a plan is not blanking a name.
    expect(preview?.stops['sequence_enrollments']).toBe(1);
    expect(preview?.stops['step_executions']).toBeGreaterThan(0);
    // Removals. The LinkedIn results table went with migration 0018.
    expect(preview?.removes).not.toHaveProperty('enrollment_linkedin_results');
    expect(preview?.removes['mail_reply_confirmations']).toBe(1);
    // And the honest line: one route is frozen into a fence that has dispatched.
    expect(preview?.retains['email_addresses_pinned_by_a_sent_fence']).toBe(1);
    // Nothing was touched by the preview itself.
    expect(
      await count('SELECT count(*) AS count FROM mail_reply_confirmations WHERE workspace_id = $1', [
        seeded.alpha.workspaceId,
      ]),
    ).toBe(1);
  });
});

describe('the deletion commit against the sequence and classification tables', () => {
  it('removes the prospect’s words, stops the plan, and keeps the executed history', async () => {
    const context = adminContext(seeded.alpha.workspaceId, seeded.alpha.admin.userId);
    const preview = await previewDeletion(context, { targetKind: 'firm', firmId: crm.alpha.firmId });
    const outcome = await commitDeletion(context, {
      requestId: preview.value?.requestId ?? '',
      previewHash: preview.value?.previewHash ?? '',
      commandId: 'deletion-sequences-commit',
      journal: recordingSuppressionJournal(),
    });
    expect(outcome.ok, outcome.reason).toBe(true);

    // Removed: the confirmation. It went first, which is the only reason the callback
    // delete below succeeded at all.
    expect(
      await count('SELECT count(*) AS count FROM mail_reply_confirmations WHERE workspace_id = $1', [
        seeded.alpha.workspaceId,
      ]),
    ).toBe(0);
    expect(
      await count('SELECT count(*) AS count FROM callbacks WHERE workspace_id = $1 AND id = $2', [
        seeded.alpha.workspaceId,
        callbackId,
      ]),
    ).toBe(0);

    // Stopped, not deleted. 11.1 requires executed history preserved, and an
    // enrollment row is business history of who was worked and how.
    const { rows: enrollment } = await database.session.query<{
      state: string;
      end_reason: string | null;
      ended_at: Date | null;
      review_union_milliseconds: string | null;
    }>(
      `SELECT state, end_reason, ended_at, review_union_milliseconds
         FROM sequence_enrollments WHERE workspace_id = $1 AND id = $2`,
      [seeded.alpha.workspaceId, enrollmentId],
    );
    expect(enrollment[0]?.state).toBe('stopped');
    expect(enrollment[0]?.end_reason).toBe('admin_stop');
    expect(enrollment[0]?.ended_at).not.toBeNull();
    expect(enrollment[0]?.review_union_milliseconds).toBeNull();

    // No unexecuted step is left for a worker to claim.
    expect(
      await count(
        `SELECT count(*) AS count FROM step_executions
          WHERE workspace_id = $1 AND enrollment_id = $2 AND state IN ('pending', 'held')`,
        [seeded.alpha.workspaceId, enrollmentId],
      ),
    ).toBe(0);
    const { rows: cancelled } = await database.session.query<{ cancel_reason: string; hold_reason_code: string | null }>(
      `SELECT cancel_reason, hold_reason_code FROM step_executions
        WHERE workspace_id = $1 AND enrollment_id = $2 AND state = 'cancelled'`,
      [seeded.alpha.workspaceId, enrollmentId],
    );
    expect(cancelled.length).toBeGreaterThan(0);
    for (const row of cancelled) {
      expect(row.cancel_reason).toBe('deleted under 10.3');
      // 0012 states the hold as an equivalence, so a cancelled row may not keep one.
      expect(row.hold_reason_code).toBeNull();
    }
  });

  it('detaches the unsent fence from its route and leaves the dispatched one whole', async () => {
    // The prepared fence let go of its route, so the route could be removed.
    const { rows: prepared } = await database.session.query<{ recipient_route_id: string | null }>(
      'SELECT recipient_route_id FROM outbound_messages WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, preparedFenceId],
    );
    expect(prepared[0]?.recipient_route_id).toBeNull();
    expect(
      await count('SELECT count(*) AS count FROM email_addresses WHERE workspace_id = $1 AND id = $2', [
        seeded.alpha.workspaceId,
        detachableRouteId,
      ]),
    ).toBe(0);

    // The dispatched one kept both, because 12.5 says the envelope is history from
    // the instant a token exists. The route row survives with it, and the preview
    // said so before the admin approved anything.
    const { rows: sent } = await database.session.query<{
      recipient_route_id: string | null;
      recipient_address: string;
    }>('SELECT recipient_route_id, recipient_address FROM outbound_messages WHERE workspace_id = $1 AND id = $2', [
      seeded.alpha.workspaceId,
      dispatchedFenceId,
    ]);
    expect(sent[0]?.recipient_route_id).toBe(pinnedRouteId);
    expect(sent[0]?.recipient_address).toBe('pinned@northwind.example.test');
    expect(
      await count('SELECT count(*) AS count FROM email_addresses WHERE workspace_id = $1 AND id = $2', [
        seeded.alpha.workspaceId,
        pinnedRouteId,
      ]),
    ).toBe(1);
  });

  it('suppresses the pinned handle anyway, so the row that survived cannot be contacted', async () => {
    const { rows } = await database.session.query<{ source: string }>(
      `SELECT source FROM suppression_events
        WHERE workspace_id = $1 AND scope = 'handle' AND canonical_key = $2`,
      [seeded.alpha.workspaceId, 'pinned@northwind.example.test'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('deletion_tombstone');
  });

  it('left the other workspace’s enrollment running', async () => {
    expect(
      await count(
        "SELECT count(*) AS count FROM sequence_enrollments WHERE workspace_id = $1 AND state = 'stopped'",
        [seeded.beta.workspaceId],
      ),
    ).toBe(0);
  });
});
