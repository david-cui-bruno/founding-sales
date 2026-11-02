import {randomUUID} from 'node:crypto';
import type {EmailCampaignPolicy} from '@fss/contracts';
import {createTestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces} from '../db/support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {requestQualification} from '../../sourcing/qualificationStore.ts';
import {runQualification} from '../../sourcing/qualificationRun.ts';
import {setProspectingAuthorization} from '../../outreach/authorization.ts';
import {approveEmailCampaign} from '../../outreach/emailCampaign.ts';
import {approveCampaignOpening,readCampaignOpeningControl} from '../../outreach/campaignOpeningControl.ts';
import {createTemplateVersion} from '../../templates/templates.ts';
import {createSequence,createDraftVersion,publishVersion} from '../../sequences/definitions.ts';
import {dnsEmailVerifier,type EmailVerifier} from '../../outreach/emailVerification.ts';
import {runPreparedEmailAdmission} from '../../outreach/preparedEmailAdmission.ts';
import {runPeopleEnrichment} from '../../outreach/peopleEnrichment.ts';
import {ownSitePeople} from '../../outreach/ownSitePeople.ts';
import type {PeopleLookup,PeopleProvider,ProviderPerson} from '../../outreach/peopleProvider.ts';
import {updateSetting} from '../../settings/store.ts';
import type {MailDomainResolver} from '../../crm/routeValidation.ts';
import {researchPageFetch,type RawResponse} from '../../../../apps/worker/src/research/companyPageFetch.ts';

/** A verified decision-maker answer for `host`; `patch` changes any person field. Never a real provider. */
export const ownerAt=(host:string,patch:Partial<ProviderPerson>={},creditsUsed=1):PeopleLookup=>({ok:true,creditsUsed,person:{providerPersonId:`p-${host}`,firstName:'Jordan',lastName:'Blake',title:'Owner',email:`jordan.blake@${host}`,emailStatus:'verified',matchConfidence:'high',...patch}});
/** A fake people provider that records every host it was asked about and answers `answer(host)` (default: the verified owner above). */
export function fakePeople(answer:(host:string)=>PeopleLookup=ownerAt){const calls:string[]=[];const provider:PeopleProvider={providerKey:'fake_people',maxCreditsPerLookup:1,findDecisionMaker:async({domain})=>{calls.push(domain);return answer(domain);}};return {provider,calls};}
/** ADR0035/0036 fixture: a real approved email campaign (mailbox, booking link, postal address, five approved touches) and real own-site
 * prepared captures. `prepared` runs the real fetch and qualification; `invalid` makes the extractor answer invalid_evidence, which is
 * what most real prepared candidates carry (run.reason NOT NULL). `opening` also approves a campaign opening policy. `enrich` runs the real
 * enrichment pass with a fake provider (people enrichment is switched on with `dailyCredits`, default 100) and `enrichOwnSite` with the real own-site source; `pass` is the admission pass. */
const response=(body:string):RawResponse=>({statusCode:200,headers:{'content-type':'text/html'},body:new TextEncoder().encode(body),abortedOverCap:false});
const business='<p>Our property management company manages residential homes for owners and coordinates tenant maintenance requests.</p>';
const page=(website:string,contact:string)=>researchPageFetch({lookup:async()=>['93.184.216.34'],request:async input=>{
 if(input.url.endsWith('/robots.txt'))return {statusCode:200,headers:{'content-type':'text/plain'},body:new TextEncoder().encode('User-agent: *\nDisallow:\n'),abortedOverCap:false};
 if(input.url===website)return response(`<main>${business}<p>${contact}</p></main>`);
 return {statusCode:404,headers:{},body:null,abortedOverCap:false};
}});
export const goodMx:MailDomainResolver={resolveMx:async()=>[{exchange:'mx.mail-host.net',priority:10}],resolve4:async()=>[],resolve6:async()=>[]};
export const verifier=dnsEmailVerifier(goodMx,50);
export const BOOKING_LINK='https://cal.com/david-cui-yrp9dm/demo',POSTAL_ADDRESS='339 Thayer Street, Providence, RI 02906';
/** `manyCaptures` lifts the workspace's daily research ceilings so a test can make more than the default number of real captures. */
export async function preparedEmailWorld(options:{opening?:boolean;regions?:string[];manyCaptures?:boolean;dailyCredits?:number}={}){
 const db=await createTestDatabase(),seed=await seedTwoWorkspaces(db.session),runtime:SessionQueryable=await db.appRuntimeSession(),ws=seed.alpha.workspaceId;
 const ctx=(worker=false)=>repositoryContext(workspaceScope(ws,worker?{kind:'system',component:'worker'}:{kind:'user',role:'admin',userId:seed.alpha.admin.userId}),runtime);
 const tx=<T>(fn:()=>Promise<T>)=>withTransaction(runtime,fn);
 let serial=0;
 /** A real own-site capture: the page publishes `contact(domain)`; `name` is the stored company name (default: a branded label). */
 async function prepared(region:string,contact:(domain:string)=>string,locality='Columbus',invalid=false,name?:string){
  const domain=`peak-${randomUUID().slice(0,8)}.org`,website=`https://${domain}/`;
  const saved=await tx(()=>saveCandidate(ctx(),{firmName:name??`Peak${String(serial++)} Property Management`,website,sourceUrl:website,locality,region:region as never,signal:'fit_only',evidence:'Fictional search label only',observedOn:new Date().toISOString().slice(0,10),preparedBy:'Controlled test'} as never));
  if(!saved.ok)throw Error(saved.reason);
  const requested=await tx(()=>requestQualification(ctx(true),{candidateId:saved.value.id,expectedRevision:1},{enqueue:false}));if(!requested.ok)throw Error(requested.reason);
  const target={candidateId:saved.value.id,candidateRevision:1,runId:requested.value.runId};
  await runQualification(ctx(true),target,{pageFetch:page(website,contact(domain)),extraction:{providerKey:'aws_bedrock.sourcing_qualification',countInputTokens:async()=>100,extract:async()=>invalid?{ok:false as const,failureCode:'invalid_evidence' as const,costCents:1}:{ok:true as const,costCents:1,value:{facts:[],openingQuestion:null}}}});
  return {candidateId:saved.value.id,runId:target.runId,domain};
 }
 const admissions=async()=>(await runtime.query<{address:string;source_kind:string;region:string}>("SELECT r.address,a.source_kind,c.payload->>'region' AS region FROM outreach_email_campaign_admissions a JOIN email_addresses r ON r.workspace_id=a.workspace_id AND r.id=a.route_id JOIN sourcing_candidates c ON c.workspace_id=a.workspace_id AND c.id=a.candidate_id WHERE a.workspace_id=$1 ORDER BY r.address",[ws])).rows;
 const pass=(v:EmailVerifier=verifier)=>runPreparedEmailAdmission(ctx(true),{verifier:v});
 const setPeople=(value:{enabled:boolean;dailyCredits:number})=>tx(()=>updateSetting(ctx(),{settingKey:'people_enrichment',value}));
 const enrich=(people:{provider:PeopleProvider}=fakePeople())=>runPeopleEnrichment(ctx(true),people);
 /** The real own-site source (ADR0037) over the retained captures: free, no provider fake. */
 const enrichOwnSite=()=>runPeopleEnrichment(ctx(true),{provider:ownSitePeople()});
 if(options.manyCaptures)await runtime.query('INSERT INTO research_settings(workspace_id,enabled,max_pages_per_firm,daily_firm_ceiling,daily_cost_ceiling_cents,monthly_cost_ceiling_cents) VALUES($1,true,1,10000,1000000,10000000)',[ws]);
 else await runtime.query('INSERT INTO research_settings(workspace_id,enabled,max_pages_per_firm) VALUES($1,true,1)',[ws]);
 const mailbox=(await runtime.query<{id:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status,sync_state,history_id,history_id_updated_at,baseline_from_at,baseline_completed_at,coverage_watermark_at) VALUES($1,$2,$3,$4,'connected','ready','1000',now(),now()-interval '30 days',now(),now()) RETURNING id",[ws,seed.alpha.admin.userId,`campaign-${randomUUID()}@example.test`,`local-${randomUUID()}`])).rows[0]!.id;
 await runtime.query("INSERT INTO workspace_settings(workspace_id,setting_key,version,value,change_note,changed_by_user_id) VALUES($1,'postal_address',1,$2::jsonb,'fixture',$3)",[ws,JSON.stringify({address:POSTAL_ADDRESS}),seed.alpha.admin.userId]);
 await runtime.query("INSERT INTO workspace_settings(workspace_id,setting_key,version,value,change_note,changed_by_user_id) VALUES($1,'booking_link',1,$2::jsonb,'fixture',$3)",[ws,JSON.stringify({url:BOOKING_LINK}),seed.alpha.admin.userId]);
 const authorization=await tx(()=>setProspectingAuthorization(ctx(),{mailboxId:mailbox,expectedRevision:0,enabled:true,basis:'owner_reported_google_permission'}));if(!authorization.ok)throw Error(authorization.reason);
 const people=await setPeople({enabled:true,dailyCredits:options.dailyCredits??100});if(!people.ok)throw Error(people.reason);
 const ids:string[]=[];
 for(let index=0;index<5;index++){
  const template=await tx(()=>createTemplateVersion(ctx(),{name:`Touch ${String(index+1)}`,subject:'maintenance calls at {firm_name}',body:index===0?'Hi {first_name},\n\nSo I built Callie. Grab a time: {booking_link}\n\nBest,\nDavid':'Hi {firm_name} team,\n\nSo I built Callie. Grab a time: {booking_link}\n\nBest,\nDavid',footer:{signOff:'David Cui · Brown University'},requiredVariables:index===0?['first_name','firm_name','booking_link']:['firm_name','booking_link'],approve:true}));
  if(!template.ok)throw Error(template.reason);ids.push(template.value.id);
 }
 const sequence=await tx(()=>createSequence(ctx(),{name:`Campaign ${randomUUID()}`}));if(!sequence.ok)throw Error(sequence.reason);
 const version=await tx(()=>createDraftVersion(ctx(),{sequenceId:sequence.value.id,steps:ids.map((templateVersionId,index)=>({ordinal:index+1,channel:'email',delay:{unit:'elapsed',hours:[0,72,168,312,480][index]!},templateVersionId}))}));if(!version.ok)throw Error(version.reason);
 const published=await tx(()=>publishVersion(ctx(),{sequenceVersionId:version.value.sequenceVersionId}));if(!published.ok)throw Error(published.reason);
 const policy:EmailCampaignPolicy={mailboxId:mailbox,authorizationRevision:authorization.value.revision,sequenceVersionId:version.value.sequenceVersionId,regions:(options.regions??['OH','WA']) as EmailCampaignPolicy['regions'],maxEnrollments:25,dailyAdmissionLimit:5,expiresAt:new Date(Date.now()+86_400_000).toISOString()};
 const approved=await tx(()=>approveEmailCampaign(ctx(),policy));if(!approved.ok)throw Error(approved.reason);
 const campaignId=approved.value.campaignId,allow=async()=>true;
 const openingInput=async()=>{const baseline=(await readCampaignOpeningControl(ctx(),{campaignId},allow))!.baseline!;return {campaignId,expectedCampaignRevision:1,templateVersionId:baseline.templateVersionId,templateContentHash:baseline.templateContentHash,variants:[{id:'local',text:'I noticed {{firm_name}} serves {{firm_locality}}, {{firm_region}}.'}],expiresAt:policy.expiresAt};};
 const approveOpening=async()=>tx(async()=>approveCampaignOpening(ctx(),await openingInput(),allow));
 if(options.opening){const opened=await approveOpening();if(!opened.ok)throw Error(opened.reason);}
 return {db,seed,runtime,ws,ctx,tx,prepared,admissions,pass,enrich,enrichOwnSite,setPeople,campaignId,approveOpening,stop:()=>db.drop()};
}
