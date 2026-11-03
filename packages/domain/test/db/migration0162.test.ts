import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from './support/fixtures.ts';
// 0162 (ADR0038): an append-only ledger of paid address checks (`outreach_people_paid_checks`, one row per candidate revision, no personal data, no foreign key to the candidate), a person copy may hold a guessed, verified
// address (`verified_guess`, still citing the page the name was read from), and a check record may name the paid verifier. The 0160 spend custody and its two unique fences are untouched; no routine is replaced.
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
 const found=await lookup({state:'found'},'millionverifier'),value:Record<string,unknown>={workspace_id:found.w,lookup_id:found.id,candidate_id:found.candidate,host:found.host,provider_person_id:'p1',first_name:'Ryan',last_name:'Stetson',title:'Broker',email:`ryan@${found.host}`,email_status:'verified_guess',match_confidence:'medium',...cited,...patch},columns=Object.keys(value);
 return db.session.query(`INSERT INTO outreach_people_contacts(${columns.join(',')}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(value));
};
const verification=(provider:string)=>db.session.query('INSERT INTO outreach_email_verifications(workspace_id,address_key,provider,result,outcome) VALUES($1,$2,$3,$4,$5)',[seeded.alpha.workspaceId,'a'.repeat(64),provider,'valid','ok']);
const paid=(candidate:string,revision:number,host:string,patch:Record<string,unknown>={})=>{
 const value:Record<string,unknown>={workspace_id:seeded.alpha.workspaceId,candidate_id:candidate,candidate_revision:revision,host,kind:'guess',state:'none',reason:'verdict_ok',credits:1,business_date:'2026-11-02',business_time_zone:'America/New_York',observed_at:new Date().toISOString(),expires_at:new Date(Date.now()+86_400_000).toISOString(),...patch},columns=Object.keys(value);
 return db.session.query(`INSERT INTO outreach_people_paid_checks(${columns.join(',')}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(value));
};
it('refuses the new shapes at 161, then admits them at 162 without touching a stored row',async()=>{
 await person({email_status:'published'});
 expect((await db.session.query("SELECT to_regclass('outreach_people_paid_checks') AS t")).rows).toEqual([{t:null}]);
 await expect(person()).rejects.toMatchObject({code:'23514'});
 await expect(verification('millionverifier')).rejects.toMatchObject({code:'23514'});
 const before=(await db.session.query('SELECT to_jsonb(c) AS c FROM outreach_people_contacts c ORDER BY lookup_id')).rows,lookups=(await db.session.query('SELECT to_jsonb(l) AS l FROM outreach_people_lookups l ORDER BY id')).rows;
 await applyMigrations(db.session,{throughVersion:162});
 expect(await readAppliedSchemaVersion(db.session)).toBe(162);
 expect((await db.session.query('SELECT to_jsonb(c) AS c FROM outreach_people_contacts c ORDER BY lookup_id')).rows).toEqual(before);
 expect((await db.session.query('SELECT to_jsonb(l) AS l FROM outreach_people_lookups l ORDER BY id')).rows).toEqual(lookups);
 expect((await db.session.query("SELECT count(*)::int AS n FROM outreach_people_paid_checks")).rows).toEqual([{n:0}]);
});
it('admits a guessed address only with the name\'s page citation and an own-host address, and keeps every earlier shape',async()=>{
 await expect(person()).resolves.toBeDefined();
 await expect(person({email_status:'published'})).resolves.toBeDefined();
 await expect(person({email:null,email_status:'unavailable',source_url:null,source_block_id:null,source_quote:null})).resolves.toBeDefined();
 await expect(person({email_status:'verified',source_url:null,source_block_id:null,source_quote:null})).resolves.toBeDefined();
 for(const bad of [{source_url:null,source_block_id:null,source_quote:null},{email:null},{email:'ryan@other.example.test'},{email_status:'guess'},{match_confidence:'low'}])await expect(person(bad),JSON.stringify(bad)).rejects.toMatchObject({code:'23514'});
});
it('leaves the 0160 custody reasons and its two unique fences exactly as they were: a verdict is no custody reason, and one row per candidate and per host and provider still holds',async()=>{
 for(const reason of ['verdict_ok','verdict_invalid','interrupted','no_mail_domain'])await expect(lookup({reason},'millionverifier'),reason).rejects.toMatchObject({code:'23514'});
 const own=await lookup({},'own_site'),row=(provider:string,revision:number,host:string,candidate:string)=>db.session.query(`INSERT INTO outreach_people_lookups(workspace_id,candidate_id,candidate_revision,host,provider,state,credits,business_date,business_time_zone,expires_at) VALUES($1,$2,$3,$4,$5,'reserved',0,'2026-11-02','America/New_York',now()+interval '1 day')`,[seeded.alpha.workspaceId,candidate,revision,host,provider]);
 await expect(row('own_site',2,`x-${own.host}`,own.candidate)).rejects.toMatchObject({code:'23505',constraint:'outreach_people_lookups_candidate_provider_key'});
 await expect(row('own_site',1,own.host,randomUUID())).rejects.toMatchObject({code:'23505',constraint:'outreach_people_lookups_host_provider_key'});
 expect((await db.session.query<{contype:string}>("SELECT contype FROM pg_constraint WHERE conname IN ('outreach_people_lookups_candidate_provider_key','outreach_people_lookups_host_provider_key')")).rows.map(r=>r.contype)).toEqual(['u','u']);
});
it('records paid checks append-only, one row per candidate REVISION, so an earlier revision\'s charge is a row of its own, with the verifier\'s five answers and the free no-mail-domain refusal as reasons and nothing else',async()=>{
 const candidate=randomUUID(),host=`${candidate.slice(0,8)}.example.test`;
 await paid(candidate,1,host);
 await expect(paid(candidate,1,`x-${host}`)).rejects.toMatchObject({code:'23505',constraint:'outreach_people_paid_checks_revision_key'});
 await expect(paid(candidate,2,host)).resolves.toBeDefined();
 expect((await db.session.query<{n:string;c:string}>('SELECT count(*)::text n,sum(credits)::text c FROM outreach_people_paid_checks WHERE candidate_id=$1',[candidate])).rows).toEqual([{n:'2',c:'2'}]);
 for(const reason of ['verdict_ok','verdict_catch_all','verdict_unknown','verdict_invalid','verdict_disposable','no_mail_domain'])await expect(paid(randomUUID(),1,host,{reason}),reason).resolves.toBeDefined();
 for(const reason of ['verdict_maybe','guess_invalid','no_person'])await expect(paid(randomUUID(),1,host,{reason}),reason).rejects.toMatchObject({code:'23514'});
 await expect(paid(randomUUID(),1,host,{state:'reserved',reason:null,observed_at:null})).resolves.toBeDefined();
 await expect(paid(randomUUID(),1,host,{state:'unknown',reason:'interrupted',observed_at:null})).resolves.toBeDefined();
 await expect(paid(randomUUID(),1,host,{state:'failed',reason:'auth_failed',credits:0,observed_at:null})).resolves.toBeDefined();
});
it('keeps the paid-check ledger body-free and independent of the candidate: no personal column, no foreign key, and the application may add, read and update but never delete',async()=>{
 const columns=(await db.session.query<{column_name:string}>("SELECT column_name FROM information_schema.columns WHERE table_name='outreach_people_paid_checks'")).rows.map(r=>r.column_name);
 for(const personal of ['first_name','last_name','title','email','address','address_key','provider_person_id'])expect(columns).not.toContain(personal);
 expect((await db.session.query("SELECT conname FROM pg_constraint WHERE conrelid='outreach_people_paid_checks'::regclass AND contype='f'")).rows).toEqual([]);
 const grants=(await db.session.query<{privilege_type:string}>("SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name='outreach_people_paid_checks' AND grantee='app_runtime' ORDER BY privilege_type")).rows.map(row=>row.privilege_type);
 expect(grants).toEqual(['INSERT','SELECT','UPDATE']);
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
