import {afterAll,beforeAll,expect,it} from 'vitest';
import {preparedEmailWorld} from './preparedEmailFixture.ts';

// ADR0035: a prepared own-site company that publishes an exact business address enters the approved campaign after a free check.
// `pass` runs OUTSIDE a transaction, as the worker's outbound_fence runner does: the check commits and each admission is its own transaction.
let world:Awaited<ReturnType<typeof preparedEmailWorld>>;
const prepared=(...args:Parameters<typeof world.prepared>)=>world.prepared(...args),admissions=()=>world.admissions(),pass=(v?:Parameters<typeof world.pass>[0])=>world.pass(v),runtime=()=>world.runtime;
beforeAll(async()=>{world=await preparedEmailWorld();},180_000);
afterAll(async()=>world?.stop());


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
 expect((await runtime().query('SELECT count(*)::int AS n FROM outreach_email_verifications')).rows[0]).toEqual({n:2});
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
 await world.tx(()=>runtime().query("INSERT INTO firms(workspace_id,name,website) VALUES($1,$2,$3)",[world.ws,'Existing Customer',`https://${taken.domain}/`]));
 await pass();
 const addresses=(await admissions()).map(row=>row.address);
 expect(addresses).not.toContain(`info@${other.domain}`);expect(addresses).not.toContain(`info@${taken.domain}`);
});
it('is not starved by invalid or refused companies ahead of it in the prepared order',async()=>{
 const dead=[];for(let i=0;i<15;i++)dead.push(await prepared('OH',domain=>`Email info@${domain}`));
 const good=await prepared('OH',domain=>`Email office@${domain}`),before=(await admissions()).length;
 const asked:string[]=[];
 const result=await pass({verify:async address=>{asked.push(address);return address===`office@${good.domain}`?'valid':'invalid';}});
 expect(result).toMatchObject({admitted:1,checked:16,failed:0});
 expect((await admissions()).length).toBe(before+1);expect((await admissions()).map(row=>row.address)).toContain(`office@${good.domain}`);
 expect(asked).toHaveLength(16);
 // The recorded invalid answers are excluded before the list's limit, never asked again, and never re-selected ahead of later companies.
 expect(await pass({verify:async()=>{throw Error('must not ask inside the window');}})).toMatchObject({admitted:0,checked:0,failed:0});
 expect(dead).toHaveLength(15);
});
it('stops at the campaign caps',async()=>{
 for(let i=0;i<7;i++)await prepared('OH',domain=>`Email info@${domain}`);
 await pass();await pass();
 expect(((await runtime().query('SELECT count(*)::int AS n FROM outreach_email_campaign_admissions WHERE workspace_id=$1',[world.ws])).rows[0] as {n:number}).n).toBe(5);
});
