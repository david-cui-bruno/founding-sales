import { afterAll, beforeAll, expect, it } from 'vitest';
import { recordSuppression } from '../../suppression/events.ts';
import { lockSendGateForStopFact } from '../../policy/sendGate.ts';
import { beginReconciling, claimForDispatch, recordReconciledSent } from '../../outbound/fence.ts';
import { applyDirectSendEffects } from '../../mail/effects.ts';
import { readMessage } from '../../mail/messages.ts';
import { withTransaction } from '../../db/queryable.ts';
import { closeSendDay, openSendDay, readRampStanding, recordDaySignal, setAdminCap } from '../../outbound/ramp.ts';
import { recoveryStageCap } from '../../outbound/recovery.ts';
import { dispatchOutboundMessage } from '../../outbound/send.ts';
import { createOutboundWorld, type OutboundWorld } from './support/outboundWorld.ts';
import { openExtraSession, pausingAtTokenRefresh, prepareFor, seedFirm, type ExtraSession } from './support/dispatchFixtures.ts';

let world: OutboundWorld;
let other: ExtraSession;
beforeAll(async () => {
  world = await createOutboundWorld();
  other = await openExtraSession(world);
  const firm = await seedFirm(world, world.alpha, 'inactivity-clock');
  const fence = await prepareFor(world, world.alpha, firm);
  expect(await dispatchOutboundMessage(world.systemContext(world.alpha.workspace.workspaceId), world.sendDeps(world.alpha), { outboundMessageId: fence })).toMatchObject({ outcome: 'sent' });
  // Durable provider acceptance is the activity source, independently of job time.
  await world.database.session.query('UPDATE outbound_messages SET sent_at=$2::timestamptz WHERE id=$1', [fence, '2026-09-23T09:00:00Z']);
});
afterAll(async () => { await other?.close(); await world?.stop(); });
const context = () => world.systemContext(world.alpha.workspace.workspaceId);

it('retains earned standing at13 calendar days and creates one temporary epoch at14 under concurrent reads', async () => {
  const before = await readRampStanding(context(), world.alpha.mailboxId, { now: new Date('2026-10-06T09:00:00Z') });
  expect(before).toMatchObject({ effectiveCap: 50, ramp: { healthySendingDays: 40 } });
  const readings = await Promise.all([
    readRampStanding(context(), world.alpha.mailboxId, { now: new Date('2026-10-07T09:00:00Z') }),
    readRampStanding(other.context(world.alpha.workspace.workspaceId), world.alpha.mailboxId, { now: new Date('2026-10-07T09:00:00Z') }),
  ]);
  for (const value of readings) expect(value).toMatchObject({ effectiveCap: 5, ramp: { healthySendingDays: 40 }, recovery: { stageCap: 5, qualifyingDays: 0, startedOn: '2026-10-07' } });
  expect(readings[0]?.recovery?.epochId).toBe(readings[1]?.recovery?.epochId);
});

async function exposure(date: string, count: number) {
  const standing = await readRampStanding(context(), world.alpha.mailboxId, { now: new Date('2026-10-07T09:00:00Z') });
  await openSendDay(context(), { mailboxId: world.alpha.mailboxId, businessDate: date, cap: standing!.effectiveCap });
  await world.database.session.query('UPDATE mailbox_send_days SET automated_sent=$3 WHERE mailbox_id=$1 AND business_date=$2::date', [world.alpha.mailboxId, date, count]);
}
const close = (date: string) => withTransaction(world.database.session, () => closeSendDay(context(), { mailboxId: world.alpha.mailboxId, businessDate: date, signals: { authenticationPasses: true, coverageHealthy: true, providerWarning: false } }));
it('earns recovery with five new exposed days without changing earned history or crediting historical closures', async () => {
  await exposure('2026-10-06', 4);
  expect(await close('2026-10-06')).toMatchObject({ advanced: false, failure: 'out_of_order_day', healthySendingDays: 40 });
  for (const date of ['2026-10-07','2026-10-08','2026-10-09','2026-10-10','2026-10-11']) {
    await exposure(date, 4);
    expect(await close(date)).toMatchObject({ advanced: true, healthySendingDays: 40 });
  }
  expect(await readRampStanding(context(), world.alpha.mailboxId)).toMatchObject({ effectiveCap: 10, recovery: { qualifyingDays: 5, stageCap: 10 } });
});

it('reverses recovery progress once for late adverse evidence while preserving earned history', async () => {
  for (let i=0; i<2; i+=1) await recordDaySignal(context(), { mailboxId: world.alpha.mailboxId, businessDate: '2026-10-11', signal: 'opt_out' });
  expect(await readRampStanding(context(), world.alpha.mailboxId)).toMatchObject({ effectiveCap: 5, ramp: { healthySendingDays: 40 }, recovery: { qualifyingDays: 4, stageCap: 5 } });
});

it('reports transient coverage loss and recovers readiness only after fresh coverage is proven', async () => {
  await world.database.session.query("UPDATE mailboxes SET coverage_watermark_at=clock_timestamp()-interval '1 hour' WHERE id=$1", [world.alpha.mailboxId]);
  expect(await readRampStanding(context(), world.alpha.mailboxId)).toMatchObject({ effectiveCap: 5, readiness: { ready: false, reasons: ['coverage_incomplete'] } });
  await world.database.session.query('UPDATE mailboxes SET coverage_watermark_at=clock_timestamp() WHERE id=$1', [world.alpha.mailboxId]);
  expect(await readRampStanding(context(), world.alpha.mailboxId)).toMatchObject({ effectiveCap: 5, readiness: { ready: true, reasons: [] } });
});

it('holds a recovered mailbox with unsettled provider evidence and sends only after established reconciliation', async () => {
  const uncertainFirm = await seedFirm(world, world.alpha, 'uncertain-recovery');
  const uncertain = await prepareFor(world, world.alpha, uncertainFirm);
  expect(await claimForDispatch(context(), { outboundMessageId: uncertain, businessDate: '2026-10-08' })).toMatchObject({ ok: true });
  const target = await prepareFor(world, world.alpha, await seedFirm(world, world.alpha, 'recovery-target'));
  const gmail = world.clientWith(world.alpha, {});
  expect(await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail }), { outboundMessageId: target })).toMatchObject({ outcome: 'held', refusal: 'step_ineligible', detail: 'sender_recovery_unready:unresolved_submission' });
  expect(gmail.sends).toHaveLength(0);
  expect(await readRampStanding(context(), world.alpha.mailboxId)).toMatchObject({ readiness: { ready: false, reasons: ['unresolved_submission'] } });
  expect(await beginReconciling(context(), { outboundMessageId: uncertain, detail: 'controlled_unknown', windowHours: 24 })).toMatchObject({ ok: true });
  expect(await recordReconciledSent(context(), { outboundMessageId: uncertain, providerMessageId: 'recovered1', providerThreadId: 'recoveredthread1' })).toMatchObject({ ok: true });
  expect(await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail }), { outboundMessageId: target })).toMatchObject({ outcome: 'sent' });
  expect(gmail.sends).toHaveLength(1);
});

it('reports a saved lower cap as the actual recovery allowance and retains it on restoration', async () => {
  const save = (lowerTo: number|null) => withTransaction(world.database.session, () => setAdminCap(context(), { mailboxId: world.alpha.mailboxId, adminUserId: world.alpha.workspace.admin.userId, lowerTo }));
  expect(await save(3)).toMatchObject({ ok: true, effectiveCap: 3 });
  expect(await save(null)).toMatchObject({ ok: true, effectiveCap: 5 });
});

it('finishes recovery at an earned initial stage, resumes the earned ramp, and reopens on a late revoked recovery day', async () => {
  const box=world.beta;
  const ctx=world.systemContext(box.workspace.workspaceId);
  await world.database.session.query("UPDATE mailboxes SET created_at='2026-09-01T09:00Z' WHERE id=$1", [box.mailboxId]);
  await world.database.session.query("UPDATE mailbox_send_ramp SET healthy_sending_days=4,last_advanced_on='2026-09-01',recovery_epoch_id=NULL WHERE mailbox_id=$1", [box.mailboxId]);
  expect(await readRampStanding(ctx,box.mailboxId,{now:new Date('2026-09-15T09:00Z')})).toMatchObject({effectiveCap:5});
  const qualify=async(date:string)=>{
    const cap=(await readRampStanding(ctx,box.mailboxId))!.effectiveCap;
    await openSendDay(ctx,{mailboxId:box.mailboxId,businessDate:date,cap});
    await world.database.session.query('UPDATE mailbox_send_days SET automated_sent=4 WHERE mailbox_id=$1 AND business_date=$2::date',[box.mailboxId,date]);
    return withTransaction(world.database.session,()=>closeSendDay(ctx,{mailboxId:box.mailboxId,businessDate:date,signals:{authenticationPasses:true,coverageHealthy:true,providerWarning:false}}));
  };
  await openSendDay(ctx,{mailboxId:box.mailboxId,businessDate:'2026-09-24',cap:5});
  await world.database.session.query("UPDATE mailbox_send_days SET automated_sent=4 WHERE mailbox_id=$1 AND business_date='2026-09-24'",[box.mailboxId]);
  for(const date of ['2026-09-15','2026-09-16','2026-09-17','2026-09-18','2026-09-21']) expect(await qualify(date)).toMatchObject({advanced:true,healthySendingDays:4});
  expect(await readRampStanding(ctx,box.mailboxId)).toMatchObject({effectiveCap:5,recovery:{qualifyingDays:5,active:false}});
  expect(await withTransaction(world.database.session,()=>closeSendDay(ctx,{mailboxId:box.mailboxId,businessDate:'2026-09-24',signals:{authenticationPasses:true,coverageHealthy:true,providerWarning:false}}))).toMatchObject({advanced:false,failure:'out_of_order_day'});
  expect(await qualify('2026-09-22')).toMatchObject({advanced:true,healthySendingDays:5});
  expect(await readRampStanding(ctx,box.mailboxId)).toMatchObject({effectiveCap:10});
  await recordDaySignal(ctx,{mailboxId:box.mailboxId,businessDate:'2026-09-21',signal:'bounce'});
  expect(await readRampStanding(ctx,box.mailboxId)).toMatchObject({effectiveCap:5,ramp:{healthySendingDays:5},recovery:{qualifyingDays:4,active:true}});
});

it('does not graduate a new stage from historical days exposed before its allowance became effective', async () => {
  await exposure('2026-10-14',4);
  await exposure('2026-10-15',4);
  expect(await close('2026-10-14')).toMatchObject({advanced:true,healthySendingDays:40});
  expect(await readRampStanding(context(),world.alpha.mailboxId)).toMatchObject({effectiveCap:10,recovery:{qualifyingDays:5}});
  expect(await close('2026-10-15')).toMatchObject({advanced:false,failure:'out_of_order_day',healthySendingDays:40});
  expect(await readRampStanding(context(),world.alpha.mailboxId)).toMatchObject({effectiveCap:10,recovery:{qualifyingDays:5}});
});

it('uses a matched manual Sent message for the inactivity clock without earning automated exposure, including timezone boundaries', async () => {
  const box=world.beta,ctx=world.systemContext(world.beta.workspace.workspaceId);
  const firm=await seedFirm(world,box,'manual-activity');
  const id=(await world.database.session.query<{id:string}>(`INSERT INTO mail_messages(workspace_id,mailbox_id,provider_message_id,provider_thread_id,direction,internal_date,header_from,header_to,matched)
    VALUES($1,$2,'manual-clock','manual-clock','outgoing',clock_timestamp(),$3,$4::text[],true) RETURNING id`,[box.workspace.workspaceId,box.mailboxId,box.address,[firm.address]])).rows[0]!.id;
  const message=(await readMessage(ctx,id))!;
  await withTransaction(world.database.session,()=>applyDirectSendEffects(ctx,{message,candidate:{firmId:firm.firmId,opportunityId:firm.opportunityId,contactId:firm.contactId,rule:'thread',viaClosedOpportunity:false}}));
  // The matched fixture's provider time straddles a local midnight. Read jobs and
  // effect application times are deliberately different from this activity date.
  await world.database.session.query("UPDATE mail_messages SET internal_date='2026-09-23T23:30Z' WHERE id=$1",[id]);
  await world.database.session.query("UPDATE workspaces SET business_time_zone='America/New_York' WHERE id=$1",[box.workspace.workspaceId]);
  await world.database.session.query('UPDATE mailbox_send_ramp SET healthy_sending_days=40,recovery_epoch_id=NULL WHERE mailbox_id=$1',[box.mailboxId]);
  expect(await readRampStanding(ctx,box.mailboxId,{now:new Date('2026-10-07T03:00Z')})).toMatchObject({effectiveCap:50,inactivityDays:13,lastActivityAt:'2026-09-23T23:30:00.000Z',recovery:null});
  expect(await readRampStanding(ctx,box.mailboxId,{now:new Date('2026-10-07T05:00Z')})).toMatchObject({effectiveCap:5,inactivityDays:14,ramp:{healthySendingDays:40},recovery:{qualifyingDays:0,startedOn:'2026-10-07'}});
});

it('rechecks a concurrent stop after recovery is reassessed during provider readiness', async () => {
  const firm=await seedFirm(world,world.alpha,'recovery-stop-race');
  const target=await prepareFor(world,world.alpha,firm);
  const gmail=world.clientWith(world.alpha,{});
  const paused=pausingAtTokenRefresh(gmail,async()=>{
    const otherCtx=other.context(world.alpha.workspace.workspaceId);
    await withTransaction(other.session,async()=>{
      await lockSendGateForStopFact(otherCtx);
      const standing=await readRampStanding(otherCtx,world.alpha.mailboxId,{now:new Date('2026-10-23T09:00Z')});
      expect(standing).toMatchObject({effectiveCap:5,recovery:{qualifyingDays:0}});
      expect(await recordSuppression(otherCtx,{scope:'firm',firmId:firm.firmId,source:'prospect_opt_out',channel:'email',journal:world.journal})).toMatchObject({ok:true});
    });
  });
  expect(await dispatchOutboundMessage(context(),world.sendDeps(world.alpha,{gmail:paused.client}),{outboundMessageId:target})).toMatchObject({outcome:'held',refusal:'firm_suppressed'});
  expect(paused.refreshes()).toBe(1);
  expect(gmail.sends).toHaveLength(0);
});

it('computes recovery stages after each five new qualifying days without exceeding the recovery ladder', () => {
  expect([0,4,5,9,10,14,15,19,20,24,25,100].map(recoveryStageCap)).toEqual([5,5,10,10,15,15,25,25,35,35,50,50]);
});
