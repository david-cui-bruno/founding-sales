import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {callingWrapCommandSchema} from '@fss/contracts';
import {routeCalling} from '../src/routes/calling.ts';
import type {ApiRequest} from '../src/routes/types.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {localNoopSuppressionJournal} from '../src/journal/index.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction,type SessionQueryable} from '@fss/domain/db/queryable.ts';
import {saveCandidate} from '@fss/domain/sourcing/candidates.ts';
import {manualOrdinaryFixture} from '../../../packages/domain/test/sourcing/support/manualProspectFixture.ts';
import {payloadHashOf} from '../src/auth/tokens.ts';
import {callingBrowserResult} from '../../web/src/server/callingBoundary.ts';
let f:AuthFixture,runtime:SessionQueryable,token:string;
beforeAll(async()=>{f=await createAuthFixture();runtime=await f.database.appRuntimeSession();token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;console.info('Calling correction refusal DB',{database:f.database.name,template:process.env['FSS_TEST_TEMPLATE_DATABASE'],port:new URL(process.env['FSS_TEST_CLUSTER_URL']!).port,googleStubPort:new URL(f.google.issuer).port});});
afterAll(async()=>f?.stop());
async function request(path:string,body:unknown){const answer=await routeCalling({method:'POST',path:`/calling/${path}`,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body} as ApiRequest,{session:runtime,auth:{...f.deps,db:runtime},supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://example.test/update',suppressionJournal:localNoopSuppressionJournal()});if(!answer)throw Error('Exact Calling route required');return answer;}
async function input(index:number){const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'user',userId:f.alpha.admin.userId,role:'admin'}),runtime),candidate=await withTransaction(runtime,()=>saveCandidate(ctx,manualOrdinaryFixture(index)));if(!candidate.ok)throw Error(candidate.reason);return callingWrapCommandSchema.parse({kind:'candidate',candidateId:candidate.value.id,expectedCandidateRevision:1,attemptId:randomUUID(),report:{performedByUser:true,channel:'manual_phone',occurrence:{kind:'unknown'},result:'unknown',note:null,callback:null},commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});}
async function assertRefusal(command:Awaited<ReturnType<typeof input>>,reason:string){
 const response=await request('wrap',command);expect(response).toMatchObject({status:409,body:{status:'refused',reason,replayed:false}});expect(callingBrowserResult('/calling/wrap',response.status,response.body)).toEqual({status:200,body:response.body});expect((await request('wrap',command)).body).toMatchObject({status:'refused',reason,replayed:true});
 const {commandId,clientVersion:_version,...payload}=command;expect((await request('follow-ups/receipt',{operation:'wrap',commandId,payloadSHA256:payloadHashOf(payload)})).body).toEqual({state:'refused',reason});
 expect((await runtime.query("SELECT result_status FROM command_receipts WHERE workspace_id=$1 AND command_id=$2",[f.alpha.workspaceId,commandId])).rows).toEqual([{result_status:'refused'}]);
 for(const table of ['firms','call_logs','callbacks','today_items','sequence_enrollments','outbound_messages','provider_reservations','calling_follow_up_drafts'])expect((await runtime.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']).toBe(0);
}
it('actual app_runtime future occurrence refuses invalid_time with an opaque refused receipt and no business writes',async()=>{
 const command=await input(79021);if(command.kind!=='candidate')throw Error('Candidate required');command.report.occurrence={kind:'known',occurredAt:new Date(Date.now()+86400000).toISOString()};await assertRefusal(command,'invalid_time');expect((await runtime.query('SELECT id FROM sourcing_manual_prospect_attempts WHERE id=$1',[command.attemptId])).rows).toEqual([]);
});
it('actual app_runtime repeated attempt under a new UUID refuses already_exists, preserving the original report',async()=>{
 const original=await input(79022);if(original.kind!=='candidate')throw Error('Candidate required');expect((await request('wrap',original)).body).toMatchObject({status:'accepted'});const prior=(await runtime.query('SELECT * FROM sourcing_manual_prospect_attempts WHERE id=$1',[original.attemptId])).rows;await assertRefusal({...original,commandId:randomUUID()},'already_exists');expect((await runtime.query('SELECT * FROM sourcing_manual_prospect_attempts WHERE id=$1',[original.attemptId])).rows).toEqual(prior);
});
