import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from './support/fixtures.ts';
// 0162 (ADR0038): a person copy may hold a guessed, verified address (`verified_guess`, still citing the page the name was read from), the spend custody may record the verifier's answers as reasons,
// and a check record may name the paid verifier. Additive: three CHECKs replaced by supersets; no row rewritten, no routine replaced, no grant changed.
let db:TestDatabase,seeded:TwoWorkspaces;
beforeAll(async()=>{db=await createTestDatabase({throughVersion:161});seeded=await seedTwoWorkspaces(db.session);},120_000);
afterAll(async()=>{await db.drop();});
const cited={source_url:'https://x.example/team',source_block_id:'b4',source_quote:'Ryan Stetson, Broker'};
async function lookup(patch:Record<string,unknown>={},provider='own_site'){
 const w=seeded.alpha.workspaceId,candidate=randomUUID(),id=randomUUID(),host=`${candidate.slice(0,8)}.example.test`;
 await db.session.query('INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload) VALUES($1,$2,$3,$4::jsonb)',[w,candidate,candidate.replaceAll('-','').padEnd(64,'0'),'{}']);
 const value:Record<string,unknown>={workspace_id:w,id,candidate_id:candidate,candidate_revision:1,host,provider,state:'none',credits:0,business_date:'2026-11-02',business_time_zone:'America/New_York',observed_at:new Date().toISOString(),expires_at:new Date(Date.now()+86_400_000).toISOString(),...patch},columns=Object.keys(value);
 await db.session.query(`INSERT INTO outreach_people_lookups(${columns.join(',')}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(value));
 return {w,id,candidate,host};
}
const person=async(patch:Record<string,unknown>={})=>{
 const found=await lookup({state:'found',credits:1},'millionverifier'),value:Record<string,unknown>={workspace_id:found.w,lookup_id:found.id,candidate_id:found.candidate,host:found.host,provider_person_id:'p1',first_name:'Ryan',last_name:'Stetson',title:'Broker',email:`ryan@${found.host}`,email_status:'verified_guess',match_confidence:'medium',...cited,...patch},columns=Object.keys(value);
 return db.session.query(`INSERT INTO outreach_people_contacts(${columns.join(',')}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(value));
};
const verification=(provider:string)=>db.session.query('INSERT INTO outreach_email_verifications(workspace_id,address_key,provider,result,outcome) VALUES($1,$2,$3,$4,$5)',[seeded.alpha.workspaceId,'a'.repeat(64),provider,'valid','ok']);
it('refuses the new shapes at 161, then admits them at 162 without touching a stored row',async()=>{
 await person({email_status:'published'});
 const before=(await db.session.query('SELECT to_jsonb(c) AS c FROM outreach_people_contacts c ORDER BY lookup_id')).rows;
 await expect(person()).rejects.toMatchObject({code:'23514'});
 await expect(lookup({reason:'verdict_invalid'})).rejects.toMatchObject({code:'23514'});
 await expect(verification('millionverifier')).rejects.toMatchObject({code:'23514'});
 await applyMigrations(db.session,{throughVersion:162});
 expect(await readAppliedSchemaVersion(db.session)).toBe(162);
 expect((await db.session.query('SELECT to_jsonb(c) AS c FROM outreach_people_contacts c ORDER BY lookup_id')).rows).toEqual(before);
});
it('admits a guessed address only with the name\'s page citation and an own-host address, and keeps every earlier shape',async()=>{
 await expect(person()).resolves.toBeDefined();
 await expect(person({email_status:'published'})).resolves.toBeDefined();
 await expect(person({email:null,email_status:'unavailable',source_url:null,source_block_id:null,source_quote:null})).resolves.toBeDefined();
 await expect(person({email_status:'verified',source_url:null,source_block_id:null,source_quote:null})).resolves.toBeDefined();
 for(const bad of [{source_url:null,source_block_id:null,source_quote:null},{email:null},{email:'ryan@other.example.test'},{email_status:'guess'},{match_confidence:'low'}])await expect(person(bad),JSON.stringify(bad)).rejects.toMatchObject({code:'23514'});
});
it('records the verifier\'s five answers and the free no-mail-domain refusal as custody reasons, and nothing else new',async()=>{
 for(const reason of ['verdict_ok','verdict_catch_all','verdict_unknown','verdict_invalid','verdict_disposable','no_mail_domain','no_person','unavailable'])await expect(lookup({reason},'millionverifier'),reason).resolves.toBeDefined();
 for(const reason of ['verdict_maybe','guess_invalid','because'])await expect(lookup({reason},'millionverifier'),reason).rejects.toMatchObject({code:'23514'});
});
it('lets a check record name the paid verifier and still refuses any other provider',async()=>{
 await expect(verification('millionverifier')).resolves.toBeDefined();
 await expect(verification('dns_mx')).resolves.toBeDefined();
 await expect(verification('neverbounce')).rejects.toMatchObject({code:'23514'});
});
it('keeps the grants and the lineage trigger of 0160: the application adds, reads and deletes a person copy, never updates it, and a route still needs a found person',async()=>{
 const grants=(await db.session.query<{privilege_type:string}>("SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name='outreach_people_contacts' AND grantee='app_runtime' ORDER BY privilege_type")).rows.map(row=>row.privilege_type);
 expect(grants).toEqual(['DELETE','INSERT','SELECT']);
 expect((await db.session.query("SELECT 1 FROM pg_trigger WHERE tgname='email_campaign_prepared_person_lineage' AND NOT tgisinternal")).rows).toHaveLength(1);
});
