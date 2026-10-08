import {afterEach,beforeEach,expect,it} from 'vitest';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {readMessage} from '../../mail/messages.ts';
import {recordMatches,type MatchCandidate} from '../../mail/matching.ts';
import {applyDirectSendEffects} from '../../mail/effects.ts';
import {closeSendDay,openSendDay,readRampStanding,readSendDayHealth,recordDaySignal} from '../../outbound/ramp.ts';
import {openHold,releaseHold} from '../../policy/holds.ts';
import {commitDeletion,previewDeletion} from '../../retention/deletion.ts';
import {commitDeparture} from '../../retention/departure.ts';
import {runRetentionBatch} from '../../retention/runs.ts';
import {createOutboundWorld,type OutboundWorld} from '../outbound/support/outboundWorld.ts';
import {seedFirm,type SeededFirm} from '../outbound/support/dispatchFixtures.ts';

let world:OutboundWorld,firm:SeededFirm,messageId:string,epochId:string,date:string;
const system=()=>world.systemContext(world.alpha.workspace.workspaceId);
const admin=()=>repositoryContext(workspaceScope(world.alpha.workspace.workspaceId,{kind:'user',userId:world.alpha.workspace.admin.userId,role:'admin'}),world.database.session);
beforeEach(async()=>{
 world=await createOutboundWorld();
 const box=world.alpha;
 firm=await seedFirm(world,box,'retained-recovery');
 messageId=(await world.database.session.query<{id:string}>(`INSERT INTO mail_messages
   (workspace_id,mailbox_id,provider_message_id,provider_thread_id,direction,internal_date,header_from,header_to,matched)
   VALUES($1,$2,'retained-recovery','retained-recovery','outgoing',clock_timestamp()-interval '15 days',$3,$4::text[],true) RETURNING id`,
 [box.workspace.workspaceId,box.mailboxId,box.address,[firm.address]])).rows[0]!.id;
 const message=(await readMessage(system(),messageId))!;
 const candidate:MatchCandidate={firmId:firm.firmId,opportunityId:firm.opportunityId,contactId:firm.contactId,rule:'thread',viaClosedOpportunity:false};
 await withTransaction(world.database.session,async()=>{await recordMatches(system(),{messageId,candidates:[candidate]});await applyDirectSendEffects(system(),{message,candidate});});
 const standing=(await readRampStanding(system(),box.mailboxId))!;
 expect(standing).toMatchObject({effectiveCap:5,recovery:{active:true,qualifyingDays:0}});
 epochId=standing.recovery!.epochId;date=standing.recovery!.startedOn;
 await openSendDay(system(),{mailboxId:box.mailboxId,businessDate:date,cap:5});
 await world.database.session.query('UPDATE mailbox_send_days SET automated_sent=4 WHERE mailbox_id=$1 AND business_date=$2::date',[box.mailboxId,date]);
 const signals=(await readSendDayHealth(system(),box.mailboxId))!;
 expect(await withTransaction(world.database.session,()=>closeSendDay(system(),{mailboxId:box.mailboxId,businessDate:date,signals}))).toMatchObject({advanced:true,healthySendingDays:40});
});
afterEach(async()=>{await world?.stop();});

it('retains inactivity recovery while expired mailbox sync diagnostics are swept',async()=>{
 const box=world.alpha;
 await world.database.session.query(`INSERT INTO mailbox_recoveries
   (workspace_id,mailbox_id,generation,reason,from_at,to_at,started_at,completed_at)
   VALUES($1,$2,999,'restore','2026-09-01T09:00Z','2026-09-02T09:00Z','2026-09-01T09:00Z','2026-09-02T09:00Z')`,[box.workspace.workspaceId,box.mailboxId]);
 expect(await withTransaction(world.database.session,()=>runRetentionBatch(system(),{dataKind:'raw_mime',now:'2026-10-08T18:00:00Z'}))).toMatchObject({outcome:'swept',detail:{mailbox_recoveries:1}});
 expect(await readRampStanding(system(),box.mailboxId)).toMatchObject({effectiveCap:5,ramp:{healthySendingDays:40},recovery:{epochId,qualifyingDays:1}});
});

it('retains recovery and day reversal references through prospect deletion and restore safety holds',async()=>{
 const box=world.alpha;
 const preview=await previewDeletion(admin(),{targetKind:'firm',firmId:firm.firmId});
 expect(preview).toMatchObject({ok:true});
 expect(await withTransaction(world.database.session,()=>commitDeletion(admin(),{requestId:preview.value!.requestId,previewHash:preview.value!.previewHash,commandId:'retained-recovery-deletion',journal:world.journal}))).toMatchObject({ok:true});
 expect(await readMessage(system(),messageId)).toBeNull();
 expect(await readRampStanding(system(),box.mailboxId)).toMatchObject({effectiveCap:5,lastActivityAt:null,ramp:{healthySendingDays:40},recovery:{epochId,qualifyingDays:1}});
 const hold=await openHold(system(),{scopeKind:'workspace',reasonCode:'restore_in_progress',blockedActionKinds:['email_send'],sourceEventKind:'restore.test'});
 expect(await readRampStanding(system(),box.mailboxId)).toMatchObject({readiness:{ready:false,reasons:['restore_in_progress']},recovery:{epochId,qualifyingDays:1}});
 await releaseHold(system(),hold,'restore_in_progress');
 expect(await readRampStanding(system(),box.mailboxId)).toMatchObject({readiness:{ready:true,reasons:[]},recovery:{epochId,qualifyingDays:1}});
 await recordDaySignal(system(),{mailboxId:box.mailboxId,businessDate:date,signal:'bounce'});
 expect(await readRampStanding(system(),box.mailboxId)).toMatchObject({effectiveCap:5,ramp:{healthySendingDays:40},recovery:{epochId,qualifyingDays:0}});
});

it('keeps earned and recovery history when owner departure revokes mailbox readiness',async()=>{
 const box=world.alpha;
 expect(await withTransaction(world.database.session,()=>commitDeparture(admin(),{userId:box.workspace.salesperson.userId,commandId:'retained-recovery-departure'}))).toMatchObject({ok:true,value:{mailboxesDisconnected:1,refreshTokenMaterialDeleted:true}});
 const standing=await readRampStanding(system(),box.mailboxId);
 expect(standing).toMatchObject({effectiveCap:5,ramp:{healthySendingDays:40},recovery:{epochId,qualifyingDays:1},readiness:{ready:false}});
 expect(standing!.readiness.reasons).toContain('mailbox_disconnected');
});
