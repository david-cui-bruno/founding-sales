import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import type {SessionQueryable} from '../../db/queryable.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from './support/fixtures.ts';
import {seedCrm,type SeededCrm} from './support/crmFixtures.ts';
import {automaticSupplyPublicationRow} from './support/automaticSupplyCases.ts';
let db:TestDatabase,runtime:SessionQueryable,seed:TwoWorkspaces,crm:SeededCrm,legacy:Record<string,unknown>,before:unknown,sending:unknown[];
let slot=0;
const fixture=()=>({session:db.session,seeded:seed,crm});
const row=()=>automaticSupplyPublicationRow(fixture(),slot++);
async function insert(row:Record<string,unknown>,session=db.session){
 return session.query(`INSERT INTO sourcing_automatic_research_firms(${Object.keys(row).join(',')})
  VALUES(${Object.keys(row).map((_,index)=>`$${index+1}`).join(',')})`,Object.values(row));
}
const retained=async()=>(await db.session.query(`SELECT to_jsonb(p)-'native_policy_version' AS value
 FROM sourcing_automatic_research_firms p WHERE workspace_id=$1 AND id=$2`,[legacy['workspace_id'],legacy['id']])).rows[0]?.['value'];
beforeAll(async()=>{
 db=await createTestDatabase({throughVersion:146});seed=await seedTwoWorkspaces(db.session);crm=await seedCrm(db.session,seed);
 legacy=await row();await insert(legacy);
 before=await retained();sending=(await db.session.query("SELECT * FROM workspace_settings WHERE setting_key='sending_enabled' ORDER BY workspace_id,version")).rows;
 await applyMigrations(db.session,{throughVersion:147});runtime=await db.appRuntimeSession();
});
afterAll(async()=>db?.drop());
it('upgrades populated146 with byte-value unchanged legacy proof/history and legacy-default native interpretation',async()=>{
 expect(await readAppliedSchemaVersion(db.session)).toBe(147);expect(await retained()).toEqual(before);
 expect((await runtime.query('SELECT native_policy_version FROM sourcing_automatic_research_firms WHERE workspace_id=$1 AND id=$2',[legacy['workspace_id'],legacy['id']])).rows)
  .toEqual([{native_policy_version:'native-firm-eligibility-v1'}]);
 expect((await db.session.query("SELECT * FROM workspace_settings WHERE setting_key='sending_enabled' ORDER BY workspace_id,version")).rows).toEqual(sending);
});
it('accepts explicit new policy metadata for a newly inserted publication without changing the legacy row',async()=>{
 const value=await row();await insert({...value,native_policy_version:'native-firm-eligibility-us-v1'},runtime);
 expect((await runtime.query('SELECT native_policy_version FROM sourcing_automatic_research_firms WHERE workspace_id=$1 AND id=$2',[value['workspace_id'],value['id']])).rows)
  .toEqual([{native_policy_version:'native-firm-eligibility-us-v1'}]);
 expect(await retained()).toEqual(before);
});
it('rejects unknown native-policy metadata through the registered closed constraint',async()=>{
 const value=await row();
 await expect(insert({...value,native_policy_version:'unknown'},runtime)).rejects.toMatchObject({code:'23514',constraint:'automatic_research_native_policy_supported'});
});
it('rejects null native policy instead of treating it as a new coverage grant',async()=>{
 const value=await row();
 await expect(insert({...value,native_policy_version:null},runtime)).rejects.toMatchObject({code:'23502',column:'native_policy_version'});
});
it('rejects changing existing native interpretation, even with the normal next revision, and preserves legacy bytes',async()=>{
 await expect(runtime.query(`UPDATE sourcing_automatic_research_firms SET native_policy_version='native-firm-eligibility-us-v1',revision=revision+1
  WHERE workspace_id=$1 AND id=$2`,[legacy['workspace_id'],legacy['id']])).rejects.toMatchObject({code:'23514',constraint:'automatic_research_native_policy_immutable'});
 expect(await retained()).toEqual(before);
});
