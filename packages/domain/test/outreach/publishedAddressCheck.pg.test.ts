import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {checkPublishedAddress,type AddressCheck,type AddressVerdict} from '../../outreach/addressGuess.ts';
import {markStalePaidChecks} from '../../outreach/paidChecks.ts';
import {fakeAddressVerifier,preparedEmailWorld} from './preparedEmailFixture.ts';

// ADR0038: a PUBLISHED address is asked of the paid verifier once before admission, through the real own-site read and the real admission pass, with a fake verifier (no network, no key).
let world:Awaited<ReturnType<typeof preparedEmailWorld>>;
beforeAll(async()=>{world=await preparedEmailWorld({dailyCredits:100});},240_000);
afterAll(async()=>world?.stop());
const published=(domain:string)=>`Meet the team</p><p>Tyler Bradford</p><p>President, CPM</p><p>tyler@${domain}`;
const verdict=(value:AddressVerdict):AddressCheck=>({ok:true,verdict:value});
const custody=async(candidateId:string)=>(await world.runtime.query<Record<string,unknown>>('SELECT state,credits,reason FROM outreach_people_paid_checks WHERE workspace_id=$1 AND candidate_id=$2',[world.ws,candidateId])).rows[0];
const spent=async()=>Number((await world.runtime.query<{n:string}>('SELECT coalesce(sum(credits),0)::text AS n FROM outreach_people_paid_checks WHERE workspace_id=$1',[world.ws])).rows[0]!.n);
const lastCheck=async()=>(await world.runtime.query<{provider:string;result:string}>('SELECT provider,result FROM outreach_email_verifications WHERE workspace_id=$1 ORDER BY checked_at DESC,id DESC LIMIT 1',[world.ws])).rows[0]!;

it('asks a verifier about a published address once before admission: invalid and disposable refuse it, ok and catch_all admit it, and each costs per the verdict against the daily cap',async()=>{
 const cases=[['invalid',1,0],['disposable',1,0],['ok',1,1],['catch_all',0,1]] as const,results:string[]=[];
 for(const [answer,credits,admitted] of cases){
  const company=await world.prepared('OH',published,'Columbus',true);
  await world.enrichOwnSite();
  const before=await spent(),paid=fakeAddressVerifier(()=>verdict(answer));
  const pass=await world.pass(undefined,paid.verifier);
  expect(paid.calls,answer).toEqual([`tyler@${company.domain}`]);expect(pass.admitted,answer).toBe(admitted);expect(await spent(),answer).toBe(before+credits);
  expect(await custody(company.candidateId),answer).toMatchObject({state:'none',credits,reason:`verdict_${answer}`});
  const record=await lastCheck();results.push(`${answer}:${record.provider}:${record.result}`);
  // Asked once: a second pass neither asks again nor admits an invalid address.
  await world.pass(undefined,paid.verifier);expect(paid.calls,answer).toHaveLength(1);
  // A person with a published address is never guessed.
  expect(await world.guess(fakeAddressVerifier().verifier)).toMatchObject({looked:0,refused:0});
 }
 expect(results).toEqual(['invalid:millionverifier:invalid','disposable:millionverifier:invalid','ok:millionverifier:valid','catch_all:millionverifier:valid']);
 expect((await world.admissions()).length).toBe(2);
});

it('leaves a published address to the free check alone when the verifier fails or the switch or the cap is off (no verifier at all is every other test\'s pass)',async()=>{
 const down=await world.prepared('OH',published,'Columbus',true);
 await world.enrichOwnSite();
 const broken=fakeAddressVerifier(()=>({ok:false,code:'auth_failed',mayHaveCharged:false}));
 expect(await world.pass(undefined,broken.verifier)).toMatchObject({admitted:1});expect(broken.calls).toEqual([`tyler@${down.domain}`]);
 expect(await custody(down.candidateId)).toMatchObject({state:'failed',credits:0,reason:'auth_failed'});
 expect(await lastCheck()).toMatchObject({provider:'dns_mx',result:'valid'});
 const off=await world.prepared('OH',published,'Columbus',true);
 await world.enrichOwnSite();
 await world.setPeople({enabled:true,dailyCredits:0});
 const never=fakeAddressVerifier();
 expect(await world.pass(undefined,never.verifier)).toMatchObject({admitted:1});expect(never.calls).toEqual([]);
 expect(await custody(off.candidateId)).toBeUndefined();
});

it('honours a persisted invalid or disposable answer as a refusal even when the drop record was never written (a crash between the custody settling and the record)',async()=>{
 for(const reason of ['verdict_invalid','verdict_disposable']){
  const company=await world.prepared('OH',published,'Columbus',true);
  await world.enrichOwnSite();
  const revision=(await world.runtime.query<{revision:number}>('SELECT revision FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[world.ws,company.candidateId])).rows[0]!.revision;
  await world.runtime.query("INSERT INTO outreach_people_paid_checks(workspace_id,candidate_id,candidate_revision,host,kind,state,reason,credits,business_date,business_time_zone,observed_at,expires_at) VALUES($1,$2,$3,$4,'published','none',$5,1,current_date,'America/New_York',clock_timestamp(),clock_timestamp()+interval '30 days')",[world.ws,company.candidateId,revision,company.domain,reason]);
  const paid=fakeAddressVerifier(()=>verdict('ok')),before=(await world.admissions()).length;
  // Not selected, not previewed, never admitted, and no second paid call; the free check is never reached for it.
  expect(await world.pass(undefined,paid.verifier),reason).toMatchObject({admitted:0});
  expect(paid.calls,reason).toEqual([]);expect((await world.admissions()).length,reason).toBe(before);
 }
});

it('commits a negative answer with its address-bound refusal record or neither: a failed record write rolls the settlement back and the company stays fenced, never re-asked',async()=>{
 await world.setPeople({enabled:true,dailyCredits:100});
 const company=await world.prepared('OH',published,'Columbus',true);
 await world.enrichOwnSite();
 const revision=(await world.runtime.query<{revision:number}>('SELECT revision FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[world.ws,company.candidateId])).rows[0]!.revision,target={candidateId:company.candidateId,candidateRevision:revision,host:company.domain};
 const paid=fakeAddressVerifier(()=>verdict('invalid'));
 await expect(checkPublishedAddress(world.ctx(),paid.verifier,target,`tyler@${company.domain}`,async()=>{throw new Error('record write failed');})).rejects.toThrow('record write failed');
 expect(await custody(company.candidateId)).toMatchObject({state:'reserved'});
 const again=fakeAddressVerifier(()=>verdict('ok'));
 expect(await checkPublishedAddress(world.ctx(),again.verifier,target,`tyler@${company.domain}`,async()=>undefined)).toBe('held');expect(again.calls).toEqual([]);// taken by an unresolved attempt: refused, not an MX fallback
 const before=(await world.admissions()).length;
 // The NEXT FULL admission passes (the row still reserved, then settled unknown by the stale-reservation sweep): nothing is admitted and nothing is asked again.
 expect(await world.pass(undefined,again.verifier)).toMatchObject({admitted:0});expect(again.calls).toEqual([]);
 await world.runtime.query("UPDATE outreach_people_paid_checks SET reserved_at=clock_timestamp()-interval '10 minutes' WHERE workspace_id=$1 AND candidate_id=$2",[world.ws,company.candidateId]);
 await markStalePaidChecks(world.ctx());
 expect(await custody(company.candidateId)).toMatchObject({state:'unknown',reason:'interrupted'});
 expect(await world.pass(undefined,again.verifier)).toMatchObject({admitted:0});expect(again.calls).toEqual([]);expect((await world.admissions()).length).toBe(before);
 let wrote:string|null=null;
 const other=await world.prepared('OH',published,'Columbus',true);
 const otherTarget={candidateId:other.candidateId,candidateRevision:(await world.runtime.query<{revision:number}>('SELECT revision FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[world.ws,other.candidateId])).rows[0]!.revision,host:other.domain};
 expect(await checkPublishedAddress(world.ctx(),fakeAddressVerifier(()=>verdict('disposable')).verifier,otherTarget,`tyler@${other.domain}`,async v=>{wrote=v;})).toBe('disposable');
 expect(wrote).toBe('disposable');expect(await custody(other.candidateId)).toMatchObject({state:'none',reason:'verdict_disposable'});
});

it('still falls back to the free check when THIS call gets no verifier answer: a transport failure admits, and the failed attempt then holds the company (never asked twice)',async()=>{
 await world.setPeople({enabled:true,dailyCredits:100});
 const company=await world.prepared('OH',published,'Columbus',true);
 await world.enrichOwnSite();
 const down=fakeAddressVerifier(()=>({ok:false,code:'unavailable',mayHaveCharged:true}));
 expect(await world.pass(undefined,down.verifier)).toMatchObject({admitted:1});expect(down.calls).toEqual([`tyler@${company.domain}`]);
 expect(await custody(company.candidateId)).toMatchObject({state:'unknown',credits:1});
 expect(await lastCheck()).toMatchObject({provider:'dns_mx',result:'valid'});
});

it.each([['unknown','unavailable'],['reserved',null],['none','verdict_invalid'],['none','verdict_disposable']] as const)('fences a REPLACEMENT candidate on the same host behind its predecessor\'s paid custody (%s/%s): no paid call, no admission, no free-check fallback',async(state,reason)=>{
 await world.setPeople({enabled:true,dailyCredits:100});
 const company=await world.prepared('OH',published,'Columbus',true);
 await world.enrichOwnSite();
 // The predecessor is another candidate id on this company's host (custody has no foreign key to the candidate).
 await world.runtime.query("INSERT INTO outreach_people_paid_checks(workspace_id,candidate_id,candidate_revision,host,kind,state,reason,credits,business_date,business_time_zone,observed_at,expires_at) VALUES($1,$2,1,$3,'published',$4,$5,1,current_date,'America/New_York',CASE WHEN $4='none' THEN clock_timestamp() END,clock_timestamp()+interval '30 days')",[world.ws,randomUUID(),company.domain,state,reason]);
 const paid=fakeAddressVerifier(()=>verdict('ok')),before=(await world.admissions()).length;
 expect(await world.pass(undefined,paid.verifier)).toMatchObject({admitted:0});
 expect(paid.calls).toEqual([]);expect((await world.admissions()).length).toBe(before);
 expect(await custody(company.candidateId)).toBeUndefined();
 const target={candidateId:company.candidateId,candidateRevision:(await world.runtime.query<{revision:number}>('SELECT revision FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[world.ws,company.candidateId])).rows[0]!.revision,host:company.domain};
 expect(await checkPublishedAddress(world.ctx(),paid.verifier,target,`tyler@${company.domain}`,async()=>undefined)).toBe('held');expect(paid.calls).toEqual([]);
});
