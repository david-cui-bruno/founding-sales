import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {dispatch,type ApiRequest} from '../src/server.ts';
import {localNoopSuppressionJournal} from '../src/journal/index.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {saveCandidate} from '@fss/domain/sourcing/candidates.ts';
import {requestQualification,finishQualification} from '@fss/domain/sourcing/qualificationStore.ts';
import {recordStatePosture} from '@fss/domain/policy/postures.ts';
import {POSTURE_STATEMENTS} from '@fss/domain/src/rules/statePosture.ts';
let f:AuthFixture,admin:string,sales:string,beta:string;
const context=()=>repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'user',role:'admin',userId:f.alpha.admin.userId}),f.db);
const envelope=(body:object)=>({...body,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
async function request(path:string,token:string|null,body:unknown,method='POST'){
 return dispatch({method,path,query:new URLSearchParams(),headers:token?{authorization:`Bearer ${token}`}:{},body} as ApiRequest,{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://example.test/update',suppressionJournal:localNoopSuppressionJournal()});
}
beforeAll(async()=>{f=await createAuthFixture();admin=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;sales=(await issueSessionFor(f,f.alpha,f.alpha.salesperson)).accessToken;beta=(await issueSessionFor(f,f.beta,f.beta.admin)).accessToken;await withTransaction(f.db,()=>recordStatePosture(context(),{state:'TX',effectiveFrom:new Date(Date.now()-60000).toISOString(),confirmedStatements:Object.keys(POSTURE_STATEMENTS)}));});
afterAll(async()=>f.stop());
it.each(['/sourcing/calling/admit','/sourcing/calling/assess'])('requires authenticated current admin and strict normal envelope at %s',async(path)=>{
 const input=path.endsWith('admit')?{candidateId:randomUUID(),expectedRevision:1,qualificationRunId:randomUUID(),phone:'+12145550111'}:{firmId:randomUUID(),officeAssessmentId:randomUUID()};
 expect((await request(path,null,envelope(input))).status).toBe(401);
 expect((await request(path,admin,envelope(input),'GET')).status).toBe(405);
 expect((await request(path,sales,envelope(input))).body).toMatchObject({reason:'admin_only'});
 expect((await request(path,admin,envelope({...input,policyVersion:'forged'}))).status).toBe(400);
 expect((await request(path,admin,envelope(input))).body).toMatchObject({reason:'not_found'});
});
it('receipts replay exactly once without strict admission, email/SMS enrollment or candidate mutation',async()=>{
 const payload={firmName:'API Calling Only',website:'https://api-calling.example.test/',sourceUrl:'https://api-calling.example.test/',locality:'Dallas',region:'TX' as const,signal:'fit_only' as const,evidence:'Search only',observedOn:new Date().toISOString().slice(0,10),preparedBy:'Synthetic fixture'};
 const saved=await withTransaction(f.db,()=>saveCandidate(context(),payload));if(!saved.ok)throw new Error(saved.reason);
 const run=await withTransaction(f.db,()=>requestQualification(context(),{candidateId:saved.value.id,expectedRevision:1},{enqueue:false}));if(!run.ok)throw new Error(run.reason);
 const blocks=[{id:'identity',text:payload.firmName},{id:'fit',text:'We manage residential rentals.'},{id:'area',text:'Dallas'},{id:'phone',text:'For information, (214) 555-0111.'}];
 await withTransaction(f.db,()=>finishQualification(context(),{runId:run.value.runId,observations:[{id:randomUUID(),url:payload.website,contentHash:'a'.repeat(64),relevantTextHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex'),retrievedAt:new Date(Date.now()-1000).toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks}],facts:[],reason:'invalid_evidence'}));
 const before=(await f.db.query('SELECT * FROM sourcing_qualification_runs WHERE id=$1',[run.value.runId])).rows[0];
 const command=envelope({candidateId:saved.value.id,expectedRevision:1,qualificationRunId:run.value.runId,phone:'+12145550111'});
 expect((await request('/sourcing/calling/admit',beta,{...command,commandId:randomUUID()})).body).toMatchObject({reason:'not_found'});
 const first=await request('/sourcing/calling/admit',admin,command);expect(first.body,JSON.stringify(first.body)).toMatchObject({status:'accepted',result:{policyVersion:'calling-first-party-tx-v1'}});
 expect((await request('/sourcing/calling/admit',admin,command)).body).toMatchObject({replayed:true});
 expect((await f.db.query('SELECT * FROM sourcing_qualification_runs WHERE id=$1',[run.value.runId])).rows[0]).toEqual(before);
 expect((await f.db.query('SELECT candidate_id FROM sourcing_admissions')).rows).toEqual([]);
 expect((await f.db.query('SELECT id FROM email_addresses')).rows).toEqual([]);
 expect((await f.db.query('SELECT id FROM sequence_enrollments')).rows).toEqual([]);
 expect((await f.db.query("SELECT id FROM audit_events WHERE action='calling.source_evidence_assessed'")).rows).toHaveLength(1);
});
