import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from './support/fixtures.ts';
// 0161 (ADR0037): the person copy may now have no address ('unavailable'), carry an address its own company page published ('published') and cite the page. Additive: three nullable columns, a dropped NOT NULL, the 0160 CHECK replaced by a superset.
let db:TestDatabase,seeded:TwoWorkspaces;
beforeAll(async()=>{db=await createTestDatabase({throughVersion:160});seeded=await seedTwoWorkspaces(db.session);},120_000);
afterAll(async()=>{await db.drop();});
const person=async(patch:Record<string,unknown>={})=>{
 const w=seeded.alpha.workspaceId,candidate=randomUUID(),lookup=randomUUID(),host=`${candidate.slice(0,8)}.example.test`;
 await db.session.query('INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload) VALUES($1,$2,$3,$4::jsonb)',[w,candidate,candidate.replaceAll('-','').padEnd(64,'0'),'{}']);
 await db.session.query("INSERT INTO outreach_people_lookups(workspace_id,id,candidate_id,candidate_revision,host,provider,state,credits,business_date,business_time_zone,observed_at,expires_at) VALUES($1,$2,$3,1,$4,'apollo','found',1,'2026-11-02','America/New_York',clock_timestamp(),clock_timestamp()+interval '30 days')",[w,lookup,candidate,host]);
 const value:Record<string,unknown>={workspace_id:w,lookup_id:lookup,candidate_id:candidate,host,provider_person_id:'p1',first_name:'Jordan',last_name:'Blake',title:'Owner',email:`jordan@${host}`,email_status:'verified',match_confidence:'high',...patch},columns=Object.keys(value);
 return db.session.query(`INSERT INTO outreach_people_contacts(${columns.join(',')}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(value));
};
it('keeps every 0160 person and refuses the new shapes at 160, then admits them at 161 without touching stored rows',async()=>{
 await person();
 const before=(await db.session.query('SELECT to_jsonb(c) AS c FROM outreach_people_contacts c ORDER BY lookup_id')).rows;
 await expect(person({email:null,email_status:'unavailable'})).rejects.toThrow();
 await applyMigrations(db.session,{throughVersion:161});
 expect(await readAppliedSchemaVersion(db.session)).toBe(161);
 expect((await db.session.query('SELECT to_jsonb(c)-\'source_url\'-\'source_block_id\'-\'source_quote\' AS c FROM outreach_people_contacts c ORDER BY lookup_id')).rows).toEqual(before);
 expect((await db.session.query('SELECT source_url,source_block_id,source_quote FROM outreach_people_contacts')).rows).toEqual([{source_url:null,source_block_id:null,source_quote:null}]);
});
it('admits a person with no address, a published address with its citation, and the old verified shape, and nothing else',async()=>{
 const cited={source_url:'https://x.example/team',source_block_id:'b4',source_quote:'Tyler Bradford / President / tyler@x.example'};
 await expect(person({email:null,email_status:'unavailable'})).resolves.toBeDefined();
 await expect(person({email_status:'published',...cited})).resolves.toBeDefined();
 await expect(person({email:null,email_status:'unavailable',...cited})).resolves.toBeDefined();
 await expect(person()).resolves.toBeDefined();
 for(const bad of [{email_status:'published'},{email:null},{email:null,email_status:'verified'},{email_status:'unavailable'},{email_status:'maybe'},{source_url:cited.source_url}])await expect(person(bad),JSON.stringify(bad)).rejects.toThrow();
});
it('keeps the grants of 0160: the application adds, reads and deletes a person copy, never updates it',async()=>{
 const grants=(await db.session.query<{privilege_type:string}>("SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name='outreach_people_contacts' AND grantee='app_runtime' ORDER BY privilege_type")).rows.map(row=>row.privilege_type);
 expect(grants).toEqual(['DELETE','INSERT','SELECT']);
});
