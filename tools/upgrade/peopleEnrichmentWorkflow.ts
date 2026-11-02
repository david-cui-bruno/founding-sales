import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import type {RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {reservePeopleLookup} from '@fss/domain/outreach/peopleEnrichment.ts';
import {saveCandidate} from '@fss/domain/sourcing/candidates.ts';
import {updateSetting} from '@fss/domain/settings/store.ts';
import {readPeopleEnrichmentSetting} from '@fss/domain/settings/peopleEnrichment.ts';

export const PEOPLE_ENRICHMENT_UPGRADE_WORKFLOW='outreach.people enrichment ledger (0160, runtime role)';

/** Post-upgrade runtime writes: the widened settings CHECK takes the new key, the ledger reserves one row per company under the daily cap and refuses a
 * second reservation and a reservation past the cap, and the person-lineage trigger function exists beside 0158's. No provider is called. */
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
 const reserve=(target:typeof first,dailyCredits:number)=>reservePeopleLookup(context,{provider:'upgrade_fake',company:target,credits:1,dailyCredits});
 assert.equal((await reserve(first,1)).kind,'reserved');
 assert.equal((await reserve(first,5)).kind,'taken','a company is never reserved twice');
 assert.equal((await reserve(second,1)).kind,'cap','the daily credit cap refuses a lookup that would pass it');
 const row=(await context.db.query<{state:string;credits:number}>('SELECT state,credits FROM outreach_people_contacts WHERE workspace_id=$1 AND candidate_id=$2',[context.scope.workspaceId,first.candidateId])).rows;
 assert.deepEqual(row,[{state:'reserved',credits:1}]);
 const body=(await context.db.query<{src:string}>("SELECT prosrc AS src FROM pg_proc WHERE proname='outreach_email_campaign_prepared_person_lineage'")).rows[0]?.src??'';
 assert(body.includes('outreach_people_contacts')&&body.includes("p.state='found'"),'the person lineage function proves the provider person');
 return 'runtime role set people_enrichment, reserved one ledger row under a one-credit cap, refused a second reservation and a reservation past the cap; person lineage function present; no provider called';
}
