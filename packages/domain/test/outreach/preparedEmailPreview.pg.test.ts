import {afterAll,beforeAll,expect,it} from 'vitest';
import {fakePeople,preparedEmailWorld} from './preparedEmailFixture.ts';
import {previewPreparedEmailAdmission} from '../../outreach/preparedEmailPreview.ts';
import {admittedCandidateIds,listPreparedEmailChoices} from '../../outreach/preparedEmailSelection.ts';
import {recordEmailVerification} from '../../outreach/emailVerification.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withReadOnlyTransaction} from '../../db/queryable.ts';

// ADR0036: the admin preview is the next admission pass's list (same skip set and selection) with each provider person and the address's latest stored check, the count of
// companies still awaiting enrichment, and a pure read (no provider call, no write).
let world:Awaited<ReturnType<typeof preparedEmailWorld>>;
beforeAll(async()=>{world=await preparedEmailWorld();},180_000);
afterAll(async()=>world?.stop());
const TABLES=['outreach_email_verifications','outreach_people_lookups','outreach_people_contacts','outreach_email_campaign_admissions','firms','contacts','email_addresses','sequence_enrollments','jobs'];
const counts=async()=>Object.fromEntries(await Promise.all(TABLES.map(async table=>[table,(await world.runtime.query<{n:number}>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n])));
const preview=(limit=25,regions=['OH','WA'])=>withReadOnlyTransaction(world.runtime,()=>previewPreparedEmailAdmission(world.ctx(),{limit,regions}));

it('lists the next pass in admission order with company, place, the provider person and the stored check, counts who awaits enrichment, and changes nothing',async()=>{
 await world.prepared('OH',()=>'Call our office.','Columbus');await world.prepared('WA',()=>'Call our office.','Seattle');await world.prepared('OH',()=>'x');
 const people=fakePeople();
 await world.setPeople({enabled:true,dailyCredits:2});
 // Two lookups fit the cap: the third company still awaits enrichment.
 expect(await world.enrich(people)).toMatchObject({looked:2,found:2,stopped:'cap'});
 const before=await counts(),shown=(await preview())!;
 expect(await counts()).toEqual(before);
 expect(people.calls).toHaveLength(2);
 expect(shown.awaitingEnrichment).toBe(1);
 const admissionOrder=await withReadOnlyTransaction(world.runtime,async()=>(await listPreparedEmailChoices(world.ctx(),{limit:25,regions:['OH','WA'],skip:await admittedCandidateIds(world.ctx()),campaignId:null})).map(choice=>choice.read.candidateId));
 expect(shown.candidates).toHaveLength(2);
 expect(shown.candidates.map(row=>row.candidateId)).toEqual(admissionOrder);
 for(const row of shown.candidates)expect(row).toEqual({candidateId:row.candidateId,host:expect.any(String),companyName:expect.stringMatching(/ Property Management$/u),website:`https://${row.host}/`,locality:expect.any(String),region:expect.stringMatching(/^(OH|WA)$/u),
  person:{firstName:'Jordan',lastName:'Blake',title:'Owner',email:`jordan.blake@${row.host}`,emailStatus:'verified',matchConfidence:'high',provider:'fake_people',observedAt:expect.any(String),creditsSpent:1},verification:null});
 expect((await preview(1))!.candidates).toHaveLength(1);
 const target=shown.candidates[0]!;
 expect((await preview(25,[target.region==='OH'?'WA':'OH']))!.candidates.some(row=>row.candidateId===target.candidateId)).toBe(false);
 await world.tx(()=>recordEmailVerification(world.ctx(true),target.person.email,'valid'));
 expect((await preview())!.candidates.find(row=>row.candidateId===target.candidateId)!.verification).toEqual({result:'valid',outcome:'ok',checkedAt:expect.any(String)});
 // An address with a recorded invalid check is not previewed, exactly as the pass would not take it.
 const other=shown.candidates[1]!;
 await world.tx(()=>recordEmailVerification(world.ctx(true),other.person.email,'invalid'));
 expect((await preview())!.candidates.map(row=>row.candidateId)).toEqual([target.candidateId]);
 expect((await world.admissions()).length).toBe(0);
});
it('refuses a salesperson',async()=>{
 const sales=repositoryContext(workspaceScope(world.ws,{kind:'user',role:'salesperson',userId:world.seed.alpha.salesperson.userId}),world.runtime);
 expect(await previewPreparedEmailAdmission(sales,{limit:25,regions:['OH']})).toBeNull();
});
