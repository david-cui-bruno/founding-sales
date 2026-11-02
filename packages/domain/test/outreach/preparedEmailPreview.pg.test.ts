import {afterAll,beforeAll,expect,it} from 'vitest';
import {preparedEmailWorld} from './preparedEmailFixture.ts';
import {previewPreparedEmailAdmission} from '../../outreach/preparedEmailPreview.ts';
import {recordEmailVerification} from '../../outreach/emailVerification.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withReadOnlyTransaction} from '../../db/queryable.ts';

// ADR0035: the admin preview is the next admission pass's list (same skip set and accept filter) plus each address's latest stored check, and a pure read.
let world:Awaited<ReturnType<typeof preparedEmailWorld>>;
beforeAll(async()=>{world=await preparedEmailWorld();},180_000);
afterAll(async()=>world?.stop());
const TABLES=['outreach_email_verifications','outreach_email_campaign_admissions','firms','email_addresses','sequence_enrollments','jobs'];
const counts=async()=>Object.fromEntries(await Promise.all(TABLES.map(async table=>[table,(await world.runtime.query<{n:number}>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n])));
const preview=(limit=25,regions=['OH','WA'])=>withReadOnlyTransaction(world.runtime,()=>previewPreparedEmailAdmission(world.ctx(),{limit,regions}));

it('lists the next pass in admission order with company, place, address and the stored check, and changes nothing',async()=>{
 await world.prepared('OH',()=>'Call our office.');
 const oh=await world.prepared('OH',domain=>`Email info@${domain}`,'Columbus'),wa=await world.prepared('WA',domain=>`Email Office@${domain}`,'Seattle'),dropped=await world.prepared('OH',domain=>`Email hello@${domain}`);
 await world.tx(()=>recordEmailVerification(world.ctx(true),`hello@${dropped.domain}`,'invalid'));
 const before=await counts(),first=(await preview())!;
 expect(await counts()).toEqual(before);
 expect(first.candidates.map(row=>row.candidateId).sort()).toEqual([oh.candidateId,wa.candidateId].sort());
 expect(first.candidates).toEqual(expect.arrayContaining([
  {candidateId:oh.candidateId,host:oh.domain,companyName:expect.stringMatching(/ Property Management$/u),website:`https://${oh.domain}/`,locality:'Columbus',region:'OH',address:`info@${oh.domain}`,verification:null},
  {candidateId:wa.candidateId,host:wa.domain,companyName:expect.stringMatching(/ Property Management$/u),website:`https://${wa.domain}/`,locality:'Seattle',region:'WA',address:`office@${wa.domain}`,verification:null},
 ]));
 expect((await preview(1))!.candidates).toHaveLength(1);
 expect((await preview(25,['WA']))!.candidates.map(row=>row.candidateId)).toEqual([wa.candidateId]);
 await world.tx(()=>recordEmailVerification(world.ctx(true),`info@${oh.domain}`,'valid'));
 const checked=(await preview())!.candidates.find(row=>row.candidateId===oh.candidateId)!;
 expect(checked.verification).toEqual({result:'valid',outcome:'ok',checkedAt:expect.any(String)});
 expect((await world.admissions()).length).toBe(0);
 await world.pass();
 expect((await preview())!.candidates.map(row=>row.candidateId)).toEqual([]);
});
it('refuses a salesperson',async()=>{
 const sales=repositoryContext(workspaceScope(world.ws,{kind:'user',role:'salesperson',userId:world.seed.alpha.salesperson.userId}),world.runtime);
 expect(await previewPreparedEmailAdmission(sales,{limit:25,regions:['OH']})).toBeNull();
});
