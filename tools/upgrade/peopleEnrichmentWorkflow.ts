import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import type {RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {reservePeopleLookup} from '@fss/domain/outreach/peopleEnrichment.ts';
import {saveCandidate} from '@fss/domain/sourcing/candidates.ts';
import {updateSetting} from '@fss/domain/settings/store.ts';
import {readPeopleEnrichmentSetting} from '@fss/domain/settings/peopleEnrichment.ts';

export const PEOPLE_ENRICHMENT_UPGRADE_WORKFLOW='outreach.people enrichment custody, own-site person and guessed address (0160/0161/0162, runtime role)';

/** Post-upgrade runtime writes (0161 adds the free own-site source, 0162 the guessed address): a zero-credit reservation passes a zero daily cap and its found person may have no address, or carry a published address with its citation. The widened settings CHECK takes the new key, the ledger reserves one row per company under the daily cap and refuses a
 * second reservation and a reservation past the cap, and the person-lineage trigger function exists beside 0158's. The paid single-address check's custody (provider millionverifier) takes a found guess with a `verified_guess` person copy and a refused guess with its verdict as the reason, and a check record may name the verifier. No provider is called. */
export async function runPeopleEnrichmentUpgradeWorkflow(context:RepositoryContext):Promise<string>{
 const database=(await context.db.query<{name:string}>('SELECT current_database() AS name')).rows[0]!;
 assert(database.name.startsWith('fss_upgrade_'),'People upgrade workflow requires its owned disposable database');
 assert.deepEqual(await readPeopleEnrichmentSetting(context),{enabled:false,dailyCredits:30},'a workspace with no stored value reads the default: off');
 const saved=await withTransaction(context.db,()=>updateSetting(context,{settingKey:'people_enrichment',value:{enabled:true,dailyCredits:1}}));
 assert(saved.ok,'the widened settings CHECK must accept people_enrichment');
 assert.deepEqual(await readPeopleEnrichmentSetting(context),{enabled:true,dailyCredits:1});
 const token=randomUUID(),company=async(name:string)=>{
  const saved=await withTransaction(context.db,()=>saveCandidate(context,{firmName:`Fictional upgrade people ${name} ${token}`,website:`https://upgrade-people-${name}-${token}.example.test/`,locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Fictional upgrade people candidate',sourceUrl:`https://upgrade-people-${name}-${token}.example.test/about`,observedOn:new Date().toISOString().slice(0,10),preparedBy:'Controlled post-upgrade workflow'}));
  assert(saved.ok);return {candidateId:saved.value.id,candidateRevision:1,host:`upgrade-people-${name}-${token}.example.test`};
 };
 const [first,second]=[await company('a'),await company('b')];
 const setting=(value:{enabled:boolean;dailyCredits:number})=>withTransaction(context.db,()=>updateSetting(context,{settingKey:'people_enrichment',value}));
 const reserve=(target:typeof first)=>reservePeopleLookup(context,{provider:'upgrade_fake',company:target,credits:1});
 assert.equal((await reserve(first)).kind,'reserved');
 assert((await setting({enabled:true,dailyCredits:5})).ok);
 assert.equal((await reserve(first)).kind,'taken','a company is never reserved twice');
 assert((await setting({enabled:true,dailyCredits:1})).ok);
 assert.equal((await reserve(second)).kind,'cap','the daily credit cap, read under the setting lock at reservation time, refuses a lookup that would pass it');
 assert((await setting({enabled:false,dailyCredits:5})).ok);
 assert.equal((await reserve(second)).kind,'disabled','a disable takes effect before the next reservation');
 const row=(await context.db.query<{state:string;credits:number}>('SELECT state,credits FROM outreach_people_lookups WHERE workspace_id=$1 AND candidate_id=$2',[context.scope.workspaceId,first.candidateId])).rows;
 assert.deepEqual(row,[{state:'reserved',credits:1}]);
 // 0161: the free own-site source reserves at a zero cap (the cap applies only to credits), and its found person is storable without an address, then with a published one and its citation.
 const [third,fourth]=[await company('c'),await company('d')];
 assert((await setting({enabled:true,dailyCredits:0})).ok);
 for(const [target,address,status] of [[third,null,'unavailable'],[fourth,`jordan@${fourth.host}`,'published']] as const){
  const free=await reservePeopleLookup(context,{provider:'own_site',company:target,credits:0});
  assert(free.kind==='reserved','a zero-credit own-site lookup reserves at a zero daily cap');
  await context.db.query("UPDATE outreach_people_lookups SET state='found',observed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND state='reserved'",[context.scope.workspaceId,free.id]);
  await context.db.query("INSERT INTO outreach_people_contacts(workspace_id,lookup_id,candidate_id,host,provider_person_id,first_name,last_name,title,email,email_status,match_confidence,source_url,source_block_id,source_quote) SELECT workspace_id,id,candidate_id,host,'site:test','Jordan','Blake','Owner',$3,$4,'high','https://'||host||'/team','b1','Jordan Blake, Owner' FROM outreach_people_lookups WHERE workspace_id=$1 AND id=$2",[context.scope.workspaceId,free.id,address,status]);
 }
 const people=(await context.db.query<{email:string|null;email_status:string}>('SELECT email,email_status FROM outreach_people_contacts WHERE workspace_id=$1 AND candidate_id=ANY($2::uuid[]) ORDER BY email_status',[context.scope.workspaceId,[third.candidateId,fourth.candidateId]])).rows;
 assert.deepEqual(people,[{email:`jordan@${fourth.host}`,email_status:'published'},{email:null,email_status:'unavailable'}]);
 // 0162: the guess's custody row (one credit under the cap) settles found with a guessed, verified address that still cites the name's page, or none with the verifier's verdict; a check record may name the verifier.
 const [fifth,sixth]=[await company('e'),await company('f')];
 assert((await setting({enabled:true,dailyCredits:5})).ok);
 const guessed=await reservePeopleLookup(context,{provider:'millionverifier',company:fifth,credits:1}),invalid=await reservePeopleLookup(context,{provider:'millionverifier',company:sixth,credits:1});
 assert(guessed.kind==='reserved'&&invalid.kind==='reserved','the paid check reserves one credit per company under the daily cap');
 await context.db.query("UPDATE outreach_people_lookups SET state='found',observed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND state='reserved'",[context.scope.workspaceId,guessed.id]);
 await context.db.query("INSERT INTO outreach_people_contacts(workspace_id,lookup_id,candidate_id,host,provider_person_id,first_name,last_name,title,email,email_status,match_confidence,source_url,source_block_id,source_quote) SELECT workspace_id,id,candidate_id,host,'site:test','Ryan','Stetson','Broker','ryan@'||host,'verified_guess','medium','https://'||host||'/team','b1','Ryan Stetson, Broker' FROM outreach_people_lookups WHERE workspace_id=$1 AND id=$2",[context.scope.workspaceId,guessed.id]);
 await context.db.query("UPDATE outreach_people_lookups SET state='none',reason='verdict_invalid',observed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND state='reserved'",[context.scope.workspaceId,invalid.id]);
 await context.db.query("INSERT INTO outreach_email_verifications(workspace_id,address_key,provider,result,outcome) VALUES($1,$2,'millionverifier','invalid','drop')",[context.scope.workspaceId,'c'.repeat(64)]);
 assert.deepEqual((await context.db.query('SELECT email_status FROM outreach_people_contacts WHERE workspace_id=$1 AND lookup_id=$2',[context.scope.workspaceId,guessed.id])).rows,[{email_status:'verified_guess'}]);
 assert.deepEqual((await context.db.query('SELECT state,reason FROM outreach_people_lookups WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,invalid.id])).rows,[{state:'none',reason:'verdict_invalid'}]);
 const body=(await context.db.query<{src:string}>("SELECT prosrc AS src FROM pg_proc WHERE proname='outreach_email_campaign_prepared_person_lineage'")).rows[0]?.src??'';
 assert(body.includes('outreach_people_contacts')&&body.includes("p.state='found'"),'the person lineage function proves the provider person');
 return 'runtime role set people_enrichment, reserved one custody row under a one-credit cap, refused a second reservation, a reservation past the cap and one after a disable, reserved two zero-credit own-site rows at a zero cap and stored a person with no address and a published one with its citation, reserved two millionverifier rows and stored a verified_guess person, a refused guess with its verdict and a check record naming the verifier; person lineage function present; no provider called';
}
