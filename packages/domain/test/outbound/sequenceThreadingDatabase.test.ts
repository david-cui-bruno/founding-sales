import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFence } from '../../outbound/fence.ts';
import { regularSequenceThreading } from '../../outbound/sequenceThreading.ts';
import { dispatchOutboundMessage } from '../../outbound/send.ts';
import { reconcileOutboundMessage } from '../../outbound/reconcile.ts';
import { completeEmailStep } from '../../sequences/executions.ts';
import { withTransaction } from '../../db/queryable.ts';
import { createOutboundWorld, TEMPLATE_SUBJECT, TEMPLATE_BODY, type OutboundWorld } from './support/outboundWorld.ts';
import { seedFirm } from './support/dispatchFixtures.ts';

let world: OutboundWorld;
beforeAll(async () => {
  world = await createOutboundWorld();
  const ws = world.alpha.workspace.workspaceId;
  const db = world.database.session;
  // A private fixture sequence is populated BEFORE publication. Published versions
  // and their approved templates are never rewritten to make follow-ups possible.
  const sequence = (await db.query<{ id: string }>(`INSERT INTO sequences(workspace_id,name,created_by_user_id) VALUES($1,'Fence fixture sequence',$2) RETURNING id`, [ws, world.alpha.workspace.salesperson.userId])).rows[0]!;
  const version = (await db.query<{ id: string }>(`INSERT INTO sequence_versions(workspace_id,sequence_id,version) VALUES($1,$2,1) RETURNING id`, [ws, sequence.id])).rows[0]!;
  const templateId = '32222222-3333-4444-8555-666666666666';
  const subject = `Re: ${TEMPLATE_SUBJECT}`;
  const hash = createHash('sha256').update(JSON.stringify({ kind: 'template_content', version: 1, templateId, templateVersion: 1, subject, body: TEMPLATE_BODY })).digest('hex');
  const reply = (await db.query<{ id: string }>(`INSERT INTO template_versions(workspace_id,template_id,version,name,subject,body,content_hash,footer_sign_off,approved_at,approved_by_user_id)
    VALUES($1,$2,1,'Reviewed follow-up',$3,$4,$5,'Signed off',now(),$6) RETURNING id`, [ws, templateId, subject, TEMPLATE_BODY, hash, world.alpha.workspace.admin.userId])).rows[0]!;
  await db.query(`INSERT INTO sequence_steps(workspace_id,sequence_version_id,ordinal,channel,delay_unit,delay_amount,template_version_id)
    SELECT $1,$2,n,'email','elapsed',0,CASE WHEN n=1 THEN $3::uuid ELSE $4::uuid END FROM generate_series(1,4) n`, [ws, version.id, world.alpha.templateVersionId, reply.id]);
  await db.query(`UPDATE sequence_versions SET state='published',published_at=now(),published_by_user_id=$3 WHERE workspace_id=$1 AND id=$2`, [ws, version.id, world.alpha.workspace.salesperson.userId]);
}, 180_000);
afterAll(async () => { await world?.stop(); });

const ctx = () => world.systemContext(world.alpha.workspace.workspaceId);

async function successor(fenceId: string): Promise<string> {
  const fence = (await readFence(ctx(), fenceId))!;
  const done = await withTransaction(world.database.session, () => completeEmailStep(ctx(), {
    stepExecutionId: fence.stepExecutionId!, result: 'sent', at: fence.sentAt!,
  }));
  expect(done.ok).toBe(true);
  const next = (await world.database.session.query<{ id: string }>(`SELECT id FROM step_executions WHERE workspace_id=$1 AND enrollment_id=$2 AND state='pending' ORDER BY ordinal LIMIT 1`, [world.alpha.workspace.workspaceId, fence.enrollmentId])).rows[0]!;
  const template = (await ctx().db.query<{ id: string; subject: string; body: string; content_hash: string }>(`SELECT t.* FROM step_executions x JOIN sequence_steps s ON s.workspace_id=x.workspace_id AND s.id=x.step_id JOIN template_versions t ON t.workspace_id=s.workspace_id AND t.id=s.template_version_id WHERE x.workspace_id=$1 AND x.id=$2`, [world.alpha.workspace.workspaceId, next.id])).rows[0]!;
  return world.prepare(world.alpha, { stepExecutionId: next.id, templateVersionId: template.id, templateContentHash: template.content_hash, subject: template.subject, body: template.body, firmId: fence.firmId });
}

describe('ordinary sequence dispatch through disposable database and recorded Gmail', () => {
  it('sends three steps on one provider thread with cumulative durable Message-ID lineage and no resend', async () => {
    const gmail = world.clientWith(world.alpha, {});
    const deps = world.sendDeps(world.alpha, { gmail });
    const first = await world.prepare(world.alpha);
    expect((await dispatchOutboundMessage(ctx(), deps, { outboundMessageId: first })).outcome).toBe('sent');
    const root = (await readFence(ctx(), first))!;
    expect(gmail.sends[0]?.threadId).toBeUndefined();
    expect(gmail.sends[0]?.inReplyTo).toBeUndefined();

    const second = await successor(first);
    expect((await dispatchOutboundMessage(ctx(), deps, { outboundMessageId: second })).outcome).toBe('sent');
    const parent = (await readFence(ctx(), second))!;
    expect(gmail.sends[1]).toMatchObject({ subject: `Re: ${TEMPLATE_SUBJECT}`, threadId: root.providerThreadId, inReplyTo: root.providerMessageIdHeader, references: [root.providerMessageIdHeader] });
    expect(parent.providerThreadId).toBe(root.providerThreadId);

    const third = await successor(second);
    expect((await dispatchOutboundMessage(ctx(), deps, { outboundMessageId: third })).outcome).toBe('sent');
    const child = (await readFence(ctx(), third))!;
    expect(gmail.sends[2]).toMatchObject({ threadId: root.providerThreadId, rfcMessageId: child.providerMessageIdHeader, inReplyTo: parent.providerMessageIdHeader, references: [root.providerMessageIdHeader, parent.providerMessageIdHeader] });
    expect((await dispatchOutboundMessage(ctx(), deps, { outboundMessageId: third })).outcome).toBe('already_terminal');
    expect(gmail.sends).toHaveLength(3);

    const fourth = await successor(third);
    const pending = (await readFence(ctx(), fourth))!;
    // The historical OAuth account, not just mutable mailbox row identity, binds
    // Gmail thread IDs. A reconnect to another account cannot reuse this thread.
    await ctx().db.query(`UPDATE mailboxes SET provider_account_id='different@example.test' WHERE workspace_id=$1 AND id=$2`, [world.alpha.workspace.workspaceId, world.alpha.mailboxId]);
    expect(await regularSequenceThreading(ctx(), pending)).toEqual({ ok: false, reason: 'sequence_thread_scope_changed' });
    const refused = await dispatchOutboundMessage(ctx(), deps, { outboundMessageId: fourth });
    expect(refused.outcome).not.toBe('sent');
    expect(gmail.sends).toHaveLength(3);
    expect((await readFence(ctx(), fourth))?.attemptToken).toBeNull();
    await ctx().db.query(`UPDATE mailboxes m SET provider_account_id=o.provider_account_id FROM mailbox_oauth_grant_observations o WHERE m.workspace_id=$1 AND m.id=$2 AND o.workspace_id=m.workspace_id AND o.mailbox_id=m.id`, [world.alpha.workspace.workspaceId, world.alpha.mailboxId]);
  });

  it('reconciles an uncertain delivered attempt without resend and uses its original Message-ID as parent', async () => {
    const firm = await seedFirm(world, world.alpha, 'thread-reconcile');
    const first = await world.prepare(world.alpha, { firmId: firm.firmId, opportunityId: firm.opportunityId });
    const gmail = world.clientWith(world.alpha, {});
    let dropped = false;
    const deps = world.sendDeps(world.alpha, { gmail: { ...gmail, sendMessage: async (...args) => {
      const sent = await gmail.sendMessage(...args);
      if (!dropped) { dropped = true; return { ok: false, outcome: 'indeterminate', detail: 'fixture response dropped after delivery' }; }
      return sent;
    } } });
    expect((await dispatchOutboundMessage(ctx(), deps, { outboundMessageId: first })).outcome).toBe('reconciling');
    expect((await dispatchOutboundMessage(ctx(), deps, { outboundMessageId: first })).outcome).toBe('not_ready');
    expect(gmail.sends).toHaveLength(1);
    expect((await reconcileOutboundMessage(ctx(), world.reconcileDeps(world.alpha, { gmail }), { outboundMessageId: first })).outcome).toBe('sent');
    const root = (await readFence(ctx(), first))!;
    const second = await successor(first);
    expect((await dispatchOutboundMessage(ctx(), deps, { outboundMessageId: second })).outcome).toBe('sent');
    expect(gmail.sends).toHaveLength(2);
    expect(gmail.sends[1]).toMatchObject({ threadId: root.providerThreadId, inReplyTo: root.providerMessageIdHeader, references: [root.providerMessageIdHeader] });
  });
});
