import {afterAll,beforeAll,expect,it} from 'vitest';
import {preparedEmailWorld} from './preparedEmailFixture.ts';

// ADR0035: confirmed deterministic refusals (an existing Firm with the company's host, an unresolvable time zone) make no progress across
// passes. They are excluded in the candidate selection, before the work limit and the 8x50 scan window, so they cannot starve a later company.
// Real captures throughout (the real fetch, qualification and selection path); nothing is lowered or stubbed. The campaign is the fixture's
// (room 5, so each list holds 15 and a pass reads at most 8 lists = 120 companies), so 120 refused companies ahead of one admissible company
// is exactly the case that used to leave the 121st unread.
let world:Awaited<ReturnType<typeof preparedEmailWorld>>;
beforeAll(async()=>{world=await preparedEmailWorld({regions:['OH','WA','FL'],manyCaptures:true});},180_000);
afterAll(async()=>world?.stop());

it('admits the admissible company in the first pass behind 120 companies whose host already has a Firm',async()=>{
 const taken:string[]=[];
 for(let i=0;i<120;i++)taken.push((await world.prepared('OH',domain=>`Email info@${domain}`)).domain);
 await world.tx(()=>world.runtime.query("INSERT INTO firms(workspace_id,name,website) SELECT $1,'Existing '||d,'https://'||d||'/' FROM unnest($2::text[]) d",[world.ws,taken]));
 const good=await world.prepared('OH',domain=>`Email office@${domain}`);
 const asked:string[]=[];
 const result=await world.pass({verify:async address=>{asked.push(address);return 'valid';}});
 expect(result).toMatchObject({admitted:1,checked:1,failed:0});
 expect(asked).toEqual([`office@${good.domain}`]);
 expect((await world.admissions()).map(row=>row.address)).toEqual([`office@${good.domain}`]);
},900_000);

it('does not read, check or admit companies whose time zone is unresolvable (FL spans zones), and admits the one after them',async()=>{
 for(let i=0;i<16;i++)await world.prepared('FL',domain=>`Email info@${domain}`,'Miami');
 const good=await world.prepared('OH',domain=>`Email hello@${domain}`);
 const asked:string[]=[];
 const result=await world.pass({verify:async address=>{asked.push(address);return 'valid';}});
 expect(result).toMatchObject({admitted:1,checked:1,failed:0});
 expect(asked).toEqual([`hello@${good.domain}`]);
 expect((await world.admissions()).map(row=>row.address)).toContain(`hello@${good.domain}`);
},900_000);
