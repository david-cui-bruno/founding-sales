import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import {
  RETENTION_LEDGER_KINDS,
  readRetentionPolicies,
  retentionPeriodOf,
  runRetentionBatch,
} from '../../retention/index.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedMail, type SeededMail } from '../db/support/mailFixtures.ts';
import { RETENTION_NOW, seedRetention, type SeededRetention } from '../db/support/retentionFixtures.ts';

/**
 * Appendix G scenario 41, against a real PostgreSQL 16.
 *
 * > Retention deletes unmatched metadata, raw MIME, canceled drafts, and logs at
 * > their boundaries without deleting matched business history or suppression
 * > tombstones.
 *
 * The sentence has two halves and the second one is the one that matters. A sweep
 * that deletes everything passes the first half. So every assertion below names
 * both: what went, and what is still there — including in the other workspace,
 * because a retention job that swept two workspaces at once would be the quietest
 * possible cross-tenant bug (section 6, Appendix G 8).
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let mail: SeededMail;
let retention: SeededRetention;

const period = retentionPeriodOf(RETENTION_NOW);

/** The worker's scope: the system acting for a workspace, never a user. */
const workerContext = (workspaceId: string, db: SessionQueryable = database.session): RepositoryContext =>
  repositoryContext(workspaceScope(workspaceId, { kind: 'system', component: 'worker' }), db);

const rowExists = async (table: string, workspaceId: string, rowId: string): Promise<boolean> => {
  const { rows } = await database.session.query<{ present: boolean }>(
    `SELECT true AS present FROM ${table} WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, rowId],
  );
  return rows.length === 1;
};

const subjectsIn = async (
  workspaceId: string,
  id: string,
): Promise<{ subject: string; body: string } | undefined> => {
  const { rows } = await database.session.query<{ subject: string; body: string }>(
    'SELECT subject, body FROM outbound_messages WHERE workspace_id = $1 AND id = $2',
    [workspaceId, id],
  );
  return rows[0];
};

const tombstoneCount = async (workspaceId: string): Promise<number> => {
  const { rows } = await database.session.query<{ count: string }>(
    'SELECT count(*) AS count FROM suppression_events WHERE workspace_id = $1',
    [workspaceId],
  );
  return Number(rows[0]?.count ?? '0');
};

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, seeded);
  mail = await seedMail(database.session, seeded, crm);
  retention = await seedRetention(database.session, seeded, crm, mail);
});

afterAll(async () => {
  await database.drop();
});

describe('the retention policy rows exist before any job runs', () => {
  it('seeds the ten rows of the 10.3 table for every workspace, with the horizons the table states', async () => {
    for (const workspace of [seeded.alpha, seeded.beta]) {
      const policies = await readRetentionPolicies(workerContext(workspace.workspaceId));
      const byKind = new Map(policies.map(policy => [policy.dataKind, policy]));
      expect([...byKind.keys()].sort()).toEqual(
        [
          'audit_events',
          'business_records',
          'canceled_drafts',
          'database_backups',
          'matched_message_body',
          'operational_logs',
          'raw_mime',
          'research_evidence',
          'suppression_history',
          'unmatched_gmail_metadata',
        ].sort(),
      );
      expect(byKind.get('unmatched_gmail_metadata')?.retentionDays).toBe(30);
      expect(byKind.get('raw_mime')?.retentionDays).toBe(7);
      expect(byKind.get('canceled_drafts')?.retentionDays).toBe(30);
      expect(byKind.get('operational_logs')?.retentionDays).toBe(90);
      // PostgreSQL's epoch for an interval counts a year as 365.25 days, so seven
      // years is 2556.75 rather than 2555. The assertion keeps the arithmetic
      // visible: the stored interval is `7 years`, and this is what that means.
      expect(byKind.get('audit_events')?.retentionDays).toBe(7 * 365.25);
      expect(byKind.get('suppression_history')?.disposition).toBe('retain_indefinitely');
      expect(byKind.get('business_records')?.disposition).toBe('retain_indefinitely');
    }
  });
});

describe('scenario 41: retention deletes at the boundary and nothing else', () => {
  it('takes unmatched Gmail metadata older than thirty days and leaves the rest', async () => {
    const report = await runRetentionBatch(workerContext(seeded.alpha.workspaceId), {
      dataKind: 'unmatched_gmail_metadata',
      period,
      now: RETENTION_NOW,
    });
    expect(report.outcome).toBe('swept');
    expect(report.rowsDeleted).toBe(1);

    expect(await rowExists('mail_messages', seeded.alpha.workspaceId, retention.alpha.expiredUnmatchedMessageId)).toBe(
      false,
    );
    // Inside the horizon.
    expect(await rowExists('mail_messages', seeded.alpha.workspaceId, retention.alpha.freshUnmatchedMessageId)).toBe(
      true,
    );
    // Matched business correspondence, older than thirty days, and retained: 10.3
    // keeps it "with business correspondence", not under the metadata rule.
    expect(await rowExists('mail_messages', seeded.alpha.workspaceId, retention.alpha.matchedMessageId)).toBe(true);
    const { rows } = await database.session.query(
      'SELECT 1 FROM mail_message_bodies WHERE workspace_id = $1 AND mail_message_id = $2',
      [seeded.alpha.workspaceId, retention.alpha.matchedMessageId],
    );
    expect(rows).toHaveLength(1);

    // The other workspace's identical row is untouched.
    expect(await rowExists('mail_messages', seeded.beta.workspaceId, retention.beta.expiredUnmatchedMessageId)).toBe(
      true,
    );
  });

  it('takes temporary mailbox material older than seven days', async () => {
    const report = await runRetentionBatch(workerContext(seeded.alpha.workspaceId), {
      dataKind: 'raw_mime',
      period,
      now: RETENTION_NOW,
    });
    expect(report.outcome).toBe('swept');

    expect(
      await rowExists('gmail_push_notifications', seeded.alpha.workspaceId, retention.alpha.expiredPushNotificationId),
    ).toBe(false);
    expect(
      await rowExists('gmail_push_notifications', seeded.alpha.workspaceId, retention.alpha.freshPushNotificationId),
    ).toBe(true);
    expect(await rowExists('mailbox_recoveries', seeded.alpha.workspaceId, retention.alpha.expiredRecoveryId)).toBe(
      false,
    );
    expect(
      await rowExists('gmail_push_notifications', seeded.beta.workspaceId, retention.beta.expiredPushNotificationId),
    ).toBe(true);
  });

  it('takes research evidence whose provider terms have expired and keeps evidence whose terms have not', async () => {
    const report = await runRetentionBatch(workerContext(seeded.alpha.workspaceId), {
      dataKind: 'research_evidence',
      period,
      now: RETENTION_NOW,
    });
    expect(report.outcome).toBe('swept');
    expect(await rowExists('evidence_items', seeded.alpha.workspaceId, retention.alpha.expiredEvidenceId)).toBe(false);
    expect(await rowExists('evidence_items', seeded.alpha.workspaceId, retention.alpha.liveEvidenceId)).toBe(true);
  });

  it('archives a completed job payload after the operational window and leaves the dedupe key', async () => {
    const report = await runRetentionBatch(workerContext(seeded.alpha.workspaceId), {
      dataKind: 'job_payloads',
      period,
      now: RETENTION_NOW,
    });
    expect(report.outcome).toBe('swept');

    const { rows } = await database.session.query<{
      id: string;
      payload: unknown;
      idempotency_key: string;
      archived: boolean;
    }>(
      `SELECT id, payload, idempotency_key, payload_archived_at IS NOT NULL AS archived
         FROM jobs WHERE workspace_id = $1 AND id = ANY($2::uuid[]) ORDER BY completed_at`,
      [seeded.alpha.workspaceId, [retention.alpha.oldJobId, retention.alpha.recentJobId]],
    );
    const old = rows.find(row => row.id === retention.alpha.oldJobId);
    const recent = rows.find(row => row.id === retention.alpha.recentJobId);
    expect(old?.archived).toBe(true);
    expect(old?.payload).toEqual({});
    // 13.2: "durable business dedupe remains for its required horizon".
    expect(old?.idempotency_key).toBe('retention-old-job');
    expect(recent?.archived).toBe(false);
  });

  it('reports operational logs and database backups as somebody else’s retention rather than sweeping nothing quietly', async () => {
    for (const dataKind of ['operational_logs', 'database_backups'] as const) {
      const report = await runRetentionBatch(workerContext(seeded.alpha.workspaceId), {
        dataKind,
        period,
        now: RETENTION_NOW,
      });
      expect(report.outcome, dataKind).toBe('external');
      expect(report.rowsDeleted, dataKind).toBe(0);
    }
  });

  it('clears a held draft’s subject and body at thirty days, and leaves the fresh one and the sent one alone', async () => {
    const report = await runRetentionBatch(workerContext(seeded.alpha.workspaceId), {
      dataKind: 'canceled_drafts',
      period,
      now: RETENTION_NOW,
    });
    expect(report.outcome).toBe('swept');
    // Redaction, not deletion: migration 0010 revokes DELETE on the fence, because a
    // fence that could be deleted is an origin that could be given a second one.
    expect(report.rowsDeleted).toBe(0);
    expect(report.rowsRedacted).toBe(1);

    const subjects = async (id: string): Promise<{ subject: string; body: string } | undefined> => {
      const { rows } = await database.session.query<{ subject: string; body: string }>(
        'SELECT subject, body FROM outbound_messages WHERE workspace_id = $1 AND id = $2',
        [seeded.alpha.workspaceId, id],
      );
      return rows[0];
    };
    expect((await subjects(retention.alpha.expiredDraftFenceId))?.subject).toBe('[deleted]');
    expect((await subjects(retention.alpha.expiredDraftFenceId))?.body).toBe('[deleted]');
    // Inside the horizon.
    expect((await subjects(retention.alpha.freshDraftFenceId))?.subject).toBe('fresh-draft');
    // Sent long ago, and business correspondence: 10.3 keeps it with the firm, and
    // migration 0010's trigger would refuse to change its envelope anyway.
    expect((await subjects(retention.alpha.sentFenceId))?.subject).toBe('sent-long-ago');
    // The row itself never goes.
    const { rows } = await database.session.query<{ count: string }>(
      'SELECT count(*) AS count FROM outbound_messages WHERE workspace_id = $1',
      [seeded.alpha.workspaceId],
    );
    expect(Number(rows[0]?.count)).toBe(3);

    // And the other workspace's identical draft is untouched.
    expect((await subjectsIn(seeded.beta.workspaceId, retention.beta.expiredDraftFenceId))?.subject).toBe(
      'expired-draft',
    );
  });

  it('writes one ledger row per kind and period, and a second run of the same period sweeps nothing', async () => {
    const context = workerContext(seeded.alpha.workspaceId);
    const again = await runRetentionBatch(context, {
      dataKind: 'unmatched_gmail_metadata',
      period,
      now: RETENTION_NOW,
    });
    expect(again.replayed).toBe(true);
    expect(again.rowsDeleted).toBe(0);

    const { rows } = await database.session.query<{ count: string }>(
      `SELECT count(*) AS count FROM retention_runs
        WHERE workspace_id = $1 AND data_kind = 'unmatched_gmail_metadata' AND period = $2`,
      [seeded.alpha.workspaceId, period],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });
});

describe('the tombstone survives every retention job', () => {
  it('runs every kind in the ledger vocabulary and still finds the suppression tombstone', async () => {
    const before = await tombstoneCount(seeded.alpha.workspaceId);
    expect(before).toBeGreaterThan(0);

    // A fresh period so nothing is answered from the ledger.
    const laterPeriod = retentionPeriodOf('2026-09-21T12:00:00.000Z');
    for (const dataKind of RETENTION_LEDGER_KINDS) {
      await runRetentionBatch(workerContext(seeded.alpha.workspaceId), {
        dataKind,
        period: laterPeriod,
        now: '2026-09-21T12:00:00.000Z',
      });
    }

    expect(await tombstoneCount(seeded.alpha.workspaceId)).toBe(before);
    const { rows } = await database.session.query<{ event_id: string }>(
      'SELECT event_id FROM suppression_events WHERE workspace_id = $1 AND event_id = $2',
      [seeded.alpha.workspaceId, retention.alpha.tombstoneEventId],
    );
    expect(rows).toHaveLength(1);
  });

  it('answers suppression history and business records as retained, never as a sweep', async () => {
    const laterPeriod = retentionPeriodOf('2026-09-22T12:00:00.000Z');
    for (const dataKind of ['suppression_history', 'business_records', 'audit_events', 'matched_message_body'] as const) {
      const report = await runRetentionBatch(workerContext(seeded.alpha.workspaceId), {
        dataKind,
        period: laterPeriod,
        now: '2026-09-22T12:00:00.000Z',
      });
      expect(report.outcome, dataKind).toBe('retained');
      expect(report.rowsDeleted, dataKind).toBe(0);
    }
  });
});

describe('no retention job can touch suppression events or audit events', () => {
  it('refuses the DELETE for the application role, so no future sweep can be written that does it', async () => {
    // Not "no code path calls it today" — that is a grep, and a grep is not a
    // guarantee. Section 10.2 and 5.2 make it a privilege, and this asserts the
    // privilege under `SET ROLE app_runtime`, which is what the worker runs as.
    const runtime = await database.appRuntimeSession();
    await expect(runtime.query('DELETE FROM suppression_events')).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query('DELETE FROM audit_events')).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query('TRUNCATE suppression_events')).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query('TRUNCATE audit_events')).rejects.toMatchObject({ code: '42501' });
    await expect(
      runtime.query("UPDATE suppression_events SET canonical_key = 'moved@example.test'"),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('declares no retention target for either table', async () => {
    const { RETENTION_TARGETS } = await import('../../retention/index.ts');
    const reachable = RETENTION_TARGETS.flatMap(target =>
      target.state === 'implemented' ? [...target.tables] : [],
    );
    expect(reachable).not.toContain('suppression_events');
    expect(reachable).not.toContain('audit_events');
  });

  it('refuses the DELETE on the retention ledger itself, so a sweep cannot erase its own tombstone', async () => {
    const runtime = await database.appRuntimeSession();
    await expect(runtime.query('DELETE FROM retention_runs')).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query('DELETE FROM deletion_requests')).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query('DELETE FROM departures')).rejects.toMatchObject({ code: '42501' });
  });
});
