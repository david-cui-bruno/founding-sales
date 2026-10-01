import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { beginClassification, classifyReplyWithModel, ensureClassificationCalling } from '../../classification/classify.ts';
import { readCreditSpend, readSpend, workspaceBusinessZone } from '../../research/ledger.ts';
import { databaseNow } from '../../policy/clock.ts';
import { REPLY_CORPUS } from '../corpus/replies/cases.ts';
import { createClassifierWorld, type ClassifierWorld } from './support/classifierWorld.ts';

/**
 * Slice BR1 on the reply classifier, against the real database: a Bedrock attempt is
 * reserved under `aws_bedrock.classifier`, priced at Bedrock's rate, credit-funded and so
 * not cleared against the month's cash ceiling; and a reservation made for one transport is
 * never called through the other.
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
const bedrockDeps = () => ({ ...world.deps, transport: 'bedrock' as const });

beforeEach(async () => {
  await session().query("DELETE FROM mail_message_classifications WHERE workspace_id = $1 AND layer = 'model'", [workspaceId()]);
  await session().query('DELETE FROM mail_classification_calls WHERE workspace_id = $1', [workspaceId()]);
  await session().query('DELETE FROM provider_ledger WHERE workspace_id = $1', [workspaceId()]);
  await session().query("DELETE FROM provider_reservations WHERE workspace_id = $1 AND subject_kind = 'reply_classification'", [workspaceId()]);
  await session().query("DELETE FROM workspace_settings WHERE workspace_id = $1 AND setting_key = 'monthly_cash_ceiling_cents'", [workspaceId()]);
});

async function noCashHeadroom(): Promise<void> {
  await session().query(
    `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, changed_by_user_id)
     VALUES ($1, 'monthly_cash_ceiling_cents', 1, '{"cents": 0}'::jsonb, $2)`,
    [workspaceId(), world.mail.seeded.alpha.admin.userId],
  );
}

const reservations = async (): Promise<{ attempt: number; provider_key: string; state: string; cents: number }[]> => {
  const { rows } = await session().query<{ attempt: number; provider_key: string; state: string; cents: number }>(
    "SELECT attempt, provider_key, state, cents FROM provider_reservations WHERE workspace_id = $1 AND subject_kind = 'reply_classification' ORDER BY attempt",
    [workspaceId()],
  );
  return rows.map(row => ({ ...row, attempt: Number(row.attempt), cents: Number(row.cents) }));
};

const month = async (): Promise<{ cash: number; credits: number }> => {
  const context = world.systemContext();
  const at = await databaseNow(context);
  const zone = await workspaceBusinessZone(context);
  return {
    cash: (await readSpend(context, { businessTimeZone: zone, at })).monthToDateCents,
    credits: (await readCreditSpend(context, { businessTimeZone: zone, at })).monthToDateCents,
  };
};

describe('a Bedrock classification is credit-funded', () => {
  it('the control: on the direct API, no cash headroom means no request', async () => {
    await noCashHeadroom();
    const before = world.transport.calls.length;
    const report = await classifyReplyWithModel(world.systemContext(), world.deps, { messageId: world.messageIdOf(CASE) });
    expect(report.outcome).toBe('capped');
    expect(world.transport.calls.length).toBe(before);
  });

  it('through Bedrock it is asked anyway, reserved and ledgered under aws_bedrock.classifier, and counted as credits, not cash', async () => {
    await noCashHeadroom();
    const before = world.transport.calls.length;
    const report = await classifyReplyWithModel(world.systemContext(), bedrockDeps(), { messageId: world.messageIdOf(CASE) });
    expect(report.outcome).toBe('accepted');
    expect(world.transport.calls.length).toBe(before + 1);
    const rows = await reservations();
    expect(rows.map(row => [row.provider_key, row.state])).toEqual([['aws_bedrock.classifier', 'settled']]);
    const { rows: ledger } = await session().query<{ provider_key: string; calls: number }>(
      'SELECT provider_key, calls FROM provider_ledger WHERE workspace_id = $1',
      [workspaceId()],
    );
    expect(ledger.map(row => [row.provider_key, Number(row.calls)])).toEqual([['aws_bedrock.classifier', 1]]);
    const spent = await month();
    expect(spent.cash).toBe(0);
    expect(spent.credits).toBeGreaterThan(0);
  });
});

describe('a reservation is only ever called through the transport it was made for', () => {
  it('releases a direct-API reservation that a Bedrock worker finds, and reserves again under Bedrock', async () => {
    const messageId = world.messageIdOf(CASE);
    const begun = await withTransaction(session(), async () => await beginClassification(world.systemContext(), world.deps, { messageId, retry: false }));
    expect(begun.kind).toBe('reserved');
    if (begun.kind !== 'reserved') return;
    expect((await reservations()).map(row => row.provider_key)).toEqual(['anthropic_classifier']);

    const calling = await withTransaction(session(), async () => await ensureClassificationCalling(world.systemContext(), bedrockDeps(), { messageId, attempt: begun.attempt }));
    expect(calling).toEqual({ kind: 'retry' });
    expect((await reservations()).map(row => [row.attempt, row.provider_key, row.state])).toEqual([[1, 'anthropic_classifier', 'released']]);

    const again = await withTransaction(session(), async () => await beginClassification(world.systemContext(), bedrockDeps(), { messageId, retry: true }));
    expect(again).toEqual({ kind: 'reserved', attempt: 2 });
    expect((await reservations()).map(row => [row.attempt, row.provider_key, row.state])).toEqual([
      [1, 'anthropic_classifier', 'released'],
      [2, 'aws_bedrock.classifier', 'reserved'],
    ]);
  });
});
