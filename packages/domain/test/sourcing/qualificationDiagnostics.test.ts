import {expect,it} from 'vitest';
import {normalizeQualificationDiagnostic as normalize,QUALIFICATION_DIAGNOSTIC_PHASES} from '../../sourcing/qualificationDiagnostics.ts';
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
