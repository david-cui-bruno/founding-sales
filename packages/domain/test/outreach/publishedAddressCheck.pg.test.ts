import {afterAll,beforeAll,expect,it} from 'vitest';
import type {AddressCheck,AddressVerdict} from '../../outreach/addressGuess.ts';
import {fakeAddressVerifier,preparedEmailWorld} from './preparedEmailFixture.ts';

// ADR0038: a PUBLISHED address is asked of the paid verifier once before admission, through the real own-site read and the real admission pass, with a fake verifier (no network, no key).
let world:Awaited<ReturnType<typeof preparedEmailWorld>>;
beforeAll(async()=>{world=await preparedEmailWorld({dailyCredits:100});},240_000);
afterAll(async()=>world?.stop());
const published=(domain:string)=>`Meet the team</p><p>Tyler Bradford</p><p>President, CPM</p><p>tyler@${domain}`;
const verdict=(value:AddressVerdict):AddressCheck=>({ok:true,verdict:value});
const custody=async(candidateId:string)=>(await world.runtime.query<Record<string,unknown>>("SELECT state,credits,reason FROM outreach_people_lookups WHERE workspace_id=$1 AND candidate_id=$2 AND provider='millionverifier'",[world.ws,candidateId])).rows[0];
const spent=async()=>Number((await world.runtime.query<{n:string}>("SELECT coalesce(sum(credits),0)::text AS n FROM outreach_people_lookups WHERE workspace_id=$1 AND provider='millionverifier'",[world.ws])).rows[0]!.n);
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
