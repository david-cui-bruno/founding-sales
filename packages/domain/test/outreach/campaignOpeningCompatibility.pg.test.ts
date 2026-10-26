import { expect, it, vi } from 'vitest';
import { campaignOpeningPgFixture, openingPgHandoff } from './campaignOpeningPgFixture.ts';
import { registerOpeningDatabases } from './campaignOpeningPgRuntime.ts';
import { repositoryContext } from '../../db/workspaceScope.ts';
import { allowAllEligibility } from '../../sequences/eligibility.ts';
import { runDueStepExecution } from '../../sequences/executions.ts';
import { selectCampaignOpeningBeforeTransaction, readCampaignOpeningAttempt } from '../../outreach/campaignOpeningStore.ts';
import { claimForDispatch, markPreDispatchFenceSent, readFenceByStepExecution, readFenceEvents } from '../../outbound/fence.ts';
import type { SessionQueryable } from '../../db/queryable.ts';

type Fixture = Awaited<ReturnType<typeof campaignOpeningPgFixture>>;
const serialization = { code: '40001', constraint: 'campaign_opening_stop_serialization' };
const insertPolicy = (f: Fixture, db: SessionQueryable = f.db) => db.query(
  'INSERT INTO outreach_campaign_opening_policies(workspace_id,id,campaign_id,policy) VALUES($1,$2,$3,$4::jsonb)',
  [f.w, f.policy.id, f.policy.campaignId, JSON.stringify(f.policy)]);
const changeSource = (f: Fixture, db: SessionQueryable = f.db) => db.query(
  'UPDATE sourcing_candidates SET revision=revision+1 WHERE workspace_id=$1 AND id=$2', [f.w, f.source.selection.candidateId]);
async function prepare(f: Fixture) {
  const select = vi.fn(async (input: Parameters<NonNullable<Parameters<typeof selectCampaignOpeningBeforeTransaction>[2]['selector']>['select']>[0]) =>
    ({ kind: 'selected' as const, choice: { variantId: 'local', citationIds: input.citationIds } }));
  await selectCampaignOpeningBeforeTransaction(f.worker, f.db, { executionId: f.executionId, eligibility: allowAllEligibility(), selector: { select } });
  expect(select).toHaveBeenCalledTimes(1);
  const dispatch = vi.fn(async () => ({ ok: true as const }));
  const result = await f.tx(() => runDueStepExecution(f.worker, { stepExecutionId: f.executionId, now: f.at,
    eligibility: allowAllEligibility(), sendHandoff: { ...openingPgHandoff(f.at), dispatch } }));
  const fence = await readFenceByStepExecution(f.worker, f.executionId);
  if (!fence) throw new Error(`missing prepared fence: ${JSON.stringify(result)}`);
  expect(dispatch).not.toHaveBeenCalled(); expect(fence.attemptToken).toBeNull();
  return fence;
}
async function noSelection(f: Fixture) {
  const select = vi.fn(async () => { throw new Error('stale authority must not reach selector'); });
  await selectCampaignOpeningBeforeTransaction(f.worker, f.db, { executionId: f.executionId, eligibility: allowAllEligibility(), selector: { select } });
  expect(select).not.toHaveBeenCalled(); expect(await readCampaignOpeningAttempt(f.worker, f.executionId)).toBeNull();
}

it('CI1 mutation-first absence is locked against first activation until its source change commits', async () => {
  const f = await campaignOpeningPgFixture(false);
  try {
    const activation = await f.fixture.database.appRuntimeSession(); await registerOpeningDatabases();
    await f.db.query('BEGIN');
    try {
      await changeSource(f);
      await expect(insertPolicy(f, activation)).rejects.toMatchObject(serialization);
      expect((await activation.query('SELECT 1 FROM outreach_campaign_opening_policies WHERE workspace_id=$1', [f.w])).rows).toEqual([]);
      await f.db.query('COMMIT');
    } finally { await f.db.query('ROLLBACK'); }
    // Explicit later activation is not a retry of a selector or a send. It cannot
    // make the old admitted revision current or create an opening attempt.
    await insertPolicy(f, activation); await noSelection(f);
    expect(await readFenceByStepExecution(f.worker, f.executionId)).toBeNull();
  } finally { await f.stop(); }
});

it.each(['COMMIT', 'ROLLBACK'] as const)('CI1 activation-first %s conserves source and never skips contended erasure', async terminal => {
  const f = await campaignOpeningPgFixture(false);
  try {
    const activation = await f.fixture.database.appRuntimeSession(); await registerOpeningDatabases();
    const before = (await f.db.query('SELECT revision FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2', [f.w, f.source.selection.candidateId])).rows;
    await activation.query('BEGIN');
    try {
      await insertPolicy(f, activation);
      await expect(changeSource(f)).rejects.toMatchObject(serialization);
      expect((await f.db.query('SELECT revision FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2', [f.w, f.source.selection.candidateId])).rows).toEqual(before);
      await activation.query(terminal);
    } finally { await activation.query('ROLLBACK'); }
    if (terminal === 'COMMIT') {
      const fence = await prepare(f);
      await activation.query('BEGIN');
      try {
        await activation.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('fss.send-gate:'||$1::text,0))", [f.w]);
        await expect(changeSource(f)).rejects.toMatchObject(serialization);
        expect(await readCampaignOpeningAttempt(f.worker, f.executionId)).toMatchObject({ state: 'ready', invalidated_at: null });
      } finally { await activation.query('ROLLBACK'); }
      await changeSource(f);
      expect(await readCampaignOpeningAttempt(f.worker, f.executionId)).toMatchObject({ state: 'invalidated', content: null });
      await expect(f.tx(() => claimForDispatch(f.worker, { outboundMessageId: fence.id })))
        .rejects.toMatchObject({ code: '23514', constraint: 'campaign_opening_dispatch_current' });
      expect(await readFenceByStepExecution(f.worker, f.executionId)).toMatchObject({ state: 'prepared', attemptToken: null });
    } else {
      await activation.query('BEGIN');
      try {
        await activation.query("SELECT pg_advisory_xact_lock(hashtextextended('fss.send-gate:'||$1::text,0))", [f.w]);
        await changeSource(f); // Original no-policy mutation succeeds despite unrelated send-gate owner.
      } finally { await activation.query('ROLLBACK'); }
      expect((await f.db.query('SELECT 1 FROM outreach_campaign_opening_policies WHERE workspace_id=$1', [f.w])).rows).toEqual([]);
      expect(await readCampaignOpeningAttempt(f.worker, f.executionId)).toBeNull();
    }
  } finally { await f.stop(); }
});

it('CI1 repeatable snapshot predating policy activation cannot take a stale absence fast path', async () => {
  const f = await campaignOpeningPgFixture(false);
  try {
    const activation = await f.fixture.database.appRuntimeSession(); await registerOpeningDatabases();
    await f.db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      expect((await f.db.query('SELECT 1 FROM outreach_campaign_opening_policies WHERE workspace_id=$1', [f.w])).rows).toEqual([]);
      await insertPolicy(f, activation);
      await expect(changeSource(f)).rejects.toMatchObject(serialization);
    } finally { await f.db.query('ROLLBACK'); }
    expect((await f.db.query('SELECT 1 FROM outreach_campaign_opening_policies WHERE workspace_id=$1', [f.w])).rows).toHaveLength(1);
    expect(await readCampaignOpeningAttempt(f.worker, f.executionId)).toBeNull();
  } finally { await f.stop(); }
});

it('CI1 standalone revoked-policy history is atomic, immutable and cannot replay a send', async () => {
  const f = await campaignOpeningPgFixture();
  try {
    const fence = await prepare(f), attempt = await readCampaignOpeningAttempt(f.worker, f.executionId);
    // Revoke through the actual policy owner, without a fragile wall-clock
    // preparation deadline. Revocation also erases reusable opening content.
    await f.db.query('UPDATE outreach_campaign_opening_policies SET revoked_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2', [f.w, f.policy.id]);
    const verifiedBytes = { subject: fence.subject, body: `${fence.body}\nObserved immutable correspondence.` };
    const input = { outboundMessageId: fence.id, providerMessageId: 'fictional-ci1-observed-message',
      providerThreadId: 'fictional-ci1-observed-thread', sentAt: new Date().toISOString(), verifiedBytes };
    const result = await markPreDispatchFenceSent(f.worker, input); expect(result.ok).toBe(true);
    const sent = await readFenceByStepExecution(f.worker, f.executionId), events = await readFenceEvents(f.worker, fence.id);
    expect(sent).toMatchObject({ state: 'sent', subject: verifiedBytes.subject, body: verifiedBytes.body, providerMessageId: input.providerMessageId });
    expect((await readCampaignOpeningAttempt(f.worker, f.executionId))?.attempt_id).toBe(attempt?.attempt_id);
    expect(await markPreDispatchFenceSent(f.worker, { ...input, verifiedBytes: { subject: 'Never replace', body: 'Never replace' } })).toMatchObject({ ok: false });
    expect(await readFenceByStepExecution(f.worker, f.executionId)).toEqual(sent);
    expect(await readFenceEvents(f.worker, fence.id)).toEqual(events);
    expect((await f.db.query('SELECT 1 FROM outreach_email_campaign_admissions WHERE workspace_id=$1 AND enrollment_id=$2', [f.w, f.enrollmentId])).rows).toHaveLength(1);
  } finally { await f.stop(); }
});

it('CI1 nested historical recovery never commits its caller and rollback restores original frozen bytes', async () => {
  const f = await campaignOpeningPgFixture();
  try {
    const fence = await prepare(f), events = await readFenceEvents(f.worker, fence.id);
    const observer = await f.fixture.database.appRuntimeSession(); await registerOpeningDatabases();
    const observed = repositoryContext(f.worker.scope, observer);
    await f.db.query('BEGIN');
    try {
      expect((await markPreDispatchFenceSent(f.worker, { outboundMessageId: fence.id, providerMessageId: 'fictional-ci1-message',
        providerThreadId: 'fictional-ci1-thread', sentAt: new Date().toISOString(), verifiedBytes: { subject: fence.subject, body: `${fence.body}\nAlready sent.` } })).ok).toBe(true);
      expect(await readFenceByStepExecution(f.worker, f.executionId)).toMatchObject({ state: 'sent' });
      expect(await readFenceByStepExecution(observed, f.executionId)).toEqual(fence);
    } finally { await f.db.query('ROLLBACK'); }
    expect(await readFenceByStepExecution(f.worker, f.executionId)).toEqual(fence);
    expect(await readFenceEvents(f.worker, fence.id)).toEqual(events);
  } finally { await f.stop(); }
});

it('CI1 standalone recovery rolls back witness, ledger and accounting when its terminal write fails', async () => {
  const f = await campaignOpeningPgFixture();
  try {
    const fence = await prepare(f), events = await readFenceEvents(f.worker, fence.id);
    const before = (await f.db.query('SELECT * FROM outreach_touch_reservations WHERE workspace_id=$1', [f.w])).rows;
    const injected = new Error('fictional local terminal database failure');
    const session: SessionQueryable = { query: async (sql, values) => {
      if (sql.includes("SET state = 'sent', sent_at")) throw injected;
      return f.db.query(sql, values);
    } };
    await expect(markPreDispatchFenceSent(repositoryContext(f.worker.scope, session), { outboundMessageId: fence.id,
      providerMessageId: 'fictional-ci1-message', providerThreadId: 'fictional-ci1-thread', sentAt: new Date().toISOString() })).rejects.toBe(injected);
    expect(await readFenceByStepExecution(f.worker, f.executionId)).toEqual(fence);
    expect(await readFenceEvents(f.worker, fence.id)).toEqual(events);
    expect((await f.db.query('SELECT * FROM outreach_touch_reservations WHERE workspace_id=$1', [f.w])).rows).toEqual(before);
    expect((await f.db.query('SELECT 1 AS available')).rows).toEqual([{ available: 1 }]);
  } finally { await f.stop(); }
});
