import {expect,it} from 'vitest';
import {normalizeQualificationDiagnostic as normalize,QUALIFICATION_DIAGNOSTIC_PHASES} from '../../sourcing/qualificationDiagnostics.ts';
import {normalizeQualificationExtractionDiagnostic as extraction} from '../../sourcing/qualificationDiagnostics.ts';
import type {SourceObservation} from '@fss/contracts';
const valid=()=>({version:'qualification-diagnostic-v1',phase:'no_observations',fetchedPages:0,observations:0,completeFirstParty:0,truncatedObservations:0,skipped:{}});
it.each(QUALIFICATION_DIAGNOSTIC_PHASES)('accepts only the fixed phase %s',phase=>{
 expect(normalize({...valid(),phase})).toEqual({...valid(),phase});
});
it('reconstructs the whitelist and buckets only bounded numeric HTTP statuses',()=>{
 const raw={...valid(),url:'private',error:'private',skipped:{status_403:2,status_418:3,status_599:1,status_other:4,request_failed:10000,robots_disallowed:-1,paused:1.5,firm_timeout:Infinity,status_999:9,'private URL':7}};
 Object.defineProperty(raw.skipped,'unknownGetter',{get(){throw Error('must not read');}});
 expect(normalize(raw)).toEqual({...valid(),skipped:{status_403:2,status_other:8,request_failed:10000}});
 expect(normalize({...valid(),skipped:{status_418:10000,status_419:1}})?.skipped).toEqual({});
});
it.each([NaN,Infinity,-1,1.1,9,Number.MAX_SAFE_INTEGER])('omits invalid capture count %s',count=>{
 expect(normalize({...valid(),fetchedPages:count})).toBeUndefined();
});
it('represents configuration ceiling eight without raising or clamping research limits',()=>{
 expect(normalize({...valid(),fetchedPages:8,observations:8,completeFirstParty:7,truncatedObservations:1})).toBeDefined();
 expect(normalize({...valid(),fetchedPages:8,observations:9})).toBeUndefined();
 expect(normalize({...valid(),fetchedPages:1,observations:2})).toBeUndefined();
 expect(normalize({...valid(),fetchedPages:1,observations:1,completeFirstParty:1,truncatedObservations:1})).toBeUndefined();
});
it('omits malformed or hostile diagnostics instead of interfering with finishing',()=>{
 for(const raw of [null,[],{...valid(),version:'other'},{...valid(),phase:'https://private.test'},{...valid(),skipped:[]}])expect(normalize(raw)).toBeUndefined();
 expect(normalize(Object.defineProperty(valid(),'phase',{get(){throw Error('private');}}))).toBeUndefined();
 expect(normalize({...valid(),skipped:Object.defineProperty({},'paused',{get(){throw Error('private');}})})).toBeUndefined();
});
const offered:SourceObservation={id:'11111111-1111-4111-8111-111111111111',url:'https://example.test/',contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:'2026-10-20T00:00:00Z',publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[{id:'b1',text:'Private source text'}]};
it('reconstructs extraction enums and only existing offered references, never raw payload or paths',()=>{
 const expected={stage:'selection',code:'block_missing',selectionIndex:0,selectionCount:30,observationId:offered.id,blockId:'b1',schemaField:'blockId',stopReason:'max_tokens'};
 const raw={...expected,payload:'private',value:'private',message:'private',schemaPath:['private'],arbitrary:{text:'private'}};
 Object.defineProperty(raw,'unknownGetter',{get(){throw Error('must not read');}});
 expect(extraction(raw,[offered])).toEqual(expected);
 expect(extraction({...raw,observationId:'22222222-2222-4222-8222-222222222222'},[offered])).toEqual({...expected,observationId:undefined,blockId:undefined});
 expect(extraction({...raw,blockId:'unknown private reference'},[offered])).toEqual({...expected,blockId:undefined});
 expect(extraction(raw)).not.toHaveProperty('observationId');
 expect(normalize({...valid(),phase:'extraction_rejected',extraction:raw},[offered])?.extraction).toEqual(expected);
 expect(normalize({...valid(),extraction:raw},[offered])).not.toHaveProperty('extraction');
});
it.each([NaN,Infinity,-1,1.1,30,Number.MAX_SAFE_INTEGER])('drops an invalid selection index %s without changing the failure metadata',selectionIndex=>{
 expect(extraction({stage:'schema',code:'schema_invalid',selectionIndex})).toEqual({stage:'schema',code:'schema_invalid'});
});
it('bounds counts without clamping overflow and drops unknown enum strings and invalid stage/code pairs',()=>{
 for(const selectionCount of [-1,1.5,31,Infinity])expect(extraction({stage:'schema',code:'schema_over_bound',selectionCount})).toEqual({stage:'schema',code:'schema_over_bound'});
 for(const selectionCount of [0,30])expect(extraction({stage:'schema',code:'schema_over_bound',selectionCount})?.selectionCount).toBe(selectionCount);
 expect(extraction({stage:'schema',code:'schema_invalid',selectionIndex:29,schemaField:'private.path',stopReason:'private provider text'})).toEqual({stage:'schema',code:'schema_invalid',selectionIndex:29});
 for(const raw of [{stage:'private',code:'schema_invalid'},{stage:'json',code:'schema_invalid'},{stage:'schema',code:'private'},null,[]])expect(extraction(raw)).toBeUndefined();
 expect(extraction(Object.defineProperty({stage:'schema',code:'schema_invalid'},'selectionIndex',{get(){throw Error('private');}}))).toBeUndefined();
 expect(normalize({...valid(),phase:'extraction_rejected',extraction:{stage:'private',code:'private'}})).toEqual({...valid(),phase:'extraction_rejected'});
});
