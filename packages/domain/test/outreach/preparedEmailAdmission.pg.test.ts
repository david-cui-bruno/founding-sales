import {afterAll,beforeAll,expect,it} from 'vitest';
import {fakePeople,ownerAt,preparedEmailWorld} from './preparedEmailFixture.ts';

// ADR0036: a prepared own-site company whose provider-found decision-maker has a verified own-domain address enters the approved campaign after a free check.
// `pass` runs OUTSIDE a transaction, as the worker's outbound_fence runner does: the check commits and each admission is its own transaction.
let world:Awaited<ReturnType<typeof preparedEmailWorld>>;
const prepared=(...args:Parameters<typeof world.prepared>)=>world.prepared(...args),admissions=()=>world.admissions(),pass=(v?:Parameters<typeof world.pass>[0])=>world.pass(v),runtime=()=>world.runtime;
beforeAll(async()=>{world=await preparedEmailWorld();},180_000);
afterAll(async()=>world?.stop());

it('admits nothing and checks nothing for a company the provider has not been asked about or found nobody for, even when its page publishes an address',async()=>{
 await prepared('OH',domain=>`Email info@${domain}`);
 expect(await pass()).toEqual({admitted:0,checked:0,failed:0});
 expect(await world.enrich(fakePeople(()=>({ok:true,person:null,creditsUsed:0})))).toMatchObject({looked:1,none:1});
 expect(await pass()).toEqual({admitted:0,checked:0,failed:0});
 expect(await admissions()).toEqual([]);
});
it('admits a company with a found named decision-maker, in WA and OH, as a named contact on a research_provider route, and rechecks nothing inside the window',async()=>{
 const oh=await prepared('OH',()=>'Call our office.'),wa=await prepared('WA',()=>'Call our office.','Seattle');
 expect(await world.enrich(fakePeople(host=>ownerAt(host,host===oh.domain?{}:{firstName:'Riley',lastName:'Stone',title:'Managing Broker',email:`riley@${host}`})))).toMatchObject({looked:2,found:2,none:0,credits:2});
 expect(await pass()).toEqual({admitted:2,checked:2,failed:0});
 expect(await admissions()).toEqual(expect.arrayContaining([{address:`jordan.blake@${oh.domain}`,source_kind:'prepared_capture',region:'OH'},{address:`riley@${wa.domain}`,source_kind:'prepared_capture',region:'WA'}]));
 const rows=(await runtime().query<{full_name:string;title:string;source:string;association_confidence:string;identity_kind:string;block_id:string}>("SELECT c.full_name,c.title,r.source,r.association_confidence::text,s.identity_kind,s.block_id FROM outreach_email_campaign_admissions a JOIN contacts c ON c.workspace_id=a.workspace_id AND c.id=a.contact_id JOIN email_addresses r ON r.workspace_id=a.workspace_id AND r.id=a.route_id JOIN outreach_email_sources s ON s.workspace_id=a.workspace_id AND s.candidate_id=a.candidate_id WHERE a.workspace_id=$1 ORDER BY c.full_name",[world.ws])).rows;
 expect(rows).toEqual([{full_name:'Jordan Blake',title:'Owner',source:'research_provider',association_confidence:'0.950',identity_kind:'named',block_id:'person:fake_people'},{full_name:'Riley Stone',title:'Managing Broker',source:'research_provider',association_confidence:'0.950',identity_kind:'named',block_id:'person:fake_people'}]);
 expect(await pass()).toMatchObject({admitted:0,checked:0});
 expect((await runtime().query('SELECT count(*)::int AS n FROM outreach_email_verifications')).rows[0]).toEqual({n:2});
});
it('admits no company whose check fails or cannot answer, and records an invalid answer once',async()=>{
 const bad=await prepared('OH',()=>'x'),later=await prepared('OH',()=>'x');
 await world.enrich();
 const before=(await admissions()).length;
 const answers=new Map([[`jordan.blake@${bad.domain}`,'invalid' as const]]);
 expect(await pass({verify:async address=>answers.get(address)??null})).toMatchObject({admitted:0,checked:1});
 expect((await admissions()).length).toBe(before);
 expect(await pass({verify:async()=>{throw Error('must not ask twice inside the window');}}).catch(error=>String(error))).toBeDefined();
 expect(await pass()).toMatchObject({admitted:1});
 expect((await admissions()).map(row=>row.address)).toContain(`jordan.blake@${later.domain}`);
 expect((await admissions()).map(row=>row.address)).not.toContain(`jordan.blake@${bad.domain}`);
});
it('refuses a company in a region outside the campaign and a Firm that already exists',async()=>{
 const other=await prepared('CA',()=>'x','Fresno');
 const taken=await prepared('OH',()=>'x');
 await world.tx(()=>runtime().query("INSERT INTO firms(workspace_id,name,website) VALUES($1,$2,$3)",[world.ws,'Existing Customer',`https://${taken.domain}/`]));
 await world.enrich();await pass();
 const addresses=(await admissions()).map(row=>row.address);
 expect(addresses).not.toContain(`jordan.blake@${other.domain}`);expect(addresses).not.toContain(`jordan.blake@${taken.domain}`);
});
it('is not starved by invalid or refused companies ahead of it in the prepared order',async()=>{
 const dead=[];for(let i=0;i<15;i++)dead.push(await prepared('OH',()=>'x'));
 const good=await prepared('OH',()=>'x');
 await world.setPeople({enabled:true,dailyCredits:1000});
 for(let i=0;i<2;i++)await world.enrich();
 const before=(await admissions()).length,asked:string[]=[];
 const result=await pass({verify:async address=>{asked.push(address);return address===`jordan.blake@${good.domain}`?'valid':'invalid';}});
 expect(result).toMatchObject({admitted:1,failed:0});
 expect((await admissions()).length).toBe(before+1);expect((await admissions()).map(row=>row.address)).toContain(`jordan.blake@${good.domain}`);
 // The recorded invalid answers are excluded before the list's limit, never asked again, and never re-selected ahead of later companies.
 expect(await pass({verify:async()=>{throw Error('must not ask inside the window');}})).toMatchObject({admitted:0,failed:0});
 expect(dead).toHaveLength(15);
});
it('stops at the campaign caps',async()=>{
 for(let i=0;i<7;i++)await prepared('OH',()=>'x');
 await world.enrich();await world.enrich();await pass();await pass();
 expect(((await runtime().query('SELECT count(*)::int AS n FROM outreach_email_campaign_admissions WHERE workspace_id=$1',[world.ws])).rows[0] as {n:number}).n).toBe(5);
});
