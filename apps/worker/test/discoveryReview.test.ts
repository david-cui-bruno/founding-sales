import {expect,it} from 'vitest';
import {buildDiscoveryReview,qualifyDiscovery,reviewEvaluation} from '../src/sourcing/discoveryReview.ts';
const evidence={geography:'confirmed',residentialManager:'confirmed',crmMatch:'new',need:'active_vacancy',sourceUrl:'https://pm.example/jobs/1',checkedOn:'2026-10-05',current:true} as const;
it('search text cannot establish qualification, and same-host results retain all provenance',()=>{
 const review=buildDiscoveryReview([{queryId:'a',url:'https://www.pm.example/about',title:'Overwhelmed and hiring',snippet:'maintenance coordinator'}, {queryId:'b',url:'https://pm.example/about',title:'PM',snippet:'same firm'}, {queryId:'c',url:'https://branch.pm.example/',title:'Branch',snippet:''}]);
 expect(review).toHaveLength(2);expect(review[0]?.hits).toHaveLength(2);expect(review[0]?.decision).toBe('needs_review');
});
it('blocks wrong fit and existing CRM matches even with hiring evidence',()=>{
 expect(qualifyDiscovery({...evidence,geography:'rejected'})).toBe('exclude');
 expect(qualifyDiscovery({...evidence,residentialManager:'rejected'})).toBe('exclude');
 expect(qualifyDiscovery({...evidence,crmMatch:'existing'})).toBe('existing_firm');
});
it('generic careers, marketing and existing support never establish unmet need',()=>{
 for(const need of ['generic_careers','marketing','existing_support','unknown'] as const)expect(qualifyDiscovery({...evidence,need})).toBe('fit_only');
});
it('requires reviewed fit, dated source and current vacancy before signal qualification',()=>{
 expect(qualifyDiscovery(evidence)).toBe('signal_supported');
 for(const patch of [{geography:'unknown' as const},{crmMatch:'unknown' as const},{sourceUrl:''},{checkedOn:'bad'},{current:false}])expect(qualifyDiscovery({...evidence,...patch})).toBe('needs_review');
});

it('carries immutable attempt references into grouped review hits',()=>{
 const groups=reviewEvaluation({provider:'tavily',stopReason:null,results:[{attemptId:'attempt-1',queryId:'query-v2',query:'Rhode Island PM',cohort:'fit_only',observedAt:'2026-10-05T12:00:00Z',result:{ok:true,credits:1,requestId:'provider-request',hits:[{url:'https://pm.example/',title:'PM',snippet:'text'}]}}]});
 expect(groups[0]?.hits[0]).toMatchObject({attemptId:'attempt-1',provider:'tavily',requestId:'provider-request',observedAt:'2026-10-05T12:00:00Z',query:'Rhode Island PM',cohort:'fit_only'});
});
