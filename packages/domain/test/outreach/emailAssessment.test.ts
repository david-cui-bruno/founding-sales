import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {requestQualification,finishQualification} from '../../sourcing/qualificationStore.ts';
import {evaluateQualification} from '../../sourcing/qualificationDecision.ts';
import {assessEmailCandidate} from '../../outreach/selection.ts';
import {recordStatePosture} from '../../policy/postures.ts';
import {POSTURE_STATEMENTS} from '../../src/rules/statePosture.ts';
let db:TestDatabase;let seeded:TwoWorkspaces;
const ctx=()=>repositoryContext(workspaceScope(seeded.alpha.workspaceId,{kind:'user',userId:seeded.alpha.admin.userId,role:'admin'}),db.session);
const tx=<T>(fn:()=>Promise<T>)=>withTransaction(db.session,fn);
beforeAll(async()=>{db=await createTestDatabase();seeded=await seedTwoWorkspaces(db.session);await tx(()=>recordStatePosture(ctx(),{state:'TX',effectiveFrom:new Date(Date.now()-60000).toISOString(),confirmedStatements:Object.keys(POSTURE_STATEMENTS)}));});
afterAll(async()=>db.drop());
beforeEach(async()=>{await db.session.query('DELETE FROM sourcing_candidates');await db.session.query('DELETE FROM sourcing_discovery_settings');await db.session.query('DELETE FROM daily_counters');});
let phoneSerial=100;
async function qualified(name:string,options:{locality?:string;website?:string;need?:string;phone?:string}={}){
 const locality=options.locality??'Dallas',website=options.website??`https://${name.toLowerCase().replaceAll(' ','')}.example.test/`;
 const candidate=await tx(()=>saveCandidate(ctx(),{firmName:name,website,locality,region:'TX',signal:'fit_only',evidence:'Maintenance work',sourceUrl:website,observedOn:'2026-10-01',preparedBy:'Fixture'}));if(!candidate.ok)throw new Error(candidate.reason);
 const request=await tx(()=>requestQualification(ctx(),{candidateId:candidate.value.id,expectedRevision:1}));if(!request.ok)throw new Error(request.reason);
 const id=randomUUID(),date=new Date().toISOString().slice(0,10);
 const blocks=[{id:'firm',text:`${name} is a residential property management company in ${locality}, Texas.`},{id:'phone',text:`Contact ${name} at ${options.phone??`(214) 555-${String(phoneSerial++).padStart(4,'0')}`}.`},{id:'email',text:`${name} ${locality} TX office info@${new URL(website).hostname}`},{id:'need',text:options.need??'Our team is overwhelmed by maintenance calls.'},{id:'date',text:`Published ${date}`}];
 const facts=[['firm_identity','firm'],['residential_management','firm'],['service_area','firm'],['business_phone','phone'],['business_email','email'],['operational_burden','need']].map(([kind,blockId])=>({kind,blockId,observationId:id,value:blocks.find(b=>b.id===blockId)!.text}));
 const finished=await tx(()=>finishQualification(ctx(),{runId:request.value.runId,reason:null,observations:[{id,url:website,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:new Date().toISOString(),publishedAt:`${date}T00:00:00Z`,publishedAtBlockId:'date',firstParty:true,truncated:false,blocks}],facts}));if(!finished.ok)throw new Error(finished.reason);
 await tx(()=>evaluateQualification(ctx(),{runId:request.value.runId}));
 return {candidateId:candidate.value.id,expectedRevision:1,qualificationRunId:request.value.runId,mode:'reviewed' as const};
}

it('assesses sourced email without requiring a phone and preserves fit-only review',async()=>{
 const input=await qualified('Email PM',{phone:'not supplied',need:'We provide maintenance service.'});
 const assessed=await assessEmailCandidate(ctx(),input);
 expect(assessed).toMatchObject({ok:true,value:{firmId:null,lane:'email_first',rank:'fit_only',reviewRequired:true,route:{identityKind:'role',address:'info@emailpm.example.test'}}});
 expect((await db.session.query('SELECT id FROM firms')).rows).toHaveLength(0);
});
it('selects call-first for explicit burden plus a callable route, and rejects stale or ambiguous evidence',async()=>{
 const input=await qualified('Burden PM');
 expect(await assessEmailCandidate(ctx(),input)).toMatchObject({ok:true,value:{lane:'call_first',rank:'operational_burden',reviewRequired:false}});
 await db.session.query("UPDATE sourcing_candidates SET revision=revision+1 WHERE id=$1",[input.candidateId]);
 expect(await assessEmailCandidate(ctx(),input)).toEqual({ok:false,reason:'candidate_changed'});
});
