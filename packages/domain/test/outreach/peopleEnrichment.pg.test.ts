import {afterAll,beforeAll,expect,it} from 'vitest';
import {fakePeople,ownerAt,preparedEmailWorld} from './preparedEmailFixture.ts';
import type {PeopleLookup} from '../../outreach/peopleProvider.ts';

// ADR0036: enrichment reserves and commits BEFORE the paid call, never pays twice for a company, stops at the daily credit cap, keeps only verified own-domain
// personal-name decision-maker answers, and halts the pass on a provider failure without paying again. Fake provider only: no network, no real key.
let world:Awaited<ReturnType<typeof preparedEmailWorld>>;
beforeAll(async()=>{world=await preparedEmailWorld({dailyCredits:100});},180_000);
afterAll(async()=>world?.stop());
const rows=async()=>(await world.runtime.query<Record<string,unknown>>('SELECT * FROM outreach_people_contacts WHERE workspace_id=$1 ORDER BY reserved_at,id',[world.ws])).rows;
const rowFor=async(candidateId:string)=>(await rows()).find(row=>row['candidate_id']===candidateId)!;
const spentToday=async()=>Number((await world.runtime.query<{n:string}>('SELECT coalesce(sum(credits),0)::text AS n FROM outreach_people_contacts WHERE workspace_id=$1',[world.ws])).rows[0]!.n);
const PERSON_COLUMNS=['provider_person_id','first_name','last_name','title','email','email_status','match_confidence'];

it('reserves before the call, records the verified decision-maker, and never pays twice for the same company',async()=>{
 const company=await world.prepared('OH',()=>'Call our office.');
 let duringCall:Record<string,unknown>|undefined;
 const people=fakePeople(host=>ownerAt(host));
 const probe={...people.provider,findDecisionMaker:async(input:{domain:string;companyName:string})=>{duringCall=await rowFor(company.candidateId);return people.provider.findDecisionMaker(input);}};
 expect(await world.enrich({provider:probe})).toMatchObject({looked:1,found:1,none:0,credits:1,halted:null});
 // The reservation was committed (and counted as one credit) while the provider was still being asked.
 expect(duringCall).toMatchObject({state:'reserved',credits:1,host:company.domain,provider:'fake_people'});
 expect(await rowFor(company.candidateId)).toMatchObject({state:'found',credits:1,first_name:'Jordan',last_name:'Blake',title:'Owner',email:`jordan.blake@${company.domain}`,email_status:'verified',match_confidence:'high',provider_person_id:`p-${company.domain}`,reason:null});
 expect(await world.enrich(people)).toMatchObject({looked:0,credits:0});
 expect(people.calls).toEqual([company.domain]);
});
it('records "nothing found" once with no person and no spend, and does not ask again',async()=>{
 const company=await world.prepared('OH',()=>'x');
 const people=fakePeople(()=>({ok:true,person:null,creditsUsed:0}));
 expect(await world.enrich(people)).toMatchObject({looked:1,found:0,none:1,credits:0});
 expect(await rowFor(company.candidateId)).toMatchObject({state:'none',reason:'no_person',credits:0,...Object.fromEntries(PERSON_COLUMNS.map(column=>[column,null]))});
 await world.enrich(people);expect(people.calls).toEqual([company.domain]);
});
it.each([
 ['an unverified email','unverified',{emailStatus:'unverified' as const}],
 ['a role mailbox','role_address',{email:'info@HOST'}],
 ['an office mailbox','role_address',{email:'office@HOST'}],
 ['a consumer address','consumer_domain',{email:'jordan.blake@gmail.com'}],
 ['another company\'s domain','domain_mismatch',{email:'jordan.blake@someone-else.org'}],
 ['a low-confidence match','low_confidence',{matchConfidence:'low' as const}],
 ['a leasing agent title','title',{title:'Leasing Agent'}],
 ['a masked last name','no_name',{lastName:'Bl***e'}],
 ['no email','unverified',{email:null,emailStatus:'unavailable' as const}],
])('drops %s without keeping the person, but keeps the credit it cost',async(_name,reason,patch)=>{
 const company=await world.prepared('OH',()=>'x');
 const people=fakePeople(host=>ownerAt(host,{...patch,...('email' in patch&&typeof patch.email==='string'?{email:patch.email.replace('HOST',host)}:{})}));
 await world.enrich(people);
 expect(await rowFor(company.candidateId)).toMatchObject({state:'none',reason,credits:1,...Object.fromEntries(PERSON_COLUMNS.map(column=>[column,null]))});
 await world.pass();
 expect((await world.admissions()).filter(row=>row.address.endsWith(`@${company.domain}`))).toEqual([]);
});
it('stops the whole pass at the daily credit cap and spends nothing past it',async()=>{
 const before=await spentToday();
 await world.setPeople({enabled:true,dailyCredits:before+2});
 for(let i=0;i<4;i++)await world.prepared('OH',()=>'x');
 const people=fakePeople();
 expect(await world.enrich(people)).toMatchObject({looked:2,found:2,credits:2,stopped:'cap'});
 expect(await spentToday()).toBe(before+2);
 expect(await world.enrich(people)).toMatchObject({looked:0,stopped:'cap'});
 expect(people.calls).toHaveLength(2);
 await world.setPeople({enabled:true,dailyCredits:100});
});
it('does nothing while the setting is off or the cap is zero',async()=>{
 await world.prepared('OH',()=>'x');
 const people=fakePeople();
 for(const value of [{enabled:false,dailyCredits:100},{enabled:true,dailyCredits:0}]){
  await world.setPeople(value);
  expect(await world.enrich(people)).toMatchObject({looked:0,stopped:'disabled'});
 }
 expect(people.calls).toEqual([]);
 await world.setPeople({enabled:true,dailyCredits:100});
});
it('halts the pass on a refused uncharged call, leaves it failed with no spend, and tries the company again only after its cool-down',async()=>{
 await world.enrich();
 const failing:PeopleLookup={ok:false,code:'rate_limited',mayHaveCharged:false};
 await world.prepared('OH',()=>'x');await world.prepared('OH',()=>'x');
 let people=fakePeople(()=>failing);
 const pass=await world.enrich(people);
 expect(pass).toMatchObject({looked:1,found:0,halted:'rate_limited',credits:0});
 expect(people.calls).toHaveLength(1);
 const failed=(await rows()).find(row=>row['state']==='failed')!;
 expect(failed).toMatchObject({state:'failed',reason:'rate_limited',credits:0});
 // Not asked again inside the cool-down; the next pass takes the companies behind it.
 people=fakePeople();await world.enrich(people);
 expect(people.calls).not.toContain(failed['host']);
 await world.runtime.query("UPDATE outreach_people_contacts SET reserved_at=reserved_at-interval '2 hours',expires_at=clock_timestamp()-interval '1 minute' WHERE workspace_id=$1 AND id=$2",[world.ws,failed['id']]);
 people=fakePeople();await world.enrich(people);
 expect(people.calls).toContain(failed['host']);
 expect(await rowFor(failed['candidate_id'] as string)).toMatchObject({state:'found',credits:1});
});
it('leaves a call that may have been charged unknown, keeps its credit, halts, and never asks again',async()=>{
 await world.enrich();
 const company=await world.prepared('OH',()=>'x');
 const people=fakePeople(()=>({ok:false,code:'unavailable',mayHaveCharged:true}));
 const spent=await spentToday();
 expect(await world.enrich(people)).toMatchObject({looked:1,halted:'unavailable',credits:1});
 expect(await rowFor(company.candidateId)).toMatchObject({state:'unknown',reason:'unavailable',credits:1,email:null});
 expect(await spentToday()).toBe(spent+1);
 const again=fakePeople();await world.enrich(again);
 expect(again.calls).not.toContain(company.domain);
});
it('treats a provider that throws as possibly charged, and a reservation that never settled as unknown',async()=>{
 await world.enrich();
 const thrown=await world.prepared('OH',()=>'x');
 const throwing={providerKey:'fake_people',maxCreditsPerLookup:1,findDecisionMaker:async()=>{throw new Error('DO-NOT-RETAIN');}};
 expect(await world.enrich({provider:throwing})).toMatchObject({looked:1,halted:'unavailable'});
 expect(await rowFor(thrown.candidateId)).toMatchObject({state:'unknown',credits:1});
 const crashed=await world.prepared('OH',()=>'x');
 await world.runtime.query("INSERT INTO outreach_people_contacts(workspace_id,candidate_id,candidate_revision,host,provider,state,credits,business_date,business_time_zone,reserved_at,expires_at) VALUES($1,$2,1,$3,'fake_people','reserved',1,current_date,'America/New_York',clock_timestamp()-interval '10 minutes',clock_timestamp()+interval '30 days')",[world.ws,crashed.candidateId,crashed.domain]);
 const people=fakePeople();await world.enrich(people);
 expect(await rowFor(crashed.candidateId)).toMatchObject({state:'unknown',credits:1});
 expect(people.calls).not.toContain(crashed.domain);
});
it('refuses a found person at the database unless it is verified, lower case and at the company host',async()=>{
 const company=await world.prepared('OH',()=>'x');
 const insert=(email:string,status='verified')=>world.runtime.query("INSERT INTO outreach_people_contacts(workspace_id,candidate_id,candidate_revision,host,provider,state,provider_person_id,first_name,last_name,title,email,email_status,match_confidence,credits,business_date,business_time_zone,observed_at,expires_at) VALUES($1,$2,1,$3,'other_provider','found','p','A','B','Owner',$4,$5,'high',1,current_date,'America/New_York',now(),now()+interval '30 days')",[world.ws,company.candidateId,company.domain,email,status]);
 await expect(insert(`a@other.org`)).rejects.toMatchObject({code:'23514'});
 await expect(insert(`A@${company.domain}`)).rejects.toMatchObject({code:'23514'});
 await expect(insert(`a@${company.domain}`,'unverified')).rejects.toMatchObject({code:'23514'});
 await insert(`a@${company.domain}`);
});
