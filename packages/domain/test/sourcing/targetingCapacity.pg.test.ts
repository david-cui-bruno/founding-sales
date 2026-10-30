import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import type {targetingProposalSchema,TargetingQuery} from '@fss/contracts';
import type {z} from 'zod';
import {createTestDatabase} from '../../db/testing/testDatabase.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {seedTwoWorkspaces} from '../db/support/fixtures.ts';
import {ensureTargetingPolicy,readTargetingPolicy,saveTargetingProposal,applyTargetingProposal} from '../../sourcing/targetingProposals.ts';
let db:Awaited<ReturnType<typeof createTestDatabase>>,ctx:ReturnType<typeof repositoryContext>,w:string,owner:string;
const additions=(n:number,prefix='new'):TargetingQuery[]=>Array.from({length:n},(_,i)=>({id:`${prefix}-${i}`,query:`Fictional city ${i} residential property management`,locality:`City ${i}`,region:'CA'}));
type Draft=z.infer<typeof targetingProposalSchema>;
const tx=<T>(fn:()=>Promise<T>)=>withTransaction(ctx.db,fn);
async function draft(queryChanges:TargetingQuery[]):Promise<Draft>{const p=await readTargetingPolicy(ctx);return {basePolicyVersion:p.version,queryChanges,rankOrder:p.rankOrder as Draft['rankOrder'],evidenceIds:[],rationale:'Fictional approved capacity boundary test.'};}
async function save(input:Draft){const r=await tx(()=>saveTargetingProposal(ctx,input));if(!r.ok)throw Error(r.reason);return r.value;}
async function apply(input:{id:string;revision:number}){return tx(()=>applyTargetingProposal(ctx,{id:input.id,expectedRevision:input.revision}));}
async function rawProposal(changes:unknown){
 const p=await readTargetingPolicy(ctx),id=randomUUID();
 await ctx.db.query('INSERT INTO sourcing_targeting_proposals(workspace_id,id,base_version,changes,created_by) VALUES($1,$2,$3,$4::jsonb,$5)',[w,id,p.version,JSON.stringify(changes),owner]);return {id,revision:1};
}
async function bytes(value:unknown){return (await ctx.db.query<{n:number}>('SELECT octet_length($1::jsonb::text) n',[JSON.stringify(value)])).rows[0]!.n;}
async function stableControls(){
 const result:Record<string,unknown>={};
 result['settings']=(await ctx.db.query("SELECT (to_jsonb(s)-'targeting_version')::text value FROM sourcing_discovery_settings s WHERE workspace_id=$1",[w])).rows;
 for(const table of ['sourcing_search_account','sourcing_discovery_attempts','workspace_settings'])result[table]=(await ctx.db.query(`SELECT to_jsonb(t)::text value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
 return result;
}
async function durable(){const result:Record<string,unknown>={};for(const table of ['sourcing_targeting_versions','sourcing_targeting_proposals','sourcing_discovery_settings','audit_events'])result[table]=(await ctx.db.query(`SELECT to_jsonb(t)::text value FROM ${table} t WHERE workspace_id=$1 ORDER BY to_jsonb(t)::text`,[w])).rows;return result;}
beforeEach(async()=>{
 db=await createTestDatabase();const seed=await seedTwoWorkspaces(db.session);w=seed.alpha.workspaceId;owner=seed.alpha.admin.userId;
 ctx=repositoryContext(workspaceScope(w,{kind:'user',userId:owner,role:'admin'}),await db.appRuntimeSession());await tx(()=>ensureTargetingPolicy(ctx));
 await ctx.db.query("UPDATE sourcing_discovery_settings SET enabled=false,query_cursor=11,last_result='unknown',next_run_at='2026-11-01T12:34:56Z' WHERE workspace_id=$1",[w]);
 await ctx.db.query('INSERT INTO sourcing_search_account(id,halted,daily_used,monthly_used) VALUES(true,true,7,123)');
 await ctx.db.query("INSERT INTO sourcing_discovery_attempts(workspace_id,query_id,query,policy_version,state,slot) VALUES($1,'unresolved','Fictional uncertain provider attempt','targeting-v1','dispatched',0)",[w]);
});
afterEach(async()=>db?.drop());
it('save/apply60 preserves the existing12 exact selectors/order and rank order, reaches64, then refuses merged65 before any durable change',async()=>{
 const original=await readTargetingPolicy(ctx),controls=await stableControls();expect(original.queries).toHaveLength(12);
 const input=await draft(additions(48)),saved=await save(input);expect((await readTargetingPolicy(ctx)).version).toBe(original.version);
 expect(await apply(saved)).toMatchObject({ok:true});const sixty=await readTargetingPolicy(ctx);
 expect(sixty.queries).toHaveLength(60);expect(sixty.queries.slice(0,12)).toEqual(original.queries);expect(sixty.queries.slice(12)).toEqual(input.queryChanges);expect(sixty.rankOrder).toEqual(original.rankOrder);
 expect(await apply(await save(await draft(additions(4,'last'))))).toMatchObject({ok:true});expect((await readTargetingPolicy(ctx)).queries).toHaveLength(64);
 const before=await durable(),overflow=await draft(additions(1,'overflow'));expect(await tx(()=>saveTargetingProposal(ctx,overflow))).toEqual({ok:false,reason:'too_many_queries'});
 expect(await durable()).toEqual(before);expect(await stableControls()).toEqual(controls);
});
it('a persisted proposal becomes stale after another approved growth without mutating its stored revision or policy',async()=>{
 const stale=await save(await draft(additions(1,'stale'))),growth=await save(await draft(additions(48)));
 expect(await apply(growth)).toMatchObject({ok:true});const before=await durable();expect(await apply(stale)).toEqual({ok:false,reason:'policy_changed'});expect(await durable()).toEqual(before);
});
it.each(['count','unicode','base'] as const)('revalidates a persisted proposal at apply and cleanly refuses %s without durable writes',async mode=>{
 const input=await draft(mode==='count'?additions(64):mode==='unicode'?additions(52).map(q=>({...q,query:'é'.repeat(250),locality:'L'.repeat(100)})):[]);
 if(mode==='base')input.basePolicyVersion='foreign-body-version';
 expect(await bytes(input)).toBeLessThanOrEqual(49152);const saved=await rawProposal(input),before=await durable(),controls=await stableControls();
 expect(await apply(saved)).toEqual({ok:false,reason:mode==='count'?'too_many_queries':mode==='unicode'?'targeting_too_large':'invalid_input'});
 expect(await durable()).toEqual(before);expect(await stableControls()).toEqual(controls);
});
it('rejects a stale proposal revision before application',async()=>{
 const saved=await save(await draft([])),before=await durable();expect(await apply({...saved,revision:99})).toEqual({ok:false,reason:'proposal_changed'});expect(await durable()).toEqual(before);
});
it('checks the exact32KiB PostgreSQL JSONB policy boundary on save and on persisted apply',async()=>{
 const p=await readTargetingPolicy(ctx),queries=[...p.queries,...additions(52)].map(q=>({...q,query:'x'.repeat(300),locality:'L'.repeat(100)}));
 let remaining=32768-await bytes(queries);expect(remaining).toBeGreaterThan(0);
 for(const q of queries){const n=Math.min(remaining,400-q.query.length);q.query+='x'.repeat(n);remaining-=n;}expect(remaining).toBe(0);expect(await bytes(queries)).toBe(32768);
 expect(await apply(await save(await draft(queries)))).toMatchObject({ok:true});
 const over=queries.map(q=>({...q})),room=over.find(q=>q.query.length<400)!;room.query+='x';expect(await bytes(over)).toBe(32769);
 const input=await draft(over),before=await durable();expect(await tx(()=>saveTargetingProposal(ctx,input))).toEqual({ok:false,reason:'targeting_too_large'});expect(await durable()).toEqual(before);
 const persisted=await rawProposal(input),stored=await durable();expect(await apply(persisted)).toEqual({ok:false,reason:'targeting_too_large'});expect(await durable()).toEqual(stored);
});
it('counts Unicode bytes on save rather than JavaScript characters and leaves controls unchanged',async()=>{
 const input=await draft(additions(52).map(q=>({...q,query:'é'.repeat(250),locality:'L'.repeat(100)}))),before=await durable(),controls=await stableControls();
 expect(JSON.stringify(input.queryChanges).length).toBeLessThan(32768);expect(await bytes(input.queryChanges)).toBeGreaterThan(32768);
 expect(await tx(()=>saveTargetingProposal(ctx,input))).toEqual({ok:false,reason:'targeting_too_large'});expect(await durable()).toEqual(before);expect(await stableControls()).toEqual(controls);
});
it('preserves the exact48KiB proposal storage CHECK without treating oversized or schema-invalid stored input as an approval',async()=>{
 const input:Record<string,unknown>={...(await draft([])),rationale:'é'.repeat(1000)};
 input['rationale']=String(input['rationale'])+'x'.repeat(49152-await bytes(input));expect(await bytes(input)).toBe(49152);
 const saved=await rawProposal(input),before=await durable();expect(await apply(saved)).toEqual({ok:false,reason:'invalid_input'});expect(await durable()).toEqual(before);
 input['rationale']=String(input['rationale'])+'x';expect(await bytes(input)).toBe(49153);
 await expect(rawProposal(input)).rejects.toMatchObject({code:'23514',constraint:'sourcing_targeting_proposals_changes_check'});
 expect(await durable()).toEqual(before);
});
