import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import type {EmailCampaignPolicy} from '@fss/contracts';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {requestQualification} from '../../sourcing/qualificationStore.ts';
import {runQualification} from '../../sourcing/qualificationRun.ts';
import {setProspectingAuthorization} from '../../outreach/authorization.ts';
import {approveEmailCampaign} from '../../outreach/emailCampaign.ts';
import {createTemplateVersion} from '../../templates/templates.ts';
import {createSequence,createDraftVersion,publishVersion} from '../../sequences/definitions.ts';
import {dnsEmailVerifier,type EmailVerifier} from '../../outreach/emailVerification.ts';
import {runPreparedEmailAdmission} from '../../outreach/preparedEmailAdmission.ts';
import type {MailDomainResolver} from '../../crm/routeValidation.ts';
import {researchPageFetch,type RawResponse} from '../../../../apps/worker/src/research/companyPageFetch.ts';

// ADR0035: a prepared own-site company that publishes an exact business address enters the approved campaign after a free check.
let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
const ws=()=>seed.alpha.workspaceId;
const ctx=(worker=false)=>repositoryContext(workspaceScope(ws(),worker?{kind:'system',component:'worker'}:{kind:'user',role:'admin',userId:seed.alpha.admin.userId}),runtime);
const tx=<T>(fn:()=>Promise<T>)=>withTransaction(runtime,fn);
const response=(body:string):RawResponse=>({statusCode:200,headers:{'content-type':'text/html'},body:new TextEncoder().encode(body),abortedOverCap:false});
const business='<p>Our property management company manages residential homes for owners and coordinates tenant maintenance requests.</p>';
const page=(website:string,contact:string)=>researchPageFetch({lookup:async()=>['93.184.216.34'],request:async input=>{
 if(input.url.endsWith('/robots.txt'))return {statusCode:200,headers:{'content-type':'text/plain'},body:new TextEncoder().encode('User-agent: *\nDisallow:\n'),abortedOverCap:false};
 if(input.url===website)return response(`<main>${business}<p>${contact}</p></main>`);
 return {statusCode:404,headers:{},body:null,abortedOverCap:false};
}});
let serial=0;
/** A real own-site capture: the page publishes `contact` text. `host` defaults to a fresh domain; the address uses it. */
async function prepared(region:string,contact:(domain:string)=>string,locality='Columbus'){
 const domain=`peak-${randomUUID().slice(0,8)}.org`,website=`https://${domain}/`;
 const saved=await tx(()=>saveCandidate(ctx(),{firmName:`Peak${String(serial++)} Property Management`,website,sourceUrl:website,locality,region:region as never,signal:'fit_only',evidence:'Fictional search label only',observedOn:new Date().toISOString().slice(0,10),preparedBy:'Controlled test'} as never));
 if(!saved.ok)throw Error(saved.reason);
 const requested=await tx(()=>requestQualification(ctx(true),{candidateId:saved.value.id,expectedRevision:1},{enqueue:false}));if(!requested.ok)throw Error(requested.reason);
 const target={candidateId:saved.value.id,candidateRevision:1,runId:requested.value.runId};
 await runQualification(ctx(true),target,{pageFetch:page(website,contact(domain)),extraction:{providerKey:'aws_bedrock.sourcing_qualification',countInputTokens:async()=>100,extract:async()=>({ok:true as const,costCents:1,value:{facts:[],openingQuestion:null}})}});
 return {candidateId:saved.value.id,domain};
}
const goodMx:MailDomainResolver={resolveMx:async()=>[{exchange:'mx.mail-host.net',priority:10}],resolve4:async()=>[],resolve6:async()=>[]};
const verifier=dnsEmailVerifier(goodMx,50);
const admissions=async()=>(await runtime.query<{address:string;source_kind:string;region:string}>("SELECT r.address,a.source_kind,c.payload->>'region' AS region FROM outreach_email_campaign_admissions a JOIN email_addresses r ON r.workspace_id=a.workspace_id AND r.id=a.route_id JOIN sourcing_candidates c ON c.workspace_id=a.workspace_id AND c.id=a.candidate_id WHERE a.workspace_id=$1 ORDER BY r.address",[ws()])).rows;
const pass=(v:EmailVerifier=verifier)=>tx(()=>runPreparedEmailAdmission(ctx(true),{verifier:v}));
beforeAll(async()=>{
 db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();
 await runtime.query('INSERT INTO research_settings(workspace_id,enabled,max_pages_per_firm) VALUES($1,true,1)',[ws()]);
 const mailbox=(await runtime.query<{id:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,$3,$4,'connected') RETURNING id",[ws(),seed.alpha.admin.userId,`campaign-${randomUUID()}@example.test`,`local-${randomUUID()}`])).rows[0]!.id;
 await runtime.query("INSERT INTO workspace_settings(workspace_id,setting_key,version,value,change_note,changed_by_user_id) VALUES($1,'postal_address',1,$2::jsonb,'fixture',$3)",[ws(),JSON.stringify({address:'339 Thayer Street, Providence, RI 02906'}),seed.alpha.admin.userId]);
 await runtime.query("INSERT INTO workspace_settings(workspace_id,setting_key,version,value,change_note,changed_by_user_id) VALUES($1,'booking_link',1,$2::jsonb,'fixture',$3)",[ws(),JSON.stringify({url:'https://cal.com/david-cui-yrp9dm/demo'}),seed.alpha.admin.userId]);
 const authorization=await tx(()=>setProspectingAuthorization(ctx(),{mailboxId:mailbox,expectedRevision:0,enabled:true,basis:'owner_reported_google_permission'}));if(!authorization.ok)throw Error(authorization.reason);
 const ids:string[]=[];
 for(let index=0;index<5;index++){
  const template=await tx(()=>createTemplateVersion(ctx(),{name:`Touch ${String(index+1)}`,subject:'maintenance calls at {firm_name}',body:'Hi {firm_name} team,\n\nSo I built Callie. Grab a time: {booking_link}\n\nBest,\nDavid',footer:{signOff:'David Cui · Brown University'},requiredVariables:['firm_name','booking_link'],approve:true}));
  if(!template.ok)throw Error(template.reason);ids.push(template.value.id);
 }
 const sequence=await tx(()=>createSequence(ctx(),{name:`Campaign ${randomUUID()}`}));if(!sequence.ok)throw Error(sequence.reason);
 const version=await tx(()=>createDraftVersion(ctx(),{sequenceId:sequence.value.id,steps:ids.map((templateVersionId,index)=>({ordinal:index+1,channel:'email',delay:{unit:'elapsed',hours:[0,72,168,312,480][index]!},templateVersionId}))}));if(!version.ok)throw Error(version.reason);
 const published=await tx(()=>publishVersion(ctx(),{sequenceVersionId:version.value.sequenceVersionId}));if(!published.ok)throw Error(published.reason);
 const policy:EmailCampaignPolicy={mailboxId:mailbox,authorizationRevision:authorization.value.revision,sequenceVersionId:version.value.sequenceVersionId,regions:['OH','WA'],maxEnrollments:25,dailyAdmissionLimit:5,expiresAt:new Date(Date.now()+86_400_000).toISOString()};
 const approved=await tx(()=>approveEmailCampaign(ctx(),policy));if(!approved.ok)throw Error(approved.reason);
});
afterAll(async()=>db?.drop());

it('admits nothing and checks nothing when no company publishes an address',async()=>{
 await prepared('OH',()=> 'Call our office.');
 expect(await pass()).toEqual({admitted:0,checked:0,failed:0});
 expect(await admissions()).toEqual([]);
});
it('does not admit a guessed, consumer, third-party or mismatched address',async()=>{
 await prepared('OH',()=>'Our team is reachable through the contact form.');
 await prepared('OH',()=>'Email peakpm@gmail.com');
 await prepared('OH',()=>'Email owner@some-other-domain.com');
 await prepared('OH',()=>'Suggested address: info@guess.org');
 expect(await pass()).toMatchObject({admitted:0});
 expect(await admissions()).toEqual([]);
});
it('admits a company that publishes an exact own-domain address, in WA and OH, and rechecks nothing inside the window',async()=>{
 const oh=await prepared('OH',domain=>`Email info@${domain}`),wa=await prepared('WA',domain=>`Email Office@${domain}`,'Seattle');
 expect(await pass()).toEqual({admitted:2,checked:2,failed:0});
 expect(await admissions()).toEqual(expect.arrayContaining([{address:`info@${oh.domain}`,source_kind:'prepared_capture',region:'OH'},{address:`office@${wa.domain}`,source_kind:'prepared_capture',region:'WA'}]));
 expect(await pass()).toMatchObject({admitted:0,checked:0});
 expect((await runtime.query('SELECT count(*)::int AS n FROM outreach_email_verifications')).rows[0]).toEqual({n:2});
});
it('admits no company whose check fails or cannot answer, and records an invalid answer once',async()=>{
 const bad=await prepared('OH',domain=>`Email info@${domain}`),later=await prepared('OH',domain=>`Email hello@${domain}`);
 const before=(await admissions()).length;
 const answers=new Map([[`info@${bad.domain}`,'invalid' as const]]);
 expect(await pass({verify:async address=>answers.get(address)??null})).toMatchObject({admitted:0,checked:1});
 expect((await admissions()).length).toBe(before);
 expect(await pass({verify:async()=>{throw Error('must not ask twice inside the window');}}).catch(error=>String(error))).toBeDefined();
 expect(await pass()).toMatchObject({admitted:1});
 expect((await admissions()).map(row=>row.address)).toContain(`hello@${later.domain}`);
 expect((await admissions()).map(row=>row.address)).not.toContain(`info@${bad.domain}`);
});
it('refuses a company in a region outside the campaign and a Firm that already exists',async()=>{
 const other=await prepared('CA',domain=>`Email info@${domain}`,'Fresno');
 const taken=await prepared('OH',domain=>`Email info@${domain}`);
 await tx(()=>runtime.query("INSERT INTO firms(workspace_id,name,website) VALUES($1,$2,$3)",[ws(),'Existing Customer',`https://${taken.domain}/`]));
 await pass();
 const addresses=(await admissions()).map(row=>row.address);
 expect(addresses).not.toContain(`info@${other.domain}`);expect(addresses).not.toContain(`info@${taken.domain}`);
});
it('stops at the campaign caps',async()=>{
 for(let i=0;i<7;i++)await prepared('OH',domain=>`Email info@${domain}`);
 await pass();await pass();
 expect(((await runtime.query('SELECT count(*)::int AS n FROM outreach_email_campaign_admissions WHERE workspace_id=$1',[ws()])).rows[0] as {n:number}).n).toBe(5);
});
