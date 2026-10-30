import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import type {SessionQueryable} from '../../db/queryable.ts';
import {seedTwoWorkspaces} from './support/fixtures.ts';
const ranks=['help_request','operational_burden','investigation','fit_only'];
const queries=(n:number)=>Array.from({length:n},(_,i)=>({id:`fixture-${i}`,query:`Fictional city ${i} residential property management`,locality:`City ${i}`,region:'TX'}));
let db:Awaited<ReturnType<typeof createTestDatabase>>,runtime:SessionQueryable,w:string,before:unknown;
const insert=(value:unknown,version=`fixture-${randomUUID()}`)=>runtime.query('INSERT INTO sourcing_targeting_versions(workspace_id,version,queries,rank_order) VALUES($1,$2,$3::jsonb,$4::jsonb)',[w,version,value===undefined?null:JSON.stringify(value),JSON.stringify(ranks)]);
async function retained(){
 const result:Record<string,unknown>={};
 for(const table of ['sourcing_targeting_versions','sourcing_discovery_settings','sourcing_search_account','sourcing_discovery_attempts','workspace_settings'])
  result[table]=(await db.session.query(`SELECT to_jsonb(t)::text value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
 return result;
}
beforeAll(async()=>{
 db=await createTestDatabase({throughVersion:149});const seed=await seedTwoWorkspaces(db.session);w=seed.alpha.workspaceId;runtime=await db.appRuntimeSession();
 await insert(queries(30),'populated-149');
 await runtime.query("INSERT INTO sourcing_discovery_settings(workspace_id,targeting_version,enabled,query_cursor,next_run_at,last_result) VALUES($1,'populated-149',false,29,'2026-11-01T12:34:56Z','unknown')",[w]);
 await runtime.query('INSERT INTO sourcing_search_account(id,halted,daily_used,monthly_used) VALUES(true,true,7,123)');
 await runtime.query("INSERT INTO sourcing_discovery_attempts(workspace_id,query_id,query,policy_version,state,slot) VALUES($1,'fixture-0','Unresolved fictional attempt','populated-149','dispatched',0)",[w]);
 before=await retained();await applyMigrations(db.session,{throughVersion:150});
});
afterAll(async()=>db?.drop());
it('upgrades populated149 to150 without rewriting policy/settings/cursor/pacing/UNKNOWN/quota/sending byte-values or activating',async()=>{
 expect(await readAppliedSchemaVersion(db.session)).toBe(150);expect(await retained()).toEqual(before);
});
it.each([31,60,64])('app_runtime can retain %i selectors without selecting or activating the new version',async n=>{
 const before=(await runtime.query('SELECT to_jsonb(s)::text value FROM sourcing_discovery_settings s WHERE workspace_id=$1',[w])).rows;
 await insert(queries(n));expect((await runtime.query('SELECT to_jsonb(s)::text value FROM sourcing_discovery_settings s WHERE workspace_id=$1',[w])).rows).toEqual(before);
});
it.each([['65',queries(65)],['empty',[]],['object',{}],['JSON null',null]] as const)('refuses invalid query capacity/type: %s',async(_label,value)=>{
 await expect(insert(value)).rejects.toMatchObject({code:'23514',constraint:'sourcing_targeting_versions_queries_check'});
});
it('refuses SQL NULL independently of JSON null',async()=>{await expect(insert(undefined)).rejects.toMatchObject({code:'23502',column:'queries'});});
it('keeps the exact32KiB PostgreSQL JSONB byte boundary including Unicode',async()=>{
 const q=queries(1);q[0]!.query='é'.repeat(1000);
 const size=(await runtime.query<{n:number}>('SELECT octet_length($1::jsonb::text) n',[JSON.stringify(q)])).rows[0]!.n;
 q[0]!.query+='x'.repeat(32768-size);await insert(q);
 q[0]!.query+='x';await expect(insert(q)).rejects.toMatchObject({code:'23514',constraint:'sourcing_targeting_versions_queries_check'});
});
it('preserves policy SELECT/INSERT-only runtime privileges after150',async()=>{
 expect((await runtime.query("SELECT has_table_privilege(current_user,'sourcing_targeting_versions','SELECT') r,has_table_privilege(current_user,'sourcing_targeting_versions','INSERT') i,has_table_privilege(current_user,'sourcing_targeting_versions','UPDATE') u,has_table_privilege(current_user,'sourcing_targeting_versions','DELETE') d")).rows[0]).toEqual({r:true,i:true,u:false,d:false});
 await expect(runtime.query("UPDATE sourcing_targeting_versions SET rank_order=rank_order WHERE workspace_id=$1",[w])).rejects.toMatchObject({code:'42501'});
 await expect(runtime.query('DELETE FROM sourcing_targeting_versions WHERE workspace_id=$1',[w])).rejects.toMatchObject({code:'42501'});
});
