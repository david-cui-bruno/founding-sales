import {makeStepExecution} from '../../db/testing/stepExecutions.ts';
import {seedFirm,prepareFor,pausingAtTokenRefresh} from '../outbound/support/dispatchFixtures.ts';
import {dispatchOutboundMessage} from '../../outbound/send.ts';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createOutboundWorld,type OutboundWorld} from '../outbound/support/outboundWorld.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {readProspectingAuthorization,setProspectingAuthorization} from '../../outreach/authorization.ts';
let world:OutboundWorld;
beforeAll(async()=>{world=await createOutboundWorld();});
afterAll(async()=>world?.stop());
const admin=()=>repositoryContext(workspaceScope(world.alpha.workspace.workspaceId,{kind:'user',userId:world.alpha.workspace.admin.userId,role:'admin'}),world.database.session);
const save=(revision:number,enabled=true)=>withTransaction(world.database.session,()=>setProspectingAuthorization(admin(),{mailboxId:world.alpha.mailboxId,expectedRevision:revision,enabled,basis:'owner_reported_google_permission'}));
async function identity(){return (await world.database.session.query<{provider_account_id:string;owner_user_id:string}>('SELECT provider_account_id,owner_user_id FROM mailboxes WHERE id=$1',[world.alpha.mailboxId])).rows[0]!;}
async function read(){const m=await identity();return readProspectingAuthorization(admin(),{mailboxId:world.alpha.mailboxId,ownerUserId:m.owner_user_id,providerAccountId:m.provider_account_id});}
it('defaults off; authorizes only an exact mailbox identity and never changes sending or enrollments',async()=>{
 expect((await read()).allowed).toBe(false);
 const before=(await world.database.session.query('SELECT id,state FROM sequence_enrollments ORDER BY id')).rows;
 expect(await save(0)).toEqual({ok:true,value:{revision:1}});
 expect(await read()).toMatchObject({allowed:true,revision:1});
 const m=await identity();
 expect((await readProspectingAuthorization(admin(),{mailboxId:world.beta.mailboxId,ownerUserId:m.owner_user_id,providerAccountId:m.provider_account_id})).allowed).toBe(false);
 expect((await readProspectingAuthorization(admin(),{mailboxId:world.alpha.mailboxId,ownerUserId:m.owner_user_id,providerAccountId:'different-account'})).allowed).toBe(false);
 expect((await world.database.session.query('SELECT id,state FROM sequence_enrollments ORDER BY id')).rows).toEqual(before);
});
it('rejects stale writes and non-admin users, and revocation increments the binding revision',async()=>{
 expect(await save(0,false)).toEqual({ok:false,reason:'stale_revision'});
 expect(await withTransaction(world.database.session,()=>setProspectingAuthorization(world.userContext(world.alpha.workspace.workspaceId),{mailboxId:world.alpha.mailboxId,expectedRevision:1,enabled:false,basis:'owner_reported_google_permission'}))).toEqual({ok:false,reason:'admin_required'});
 expect(await save(1,false)).toEqual({ok:true,value:{revision:2}});
 expect(await read()).toMatchObject({allowed:false,revision:2});
});
it('OAuth identity replacement invalidates authorization while a same-account token refresh does not',async()=>{
 expect((await save(2)).ok).toBe(true);const original=await identity();
 await world.database.session.query('UPDATE mailboxes SET generation=generation+1 WHERE id=$1',[world.alpha.mailboxId]);
 expect((await read()).allowed).toBe(true);
 await world.database.session.query('UPDATE mailboxes SET provider_account_id=$2 WHERE id=$1',[world.alpha.mailboxId,'other-provider-account']);
 expect((await read()).allowed).toBe(false);
 await world.database.session.query('UPDATE mailboxes SET provider_account_id=$2 WHERE id=$1',[world.alpha.mailboxId,original.provider_account_id]);
});

async function prepared(label:string){
 const firm=await seedFirm(world,world.alpha,label);
 const stepExecutionId=await makeStepExecution(world.database.session,{workspaceId:world.alpha.workspace.workspaceId,firmId:firm.firmId,opportunityId:firm.opportunityId,userId:world.alpha.workspace.salesperson.userId,templateVersionId:world.alpha.templateVersionId,originKind:'prospecting'});
 return prepareFor(world,world.alpha,firm,{stepExecutionId});
}
it('passes both real Gmail gates for a newly prepared authorized fence',async()=>{
 const id=await prepared('authorized-prospect');const gmail=world.clientWith(world.alpha,{});
 const result=await dispatchOutboundMessage(world.systemContext(world.alpha.workspace.workspaceId),world.sendDeps(world.alpha,{gmail}),{outboundMessageId:id});
 expect(result.outcome,JSON.stringify(result)).toBe('sent');expect(gmail.sends).toHaveLength(1);
});
it('revocation during token refresh blocks a previously prepared send at the final gate',async()=>{
 const id=await prepared('revoked-prospect');const gmail=world.clientWith(world.alpha,{});
 const paused=pausingAtTokenRefresh(gmail,async()=>{expect((await save(3,false)).ok).toBe(true);});
 const result=await dispatchOutboundMessage(world.systemContext(world.alpha.workspace.workspaceId),world.sendDeps(world.alpha,{gmail:paused.client}),{outboundMessageId:id});
 expect(paused.refreshes()).toBe(1);expect(result.outcome).toBe('held');expect(gmail.sends).toHaveLength(0);
 expect((await save(4,true)).ok).toBe(true);
 const again=await dispatchOutboundMessage(world.systemContext(world.alpha.workspace.workspaceId),world.sendDeps(world.alpha,{gmail}),{outboundMessageId:id});
 expect(again.outcome).toBe('held');expect(gmail.sends).toHaveLength(0);
});

it('switching away and back through OAuth permanently revokes the old authorization',async()=>{
 const {insertOrReviveMailbox}=await import('../../mail/mailboxes.ts');
 const m=await identity();const address=world.alpha.address;
 const connect=(providerAccountId:string,emailAddress:string)=>withTransaction(world.database.session,()=>insertOrReviveMailbox(admin(),{ownerUserId:m.owner_user_id,providerAccountId,emailAddress,baselineFromAt:new Date().toISOString()}));
 await connect(m.provider_account_id,address);expect((await read()).allowed).toBe(true);
 await connect('replacement-account','replacement@example.test');expect((await read()).allowed).toBe(false);
 await connect(m.provider_account_id,address);expect(await read()).toMatchObject({allowed:false,reason:'authorization_revoked',revision:6});
});
