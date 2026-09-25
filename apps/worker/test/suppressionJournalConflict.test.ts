import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing';
import { repositoryContext, withTransaction, workspaceScope } from '@fss/domain/db';
import { SuppressionJournalError, recordSuppression, type SuppressionJournalRecord } from '@fss/domain/suppression';
import { journalPutRefusalIsDurable, loadS3SuppressionJournal, type S3JournalSdk } from '../src/bootstrap/deployment.ts';

/**
 * The worker's journal: a conditional-write conflict fails the write (audit S12, lane
 * g81).
 *
 * The worker records prospect opt-outs during mail sync and must journal each one
 * before its row (10.2). With `IfNoneMatch: '*'` on a deterministic key, `412
 * PreconditionFailed` is the object already there — a replay of this event — and is
 * durable. `409 ConditionalRequestConflict` is another write to the key still in
 * flight, which may fail; until lane g81 the worker returned as if it were durable,
 * and the opt-out's row was committed with nothing in the journal behind it.
 *
 * ## The vacuous-pass trap, named
 *
 * A journal that threw on everything would pass "a conflict fails". So the same fake
 * also answers success and `412`, both of which must resolve, and the database test
 * retries the same opt-out once the other writer has landed, which must record it.
 * The SDK is a fake: nothing here reaches AWS.
 */

type Outcome = 'ok' | 'PreconditionFailed' | 'ConditionalRequestConflict';

function scriptedSdk(outcomes: Outcome[]): { readonly sdk: S3JournalSdk; readonly inputs: Record<string, unknown>[] } {
  const inputs: Record<string, unknown>[] = [];
  class PutObjectCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class S3Client {
    async send(command: unknown): Promise<unknown> {
      inputs.push((command as PutObjectCommand).input);
      await Promise.resolve();
      const next = outcomes.shift() ?? 'ok';
      if (next === 'ok') return {};
      const error = new Error(`scripted ${next}`);
      error.name = next;
      throw error;
    }
  }
  return { sdk: { S3Client, PutObjectCommand }, inputs };
}

const record: SuppressionJournalRecord = {
  eventId: 'sup_worker_conflict_example',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  scope: 'handle',
  canonicalKey: 'dana@northwind.example.test',
  canonicalizerVersion: 'e164-lower.1',
  source: 'prospect_opt_out',
  actorUserId: null,
  commandId: null,
  supersedesEventId: null,
  supersessionReason: null,
  recordedAt: '2026-09-25T12:00:00.000Z',
};

describe('the worker S3 journal (audit S12)', () => {
  it('names 412 durable and nothing else', () => {
    expect(journalPutRefusalIsDurable('PreconditionFailed')).toBe(true);
    for (const name of ['ConditionalRequestConflict', 'AccessDenied', 'SlowDown', 'unknown']) {
      expect(journalPutRefusalIsDurable(name), name).toBe(false);
    }
  });

  it('writes conditionally, accepts a 412, and refuses a 409', async () => {
    const { sdk, inputs } = scriptedSdk(['ok', 'PreconditionFailed', 'ConditionalRequestConflict']);
    const journal = await loadS3SuppressionJournal({ bucket: 'fss-test-journal', region: 'us-east-1', sdk });

    await expect(journal.append(record)).resolves.toBeUndefined();
    await expect(journal.append(record)).resolves.toBeUndefined();
    const conflict = await journal.append(record).then(
      () => null,
      (error: unknown) => error,
    );
    expect(conflict).toBeInstanceOf(SuppressionJournalError);
    expect((conflict as SuppressionJournalError).code).toBe('JOURNAL_UNAVAILABLE');
    expect((conflict as Error).message).toContain('ConditionalRequestConflict');

    expect(inputs.map(input => input['IfNoneMatch'])).toEqual(['*', '*', '*']);
    expect(inputs[0]?.['Key']).toBe(`suppressions/${record.workspaceId}/${record.eventId}.json`);
  });
});

describe('an opt-out whose journal write meets a conflict', () => {
  let database: TestDatabase;
  let workspaceId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    const workspace = await database.session.query<{ id: string }>(
      "INSERT INTO workspaces (slug, display_name) VALUES ('conflict', 'Conflict') RETURNING id",
    );
    workspaceId = workspace.rows[0]?.id ?? '';
  });

  afterAll(async () => {
    await database.drop();
  });

  const countFor = async (key: string): Promise<number> => {
    const { rows } = await database.session.query<{ count: string }>(
      'SELECT count(*) AS count FROM suppression_events WHERE workspace_id = $1 AND canonical_key = $2',
      [workspaceId, key],
    );
    return Number(rows[0]?.count ?? '0');
  };

  it('records nothing on the conflict, and records it on the retry', async () => {
    const outcomes: Outcome[] = ['ConditionalRequestConflict'];
    const { sdk } = scriptedSdk(outcomes);
    const journal = await loadS3SuppressionJournal({ bucket: 'fss-test-journal', region: 'us-east-1', sdk });
    const session = await database.appRuntimeSession();
    const context = repositoryContext(workspaceScope(workspaceId, { kind: 'system', component: 'worker' }), session);
    const optOut = {
      scope: 'handle' as const,
      value: 'Dana@Northwind.example.test',
      source: 'prospect_opt_out' as const,
      commandId: '6f0c2a8e-1d5b-4c1e-9d0a-3b2f7c9e1a44',
      journal,
    };

    await expect(withTransaction(session, async () => recordSuppression(context, optOut))).rejects.toBeInstanceOf(
      SuppressionJournalError,
    );
    expect(await countFor('dana@northwind.example.test')).toBe(0);

    // The other writer landed: the retry meets its object, which is this event.
    outcomes.push('PreconditionFailed');
    const retried = await withTransaction(session, async () => recordSuppression(context, optOut));
    expect(retried.ok).toBe(true);
    expect(await countFor('dana@northwind.example.test')).toBe(1);
  });
});
