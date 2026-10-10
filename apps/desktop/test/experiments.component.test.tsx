// @vitest-environment jsdom
import {cleanup,render,screen,fireEvent} from '@testing-library/react';
import {afterEach,expect,it} from 'vitest';
import {Experiments} from '../src/renderer/sourcing/Experiments.tsx';
afterEach(cleanup);
it('reviews a suggestion without activating and shows unavailable denominators',async()=>{
 let saved=false,activated=false;
 render(<Experiments proposal={{change:{kind:'discovery_query',basePolicyVersion:'v1',queryId:'dfw',query:'Dallas residential property management'},interval:{from:'2026-10-01T00:00:00Z',to:'2026-10-09T00:00:00Z',asOf:'2026-10-09T00:00:00Z'},rationale:'Explore maintenance work.',counterexamples:['No contacted cohort yet.'],uncertainty:'Limited evidence.',successMeasures:['Supported prospects per retained URL.']}} save={async()=>{saved=true;return {id:'proposal',revision:1};}} activate={async()=>{activated=true;}}/ >);
 expect(screen.getByText(/Raw provider results and duplicates: unavailable/)).toBeTruthy();
 fireEvent.change(screen.getByLabelText('Reason for experiment'),{target:{value:'Edited after reviewing uncertainty.'}});
 fireEvent.click(screen.getByRole('button',{name:'Accept proposal'}));
 expect(await screen.findByText(/Proposal saved; no live changes/)).toBeTruthy();expect(saved).toBe(true);expect(activated).toBe(false);
 expect(screen.getByRole('button',{name:'Activate reviewed query experiment'}).hasAttribute('disabled')).toBe(true);
});
const suggestion={change:{kind:'discovery_query' as const,basePolicyVersion:'v1',queryId:'dfw',query:'Dallas residential property management'},interval:{from:'2026-10-01T00:00:00Z',to:'2026-10-09T00:00:00Z',asOf:'2026-10-09T00:00:00Z'},rationale:'Explore maintenance work.',counterexamples:['No contacted cohort yet.'],uncertainty:'Limited evidence.',successMeasures:['Supported prospects per retained URL.']};
it('keeps a definite save receipt when history is unavailable and retries unknown actions with the same command identity',async()=>{
 const ids:string[]=[];let attempt=0;
 render(<Experiments proposal={suggestion} read={async()=>{throw new Error('offline');}} save={async input=>{ids.push(input.commandId);if(attempt++===0)throw new Error('transport unknown');return {id:'saved',revision:1};}} activate={async()=>{throw new Error('must not activate');}}/>);
 expect((await screen.findByRole('alert')).textContent).toContain('Reviewed history is unavailable');
 fireEvent.click(screen.getByRole('button',{name:'Accept proposal'}));
 fireEvent.click(await screen.findByRole('button',{name:'Retry same experiment action'}));
 expect(await screen.findByText('Proposal saved; no live changes.')).toBeTruthy();expect(ids).toHaveLength(2);expect(ids[0]).toBe(ids[1]);
 expect(screen.getByRole('alert').textContent).toContain('Reviewed history is unavailable');
});
import {ExperimentsWorkspace} from '../src/renderer/sourcing/ExperimentsWorkspace.tsx';
it('prepares a bounded human suggestion from the current query and attributed interval without applying it',async()=>{
 let applied=false;
 render(<ExperimentsWorkspace report={{from:suggestion.interval.from,to:suggestion.interval.to,asOf:suggestion.interval.asOf,cohorts:[],maturity:[],firms:[],coverage:{candidates:0,qualified:0,admitted:0,unavailable:0},search:{attempts:0,creditsReserved:0}}} catalog={{policy:{version:'v1',queries:[{id:'dfw',query:'Dallas residential property management',locality:'Dallas',region:'TX'}],rankOrder:['help_request','operational_burden','investigation','fit_only']},templates:[],sequences:[]}} ports={{save:async()=>({id:'saved',revision:1}),activate:async()=>{applied=true;}}}/>);
 fireEvent.change(screen.getByLabelText('Existing approved scope'),{target:{value:'dfw'}});
 fireEvent.click(screen.getByRole('button',{name:'Prepare suggestion for review'}));
 expect(screen.getByLabelText('Proposed query')).toHaveProperty('value','Dallas residential property management');
 expect(screen.getByText(/current accepted facts through 2026-10-09/)).toBeTruthy();expect(applied).toBe(false);
});
import {DraftsProvider} from '../src/renderer/app/drafts.tsx';
it('does not surface a late mutation receipt or retained draft after the signed-in session changes',async()=>{
 let resolve:(value:{id:string;revision:number})=>void=()=>{};
 const save=()=>new Promise<{id:string;revision:number}>(r=>{resolve=r;});
 const {rerender}=render(<DraftsProvider key="first"><Experiments proposal={suggestion} save={save} activate={async()=>{}}/></DraftsProvider>);
 fireEvent.change(screen.getByLabelText('Reason for experiment'),{target:{value:'Previous workspace draft.'}});
 fireEvent.click(screen.getByRole('button',{name:'Accept proposal'}));
 rerender(<DraftsProvider key="second"><Experiments proposal={{...suggestion,rationale:'Current workspace proposal.'}} save={async()=>({id:'new',revision:1})} activate={async()=>{}}/></DraftsProvider>);
 resolve({id:'old',revision:1});await Promise.resolve();
 expect(screen.getByLabelText('Reason for experiment')).toHaveProperty('value','Current workspace proposal.');
 expect(screen.queryByText('Proposal saved; no live changes.')).toBeNull();
});
import type {ExperimentView} from '@fss/contracts';
it('stops explicitly before erasure, shows versioned results, and clears erased editor text',async()=>{
 const id='11111111-1111-4111-8111-111111111111';
 let view:ExperimentView={id,revision:1,status:'accepted',coverage:{proposalsTruncated:false,versionsTruncated:false,activationsTruncated:false},report:{...suggestion.interval,cohorts:[],maturity:[],coverage:{candidates:0,qualified:0,admitted:0,unavailable:0},search:{attempts:0,creditsReserved:0},discovery:{retainedHits:0,supportedProspects:0,admissions:0,manualStaged:1,unavailable:0},cutoffSemantics:'current_accepted_facts_through_cutoff',rawProviderResults:null,duplicates:null},versions:[],activations:[{activationId:id,revision:1,result:{kind:'discovery_query',basePolicyVersion:'v1',policyVersion:'v2',queryId:'dfw'},startedAt:suggestion.interval.asOf,stoppedAt:null,stopReason:null,outcomes:{semantics:'exact_policy_query_attempts_only',attempts:2,retainedUniqueUrls:1,rawProviderResults:null,duplicates:null,supportedProspects:null,conversionDenominator:null}}]};
 if(!view.report)throw new Error('fixture report');view.versions=[{revision:1,content:suggestion,report:view.report,createdAt:suggestion.interval.asOf}];
 render(<Experiments proposal={suggestion} read={async()=>[view]} save={async()=>({id,revision:1})} activate={async()=>{}} stop={async input=>{expect(input.activationId).toBe(id);view={...view,activations:view.activations.map(a=>({...a,stoppedAt:suggestion.interval.asOf,stopReason:input.reason,result:{...a.result,rollbackDisposition:'restored'}}))};}} erase={async()=>{view={...view,status:'erased',versions:[],report:null};}}/>);
 expect(await screen.findByText(/2 attempts · 1 retained URLs/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Edit reviewed proposal'}));
 expect(screen.getByRole('button',{name:'Erase proposal evidence'}).hasAttribute('disabled')).toBe(true);
 fireEvent.change(screen.getByLabelText('Reason to stop'),{target:{value:'Insufficient evidence; stop.'}});
 fireEvent.click(screen.getByRole('button',{name:'Stop experiment'}));
 expect(await screen.findByText('Rollback: Previous query policy restored')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Erase proposal evidence'}));
 expect(await screen.findByText('Proposal evidence erased.')).toBeTruthy();
 expect(screen.getByLabelText('Reason for experiment')).toHaveProperty('value','');
 expect(screen.queryByText('Reviewed version 1: Explore maintenance work.')).toBeNull();
});
it('freezes exact proposal review while save is pending and while its result remains unknown',async()=>{
 let resolve:(value:{id:string;revision:number})=>void=()=>{};let attempts=0;
 const save=async()=>{if(attempts++===0)throw new Error('unknown');return new Promise<{id:string;revision:number}>(r=>{resolve=r;});};
 render(<Experiments proposal={suggestion} save={save} activate={async()=>{}}/>);
 fireEvent.click(screen.getByRole('button',{name:'Accept proposal'}));
 await screen.findByRole('button',{name:'Retry same experiment action'});
 expect(screen.getByLabelText('Reason for experiment').hasAttribute('disabled')).toBe(true);
 expect(screen.getByLabelText('Proposed query').hasAttribute('disabled')).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Retry same experiment action'}));
 expect(screen.getByLabelText('Proposed query').hasAttribute('disabled')).toBe(true);
 resolve({id:'saved',revision:1});await screen.findByText('Proposal saved; no live changes.');
 expect(screen.getByLabelText('Proposed query').hasAttribute('disabled')).toBe(false);
});
it('freezes approval and copy controls during an uncertain activation',async()=>{
 render(<Experiments proposal={{...suggestion,change:{kind:'email_wording',baseTemplateVersionId:'base',subject:'Original subject',body:'Original body'}}} approvedSequences={[{id:'sequence',label:'Approved copy'}]} save={async()=>({id:'saved',revision:1})} activate={async()=>{throw new Error('unknown');}}/>);
 fireEvent.click(screen.getByRole('button',{name:'Accept proposal'}));await screen.findByText('Proposal saved; no live changes.');
 fireEvent.change(screen.getByLabelText('Separately approved sequence'),{target:{value:'sequence'}});
 fireEvent.click(screen.getByRole('button',{name:'Activate reviewed email experiment'}));await screen.findByRole('button',{name:'Retry same experiment action'});
 for(const label of ['Proposed subject','Proposed email','Separately approved sequence','Reason to stop'])expect(screen.getByLabelText(label).hasAttribute('disabled')).toBe(true);
});
