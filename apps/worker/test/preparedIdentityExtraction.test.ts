import {expect,it} from 'vitest';
import type {SourceObservation} from '@fss/contracts';
import type {ClassifierRequest} from '@fss/domain/classification/prompt.ts';
import {PREPARED_IDENTITY_PRODUCER} from '@fss/domain/sourcing/preparedIdentity.ts';
import {qualificationRequest} from '@fss/domain/sourcing/qualificationPrompt.ts';
import {qualificationExtraction} from '../src/sourcing/qualificationExtraction.ts';

const observation:SourceObservation={id:'11111111-1111-4111-8111-111111111111',url:'https://harbor.example.test/',contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:'2026-10-30T12:00:00.000Z',publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[
 {id:'name',text:'Harbor Residential Management'},
 {id:'city',text:'Boston, Massachusetts'},
 {id:'description',text:'Harbor Residential Management manages residential homes in Boston, Massachusetts.'},
]};
const input={candidate:{firmName:'Home | HRM',website:observation.url,locality:'Boston',region:'MA'},observations:[observation],modelName:'claude-haiku-4-5',maxInputTokens:100,maxOutputTokens:2048,producerVersion:PREPARED_IDENTITY_PRODUCER};
it('prepares a source identity in the same unchanged v7 request, preserving all original selections',async()=>{
 let creates=0,counted:ClassifierRequest|undefined,sent:ClassifierRequest|undefined;
 const provider=qualificationExtraction({kind:'bedrock',countTokens:async r=>{counted=r;return 100;},create:async r=>{creates++;sent=r;return {usage:{input_tokens:100,output_tokens:50},content:[{type:'text',text:JSON.stringify({selections:[
  {kind:'firm_identity',observationId:observation.id,blockId:'name'},
  {kind:'residential_management',observationId:observation.id,blockId:'description'},
  {kind:'service_area',observationId:observation.id,blockId:'city'},
 ],openingQuestion:null})}]};}});
 const before=JSON.stringify(input);await provider.countInputTokens(input);const result=await provider.extract(input);
 expect(result).toMatchObject({ok:true,value:{preparedIdentity:{producerVersion:PREPARED_IDENTITY_PRODUCER,observationId:observation.id,blockId:'name'},facts:[
  {kind:'firm_identity',blockId:'name'},{kind:'residential_management',blockId:'description'},{kind:'service_area',blockId:'city'},{kind:'service_area',blockId:'description'},
 ]}});
 expect(creates).toBe(1);expect(sent).toEqual(counted);expect(sent).toEqual(qualificationRequest({...input,producerVersion:undefined}));expect(JSON.stringify(input)).toBe(before);
});
