import {expect,it} from 'vitest';
import {manualPhoneChoiceSchema,manualProspectFeedbackInputSchema,manualProspectListInputSchema,type ManualPhoneChoice} from '@fss/contracts';
import {projectManualPhoneChoice} from '../../sourcing/manualProspectPhoneChoice.ts';
import {phoneSupplyObservation,phoneSupplyRun,PHONE_SUPPLY_NOW as now} from './phoneSupplyFixtures.ts';

function fixture(text='Office phone: 214-555-0123',literal='214-555-0123',label='Office phone'){
 const observation=phoneSupplyObservation([text]),run=phoneSupplyRun([observation]);
 const choice:ManualPhoneChoice={runId:run.id,observationId:observation.id,blockId:'b1',labelStart:text.indexOf(label),labelEnd:text.indexOf(label)+label.length,start:text.indexOf(literal),end:text.indexOf(literal)+literal.length,contentHash:observation.contentHash,relevantTextHash:observation.relevantTextHash};
 return {run,choice};
}
it.each([
 ['Office phone: 214-555-0123','214-555-0123','Office phone'],
 ['Search Rentals Tenants Owners Expert Tips Call us at: 940-323-0505','940-323-0505','Call us'],
 ['Call us today at 940.262.0091 or enter your address below.','940.262.0091','Call us'],
])('projects the explicit whole human selection from %s without a canonical route', (text,literal,label)=>{
 const {run,choice}=fixture(text,literal,label),value=projectManualPhoneChoice(run,choice,now);
 expect(value).toMatchObject({choice,sourceUrl:run.content!.observations[0]!.url});
 expect(value?.value).toMatch(/^\+1\d{10}$/u);
});
it.each(['Fax Office phone: 214-555-0123','Emergency Office phone: 214-555-0123','Mobile Office phone: 214-555-0123','Website by vendor Office phone: 214-555-0123','Office phone: 214-555-0123 ext 5','Office phone: 1214-555-01234'])('refuses ambiguous or partial whole-run selection %s',text=>{
 const {run,choice}=fixture(text);expect(projectManualPhoneChoice(run,choice,now)).toBeNull();
});
it('binds IDs, exact hashes, label, spans and expiry rather than reinterpreting source bytes',()=>{
 const {run,choice}=fixture();
 for(const change of [{runId:choice.observationId},{observationId:choice.runId},{blockId:'b2'},{contentHash:'b'.repeat(64)},{relevantTextHash:'b'.repeat(64)},{labelStart:1},{start:choice.start+1},{end:choice.end-1}])expect(projectManualPhoneChoice(run,{...choice,...change},now)).toBeNull();
 expect(projectManualPhoneChoice(run,choice,run.expires_at.getTime())).toBeNull();
 expect(projectManualPhoneChoice({...run,state:'unavailable',content:null},choice,now)).toBeNull();
});
it('keeps legacy command/list inputs valid and rejects prose or unpaired exact selectors',()=>{
 const {choice}=fixture(),base={candidateId:choice.runId,expectedRevision:1,state:'kept'};
 expect(manualProspectFeedbackInputSchema.parse(base)).toEqual(base);
 expect(manualProspectFeedbackInputSchema.safeParse({...base,phoneChoice:choice}).success).toBe(true);
 expect(manualProspectFeedbackInputSchema.safeParse({...base,state:'skipped',phoneChoice:choice}).success).toBe(false);
 expect(manualPhoneChoiceSchema.safeParse({...choice,value:'214-555-0123'}).success).toBe(false);
 expect(manualProspectListInputSchema.safeParse({state:'all',offset:0,candidateId:choice.runId}).success).toBe(false);
 expect(manualProspectListInputSchema.safeParse({state:'all',offset:50,candidateId:choice.runId,expectedRevision:1}).success).toBe(false);
});
