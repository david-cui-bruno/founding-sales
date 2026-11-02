import {afterAll,beforeAll,expect,it} from 'vitest';
import {SENDING_STOP_LINE} from '@fss/contracts';
import {runEmailRouteValidation} from '../../crm/routeValidation.ts';
import {composeEligibility} from '../../sequences/eligibility.ts';
import {runDueStepExecution} from '../../sequences/executions.ts';
import {recordingSendHandoff} from '../../sequences/sendHandoff.ts';
import {withReadOnlyTransaction,withTransaction} from '../../db/queryable.ts';
import {previewPreparedEmailAdmission} from '../../outreach/preparedEmailPreview.ts';
import {listPreparedProspects} from '../../sourcing/preparedProspects.ts';
import {BOOKING_LINK,POSTAL_ADDRESS,goodMx,preparedEmailWorld} from './preparedEmailFixture.ts';

// ADR0037: the real own-site source over a real prepared capture (the page text the capture retained), through the real enrichment pass and admission.
// No provider, no network, no credit: the company's own page names the decision-maker.
let world:Awaited<ReturnType<typeof preparedEmailWorld>>;
beforeAll(async()=>{world=await preparedEmailWorld({dailyCredits:0});},240_000);
afterAll(async()=>world?.stop());
const lookup=async(candidateId:string)=>(await world.runtime.query<Record<string,unknown>>('SELECT l.provider,l.state,l.credits,l.reason,l.host,l.candidate_revision,c.first_name,c.last_name,c.title,c.email,c.email_status,c.match_confidence,c.source_url,c.source_block_id,c.source_quote FROM outreach_people_lookups l LEFT JOIN outreach_people_contacts c ON c.workspace_id=l.workspace_id AND c.lookup_id=l.id WHERE l.workspace_id=$1 AND l.candidate_id=$2',[world.ws,candidateId])).rows[0];
const preview=()=>withReadOnlyTransaction(world.runtime,()=>previewPreparedEmailAdmission(world.ctx(),{limit:25,regions:['OH']}));
const team=(domain:string)=>`Meet the team</p><p>Tyler Bradford</p><p>President, CPM</p><p>tyler@${domain}</p><p>Amy Lowe</p><p>Leasing Agent</p><p>amy@${domain}`;

it('finds the named president and the address the company published, spends nothing, never reads the company twice, and admits it as a named contact whose first email greets "Hi Tyler,"',async()=>{
 const company=await world.prepared('OH',team,'Columbus',true);
 expect(await world.enrichOwnSite()).toMatchObject({looked:1,found:1,none:0,credits:0,halted:null,stopped:null});
 expect(await lookup(company.candidateId)).toMatchObject({provider:'own_site',state:'found',credits:0,reason:null,host:company.domain,first_name:'Tyler',last_name:'Bradford',title:'President, CPM',email:`tyler@${company.domain}`,email_status:'published',match_confidence:'high',source_url:`https://${company.domain}/`});
 const stored=await lookup(company.candidateId);
 expect(stored!['source_quote']).toBe(`Tyler Bradford / President, CPM / tyler@${company.domain}`);expect(stored!['source_block_id']).toMatch(/^b\d+$/u);
 // Zero credits against a zero daily cap: the cap applies only to a source that costs credits.
 expect((await world.runtime.query<{n:string}>('SELECT coalesce(sum(credits),0)::text AS n FROM outreach_people_lookups WHERE workspace_id=$1',[world.ws])).rows[0]).toEqual({n:'0'});
 expect(await world.enrichOwnSite()).toMatchObject({looked:0,found:0});
 expect((await preview())!.candidates.map(row=>({name:`${row.person.firstName} ${row.person.lastName}`,title:row.person.title,email:row.person.email,status:row.person.emailStatus,provider:row.person.provider,credits:row.person.creditsSpent,url:row.person.source?.url}))).toEqual([{name:'Tyler Bradford',title:'President, CPM',email:`tyler@${company.domain}`,status:'published',provider:'own_site',credits:0,url:`https://${company.domain}/`}]);
 expect(await world.pass()).toEqual({admitted:1,checked:1,failed:0});
 const admission=(await world.runtime.query<{enrollment_id:string;route_id:string}>('SELECT enrollment_id,route_id FROM outreach_email_campaign_admissions WHERE workspace_id=$1 AND candidate_id=$2',[world.ws,company.candidateId])).rows[0]!;
 expect((await world.runtime.query('SELECT c.full_name,c.title,r.address,r.source FROM email_addresses r JOIN contacts c ON c.workspace_id=r.workspace_id AND c.id=r.contact_id WHERE r.workspace_id=$1 AND r.id=$2',[world.ws,admission.route_id])).rows).toEqual([{full_name:'Tyler Bradford',title:'President, CPM',address:`tyler@${company.domain}`,source:'research_provider'}]);
 // The address was published by the company but is still checked, free, at admission: syntax and MX.
 expect((await world.runtime.query('SELECT result FROM outreach_email_verifications WHERE workspace_id=$1',[world.ws])).rows).toEqual([{result:'valid'}]);
 const route=(await world.runtime.query<{version:number}>('SELECT version FROM email_addresses WHERE workspace_id=$1 AND id=$2',[world.ws,admission.route_id])).rows[0]!;
 expect((await world.tx(()=>runEmailRouteValidation(world.ctx(true),{payload:{routeKind:'email',routeId:admission.route_id,routeVersion:route.version},resolver:goodMx}))).outcome).toBe('written');
 const execution=(await world.runtime.query<{id:string}>('SELECT id FROM step_executions WHERE workspace_id=$1 AND enrollment_id=$2 AND ordinal=1',[world.ws,admission.enrollment_id])).rows[0]!;
 const handoff=recordingSendHandoff(),dueAt=async()=>(await world.runtime.query<{at:Date}>('SELECT greatest(due_at,not_before)+interval \'1 minute\' AS at FROM step_executions WHERE workspace_id=$1 AND id=$2',[world.ws,execution.id])).rows[0]!.at.toISOString();
 const look=(now:string)=>world.tx(()=>runDueStepExecution(world.ctx(true),{stepExecutionId:execution.id,now,eligibility:composeEligibility(),sendHandoff:handoff}));
 let ran=await look(await dueAt());if(ran.kind==='scheduled')ran=await look(await dueAt());
 expect(ran).toMatchObject({kind:'handed_to_send'});
 const email=handoff.prepared[0]!;
 expect(email.toAddress).toBe(`tyler@${company.domain}`);expect(email.body.startsWith('Hi Tyler,\n')).toBe(true);
 for(const text of [BOOKING_LINK,POSTAL_ADDRESS,SENDING_STOP_LINE])expect(email.body).toContain(text);
});

it('keeps a named person with no published address for Calling, never admits or previews it for email, and counts it',async()=>{
 const company=await world.prepared('OH',()=>'TX License #597044-B Ryan Stetson, Broker</p><p>Email info@stetson.example','Columbus',true);
 expect(await world.enrichOwnSite()).toMatchObject({looked:1,found:1,none:0,credits:0});
 expect(await lookup(company.candidateId)).toMatchObject({provider:'own_site',state:'found',credits:0,first_name:'Ryan',last_name:'Stetson',title:'Broker',email:null,email_status:'unavailable',source_url:`https://${company.domain}/`,source_quote:'TX License #597044-B Ryan Stetson, Broker'});
 expect(await world.pass()).toEqual({admitted:0,checked:0,failed:0});
 expect((await world.runtime.query('SELECT 1 FROM outreach_email_campaign_admissions WHERE workspace_id=$1 AND candidate_id=$2',[world.ws,company.candidateId])).rows).toEqual([]);
 const shown=(await preview())!;
 expect(shown.candidates.map(row=>row.candidateId)).not.toContain(company.candidateId);expect(shown.namedWithoutEmail).toBe(1);
 const listed=await withTransaction(world.runtime,()=>listPreparedProspects(world.ctx(),{order:'priority'}));
 expect(listed.ok).toBe(true);
 if(listed.ok)expect(listed.value.prospects.find(row=>row.target.candidateId===company.candidateId)?.namedPerson).toEqual({name:'Ryan Stetson',title:'Broker'});
});

it('records nobody for a page that names no decision-maker, a customer, a tenant, a leasing agent or only a role mailbox, and builds no address from a name',async()=>{
 const company=await world.prepared('OH',domain=>`Email info@${domain} or office@${domain}</p><p>"They fixed it fast." - Sarah Lee, Tenant</p><p>- Mike Ross, Owner</p><p>Tom Reed, Leasing Agent tom@${domain}</p><p>Pat Roe, Associate Broker`,'Columbus',true);
 expect(await world.enrichOwnSite()).toMatchObject({looked:1,found:0,none:1,credits:0});
 expect(await lookup(company.candidateId)).toMatchObject({provider:'own_site',state:'none',reason:'no_person',credits:0,first_name:null,email:null});
});

it('keeps a person but drops an address that is another company\'s domain or a role alias, and reads a company again only when its person expires',async()=>{
 const company=await world.prepared('OH',domain=>`Jon Smith, Owner jon@other-company.example</p><p>Jon Smith, Broker ceo@${domain}`,'Columbus',true);
 await world.enrichOwnSite();
 expect(await lookup(company.candidateId)).toMatchObject({state:'found',first_name:'Jon',title:'Owner',email:null,email_status:'unavailable'});
 expect(await world.enrichOwnSite()).toMatchObject({looked:0});
 // Thirty days later the custody row is read again in place: one lookup, one person copy.
 await world.runtime.query("UPDATE outreach_people_lookups SET reserved_at=clock_timestamp()-interval '40 days',expires_at=clock_timestamp()-interval '10 days' WHERE workspace_id=$1 AND candidate_id=$2",[world.ws,company.candidateId]);
 expect(await world.enrichOwnSite()).toMatchObject({looked:1,found:1,credits:0});
 expect((await world.runtime.query('SELECT count(*)::int AS n FROM outreach_people_lookups WHERE workspace_id=$1 AND candidate_id=$2',[world.ws,company.candidateId])).rows).toEqual([{n:1}]);
 expect((await world.runtime.query('SELECT count(*)::int AS n FROM outreach_people_contacts WHERE workspace_id=$1 AND candidate_id=$2',[world.ws,company.candidateId])).rows).toEqual([{n:1}]);
 expect(await lookup(company.candidateId)).toMatchObject({state:'found',first_name:'Jon',credits:0});
});
