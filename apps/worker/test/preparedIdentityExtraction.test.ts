import {expect,it} from 'vitest';
import type {SourceObservation} from '@fss/contracts';
import type {ClassifierRequest} from '@fss/domain/classification/prompt.ts';
import {PREPARED_IDENTITY_PRODUCER} from '@fss/domain/sourcing/preparedIdentity.ts';
import {qualificationRequest,type QualificationExtractionRequest} from '@fss/domain/sourcing/qualificationPrompt.ts';
import {qualificationExtraction} from '../src/sourcing/qualificationExtraction.ts';

const observation:SourceObservation={id:'11111111-1111-4111-8111-111111111111',url:'https://harbor.example.test/',contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:'2026-10-30T12:00:00.000Z',publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[
 {id:'name',text:'Harbor Residential Management'},
 {id:'city',text:'Boston, Massachusetts'},
 {id:'description',text:'Harbor Residential Management manages residential homes in Boston, Massachusetts.'},
]};
const input={candidate:{firmName:'Home | HRM',website:observation.url,locality:'Boston',region:'MA'},observations:[observation],modelName:'claude-haiku-4-5',maxInputTokens:100,maxOutputTokens:2048,producerVersion:PREPARED_IDENTITY_PRODUCER} satisfies QualificationExtractionRequest;
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
 expect(creates).toBe(1);expect(sent).toEqual(counted);expect(sent).toEqual(qualificationRequest({candidate:input.candidate,observations:input.observations,modelName:input.modelName,maxInputTokens:input.maxInputTokens,maxOutputTokens:input.maxOutputTokens}));expect(JSON.stringify(input)).toBe(before);
});

import {effectivePreparedCandidate,LEGACY_QUALIFICATION_PRODUCER,preparedIdentityCitationRoles} from '@fss/domain/sourcing/preparedIdentity.ts';
const selections=()=>[
 {kind:'firm_identity' as const,observationId:observation.id,blockId:'name',value:observation.blocks[0]!.text},
 {kind:'residential_management' as const,observationId:observation.id,blockId:'description',value:observation.blocks[2]!.text},
 {kind:'service_area' as const,observationId:observation.id,blockId:'city',value:observation.blocks[1]!.text},
];
it('keeps legacy refusal and original literal success unchanged',()=>{
 expect(preparedIdentityCitationRoles(input.candidate,selections(),[observation],LEGACY_QUALIFICATION_PRODUCER)).toMatchObject({ok:false,diagnostic:{code:'identity_not_literal'}});
 expect(preparedIdentityCitationRoles({...input.candidate,firmName:observation.blocks[0]!.text},selections(),[observation],PREPARED_IDENTITY_PRODUCER)).toMatchObject({ok:true});
 expect(preparedIdentityCitationRoles({...input.candidate,firmName:observation.blocks[0]!.text},selections(),[observation],PREPARED_IDENTITY_PRODUCER)).not.toHaveProperty('preparedIdentity');
});
it.each(['Boston Property Management Company','Massachusetts Property Management','Harbor Residential Management manages homes','Harbor Property Management helps owners save time','Harbor Property Management Helps Owners Save Time','Harbor Property Management Can Support Your Property','Harbor Residential Management\nContact','Powered by Harbor Property Management','Harbor Property Management AMO ®','Home | Harbor Property Management','Harbor Property Management offers rentals','Harbor Property Management customer review'])('refuses a generic/prose/navigation/attribution identity: %s',name=>{
 const source={...observation,blocks:[{id:'name',text:name},...observation.blocks.slice(1)]};
 expect(preparedIdentityCitationRoles(input.candidate,[{...selections()[0]!,value:name},...selections().slice(1)],[source],PREPARED_IDENTITY_PRODUCER)).toMatchObject({ok:false});
});
it('preserves competing selections, refuses supported original names and unusable sources',()=>{
 const facts=selections();
 expect(preparedIdentityCitationRoles(input.candidate,[...facts,{...facts[0]!}], [observation],PREPARED_IDENTITY_PRODUCER)).toMatchObject({ok:false});
 for(const source of [{...observation,truncated:true},{...observation,firstParty:false},{...observation,url:'https://other.example.test/'}])expect(preparedIdentityCitationRoles(input.candidate,facts,[source],PREPARED_IDENTITY_PRODUCER)).toMatchObject({ok:false});
 const supported={...observation,blocks:[...observation.blocks,{id:'original',text:input.candidate.firmName}]};
 expect(preparedIdentityCitationRoles(input.candidate,facts,[supported],PREPARED_IDENTITY_PRODUCER)).toMatchObject({ok:false});
});
it('rederives whole identity and refuses erased, stale, future, changed or foreign proof',()=>{
 const result=preparedIdentityCitationRoles(input.candidate,selections(),[observation],PREPARED_IDENTITY_PRODUCER);
 if(!result.ok||!result.preparedIdentity)throw new Error('expected source proof');
 const resolve=(sources:SourceObservation[]= [observation],proof:unknown=result.preparedIdentity,now='2026-10-30T13:00:00.000Z',producer:unknown=PREPARED_IDENTITY_PRODUCER)=>effectivePreparedCandidate(input.candidate,result.facts,sources,producer,proof,now);
 expect(resolve()).toEqual({...input.candidate,firmName:'Harbor Residential Management'});
 expect(JSON.stringify(result.preparedIdentity)).not.toContain('Harbor');
 expect(resolve([])).toBeNull();expect(resolve([{...observation,blocks:[]}])).toBeNull();
 expect(resolve([{...observation,contentHash:'c'.repeat(64)}])).toBeNull();
 expect(resolve([{...observation,relevantTextHash:'c'.repeat(64)}])).toBeNull();
 expect(resolve([{...observation,blocks:observation.blocks.map(b=>b.id==='name'?{...b,text:b.text+' LLC'}:b)}])).toBeNull();
 expect(resolve([observation],{...result.preparedIdentity,extra:true})).toBeNull();
 expect(resolve([observation],result.preparedIdentity,'2026-11-06T12:00:00.001Z')).toBeNull();
 expect(resolve([observation],result.preparedIdentity,'2026-10-30T11:59:59.999Z')).toBeNull();
 expect(resolve([observation],result.preparedIdentity,undefined,LEGACY_QUALIFICATION_PRODUCER)).toBeNull();
 expect(resolve([observation],null,undefined,'unknown')).toBeNull();
 expect(resolve([observation],null,undefined,LEGACY_QUALIFICATION_PRODUCER)).toBe(input.candidate);
});

it('refuses an unselected competing standalone company name, while allowing duplicate branding',()=>{
 const source={...observation,blocks:[...observation.blocks,{id:'other',text:'Beacon Property Management'}]};
 expect(preparedIdentityCitationRoles(input.candidate,selections(),[source],PREPARED_IDENTITY_PRODUCER)).toMatchObject({ok:false});
 expect(preparedIdentityCitationRoles(input.candidate,selections(),[{...source,blocks:[...observation.blocks,{id:'repeat',text:'Harbor Residential Management'}]}],PREPARED_IDENTITY_PRODUCER)).toMatchObject({ok:true});
});

it('preserves punctuation in a whole company label without title cleanup',()=>{
 const name='Northeast Realty + Co.';
 const source={...observation,blocks:[{id:'name',text:name},...observation.blocks.slice(1)]};
 const result=preparedIdentityCitationRoles(input.candidate,[{...selections()[0]!,value:name},...selections().slice(1)],[source],PREPARED_IDENTITY_PRODUCER);
 expect(result).toMatchObject({ok:true,preparedIdentity:{blockId:'name'}});
 if(!result.ok)throw Error('expected source proof');
 expect(effectivePreparedCandidate(input.candidate,result.facts,[source],PREPARED_IDENTITY_PRODUCER,result.preparedIdentity,'2026-10-30T13:00:00.000Z')?.firmName).toBe(name);
});
