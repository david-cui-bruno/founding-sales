import {afterAll,beforeAll,expect,it} from 'vitest';
import {SENDING_STOP_LINE} from '@fss/contracts';
import {runEmailRouteValidation} from '../../crm/routeValidation.ts';
import {composeEligibility} from '../../sequences/eligibility.ts';
import {runDueStepExecution} from '../../sequences/executions.ts';
import {recordingSendHandoff} from '../../sequences/sendHandoff.ts';
import {withReadOnlyTransaction,withTransaction} from '../../db/queryable.ts';
import {previewPreparedEmailAdmission} from '../../outreach/preparedEmailPreview.ts';
import {currentPeopleContacts} from '../../outreach/peopleContacts.ts';
import type {EmailVerifier} from '../../outreach/emailVerification.ts';
import type {AddressCheck,AddressVerdict} from '../../outreach/addressGuess.ts';
import {reservePaidCheck,settlePaidCheck} from '../../outreach/paidChecks.ts';
import {deleteCandidate} from '../../sourcing/candidates.ts';
import {BOOKING_LINK,POSTAL_ADDRESS,fakeAddressVerifier,goodMx,preparedEmailWorld} from './preparedEmailFixture.ts';

// ADR0038: the guess-and-verify step and the published-address check, through the real own-site read and the real admission pass, with a fake paid verifier (no network, no key).
let world:Awaited<ReturnType<typeof preparedEmailWorld>>;
beforeAll(async()=>{world=await preparedEmailWorld({dailyCredits:100});},240_000);
afterAll(async()=>world?.stop());
const named=(first:string)=>()=>`TX License #597044-B ${first} Stetson, Broker</p><p>Email info@stetson.example`;
// Admission is exercised once, for the first test's guess; published addresses are in publishedAddressCheck.pg.test.ts (the campaign admits at most five a day).
const verdict=(value:AddressVerdict):AddressCheck=>({ok:true,verdict:value});
// The paid ledger row of the candidate's newest revision, with the verified-guess person copy (a free millionverifier lookup row) when there is one.
const custody=async(candidateId:string,provider='millionverifier')=>(provider==='millionverifier'
 ?(await world.runtime.query<Record<string,unknown>>("SELECT p.state,p.credits,p.reason,c.email,c.email_status,c.match_confidence,c.source_url,c.first_name FROM outreach_people_paid_checks p LEFT JOIN outreach_people_lookups l ON l.workspace_id=p.workspace_id AND l.candidate_id=p.candidate_id AND l.provider='millionverifier' AND l.state='found' LEFT JOIN outreach_people_contacts c ON c.workspace_id=l.workspace_id AND c.lookup_id=l.id WHERE p.workspace_id=$1 AND p.candidate_id=$2 ORDER BY p.candidate_revision DESC LIMIT 1",[world.ws,candidateId])).rows[0]
 :(await world.runtime.query<Record<string,unknown>>('SELECT l.state,l.credits,l.reason,c.email,c.email_status FROM outreach_people_lookups l LEFT JOIN outreach_people_contacts c ON c.workspace_id=l.workspace_id AND c.lookup_id=l.id WHERE l.workspace_id=$1 AND l.candidate_id=$2 AND l.provider=$3',[world.ws,candidateId,provider])).rows[0]);
const spent=async()=>Number((await world.runtime.query<{n:string}>('SELECT coalesce(sum(credits),0)::text AS n FROM outreach_people_paid_checks WHERE workspace_id=$1',[world.ws])).rows[0]!.n);
const preview=()=>withReadOnlyTransaction(world.runtime,()=>previewPreparedEmailAdmission(world.ctx(),{limit:25,regions:['OH']}));

it('keeps a verified guess as `verified_guess` for one credit, previews it as guessed, admits it after the free check, and greets "Hi Ryan," without ever asking the verifier again',async()=>{
 const company=await world.prepared('OH',named('Ryan'),'Columbus',true);
 expect(await world.enrichOwnSite()).toMatchObject({looked:1,found:1,credits:0});
 const paid=fakeAddressVerifier();
 expect(await world.guess(paid.verifier)).toEqual({looked:1,verified:1,refused:0,credits:1,halted:null,stopped:null});
 expect(paid.calls).toEqual([`ryan@${company.domain}`]);
 expect(await custody(company.candidateId)).toEqual({state:'none',credits:1,reason:'verdict_ok',email:`ryan@${company.domain}`,email_status:'verified_guess',match_confidence:'medium',source_url:`https://${company.domain}/`,first_name:'Ryan'});
 // The own-site row is untouched: the company still published no address for the person.
 expect(await custody(company.candidateId,'own_site')).toMatchObject({state:'found',credits:0,email:null,email_status:'unavailable'});
 expect((await world.runtime.query('SELECT g.expires_at<=o.expires_at AS bounded FROM outreach_people_lookups g JOIN outreach_people_lookups o ON o.workspace_id=g.workspace_id AND o.candidate_id=g.candidate_id AND o.provider=$3 WHERE g.workspace_id=$1 AND g.candidate_id=$2 AND g.provider=$4',[world.ws,company.candidateId,'own_site','millionverifier'])).rows).toEqual([{bounded:true}]);
 expect(await spent()).toBe(1);
 // The same person at the same company is never guessed twice, in this pass or the next.
 expect(await world.guess(paid.verifier)).toMatchObject({looked:0,verified:0,credits:0});expect(paid.calls).toHaveLength(1);
 expect((await currentPeopleContacts(world.ctx(),[company.candidateId])).get(company.candidateId)).toMatchObject({firstName:'Ryan',email:`ryan@${company.domain}`,emailStatus:'verified_guess',provider:'millionverifier'});
 const shown=(await preview())!;
 expect(shown.candidates.filter(row=>row.candidateId===company.candidateId).map(row=>({status:row.person.emailStatus,provider:row.person.provider,credits:row.person.creditsSpent,email:row.person.email}))).toEqual([{status:'verified_guess',provider:'millionverifier',credits:1,email:`ryan@${company.domain}`}]);// the preview still reports the paid charge, read from the ledger rather than the free person row
 // Admission asks only the free DNS check about a guess: the paid check already answered ok.
 const asked=fakeAddressVerifier(()=>verdict('invalid'));
 expect(await world.pass(undefined,asked.verifier)).toEqual({admitted:1,checked:1,failed:0});
 expect(asked.calls).toEqual([]);
 const admission=(await world.runtime.query<{enrollment_id:string;route_id:string}>('SELECT enrollment_id,route_id FROM outreach_email_campaign_admissions WHERE workspace_id=$1 AND candidate_id=$2',[world.ws,company.candidateId])).rows[0]!;
 expect((await world.runtime.query('SELECT c.full_name,c.title,r.address,r.source FROM email_addresses r JOIN contacts c ON c.workspace_id=r.workspace_id AND c.id=r.contact_id WHERE r.workspace_id=$1 AND r.id=$2',[world.ws,admission.route_id])).rows).toEqual([{full_name:'Ryan Stetson',title:'Broker',address:`ryan@${company.domain}`,source:'research_provider'}]);
 expect((await world.runtime.query('SELECT provider,result FROM outreach_email_verifications WHERE workspace_id=$1',[world.ws])).rows).toContainEqual({provider:'dns_mx',result:'valid'});
 const route=(await world.runtime.query<{version:number}>('SELECT version FROM email_addresses WHERE workspace_id=$1 AND id=$2',[world.ws,admission.route_id])).rows[0]!;
 expect((await world.tx(()=>runEmailRouteValidation(world.ctx(true),{payload:{routeKind:'email',routeId:admission.route_id,routeVersion:route.version},resolver:goodMx}))).outcome).toBe('written');
 const execution=(await world.runtime.query<{id:string}>('SELECT id FROM step_executions WHERE workspace_id=$1 AND enrollment_id=$2 AND ordinal=1',[world.ws,admission.enrollment_id])).rows[0]!;
 const handoff=recordingSendHandoff(),dueAt=async()=>(await world.runtime.query<{at:Date}>('SELECT greatest(due_at,not_before)+interval \'1 minute\' AS at FROM step_executions WHERE workspace_id=$1 AND id=$2',[world.ws,execution.id])).rows[0]!.at.toISOString();
 const look=(now:string)=>world.tx(()=>runDueStepExecution(world.ctx(true),{stepExecutionId:execution.id,now,eligibility:composeEligibility(),sendHandoff:handoff}));
 let ran=await look(await dueAt());if(ran.kind==='scheduled')ran=await look(await dueAt());
 expect(ran).toMatchObject({kind:'handed_to_send'});
 const email=handoff.prepared[0]!;
 expect(email.toAddress).toBe(`ryan@${company.domain}`);expect(email.body.startsWith('Hi Ryan,\n')).toBe(true);
 for(const text of [BOOKING_LINK,POSTAL_ADDRESS,SENDING_STOP_LINE])expect(email.body).toContain(text);
});

it.each([
 ['invalid','verdict_invalid',1],['catch_all','verdict_catch_all',0],['unknown','verdict_unknown',0],['disposable','verdict_disposable',1],
] as const)('a %s answer leaves the person named with no address, charges %i credit(s), and is never guessed again, across passes',async(answer,reason,credits)=>{
 const company=await world.prepared('OH',named('Sam'),'Columbus',true);
 await world.enrichOwnSite();
 const before=await spent(),paid=fakeAddressVerifier(()=>verdict(answer));
 expect(await world.guess(paid.verifier)).toEqual({looked:1,verified:0,refused:1,credits,halted:null,stopped:null});
 expect(paid.calls).toEqual([`sam@${company.domain}`]);
 expect(await custody(company.candidateId)).toMatchObject({state:'none',credits,reason,email:null});
 expect(await spent()).toBe(before+credits);
 // Never a second guess: not in the next pass, not after the own-site source is read again, and no other pattern is tried.
 expect(await world.guess(paid.verifier)).toMatchObject({looked:0,credits:0});
 await world.runtime.query("UPDATE outreach_people_lookups SET expires_at=clock_timestamp()-interval '1 second',reserved_at=clock_timestamp()-interval '2 days' WHERE workspace_id=$1 AND provider='own_site' AND candidate_id=$2",[world.ws,company.candidateId]);
 await world.enrichOwnSite();expect(await world.guess(paid.verifier)).toMatchObject({looked:0,credits:0});expect(paid.calls).toHaveLength(1);
 // The person stays for Calling and is not emailable.
 expect((await currentPeopleContacts(world.ctx(),[company.candidateId])).get(company.candidateId)).toMatchObject({firstName:'Sam',email:null,emailStatus:'unavailable'});
 expect((await preview())!.candidates.map(row=>row.candidateId)).not.toContain(company.candidateId);
 expect(await world.pass()).toMatchObject({admitted:0});
});

it('treats a transport failure as unknown (the credit is kept, no retry) and an uncharged refusal as failed (tried again after an hour), halting the pass either way',async()=>{
 const lost=await world.prepared('OH',named('Lee'),'Columbus',true);
 await world.enrichOwnSite();
 const before=await spent(),broken=fakeAddressVerifier(()=>({ok:false,code:'unavailable',mayHaveCharged:true}));
 expect(await world.guess(broken.verifier)).toEqual({looked:1,verified:0,refused:0,credits:1,halted:'unavailable',stopped:null});
 expect(await custody(lost.candidateId)).toMatchObject({state:'unknown',credits:1,reason:'unavailable',email:null});expect(await spent()).toBe(before+1);
 expect(await world.guess(fakeAddressVerifier().verifier)).toMatchObject({looked:0});
 const limited=await world.prepared('OH',named('Kim'),'Columbus',true);
 await world.enrichOwnSite();
 const refused=fakeAddressVerifier(()=>({ok:false,code:'rate_limited',mayHaveCharged:false}));
 expect(await world.guess(refused.verifier)).toEqual({looked:1,verified:0,refused:0,credits:0,halted:'rate_limited',stopped:null});
 expect(await custody(limited.candidateId)).toMatchObject({state:'failed',credits:0,reason:'rate_limited'});
 expect(await world.guess(refused.verifier)).toMatchObject({looked:0});expect(refused.calls).toHaveLength(1);
 await world.runtime.query("UPDATE outreach_people_paid_checks SET expires_at=clock_timestamp()-interval '1 second',reserved_at=clock_timestamp()-interval '2 hours' WHERE workspace_id=$1 AND candidate_id=$2",[world.ws,limited.candidateId]);
 const retry=fakeAddressVerifier();
 expect(await world.guess(retry.verifier)).toMatchObject({looked:1,verified:1,credits:1});expect(retry.calls).toEqual([`kim@${limited.domain}`]);
 expect((await world.runtime.query('SELECT count(*)::int AS n FROM outreach_people_paid_checks WHERE workspace_id=$1 AND candidate_id=$2',[world.ws,limited.candidateId])).rows).toEqual([{n:1}]);
});

it('stops at the daily credit cap, re-reads the cap under lock before each paid call, and never guesses with the switch or the cap at zero',async()=>{
 for(const first of ['Ana','Ben','Cal','Dee'])await world.prepared('OH',named(first),'Columbus',true);
 await world.enrichOwnSite();
 const before=await spent();
 await world.setPeople({enabled:true,dailyCredits:before+2});
 const paid=fakeAddressVerifier(()=>verdict('invalid'));
 expect(await world.guess(paid.verifier)).toMatchObject({looked:2,refused:2,credits:2,stopped:'cap'});expect(paid.calls).toHaveLength(2);
 expect(await world.guess(paid.verifier)).toMatchObject({looked:0,stopped:'cap'});expect(paid.calls).toHaveLength(2);
 // The cap is read again under lock for every reservation: an admin lowering it during the first check stops the second.
 await world.setPeople({enabled:true,dailyCredits:before+10});
 const lowering=fakeAddressVerifier(async()=>{await world.setPeople({enabled:true,dailyCredits:0});return verdict('invalid');});
 const stopped=await world.guess(lowering.verifier);
 expect(lowering.calls.length).toBeLessThanOrEqual(1);expect(stopped.stopped).toBe('disabled');
 expect(await spent()).toBeLessThanOrEqual(before+3);
 const off=fakeAddressVerifier();
 expect(await world.guess(off.verifier)).toMatchObject({looked:0,stopped:'disabled'});expect(off.calls).toEqual([]);
 await world.setPeople({enabled:true,dailyCredits:100});
 expect(await world.guess(fakeAddressVerifier(()=>verdict('invalid')).verifier)).toMatchObject({looked:1});
});

it('guesses only at the company\'s own host and spends nothing on a host with no mail exchanger',async()=>{
 const company=await world.prepared('OH',named('Mia'),'Columbus',true);
 await world.enrichOwnSite();
 const noMx:EmailVerifier={verify:async()=>'invalid'},paid=fakeAddressVerifier();
 expect(await world.guess(paid.verifier,noMx)).toEqual({looked:0,verified:0,refused:1,credits:0,halted:null,stopped:null});
 expect(paid.calls).toEqual([]);expect(await custody(company.candidateId)).toMatchObject({state:'none',credits:0,reason:'no_mail_domain',email:null});
 expect(await world.guess(paid.verifier,noMx)).toMatchObject({refused:0});
 // A deferred DNS answer records nothing and asks nobody.
 const later=await world.prepared('OH',named('Ola'),'Columbus',true);
 await world.enrichOwnSite();
 expect(await world.guess(paid.verifier,{verify:async()=>null})).toMatchObject({looked:0,refused:0});expect(await custody(later.candidateId)).toBeUndefined();
 await world.guess(paid.verifier);expect(paid.calls).toEqual([`ola@${later.domain}`]);
});

it('refuses to guess for a first name it cannot spell in ASCII',async()=>{
 const hyphen=await world.prepared('OH',named('Jean-Luc'),'Columbus',true);
 await world.enrichOwnSite();
 const paid=fakeAddressVerifier();
 expect(await world.guess(paid.verifier)).toMatchObject({looked:0,refused:0});expect(paid.calls).toEqual([]);
 expect(await custody(hyphen.candidateId)).toBeUndefined();
});

it('never renews a paid row: a candidate-revision change gets a new row, both charges stay in the day\'s count so the cap holds for the next company, and the same revision is never paid for twice',async()=>{
 const [a,b]=[await world.prepared('OH',named('Ava'),'Columbus',true),await world.prepared('OH',named('Bo'),'Columbus',true)];
 const revision=async(id:string)=>Number((await world.runtime.query<{revision:number}>('SELECT revision FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[world.ws,id])).rows[0]!.revision);
 const company=async(c:typeof a)=>({candidateId:c.candidateId,candidateRevision:await revision(c.candidateId),host:c.domain});
 const charge=async(c:typeof a)=>{const r=await reservePaidCheck(world.ctx(),{kind:'guess',company:await company(c),credits:1});if(r.kind==='reserved')await settlePaidCheck(world.ctx(),r.id,{state:'none',reason:'verdict_ok',credits:1});return r.kind;};
 const before=await spent();
 await world.setPeople({enabled:true,dailyCredits:before+2});
 expect(await charge(a)).toBe('reserved');
 expect(await charge(a)).toBe('taken');// the same revision is paid for once
 await world.runtime.query('UPDATE sourcing_candidates SET revision=revision+1 WHERE workspace_id=$1 AND id=$2',[world.ws,a.candidateId]);
 expect(await charge(a)).toBe('reserved');// the new revision is a new row beside the old one
 expect((await world.runtime.query<{credits:number}>('SELECT credits FROM outreach_people_paid_checks WHERE workspace_id=$1 AND candidate_id=$2',[world.ws,a.candidateId])).rows).toHaveLength(2);
 expect(await spent()).toBe(before+2);
 expect(await charge(b)).toBe('cap');// both of A's charges are counted
 await world.setPeople({enabled:true,dailyCredits:100});
});

it('keeps an uncertain (possibly charged) paid attempt fenced across a candidate-revision change and a re-read of the pages: no second paid call',async()=>{
 const c=await world.prepared('OH',named('Uri'),'Columbus',true);
 await world.enrichOwnSite();
 const revision=async()=>Number((await world.runtime.query<{revision:number}>('SELECT revision FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[world.ws,c.candidateId])).rows[0]!.revision);
 const first=await reservePaidCheck(world.ctx(),{kind:'guess',company:{candidateId:c.candidateId,candidateRevision:await revision(),host:c.domain},credits:1});
 expect(first.kind).toBe('reserved');
 if(first.kind==='reserved')await settlePaidCheck(world.ctx(),first.id,{state:'unknown',reason:'unavailable'});
 await world.runtime.query('UPDATE sourcing_candidates SET revision=revision+1 WHERE workspace_id=$1 AND id=$2',[world.ws,c.candidateId]);
 expect((await reservePaidCheck(world.ctx(),{kind:'guess',company:{candidateId:c.candidateId,candidateRevision:await revision(),host:c.domain},credits:1})).kind).toBe('taken');
 await world.enrichOwnSite();
 const paid=fakeAddressVerifier(()=>verdict('ok'));
 await world.guess(paid.verifier);
 expect(paid.calls.filter(address=>address.endsWith(`@${c.domain}`))).toEqual([]);
 expect((await world.runtime.query('SELECT state FROM outreach_people_paid_checks WHERE workspace_id=$1 AND candidate_id=$2',[world.ws,c.candidateId])).rows).toEqual([{state:'unknown'}]);
});

it('erases a guessed person with its candidate while retaining the body-free paid charge and refusing ledger deletion by the runtime role',async()=>{
 const company=await world.prepared('OH',named('Nora'),'Columbus',true);
 await world.enrichOwnSite();
 const paid=fakeAddressVerifier();
 expect(await world.guess(paid.verifier)).toMatchObject({verified:1,credits:1});
 const ledger=async()=>(await world.runtime.query('SELECT * FROM outreach_people_paid_checks WHERE workspace_id=$1 AND candidate_id=$2',[world.ws,company.candidateId])).rows;
 const before=await ledger(),spentBefore=await spent();
 expect(before).toHaveLength(1);
 const revision=(await world.runtime.query<{revision:number}>('SELECT revision FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[world.ws,company.candidateId])).rows[0]!.revision;
 expect(await withTransaction(world.runtime,()=>deleteCandidate(world.ctx(),{id:company.candidateId,expectedRevision:revision}))).toMatchObject({ok:true});
 expect((await world.runtime.query('SELECT 1 FROM outreach_people_contacts WHERE workspace_id=$1 AND candidate_id=$2',[world.ws,company.candidateId])).rows).toEqual([]);
 expect(await ledger()).toEqual(before);
 expect(await spent()).toBe(spentBefore);
 await expect(world.runtime.query('DELETE FROM outreach_people_paid_checks WHERE workspace_id=$1 AND candidate_id=$2',[world.ws,company.candidateId])).rejects.toMatchObject({code:'42501'});
});
