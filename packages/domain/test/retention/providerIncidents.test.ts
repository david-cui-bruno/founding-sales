import {afterEach,beforeEach,expect,it} from 'vitest';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {dispatchOutboundMessage} from '../../outbound/send.ts';
import {reconcileOutboundMessage} from '../../outbound/reconcile.ts';
import {readProviderIncidents,type ProviderIncident} from '../../outbound/providerIncidents.ts';
import {commitDeletion,previewDeletion} from '../../retention/deletion.ts';
import {commitDeparture} from '../../retention/departure.ts';
import {runRetentionBatch} from '../../retention/runs.ts';
import {openHold,releaseHold} from '../../policy/holds.ts';
import {prepareFor,seedFirm,type SeededFirm} from '../outbound/support/dispatchFixtures.ts';
import {createOutboundWorld,type OutboundWorld} from '../outbound/support/outboundWorld.ts';

let world:OutboundWorld,firm:SeededFirm,incident:ProviderIncident,id:string,now:Date;
const system=()=>world.systemContext(world.alpha.workspace.workspaceId);
const admin=()=>repositoryContext(workspaceScope(world.alpha.workspace.workspaceId,{kind:'user',userId:world.alpha.workspace.admin.userId,role:'admin'}),world.database.session);
beforeEach(async()=>{
 world=await createOutboundWorld();now=new Date();
 const box=world.alpha;firm=await seedFirm(world,box,'retained-incident');
 id=await prepareFor(world,box,firm);
 const gmail=world.clientWith(box,{sendBehaviour:'indeterminate_but_delivered'});
 await dispatchOutboundMessage(system(),world.sendDeps(box,{gmail}),{outboundMessageId:id});
 const retryAt=new Date(now.getTime()+300_000).toISOString();
 await reconcileOutboundMessage(system(),world.reconcileDeps(box,{gmail:{...gmail,searchSentByMessageId:async()=>({ok:false as const,reason:'rate_limited' as const,retryAt})},now:()=>now}),{outboundMessageId:id});
 incident=(await readProviderIncidents(system(),box.mailboxId,now)).find(i=>i.sourceKind==='sent_search')!;
 expect(incident).toMatchObject({state:'waiting',sourceId:id});
});
afterEach(async()=>{await world?.stop();});

it('retains coded incident ownership when expired sync diagnostics are swept',async()=>{
 await withTransaction(world.database.session,()=>runRetentionBatch(system(),{dataKind:'raw_mime',now:new Date(now.getTime()+40*86400_000).toISOString()}));
 expect((await readProviderIncidents(system(),world.alpha.mailboxId,now)).find(i=>i.id===incident.id)).toEqual(incident);
});

it('retains the original coded source identity through prospect deletion and restore holds',async()=>{
 const box=world.alpha,preview=await previewDeletion(admin(),{targetKind:'firm',firmId:firm.firmId});
 expect(preview).toMatchObject({ok:true});
 expect(await withTransaction(world.database.session,()=>commitDeletion(admin(),{requestId:preview.value!.requestId,previewHash:preview.value!.previewHash,commandId:'retained-incident-delete',journal:world.journal}))).toMatchObject({ok:true});
 expect((await readProviderIncidents(system(),box.mailboxId,now)).find(i=>i.id===incident.id)).toEqual(incident);
 const hold=await openHold(system(),{scopeKind:'workspace',reasonCode:'restore_in_progress',blockedActionKinds:['email_send'],sourceEventKind:'restore.test'});
 await releaseHold(system(),hold,'restore_in_progress');
 expect((await readProviderIncidents(system(),box.mailboxId,now)).find(i=>i.id===incident.id)).toEqual(incident);
 // Releasing only the restore hold supplies neither fresh provider evidence nor
 // authority to resubmit the original claimed fence.
 expect(await dispatchOutboundMessage(system(),world.sendDeps(box),{outboundMessageId:id})).toMatchObject({outcome:'not_ready'});
 expect(box.gmail.sends).toHaveLength(0);
});

it('retains the incident after owner departure and refuses automatic recovery for its now-unsafe binding',async()=>{
 const box=world.alpha;
 expect(await withTransaction(world.database.session,()=>commitDeparture(admin(),{userId:box.workspace.salesperson.userId,commandId:'retained-incident-departure'}))).toMatchObject({ok:true,value:{mailboxesDisconnected:1,refreshTokenMaterialDeleted:true}});
 expect((await readProviderIncidents(system(),box.mailboxId,now)).find(i=>i.id===incident.id)).toMatchObject({...incident,state:'action_required'});
 expect(await reconcileOutboundMessage(system(),world.reconcileDeps(box,{now:()=>new Date(now.getTime()+600_000)}),{outboundMessageId:id})).toMatchObject({outcome:'incident_held'});
 expect(box.gmail.sends).toHaveLength(0);
});
