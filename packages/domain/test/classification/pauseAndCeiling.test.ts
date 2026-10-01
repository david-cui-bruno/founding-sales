import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { classifyReplyWithModel } from '../../classification/classify.ts';
import { CLASSIFIER_PROVIDER_KEY } from '../../classification/pricing.ts';
import { repositoryContext, type RepositoryContext } from '../../db/workspaceScope.ts';
import type { Queryable } from '../../db/queryable.ts';
import { REPLY_CORPUS } from '../corpus/replies/cases.ts';
import { createClassifierWorld, type ClassifierWorld } from './support/classifierWorld.ts';

/**
 * Slice P1 on the reply classifier.
 *
 *   * I1: chunk 2 reads the switch after the body and the month, so a switch turned off
 *     while the message body is being read stops the call.
 *   * I2: chunk 1 reserves the exact request's upper bound against the month's cash
 *     ceiling, and the settlement writes its cost to the provider ledger the month reads.
 *
 * The three chunks here run in one transaction (`classifyReplyWithModel`); the job's own
 * commits, its rollback and its concurrency are `apps/worker/test/classifyPaidCall.test.ts`.
 */
const CASE = 'terse-human-reply';
let world: ClassifierWorld;

beforeAll(async () => {
  world = await createClassifierWorld({ cases: REPLY_CORPUS.filter(c => c.id === CASE), settings: { enabled: true } });
}, 180_000);

afterAll(async () => {
  await world?.stop();
});

const session = () => world.mail.database.session;
const workspaceId = () => world.mail.seeded.alpha.workspaceId;

beforeEach(async () => {
  await session().query("DELETE FROM mail_message_classifications WHERE workspace_id = $1 AND layer = 'model'", [workspaceId()]);
  await session().query('DELETE FROM mail_classification_calls WHERE workspace_id = $1', [workspaceId()]);
  await session().query('DELETE FROM provider_ledger WHERE workspace_id = $1', [workspaceId()]);
  await session().query("DELETE FROM provider_reservations WHERE workspace_id = $1 AND subject_kind = 'reply_classification'", [workspaceId()]);
  await session().query("DELETE FROM workspace_settings WHERE workspace_id = $1 AND setting_key = 'monthly_cash_ceiling_cents'", [workspaceId()]);
  await session().query('UPDATE classifier_settings SET enabled = true WHERE workspace_id = $1', [workspaceId()]);
});

/** The system context, with `before` run ahead of the first statement that reads a message body. */
function turningOffDuringBodyRead(): RepositoryContext {
  const base = world.systemContext();
  let done = false;
  const db: Queryable = {
    query: (async (text: string, values?: readonly unknown[]) => {
      if (!done && text.includes('mail_message_bodies')) {
        done = true;
        await base.db.query('UPDATE classifier_settings SET enabled = false WHERE workspace_id = $1', [workspaceId()]);
      }
      return await base.db.query(text, values as unknown[]);
    }) as Queryable['query'],
  };
  return repositoryContext(base.scope, db);
}

const ledgerCents = async (): Promise<number | null> => {
  const { rows } = await session().query<{ cents: number }>(
    'SELECT cost_cents AS cents FROM provider_ledger WHERE workspace_id = $1 AND provider_key = $2',
    [workspaceId(), CLASSIFIER_PROVIDER_KEY],
  );
  return rows[0] === undefined ? null : Number(rows[0].cents);
};

describe('the classifier, paused and priced', () => {
  it('the control: on, one request, and its cost in the ledger', async () => {
    const before = world.transport.calls.length;
    const report = await classifyReplyWithModel(world.systemContext(), world.deps, { messageId: world.messageIdOf(CASE) });
    expect(report.outcome).toBe('accepted');
    expect(world.transport.calls.length).toBe(before + 1);
    expect(await ledgerCents()).toBeGreaterThan(0);
  });

  it('off while the body is read: no request, recorded as disabled', async () => {
    const before = world.transport.calls.length;
    const report = await classifyReplyWithModel(turningOffDuringBodyRead(), world.deps, { messageId: world.messageIdOf(CASE) });
    expect(report.outcome).toBe('disabled');
    expect(world.transport.calls.length).toBe(before);
    expect(await ledgerCents()).toBeNull();
  });

  it('no headroom in the month: no request, recorded as capped', async () => {
    await session().query(
      `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, changed_by_user_id)
       VALUES ($1, 'monthly_cash_ceiling_cents', 1, '{"cents": 0}'::jsonb, $2)`,
      [workspaceId(), world.mail.seeded.alpha.admin.userId],
    );
    const before = world.transport.calls.length;
    const report = await classifyReplyWithModel(world.systemContext(), world.deps, { messageId: world.messageIdOf(CASE) });
    expect(report.outcome).toBe('capped');
    expect(world.transport.calls.length).toBe(before);
  });
});
