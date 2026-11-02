import {afterAll,beforeAll,expect,it} from 'vitest';
import {preparedEmailWorld} from './preparedEmailFixture.ts';
import {previewPreparedEmailAdmission} from '../../outreach/preparedEmailPreview.ts';
import {withReadOnlyTransaction} from '../../db/queryable.ts';

// ADR0035: the business name is resolved once (`resolveBusinessName`) in the shared prepared email read, so selection, preview, the existing-Firm check and the Firm all use it,
// and a company with no confident business name is neither previewed nor admitted.
let world:Awaited<ReturnType<typeof preparedEmailWorld>>;
beforeAll(async()=>{world=await preparedEmailWorld();},180_000);
afterAll(async()=>world?.stop());
const preview=()=>withReadOnlyTransaction(world.runtime,()=>previewPreparedEmailAdmission(world.ctx(),{limit:25,regions:['OH']}));
const firmNames=async()=>(await world.runtime.query<{name:string;website:string}>('SELECT name,website FROM firms WHERE workspace_id=$1 ORDER BY name',[world.ws])).rows;
it('previews and admits the brand of a search title, and never admits a company whose only name is a location and service title',async()=>{
 const generic=await world.prepared('OH',domain=>`Email info@${domain}`,'Columbus',false,'Columbus, OH Property Management Company');
 const titled=await world.prepared('OH',domain=>`Email info@${domain}`,'Columbus',false,'Property Management Services in Columbus, OH | Acme Realty - Acme Realty');
 const shown=(await preview())!.candidates;
 expect(shown.map(row=>[row.candidateId,row.companyName])).toEqual([[titled.candidateId,'Acme Realty']]);
 expect(await world.pass()).toMatchObject({admitted:1,failed:0});
 expect((await world.admissions()).length).toBe(1);
 expect(await firmNames()).toEqual([{name:'Acme Realty',website:`https://${titled.domain}/`}]);
 expect((await world.runtime.query('SELECT 1 FROM outreach_email_campaign_admissions WHERE workspace_id=$1 AND candidate_id=$2',[world.ws,generic.candidateId])).rows).toEqual([]);
});
it('takes the Firm name from the company\'s own ©-line when the stored name names no business, and refuses a name another Firm already carries',async()=>{
 const footer=await world.prepared('OH',domain=>`Email info@${domain}</p><p>© 2024 Peak Realty. All rights reserved.`,'Columbus',false,'Dallas-Fort Worth Property Management');
 const taken=await world.prepared('OH',domain=>`Email info@${domain}`,'Columbus',false,'Property Management in Columbus, OH | Acme Realty');
 expect((await preview())!.candidates.map(row=>[row.candidateId,row.companyName])).toEqual([[footer.candidateId,'Peak Realty']]);
 expect(await world.pass()).toMatchObject({admitted:1,failed:0});
 expect((await firmNames()).map(firm=>firm.name)).toEqual(['Acme Realty','Peak Realty']);
 expect((await world.runtime.query('SELECT 1 FROM outreach_email_campaign_admissions WHERE workspace_id=$1 AND candidate_id=$2',[world.ws,taken.candidateId])).rows).toEqual([]);
});
