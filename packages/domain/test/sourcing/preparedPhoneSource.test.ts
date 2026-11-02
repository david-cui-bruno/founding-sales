import {createHash,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import type {CandidateInput,ManualPhoneChoice,SourceObservation} from '@fss/contracts';
import {buildPreparedCapture} from '../../sourcing/preparedCapture.ts';
import type {ManualPhoneSnapshot} from '../../sourcing/manualProspectPhone.ts';
import {projectManualPhone} from '../../sourcing/manualProspectPhone.ts';
import {projectPreparedPhoneChoice} from '../../sourcing/manualProspectPhoneChoice.ts';
import {preparedPhoneSource,PREPARED_PHONE_HORIZON_MS} from '../../sourcing/preparedPhoneSource.ts';
import {projectPreparedProspect} from '../../sourcing/preparedProspectProjection.ts';
import type {ManualProspectRow} from '../../sourcing/manualProspectProjection.ts';

const now=Date.parse('2026-10-31T12:00:00.000Z'),candidateId=randomUUID(),runId=randomUUID(),website='https://capture.example.test/';
const sourceUrl=website+'old',middle='https://www.capture.example.test/new',pageUrl='https://www.capture.example.test/contact';
const business='Our company manages residential homes and coordinates tenant maintenance requests for owners across the region.';
function page(blocks:string[],extra:Partial<SourceObservation>={}):SourceObservation{
 const list=blocks.map((text,index)=>({id:`b${index+1}`,text}));
 return {id:randomUUID(),url:pageUrl,contentHash:'a'.repeat(64),relevantTextHash:createHash('sha256').update(JSON.stringify(list)).digest('hex'),retrievedAt:'2026-10-31T01:00:00.000Z',publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:list,...extra};
}
function snapshot(pages:SourceObservation[],options:{captured?:SourceObservation[];permitted?:string[];validUntil?:string|null;denied?:boolean;deadlines?:Record<string,number>;granted?:SourceObservation[]}={}):ManualPhoneSnapshot{
 const captured=options.captured??pages.slice(0,1);
 const binding={candidateId,candidateRevision:1,sourceUrl};
 const manifest=captured.length?buildPreparedCapture(binding,captured.map(source=>({source,trace:{version:'page-redirect-trace-v1',urls:[sourceUrl,middle,source.url]}}))):null;
 const dependencyUrls=manifest?[...new Set(manifest.pages.flatMap(entry=>entry.redirectUrls))].sort():[];
 return {id:runId,candidate_id:candidateId,candidate_revision:1,payload:{firmName:'Capture Property Management',website,sourceUrl,locality:'Columbus',region:'OH',signal:'fit_only',evidence:'Fictional',observedOn:'2026-10-30',preparedBy:'Fixture'},
  observations:pages,facts:[],permitted_urls:options.permitted??[],capture_policy_version:'prepared-source-association-v2',capture_state:'review',prepared_capture:manifest,
  prepared_capture_authority:{dependencyUrls,denied:options.denied??false,validUntil:options.validUntil??null},prepared_source_deadlines:options.deadlines??{},
  evidence_authorities:(options.granted??[]).map(source=>({id:randomUUID(),url:source.url,contentHash:source.contentHash,retrievedAt:source.retrievedAt}))};
}
const locate=(source:SourceObservation,text:string,literal:string,label=literal):ManualPhoneChoice=>{
 const block=source.blocks.find(entry=>entry.text===text)!,labelStart=text.indexOf(label),start=text.indexOf(literal);
 return {runId,observationId:source.id,blockId:block.id,labelStart,labelEnd:labelStart+label.length,start,end:start+literal.length,contentHash:source.contentHash,relevantTextHash:source.relevantTextHash};
};
const LABELLED='Office phone: (614) 725-3059';

it('offers a prepared own-site labelled phone with exact provenance and lets it be chosen',()=>{
 const source=page([business,LABELLED]),current=snapshot([source]);
 const evidence=projectManualPhone(current,now);
 expect(evidence).toMatchObject({state:'observed',value:'+16147253059',coverage:{state:'complete',observations:1}});
 if(evidence.state!=='observed')throw Error('expected observed');
 expect(evidence.sources[0]).toMatchObject({method:'retained_original_literal',runId,observationId:source.id,blockId:'b2',url:pageUrl,literal:'(614) 725-3059',label:'Office phone',authority:{kind:'prepared_capture',sourceUrl:pageUrl}});
 const choice=locate(source,LABELLED,'(614) 725-3059','Office phone'),phone=projectPreparedPhoneChoice(current,choice,now);
 expect(phone).toMatchObject({value:'+16147253059',choice,sourceUrl:pageUrl,retrievedAt:source.retrievedAt});
 expect(Date.parse(phone!.expiresAt)).toBe(Date.parse(source.retrievedAt)+PREPARED_PHONE_HORIZON_MS);
});
it('offers and lets a standalone published number be chosen as its own label',()=>{
 const text='(614) 725-3059',source=page([business,text]),current=snapshot([source]);
 const evidence=projectManualPhone(current,now);
 expect(evidence).toMatchObject({state:'observed',value:'+16147253059'});
 const choice=locate(source,text,text);expect(choice.labelStart).toBe(choice.start);
 expect(projectPreparedPhoneChoice(current,choice,now)).toMatchObject({value:'+16147253059',choice});
 const emoji=page([business,'📞 (614) 725-3059']);
 expect(projectPreparedPhoneChoice(snapshot([emoji]),locate(emoji,'📞 (614) 725-3059','(614) 725-3059','📞'),now)?.value).toBe('+16147253059');
});
it('is exactly the phone the prepared brief calls published',()=>{
 for(const text of [LABELLED,'(614) 725-3059']){
  const source=page([business,text]),current=snapshot([source]),evidence=projectManualPhone(current,now);
  const row:ManualProspectRow={id:candidateId,revision:1,payload:current.payload as CandidateInput,origins:[],created_at:new Date(now-2000),manual_state:'new',duplicate_count:0};
  const brief=projectPreparedProspect(row,current,{id:runId,candidate_revision:1},now);
  expect(brief?.callable).toMatchObject({state:'callable',phone:'(614) 725-3059'});expect(evidence).toMatchObject({state:'observed',value:'+16147253059'});
 }
});
it('reads intact blocks of an incomplete page as partial coverage and still offers the number',()=>{
 const source=page([business,LABELLED],{truncated:true}),current=snapshot([source]);
 expect(projectManualPhone(current,now)).toMatchObject({state:'observed',value:'+16147253059',coverage:{state:'partial'}});
 expect(projectPreparedPhoneChoice(current,locate(source,LABELLED,'(614) 725-3059','Office phone'),now)?.value).toBe('+16147253059');
});
it('skips pages the brief would not cite instead of poisoning the scan, and records the skip as partial',()=>{
 const own=page([business,LABELLED]),other=page(['Office phone: (212) 555-0100'],{url:'https://other.example.test/contact'}),lost=page(['Office phone: (212) 555-0101'],{url:'https://www.capture.example.test/lost'});
 const current=snapshot([own,other,lost],{captured:[own],permitted:[other.url]});
 const evidence=projectManualPhone(current,now);
 expect(evidence).toMatchObject({state:'observed',value:'+16147253059',coverage:{state:'partial',observations:1}});
 expect(JSON.stringify(evidence)).not.toContain('212');
 expect(projectPreparedPhoneChoice(current,locate(other,'Office phone: (212) 555-0100','(212) 555-0100','Office phone'),now)).toBeNull();
 expect(projectPreparedPhoneChoice(current,locate(lost,'Office phone: (212) 555-0101','(212) 555-0101','Office phone'),now)).toBeNull();
});
it('offers nothing from another host even when it is the only retained page',()=>{
 const other=page([business,LABELLED],{url:'https://other.example.test/contact'}),current=snapshot([other],{captured:[],permitted:[other.url]});
 expect(preparedPhoneSource(current,now)).toBeNull();
 expect(projectManualPhone(current,now)).toMatchObject({state:'not_extracted',reason:'original_not_usable'});
 expect(projectPreparedPhoneChoice(current,locate(other,LABELLED,'(614) 725-3059','Office phone'),now)).toBeNull();
});
it.each([
 ['withdrawn or denied source',{denied:true}],
 ['expired capture deadline',{validUntil:'2026-10-31T11:59:59.000Z'}],
] as const)('offers nothing after a %s',(_name,options)=>{
 const source=page([business,LABELLED]),current=snapshot([source],options);
 expect(preparedPhoneSource(current,now)).toBeNull();
 expect(projectManualPhone(current,now)).toMatchObject({state:'not_extracted',reason:'original_not_usable'});
 expect(projectPreparedPhoneChoice(current,locate(source,LABELLED,'(614) 725-3059','Office phone'),now)).toBeNull();
});
it('expires a choice at its source deadline and never later than the horizon after retrieval',()=>{
 const source=page([business,LABELLED]),choice=locate(source,LABELLED,'(614) 725-3059','Office phone');
 const soon=snapshot([source],{validUntil:'2026-10-31T13:00:00.000Z'});
 expect(projectPreparedPhoneChoice(soon,choice,now)?.expiresAt).toBe('2026-10-31T13:00:00.000Z');
 expect(projectPreparedPhoneChoice(soon,choice,Date.parse('2026-10-31T13:00:00.000Z'))).toBeNull();
 const horizon=Date.parse(source.retrievedAt)+PREPARED_PHONE_HORIZON_MS;
 expect(projectPreparedPhoneChoice(snapshot([source]),choice,horizon-1)?.value).toBe('+16147253059');
 expect(projectPreparedPhoneChoice(snapshot([source]),choice,horizon)).toBeNull();
});
it('binds run, observation, block, hashes and spans, and is not a phone-discovery authority',()=>{
 const source=page([business,LABELLED]),current=snapshot([source]),choice=locate(source,LABELLED,'(614) 725-3059','Office phone');
 for(const change of [{runId:randomUUID()},{observationId:randomUUID()},{blockId:'b1'},{contentHash:'b'.repeat(64)},{relevantTextHash:'b'.repeat(64)},{labelStart:choice.labelStart+1},{start:choice.start+1},{end:choice.end-1}])
  expect(projectPreparedPhoneChoice(current,{...choice,...change},now)).toBeNull();
 expect(projectPreparedPhoneChoice(undefined,choice,now)).toBeNull();
 expect(projectPreparedPhoneChoice({...current,id:randomUUID()},choice,now)).toBeNull();
});
it.each([
 ['Fax: (614) 725-3060','(614) 725-3060','Fax'],
 ['Call (614) 725-3059 or text us anytime','(614) 725-3059','Call'],
 ['Mobile phone: (614) 725-3059','(614) 725-3059','Mobile phone'],
 ['Emergency: (614) 725-3059','(614) 725-3059','Emergency'],
 ['(614) 725-3059 (cell)','(614) 725-3059','(614) 725-3059'],
 ['Office phone: (614) 725-3059 ext 12','(614) 725-3059','Office phone'],
])('keeps the v2 refusals for prepared pages: %s',(text,literal,label)=>{
 const source=page([business,text]),current=snapshot([source]);
 expect(projectManualPhone(current,now).state).not.toBe('observed');
 expect(projectPreparedPhoneChoice(current,locate(source,text,literal,label),now)).toBeNull();
});
it('leaves a candidate without a current prepared association on the unchanged exact retained-original path',()=>{
 const source=page([business,LABELLED]),plain={...snapshot([source],{captured:[]}),permitted_urls:[source.url]};
 expect(preparedPhoneSource(plain,now)).toBeNull();
 expect(projectManualPhone(plain,now)).toMatchObject({state:'not_extracted',reason:'original_not_usable'});
 const truncated=snapshot([page([business,LABELLED],{truncated:true})],{captured:[]});
 expect(projectManualPhone(truncated,now)).toMatchObject({state:'not_extracted',reason:'original_not_usable'});
});

const auxiliaryUrl='https://www.capture.example.test/team';
const auxiliaryAt=now+60_000;
it('bounds a page admitted through an exact retained grant by that grant deadline, not the seven-day horizon',()=>{
 const own=page([business]),aux=page([LABELLED],{url:auxiliaryUrl}),choice=locate(aux,LABELLED,'(614) 725-3059','Office phone');
 const current=snapshot([own,aux],{captured:[own],permitted:[aux.url],granted:[aux],deadlines:{[aux.url]:auxiliaryAt}});
 const source=preparedPhoneSource(current,now);
 expect(source?.authorities[aux.id]).toMatchObject({kind:'prepared_capture',expiresAt:new Date(auxiliaryAt).toISOString()});
 expect(projectManualPhone(current,now)).toMatchObject({state:'observed',value:'+16147253059'});
 expect(projectPreparedPhoneChoice(current,choice,now)?.expiresAt).toBe(new Date(auxiliaryAt).toISOString());
 expect(projectPreparedPhoneChoice(current,choice,auxiliaryAt)).toBeNull();
 expect(projectManualPhone(current,auxiliaryAt)).not.toMatchObject({state:'observed'});
 // Without the deadline the same page would live for the horizon: it is the deadline that bounds it.
 const unbounded=snapshot([own,aux],{captured:[own],permitted:[aux.url],granted:[aux]});
 expect(projectPreparedPhoneChoice(unbounded,choice,now)?.expiresAt).toBe(new Date(Date.parse(aux.retrievedAt)+PREPARED_PHONE_HORIZON_MS).toISOString());
});
it('never reads a snapshot that was not decorated with the shared source deadlines',()=>{
 const source=page([business,LABELLED]),current=snapshot([source]);
 delete current['prepared_source_deadlines'];
 expect(preparedPhoneSource(current,now)).toBeNull();
 expect(projectPreparedPhoneChoice(current,locate(source,LABELLED,'(614) 725-3059','Office phone'),now)).toBeNull();
});
it.each([
 ['412-685-3970 24hr@company.test','412-685-3970','412-685-3970'],
 ['📞 412-685-3970 24hr@company.test','412-685-3970','📞'],
])('offers and then saves a standalone number with an email tail whose local part starts with digits: %s',(text,literal,label)=>{
 const source=page([business,text]),current=snapshot([source]);
 expect(projectManualPhone(current,now)).toMatchObject({state:'observed',value:'+14126853970'});
 expect(projectPreparedPhoneChoice(current,locate(source,text,literal,label),now)).toMatchObject({value:'+14126853970'});
});
it.each([['412-685-3970 ext 5 24hr@company.test'],['412-685-3970-HOME 24hr@company.test'],['412-685-3970 24hr@company.test 412-685-3971']])('still refuses standalone extension, vanity or second-number blocks: %s',text=>{
 const source=page([business,text]),current=snapshot([source]);
 expect(projectManualPhone(current,now).state).not.toBe('observed');
 expect(projectPreparedPhoneChoice(current,locate(source,text,'412-685-3970','412-685-3970'),now)).toBeNull();
});
// Hosted RL shape (Nov 1): the brief is callable from the candidate's own source URL, admitted by its exact grant
// with NO prepared capture manifest, and the page is incomplete. Calling's phone read must take the same pages.
function ownSourcePage(blocks:string[],extra:Partial<SourceObservation>={}){
 const source=page(blocks,{url:website,truncated:true,...extra});
 const current:ManualPhoneSnapshot={...snapshot([source],{captured:[],permitted:[website]}),payload:{firmName:'Capture Property Management',website,sourceUrl:website,locality:'Columbus',region:'OH',signal:'fit_only',evidence:'Fictional',observedOn:'2026-10-30',preparedBy:'Fixture'}};
 return {source,current};
}
const briefOf=(current:ManualPhoneSnapshot)=>projectPreparedProspect({id:candidateId,revision:1,payload:current.payload as CandidateInput,origins:[],created_at:new Date(now-2000),manual_state:'new',duplicate_count:0} satisfies ManualProspectRow,current,{id:runId,candidate_revision:1},now);
it('reads a callable brief\'s phone from an incomplete own-source page admitted by exact grant without any capture manifest',()=>{
 const blocks=[business,'(614) 725-3059 info@capture.example.test',...Array.from({length:80},(_,index)=>`Filler passage number ${index} about nothing in particular.`),'(614) 725-3059'];
 const {source,current}=ownSourcePage(blocks);
 expect(current['prepared_capture']).toBeNull();
 expect(briefOf(current)).toMatchObject({callable:{state:'callable',phone:'(614) 725-3059'},coverage:'partial_retained_pages'});
 // The unchanged exact path refuses an incomplete page; the brief-equivalent read does not.
 expect(preparedPhoneSource(current,now)?.authorities[source.id]).toMatchObject({kind:'prepared_capture',sourceUrl:website});
 const evidence=projectManualPhone(current,now);
 expect(evidence).toMatchObject({state:'observed',value:'+16147253059',coverage:{state:'partial'}});
 if(evidence.state!=='observed')throw Error('expected observed');
 expect(evidence.sources).toHaveLength(2);
 expect(evidence.sources.every(item=>'method' in item&&item.authority.kind==='prepared_capture')).toBe(true);
 const standaloneChoice=locate(source,'(614) 725-3059','(614) 725-3059'),emailChoice=locate(source,'(614) 725-3059 info@capture.example.test','(614) 725-3059');
 expect(projectPreparedPhoneChoice(current,standaloneChoice,now)).toMatchObject({value:'+16147253059',sourceUrl:website});
 expect(projectPreparedPhoneChoice(current,emailChoice,now)).toMatchObject({value:'+16147253059'});
});
it('keeps an ungranted or other-host page out of the grant-admitted read, and a lost grant offers nothing',()=>{
 const {source,current}=ownSourcePage([business,LABELLED]);
 expect(projectManualPhone({...current,permitted_urls:[]},now)).toMatchObject({state:'not_extracted',reason:'original_not_usable'});
 expect(projectPreparedPhoneChoice({...current,permitted_urls:[]},locate(source,LABELLED,'(614) 725-3059','Office phone'),now)).toBeNull();
 expect(projectManualPhone({...current,prepared_source_deadlines:{[website]:now}},now)).toMatchObject({state:'not_extracted'});
});
