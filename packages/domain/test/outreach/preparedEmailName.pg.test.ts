import {afterAll,beforeAll,expect,it} from 'vitest';
import {preparedEmailWorld} from './preparedEmailFixture.ts';
import {previewPreparedEmailAdmission} from '../../outreach/preparedEmailPreview.ts';
import {withReadOnlyTransaction} from '../../db/queryable.ts';
import {listPreparedEmailCandidates} from '../../sourcing/preparedEmailRead.ts';
import {preparedAdmissionRefusedInAdvance} from '../../outreach/preparedEmailAssessment.ts';

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
 await world.enrich();
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
 await world.enrich();
 expect((await preview())!.candidates.map(row=>[row.candidateId,row.companyName])).toEqual([[footer.candidateId,'Peak Realty']]);
 expect(await world.pass()).toMatchObject({admitted:1,failed:0});
 expect((await firmNames()).map(firm=>firm.name)).toEqual(['Acme Realty','Peak Realty']);
 expect((await world.runtime.query('SELECT 1 FROM outreach_email_campaign_admissions WHERE workspace_id=$1 AND candidate_id=$2',[world.ws,taken.candidateId])).rows).toEqual([]);
});
const reads=()=>withReadOnlyTransaction(world.runtime,()=>listPreparedEmailCandidates(world.ctx(),{limit:100,regions:['OH'],skip:new Set()}));
const refusedInAdvance=async(candidateId:string)=>{const read=(await reads()).find(entry=>entry.candidateId===candidateId);return read===undefined?undefined:preparedAdmissionRefusedInAdvance(world.ctx(),world.campaignId,read);};
const admitted=async(candidateId:string)=>(await world.runtime.query('SELECT 1 FROM outreach_email_campaign_admissions WHERE workspace_id=$1 AND candidate_id=$2',[world.ws,candidateId])).rows.length>0;
it('refuses a company whose resolved name matches an existing Firm up to a legal form, in either direction, and not an unrelated name',async()=>{
 await world.runtime.query("INSERT INTO firms(workspace_id,name) VALUES($1,'Birch Realty LLC'),($1,'Cedar Homes'),($1,'Maple Realty Partners LLC')",[world.ws]);
 const birch=await world.prepared('OH',domain=>`Email info@${domain}`,'Columbus',false,'Property Management in Columbus, OH | Birch Realty');
 const cedar=await world.prepared('OH',domain=>`Email info@${domain}`,'Columbus',false,'Cedar Homes, LLC | Property Management in Columbus, OH');
 const maple=await world.prepared('OH',domain=>`Email info@${domain}`,'Columbus',false,'Property Management in Columbus, OH | Maple Realty');
 await world.enrich();
 expect(await refusedInAdvance(birch.candidateId)).toBe(true);
 expect(await refusedInAdvance(cedar.candidateId)).toBe(true);
 expect(await refusedInAdvance(maple.candidateId)).toBe(false);
 expect((await preview())!.candidates.map(row=>row.candidateId)).toEqual([maple.candidateId]);
 expect(await world.pass()).toMatchObject({admitted:1,failed:0});
 expect([await admitted(birch.candidateId),await admitted(cedar.candidateId),await admitted(maple.candidateId)]).toEqual([false,false,true]);
 expect((await firmNames()).map(firm=>firm.name).filter(name=>/^(Birch|Cedar|Maple)/u.test(name))).toEqual(['Birch Realty LLC','Cedar Homes','Maple Realty','Maple Realty Partners LLC']);
});
it('treats a stored name that is the company\'s host, or a leading state and service words, as no name, and falls back to the ©-line',async()=>{
 const host=await world.prepared('OH',domain=>`Email info@${domain}</p><p>© 2024 Peak Cottages. All rights reserved.`,'Columbus',false,'www.peakpm.com');
 const state=await world.prepared('OH',domain=>`Email info@${domain}</p><p>© 2024 Peak Lofts. All rights reserved.`,'Columbus',false,'Rhode Island Property Management');
 const bare=await world.prepared('OH',domain=>`Email info@${domain}`,'Columbus',false,'peakpm.com');
 const stateOnly=await world.prepared('OH',domain=>`Email info@${domain}`,'Columbus',false,'New York Property Management Company');
 await world.enrich();
 expect((await preview())!.candidates.map(row=>[row.candidateId,row.companyName]).sort((a,b)=>a[1]!<b[1]!?-1:1)).toEqual([[host.candidateId,'Peak Cottages'],[state.candidateId,'Peak Lofts']]);
 expect(await world.pass()).toMatchObject({admitted:2,failed:0});
 expect([await admitted(host.candidateId),await admitted(state.candidateId),await admitted(bare.candidateId),await admitted(stateOnly.candidateId)]).toEqual([true,true,false,false]);
 expect((await firmNames()).map(firm=>firm.name).filter(name=>/^Peak (Cottages|Lofts)$/u.test(name))).toEqual(['Peak Cottages','Peak Lofts']);
});
