import {expect,it} from 'vitest';
import {manualPhoneChoiceSchema,manualProspectFeedbackInputSchema,manualProspectListInputSchema,type ManualPhoneChoice} from '@fss/contracts';
import {V2_ONLY_PHONE_LABEL,blockPhoneLabels,phoneBlockAllowsV2} from '../../sourcing/manualProspectLiteralPhone.ts';
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
it.each([
 ['For any questions regarding our services or to request a property management estimate, please call 202.337.5080, or email us.','202.337.5080','please call'],
 ['📞 Call us at (617) 249-7141 or fill out our online form to schedule your free Quincy property management consultation today.','(617) 249-7141','Call us'],
 ['📞 (617) 249-7141','(617) 249-7141','📞'],
])('v2 verb and emoji labels are choosable for Calling: %s',(text,literal,label)=>{
 const {run,choice}=fixture(text,literal,label);expect(projectManualPhoneChoice(run,choice,now)?.value).toMatch(/^\+1\d{10}$/u);
});
it('a standalone self-labelled number is its own label and is choosable; partial self-labels are not',()=>{
 const {run,choice}=fixture('(412) 685-3970','(412) 685-3970','(412) 685-3970');
 expect(manualPhoneChoiceSchema.safeParse(choice).success).toBe(true);
 expect(projectManualPhoneChoice(run,choice,now)).toMatchObject({value:'+14126853970',choice});
 for(const patch of [{labelEnd:choice.end-1},{labelStart:choice.start+1},{start:choice.start+1,labelStart:choice.start,labelEnd:choice.end}])
  expect(projectManualPhoneChoice(run,{...choice,...patch},now)).toBeNull();
 expect(manualPhoneChoiceSchema.safeParse({...choice,labelEnd:choice.end-1}).success).toBe(false);
});
it.each([['412-685-3970 (cell)'],['412-685-3970 ext 5'],['412-685-3970 text me']])('a standalone self-label never attaches beside another line or an unsupported suffix: %s',text=>{
 const {run,choice}=fixture(text,'412-685-3970','412-685-3970');
 expect(projectManualPhoneChoice(run,choice,now)).toBeNull();
});
it.each([
 ['Please call 202.337.5080 or text us for SMS updates.','202.337.5080','Please call'],
 ['Call 412-685-3970 or reach our cell after hours.','412-685-3970','Call'],
 ['📞 412-685-3970 (personal line)','412-685-3970','📞'],
 ['☎ 412-685-3970 for emergencies','412-685-3970','☎'],
 ['Fax and phone: call 412-685-3970','412-685-3970','call'],
])('a v2-only label never yields a Calling choice beside another line or purpose: %s',(text,literal,label)=>{
 expect(V2_ONLY_PHONE_LABEL.test(label)).toBe(true);expect(phoneBlockAllowsV2(text)).toBe(false);
 expect(blockPhoneLabels(text).flatMap(found=>found.literals).filter(found=>found.value!==null)).toEqual([]);
 const {run,choice}=fixture(text,literal,label);expect(projectManualPhoneChoice(run,choice,now)).toBeNull();
});
// Risk P2: stored choices keep v1 label offsets; v2 must reproduce every v1 label span exactly.
const v1Labels=/\b(?:office\s+phone|main\s+phone|mobile(?:\s+phone)?|personal(?:\s+phone)?|emergency(?:\s+phone)?|fax|telephone|phone|tel|call\s+us)\b/giu;
it.each([
 ['Call us: 214-555-0123','214-555-0123','Call us'],
 ['Please call us: 214-555-0123','214-555-0123','call us'],
 ['Please call us at 214-555-0123.','214-555-0123','call us'],
 ['Phone: 214-555-0123','214-555-0123','Phone'],
 ['Tel 214-555-0123','214-555-0123','Tel'],
 ['call us at 214-555-0123','214-555-0123','call us'],
 ['Call us at: 940-323-0505','940-323-0505','Call us'],
 ['Call us today at 940.262.0091 or enter your address below.','940.262.0091','Call us'],
])('re-reads an existing v1-shaped stored choice unchanged under v2: %s',(text,literal,label)=>{
 const v2=blockPhoneLabels(text).map(found=>[found.label,found.labelStart,found.labelEnd]);
 for(const v1 of text.matchAll(v1Labels))expect(v2).toContainEqual([v1[0],v1.index,v1.index+v1[0].length]);
 const {run,choice}=fixture(text,literal,label);expect(choice.labelStart).toBe(text.indexOf(label));
 expect(projectManualPhoneChoice(run,choice,now)).toMatchObject({choice});
});
