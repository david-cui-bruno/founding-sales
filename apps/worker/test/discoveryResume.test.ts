import {afterAll,beforeAll,beforeEach,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '@fss/domain/db/testing/testDatabase.ts';
import {seedTwoWorkspaces} from '@fss/domain/test/db/support/fixtures.ts';
import {discoveryResumeCommand} from '../src/tools/fss/discoveryResume.ts';
let db:TestDatabase;let workspaceId:string;
const launch={launchedBy:'arn:aws:iam::123456789012:user/operator',taskArn:'arn:aws:ecs:us-east-1:123456789012:task/cluster/abc'};
beforeAll(async()=>{db=await createTestDatabase();workspaceId=(await seedTwoWorkspaces(db.session)).alpha.workspaceId;});
afterAll(async()=>{await db.drop();});
beforeEach(async()=>{await db.session.query('DELETE FROM sourcing_discovery_attempts');await db.session.query('DELETE FROM sourcing_search_account');await db.session.query('INSERT INTO sourcing_search_account(id,halted,daily_used,monthly_used) VALUES(true,true,1,21)');});
const options=()=>({'--workspace-id':workspaceId,'--observed-at':new Date(Date.now()-1000).toISOString(),'--provider-month-used':'20','--provider-month-limit':'1000','--expected-month-used':'21'});
it('resumes without refunding reserved usage, records evidence, and replay is inert',async()=>{
 const input={session:await db.appRuntimeSession(),options:options(),launch};
 expect(await discoveryResumeCommand(input)).toMatchObject({ok:true,value:{resumed:true,monthlyUsed:21,dailyUsed:1}});
 expect((await db.session.query('SELECT halted,monthly_used FROM sourcing_search_account')).rows[0]).toEqual({halted:false,monthly_used:21});
 expect(await discoveryResumeCommand(input)).toMatchObject({ok:true,value:{alreadyRunning:true}});
 expect((await db.session.query("SELECT detail FROM audit_events WHERE action='sourcing.discovery_resumed' AND workspace_id=$1",[workspaceId])).rows).toHaveLength(1);
 expect((await db.session.query('SELECT id FROM sourcing_discovery_attempts')).rows).toHaveLength(0);
});
it('refuses stale evidence, a changed counter, an unaudited caller and an unresolved request',async()=>{
 expect(await discoveryResumeCommand({session:db.session,options:options()})).toMatchObject({ok:false,reason:'launcher_unknown'});
 for(const edit of [{'--observed-at':new Date(Date.now()-660000).toISOString()},{'--expected-month-used':'20'}])expect(await discoveryResumeCommand({session:db.session,launch,options:{...options(),...edit}})).toMatchObject({ok:false,reason:'usage_changed'});
 await db.session.query("INSERT INTO sourcing_discovery_attempts(workspace_id,query_id,query) VALUES($1,'test','test')",[workspaceId]);
 expect(await discoveryResumeCommand({session:db.session,options:options(),launch})).toMatchObject({ok:false,reason:'dispatch_unresolved'});
 expect((await db.session.query('SELECT halted FROM sourcing_search_account')).rows[0]).toEqual({halted:true});
});
it('accounts for newly discovered usage conservatively and refuses either ceiling',async()=>{
 for(const edit of [{'--provider-month-used':'600'},{'--provider-month-used':'40'},{'--provider-month-limit':'21'}])expect(await discoveryResumeCommand({session:db.session,launch,options:{...options(),...edit}})).toMatchObject({ok:false,reason:'quota_exhausted'});
 expect(await discoveryResumeCommand({session:db.session,launch,options:{...options(),'--provider-month-used':'23'}})).toMatchObject({ok:true,value:{monthlyUsed:23,dailyUsed:3}});
});
