import {afterAll,beforeAll,expect,it} from 'vitest';
import {fakePeople,ownerAt,preparedEmailWorld} from './preparedEmailFixture.ts';
import {withTransaction} from '../../db/queryable.ts';
import {previewDeletion,commitDeletion} from '../../retention/deletion.ts';
import {recordingSuppressionJournal} from '../../suppression/journal.ts';

// ADR0036: ordinary CRM contact and Firm deletion erase the provider person copy (name, title, address, provider id) of the company admitted into it, the
// preview lists it, and the body-free spend custody stays so the company is neither paid for again nor re-admitted. Fake provider only.
let world:Awaited<ReturnType<typeof preparedEmailWorld>>;
beforeAll(async()=>{world=await preparedEmailWorld({dailyCredits:100});},180_000);
afterAll(async()=>world?.stop());
const rows=async()=>(await world.runtime.query<Record<string,unknown>>('SELECT l.*,c.provider_person_id,c.first_name,c.last_name,c.title,c.email FROM outreach_people_lookups l LEFT JOIN outreach_people_contacts c ON c.workspace_id=l.workspace_id AND c.lookup_id=l.id WHERE l.workspace_id=$1',[world.ws])).rows;
const rowFor=async(candidateId:string)=>(await rows()).find(row=>row['candidate_id']===candidateId)!;
const spentToday=async()=>Number((await world.runtime.query<{n:string}>('SELECT coalesce(sum(credits),0)::text AS n FROM outreach_people_lookups WHERE workspace_id=$1',[world.ws])).rows[0]!.n);
const personRows=async(candidateId:string)=>(await world.runtime.query<Record<string,unknown>>('SELECT c.* FROM outreach_people_contacts c WHERE c.workspace_id=$1 AND c.candidate_id=$2',[world.ws,candidateId])).rows;
it.each(['firm','contact'] as const)('erases the provider person copy on %s deletion, lists it in the preview, and leaves the body-free spend custody',async kind=>{
 const company=await world.prepared('OH',()=>'x'),other=await world.prepared('OH',()=>'x');
 await world.enrich(fakePeople(host=>ownerAt(host,host===company.domain?{}:{firstName:'Riley',lastName:'Stone',title:'Managing Broker',email:`riley@${host}`})));
 expect((await world.pass()).admitted).toBe(2);
 const admitted=(await world.runtime.query<{firm_id:string;contact_id:string}>('SELECT firm_id,contact_id FROM outreach_email_campaign_admissions WHERE workspace_id=$1 AND candidate_id=$2',[world.ws,company.candidateId])).rows[0]!;
 expect(await personRows(company.candidateId)).toHaveLength(1);
 const lookup=await rowFor(company.candidateId),spent=await spentToday();
 const preview=await withTransaction(world.runtime,()=>previewDeletion(world.ctx(),{targetKind:kind,firmId:admitted.firm_id,...(kind==='contact'?{contactId:admitted.contact_id}:{})}));
 if(!preview.ok)throw Error(preview.reason);
 expect(preview.value.removes).toMatchObject({outreach_people_contacts:1});
 expect(preview.value.retains).toMatchObject({outreach_people_lookups:1});
 expect(await personRows(company.candidateId)).toHaveLength(1);
 const committed=await withTransaction(world.runtime,()=>commitDeletion(world.ctx(),{requestId:preview.value.requestId,previewHash:preview.value.previewHash,commandId:`erase-people-${kind}`,journal:recordingSuppressionJournal()}));
 expect(committed.ok).toBe(true);
 expect(await personRows(company.candidateId)).toEqual([]);
 expect(await personRows(other.candidateId)).toHaveLength(1);
 const kept=(await rows()).find(row=>row['id']===lookup['id'])!;
 expect(kept).toMatchObject({state:'found',credits:1,host:company.domain,candidate_id:company.candidateId,email:null,first_name:null,last_name:null,title:null,provider_person_id:null});
 expect(await spentToday()).toBe(spent);
 const again=fakePeople();await world.enrich(again);expect(again.calls).not.toContain(company.domain);
});
