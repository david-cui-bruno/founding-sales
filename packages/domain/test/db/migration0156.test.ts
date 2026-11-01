import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import {seedTwoWorkspaces} from './support/fixtures.ts';
// 0156: up to twenty discovery searches per workspace day. Touches-existing, widening only: two named CHECKs re-added with larger bounds.
let db:TestDatabase,w:string;
const settings=(searches:number)=>db.session.query('UPDATE sourcing_discovery_settings SET searches_per_day=$2 WHERE workspace_id=$1',[w,searches]);
const attempt=(slot:number)=>db.session.query("INSERT INTO sourcing_discovery_attempts(workspace_id,query_id,query,slot) VALUES($1,'upgrade-fixture','fixture',$2)",[w,slot]);
const stored=async()=>({settings:(await db.session.query('SELECT * FROM sourcing_discovery_settings ORDER BY workspace_id')).rows,attempts:(await db.session.query('SELECT * FROM sourcing_discovery_attempts ORDER BY slot')).rows});
beforeAll(async()=>{
 db=await createTestDatabase({throughVersion:155});w=(await seedTwoWorkspaces(db.session)).alpha.workspaceId;
 await db.session.query("INSERT INTO sourcing_discovery_settings(workspace_id,enabled,searches_per_day,next_run_at) VALUES($1,true,10,'2026-11-01T00:00:00Z')",[w]);
 await attempt(0);await attempt(9);
});
afterAll(async()=>{await db.drop();});
it('refuses eleven searches and slot ten at 155, then upgrades to 156 without rewriting settings or attempts',async()=>{
 await expect(settings(11)).rejects.toMatchObject({code:'23514',constraint:'sourcing_discovery_searches_per_day'});
 await expect(attempt(10)).rejects.toMatchObject({code:'23514',constraint:'sourcing_discovery_slot'});
 const before=await stored();
 await applyMigrations(db.session,{throughVersion:156});
 expect(await readAppliedSchemaVersion(db.session)).toBe(156);expect(await stored()).toEqual(before);
});
it('stores twenty searches and slots up to nineteen, and keeps refusing beyond them',async()=>{
 await settings(20);await attempt(19);
 expect((await db.session.query('SELECT searches_per_day FROM sourcing_discovery_settings WHERE workspace_id=$1',[w])).rows).toEqual([{searches_per_day:20}]);
 for(const searches of [0,21])await expect(settings(searches)).rejects.toMatchObject({code:'23514',constraint:'sourcing_discovery_searches_per_day'});
 for(const slot of [-1,20])await expect(attempt(slot)).rejects.toMatchObject({code:'23514',constraint:'sourcing_discovery_slot'});
 await expect(attempt(19)).rejects.toMatchObject({code:'23505',constraint:'sourcing_discovery_attempts_workspace_day_slot'});
});
