import {expect,it} from 'vitest';
import {preparedProspectBriefSchema,preparedProspectCallableSchema,preparedProspectListInputSchema,preparedProspectSummarySchema} from '../src/preparedProspects.ts';

const at='2026-10-31T12:00:00.000Z',id='10000000-0000-4000-8000-000000000001';
const callable={state:'callable',missing:[],phone:'(804) 555-0142',person:'Jordan Reyes, Owner',residential:true} as const;
const summary={target:{candidateId:id,candidateRevision:1,runId:id},displayName:'Peak Property Management',discoveryLabel:'Peak Property Management',website:'https://peak.example.test/',
 targetingLocality:'Richmond',targetingRegion:'VA',state:'prepared',summary:'Retained own-site context.',unknowns:[],validUntil:null,callable,companyHost:'peak.example.test'};
const detail={checkedAt:at,nextAction:'Research the appropriate Person.',contactAuthority:'not_granted',passages:[],coverage:'complete_retained_pages'};

it('parses a closed callable assessment and refuses inconsistent or open states',()=>{
 expect(preparedProspectCallableSchema.parse(callable)).toEqual(callable);
 expect(preparedProspectCallableSchema.parse({state:'not_callable',missing:['needs_research','list_page'],phone:null,person:null,residential:false}).missing).toEqual(['needs_research','list_page']);
 expect(preparedProspectCallableSchema.parse({state:'not_callable',missing:['not_company_page'],phone:'(804) 555-0142',person:null,residential:false}).missing).toEqual(['not_company_page']);
 for(const value of [{...callable,phone:null},{...callable,missing:['list_page']},{...callable,state:'not_callable'},{...callable,missing:['list_page','list_page'],state:'not_callable'},
  {...callable,missing:['permission_granted'],state:'not_callable'},{...callable,contactAuthority:'granted'},{...callable,person:'x'.repeat(201)}])
  expect(preparedProspectCallableSchema.safeParse(value).success).toBe(false);
});

it('requires callable and companyHost on summaries and current briefs while V1 briefs stay readable without them',()=>{
 expect(preparedProspectSummarySchema.parse(summary)).toMatchObject({callable,companyHost:'peak.example.test'});
 expect(preparedProspectSummarySchema.parse({...summary,website:null,companyHost:null}).companyHost).toBeNull();
 for(const host of ['Peak.example.test','peak example.test',''])expect(preparedProspectSummarySchema.safeParse({...summary,companyHost:host}).success).toBe(false);
 const {callable:_callable,companyHost:_companyHost,...legacySummary}=summary,{callable:_omitted,...withoutCallable}=summary;
 expect(preparedProspectSummarySchema.safeParse(withoutCallable).success).toBe(false);
 expect(preparedProspectSummarySchema.safeParse(legacySummary).success).toBe(false);
 expect(preparedProspectBriefSchema.parse({...summary,...detail,policyVersion:'prepared-prospect-v2'})).toMatchObject({callable,companyHost:'peak.example.test',contactAuthority:'not_granted'});
 expect(preparedProspectBriefSchema.safeParse({...withoutCallable,...detail,policyVersion:'prepared-prospect-v2'}).success).toBe(false);
 expect(preparedProspectBriefSchema.safeParse({...legacySummary,...detail,policyVersion:'prepared-prospect-v1'}).success).toBe(true);
 expect(preparedProspectBriefSchema.safeParse({...summary,...detail,policyVersion:'prepared-prospect-v1'}).success).toBe(false);
});

it('defaults list order to priority and accepts only the closed newest order with the same continuation rule',()=>{
 expect(preparedProspectListInputSchema.parse({offset:0})).toEqual({offset:0,order:'priority'});
 expect(preparedProspectListInputSchema.parse({offset:50,viewRevision:'a'.repeat(64),order:'newest'})).toEqual({offset:50,viewRevision:'a'.repeat(64),order:'newest'});
 expect(preparedProspectListInputSchema.safeParse({offset:50,order:'newest'}).success).toBe(false);
 expect(preparedProspectListInputSchema.safeParse({offset:0,order:'callable'}).success).toBe(false);
});
