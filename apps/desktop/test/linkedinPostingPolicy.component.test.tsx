/** @vitest-environment jsdom */
import {afterEach,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react';
import {LINKEDIN_POSTING_RULES,type LinkedinPostingPolicyView} from '@fss/contracts';
import {LinkedinPostingPolicy} from '../src/renderer/social/LinkedinPostingPolicy.tsx';
import {LinkedinPostingCandidate} from '../src/renderer/social/LinkedinPostingCandidate.tsx';
import {createAuthedClient} from '../src/main/authedClient.ts';
import {linkedinPostingPolicyOperations} from '../src/main/social/linkedinPostingPolicyOperations.ts';
import {OPERATIONS} from '../src/shared/operations.ts';
const id='11111111-1111-4111-8111-111111111111';
afterEach(cleanup);
const initial:LinkedinPostingPolicyView={accounts:[{id,externalId:'david-cui-589a20228',displayName:'David Cui',revision:3,state:'connected'}],revision:0,state:'not_saved',enabled:false,technicallyReady:false,policy:null,rules:LINKEDIN_POSTING_RULES,holds:['policy_not_saved'],history:[],candidates:[]};
it('owner saves the disclosed scope then revises and revokes it without seeing Enable or optimistic readiness',async()=>{
 let view=initial;
 const save=vi.fn(async input=>{view={...view,revision:view.revision+1,state:'saved',policy:{accountId:input.accountId,accountRevision:input.accountRevision,accountExternalId:'david-cui-589a20228',generation:input.generation,rules:LINKEDIN_POSTING_RULES},holds:['runtime_acceptance_pending','publication_not_enabled']};return {view,reason:null};});
 const stop=vi.fn(async()=>{view={...view,revision:view.revision+1,state:'revoked',holds:['policy_revoked','publication_not_enabled']};return {view,reason:null};});
 render(<LinkedinPostingPolicy ports={{read:async()=>({view,reason:null}),save,stop}}/>);
 await screen.findByRole('button',{name:'Save standing posting policy'});
 expect(screen.getByText(/Tuesday and Thursday at 10AM America\/New_York/)).toBeTruthy();
 expect(screen.getByText(/\$1 per New York calendar day/)).toBeTruthy();
 expect(screen.queryByRole('button',{name:/Enable/i})).toBeNull();
 fireEvent.click(screen.getByRole('checkbox',{name:/I approve this exact posting scope/}));
 fireEvent.click(screen.getByRole('button',{name:'Save standing posting policy'}));
 await screen.findByText('Saved policy revision 1. Publication is not enabled.');
 expect(save).toHaveBeenCalledWith(expect.objectContaining({accountId:id,accountRevision:3,expectedRevision:0,approvedRulesVersion:'608-2026-10-13',generation:null}));
 fireEvent.click(screen.getByRole('checkbox',{name:/I approve this exact posting scope/}));
 fireEvent.click(screen.getByRole('button',{name:'Save revised posting policy'}));
 await screen.findByText('Saved policy revision 2. Publication is not enabled.');
 fireEvent.click(screen.getByRole('button',{name:'Revoke posting policy'}));
 await screen.findByText('Revoked policy revision 3. Publication is not enabled.');
 expect(stop).toHaveBeenCalledWith('revoked',expect.objectContaining({expectedRevision:2}));
});
it('stale settings refusal is visible and does not optimistically update the policy',async()=>{
 const saved={...initial,revision:1,state:'saved' as const,policy:{accountId:id,accountRevision:3,accountExternalId:'david-cui-589a20228',generation:null,rules:LINKEDIN_POSTING_RULES}};
 render(<LinkedinPostingPolicy ports={{read:async()=>({view:saved,reason:null}),save:async()=>({view:null,reason:'stale_revision'}),stop:async()=>({view:null,reason:'stale_revision'})}}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Revoke posting policy'}));
 await waitFor(()=>expect(screen.getByRole('status').textContent).toContain('changed elsewhere'));
 expect(screen.getByText('Saved policy revision 1. Publication is not enabled.')).toBeTruthy();
});
it('owner stages a manually approved post against read current policy and sees stale refusal instead of success',async()=>{
 const view={...initial,revision:2,state:'saved' as const};
 const bind=vi.fn(async()=>({binding:null,reason:'stale_revision'}));
 render(<LinkedinPostingCandidate postId={id} postRevision={4} ports={{read:async()=>({view,reason:null}),bind}}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Bind approved post to posting policy'}));
 await screen.findByText(/Binding refused: stale revision/);
 expect(bind).toHaveBeenCalledWith({postId:id,postRevision:4,expectedRevision:2,commandId:expect.any(String)});
 expect(screen.queryByText(/Owner-staged policy binding revision/)).toBeNull();
});
it('confirmed command with unavailable current readback clears stale saved scope and offers refresh not command replay',async()=>{
 const saved={...initial,revision:1,state:'saved' as const};
 render(<LinkedinPostingPolicy ports={{read:async()=>({view:saved,reason:null}),save:async()=>({view:null,reason:'current_read_unavailable'}),stop:async()=>({view:null,reason:'current_read_unavailable'})}}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Revoke posting policy'}));
 await screen.findByText(/Current posting policy is unavailable/);
 expect(screen.queryByText('Saved policy revision 1. Publication is not enabled.')).toBeNull();
 expect(screen.queryByRole('button',{name:'Retry same policy change'})).toBeNull();
 expect(screen.getByRole('button',{name:'Refresh posting policy'})).toBeTruthy();
});
it('visible same-command retry reads current revoked scope rather than lost-save receipt',async()=>{
 const saved:LinkedinPostingPolicyView={...initial,revision:1,state:'saved',policy:{accountId:id,accountRevision:3,accountExternalId:'david-cui-589a20228',generation:null,rules:LINKEDIN_POSTING_RULES}};
 let current=initial,lose=true;const commands:string[]=[];
 const host=linkedinPostingPolicyOperations({api:createAuthedClient({baseUrl:'https://fixture.invalid',clientVersion:'1.0.0',accessToken:async()=>({token:'controlled',generation:0}),send:async(url,init)=>{
  if(new URL(url).pathname.endsWith('/read'))return {status:200,body:current};
  commands.push(JSON.parse(init.body??'{}').commandId);
  if(lose){lose=false;current=saved;throw new Error('Committed save response lost');}
  return {status:200,body:{status:'accepted',replayed:true,result:saved}};
 }}),generation:()=>0});
 render(<LinkedinPostingPolicy ports={{read:host['social.postingPolicy'],save:host['social.savePostingPolicy'],stop:(state,input)=>host[state==='revoked'?'social.revokePostingPolicy':'social.disablePostingPolicy'](input)}}/>);
 await screen.findByRole('button',{name:'Save standing posting policy'});
 fireEvent.click(screen.getByRole('checkbox',{name:/I approve this exact posting scope/}));
 fireEvent.click(screen.getByRole('button',{name:'Save standing posting policy'}));
 await screen.findByRole('button',{name:'Retry same policy change'});
 current={...saved,revision:2,state:'revoked',holds:['policy_revoked','publication_not_enabled']};
 fireEvent.click(screen.getByRole('button',{name:'Retry same policy change'}));
 await screen.findByText('Revoked policy revision 2. Publication is not enabled.');
 expect(screen.getByText('policy revoked')).toBeTruthy();
 expect(screen.queryByText('Saved policy revision 1. Publication is not enabled.')).toBeNull();
 expect(commands).toHaveLength(2);expect(commands[1]).toBe(commands[0]);
});
it('visible same-binding retry shows the current revoked pause instead of its original receipt',async()=>{
 const saved:LinkedinPostingPolicyView={...initial,revision:1,state:'saved',policy:{accountId:id,accountRevision:3,accountExternalId:'david-cui-589a20228',generation:null,rules:LINKEDIN_POSTING_RULES}};
 let current=saved,lose=true;const commands:string[]=[];
 const receipt={postId:id,postRevision:4,policyRevision:1,current:true,publicationReady:false};
 const host=linkedinPostingPolicyOperations({api:createAuthedClient({baseUrl:'https://fixture.invalid',clientVersion:'1.0.0',accessToken:async()=>({token:'controlled',generation:0}),send:async(url,init)=>{
  if(new URL(url).pathname.endsWith('/read'))return {status:200,body:current};
  commands.push(JSON.parse(init.body??'{}').commandId);
  if(lose){lose=false;throw new Error('Committed binding response lost');}
  return {status:200,body:{status:'accepted',replayed:true,result:receipt}};
 }}),generation:()=>0});
 render(<LinkedinPostingCandidate postId={id} postRevision={4} ports={{read:host['social.postingPolicy'],bind:async input=>OPERATIONS['social.bindPostingCandidate'].output.parse(await host['social.bindPostingCandidate'](input))}}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Bind approved post to posting policy'}));
 await screen.findByRole('button',{name:'Retry same candidate binding'});
 current={...saved,revision:2,state:'revoked',holds:['policy_revoked','publication_not_enabled'],candidates:[{postId:id,postRevision:4,policyRevision:1,current:false,reason:'policy_revoked',submissionState:'pending'}]};
 fireEvent.click(screen.getByRole('button',{name:'Retry same candidate binding'}));
 await screen.findByText(/Paused: policy revoked/);
 expect(screen.getByText(/Owner-staged policy binding revision 1/)).toBeTruthy();
 expect(commands).toHaveLength(2);expect(commands[1]).toBe(commands[0]);
});
it('confirmed binding with unavailable current readback removes stale scope and offers refresh only',async()=>{
 const saved:LinkedinPostingPolicyView={...initial,revision:1,state:'saved'};
 let reads=0,failRead=true,current=saved;const commands:string[]=[];
 const host=linkedinPostingPolicyOperations({api:createAuthedClient({baseUrl:'https://fixture.invalid',clientVersion:'1.0.0',accessToken:async()=>({token:'controlled',generation:0}),send:async(url,init)=>{
  if(new URL(url).pathname.endsWith('/read')){if(++reads>1&&failRead)throw new Error('Current read unavailable');return {status:200,body:current};}
  commands.push(JSON.parse(init.body??'{}').commandId);
  return {status:200,body:{status:'accepted',replayed:false,result:{postId:id,postRevision:4,policyRevision:1,current:true,publicationReady:false}}};
 }}),generation:()=>0});
 render(<LinkedinPostingCandidate postId={id} postRevision={4} ports={{read:host['social.postingPolicy'],bind:host['social.bindPostingCandidate']}}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Bind approved post to posting policy'}));
 await screen.findByText(/Current candidate binding is unavailable/);
 expect(screen.queryByText(/Owner-staged policy binding revision/)).toBeNull();
 expect(screen.queryByRole('button',{name:'Retry same candidate binding'})).toBeNull();
 expect(screen.getByRole('button',{name:'Refresh posting policy'})).toBeTruthy();
 expect(commands).toHaveLength(1);
 failRead=false;current={...saved,revision:2,state:'revoked',holds:['policy_revoked'],candidates:[{postId:id,postRevision:4,policyRevision:1,current:false,reason:'policy_revoked',submissionState:'pending'}]};
 fireEvent.click(screen.getByRole('button',{name:'Refresh posting policy'}));
 await screen.findByText(/Paused: policy revoked/);
 expect(commands).toHaveLength(1);
});
it('binding current-read rejects an identity generation change after the receipt',async()=>{
 let generation=0;
 const current:LinkedinPostingPolicyView={...initial,revision:1,state:'saved',candidates:[{postId:id,postRevision:4,policyRevision:1,current:true,reason:'current_policy_not_dispatch_authority',submissionState:'pending'}]};
 const host=linkedinPostingPolicyOperations({api:createAuthedClient({baseUrl:'https://fixture.invalid',clientVersion:'1.0.0',accessToken:async()=>({token:'controlled',generation}),send:async(url)=>{
  if(new URL(url).pathname.endsWith('/read')){generation=1;return {status:200,body:current};}
  return {status:200,body:{status:'accepted',replayed:false,result:{postId:id,postRevision:4,policyRevision:1,current:true,publicationReady:false}}};
 }}),generation:()=>generation});
 expect(await host['social.bindPostingCandidate']({postId:id,postRevision:4,expectedRevision:1,commandId:crypto.randomUUID()})).toEqual({binding:null,reason:'session_changed'});
});
