import {useEffect,useRef,useState} from 'react';
import {LINKEDIN_POSTING_RULES,type LinkedinPostingPolicyView,type LinkedinPostingPolicySave} from '@fss/contracts';
import {operations} from '../app/bridges.ts';
import {useSessionEpoch} from '../app/drafts.tsx';
import {Button} from '../ui/button.tsx';
export interface LinkedinPostingPolicyPorts{read():Promise<{view:LinkedinPostingPolicyView|null;reason:string|null}>;save(input:LinkedinPostingPolicySave&{commandId:string}):Promise<{view:LinkedinPostingPolicyView|null;reason:string|null}>;stop(state:'disabled'|'revoked',input:{expectedRevision:number;commandId:string}):Promise<{view:LinkedinPostingPolicyView|null;reason:string|null}>}
const api=()=>{const a=operations();if(!a)throw new Error('unavailable');return a;};
const defaults:LinkedinPostingPolicyPorts={read:()=>api().read('social.postingPolicy',{}),save:input=>api().command('social.savePostingPolicy',input),stop:(state,input)=>api().command(state==='disabled'?'social.disablePostingPolicy':'social.revokePostingPolicy',input)};
type Pending={kind:'save';input:LinkedinPostingPolicySave&{commandId:string}}|{kind:'disabled'|'revoked';input:{expectedRevision:number;commandId:string}};
const label=(view:LinkedinPostingPolicyView)=>`${view.state==='not_saved'?'No saved':view.state==='saved'?'Saved':view.state==='disabled'?'Disabled':'Revoked'} policy revision ${view.revision}. Publication is not enabled.`;
export function LinkedinPostingPolicy({ports=defaults}:{ports?:LinkedinPostingPolicyPorts}){
 const epoch=useSessionEpoch(),live=useRef(0),port=useRef(ports);port.current=ports;
 const [view,setView]=useState<LinkedinPostingPolicyView|null>(null),[accountId,setAccountId]=useState(''),[approved,setApproved]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[pending,setPending]=useState<Pending|null>(null);
 const [configured,setConfigured]=useState(false),[routeVersion,setRouteVersion]=useState(''),[grantVersion,setGrantVersion]=useState(''),[dataVersion,setDataVersion]=useState('');
 const accept=(v:LinkedinPostingPolicyView)=>{setView(v);setAccountId(v.policy?.accountId??v.accounts.find(a=>a.externalId===LINKEDIN_POSTING_RULES.account)?.id??'');const g=v.policy?.generation;setConfigured(!!g);setRouteVersion(g?.routeVersion??'');setGrantVersion(g?.accessGrantVersion??'');setDataVersion(g?.dataHandlingVersion??'');setApproved(false);};
 useEffect(()=>{const g=++live.current;setView(null);setAccountId('');setPending(null);setApproved(false);setConfigured(false);setRouteVersion('');setGrantVersion('');setDataVersion('');setError(null);setBusy(false);void port.current.read().then(a=>{if(g!==live.current)return;if(a.view)accept(a.view);else setError('Posting settings are unavailable. No publication permission has changed.');}).catch(()=>{if(g===live.current)setError('Posting settings are unavailable.');});return()=>{live.current=g+1;};},[epoch]);
 const run=async(action:Pending)=>{
  if(busy)return;const g=live.current;setBusy(true);setPending(action);setError(null);
  try{const result=action.kind==='save'?await port.current.save(action.input):await port.current.stop(action.kind,action.input);if(g!==live.current)return;
   if(result.view){accept(result.view);setPending(null);}
   else if(result.reason==='current_read_unavailable'){setView(null);setAccountId('');setApproved(false);setPending(null);setError('The change was confirmed. Current posting policy is unavailable. Refresh before making another change.');}
   else if(['offline','unreadable_answer'].includes(result.reason??''))setError('The change is not confirmed. Retry the same request.');
   else{setPending(null);setError(result.reason==='stale_revision'?'The policy changed elsewhere. Refresh and review it before trying again.':`The change was refused: ${(result.reason??'unavailable').replaceAll('_',' ')}. Refresh before trying again.`);}
  }catch{if(g===live.current)setError('The change is not confirmed. Retry the same request.');}finally{if(g===live.current)setBusy(false);}
 };
 const account=view?.accounts.find(a=>a.id===accountId);
 const save=()=>{if(!view||!account||!approved)return;const generation:LinkedinPostingPolicySave['generation']=configured?{provider:'bedrock',providerKey:'aws_bedrock.social_draft',model:'claude-haiku-4-5',routeVersion:routeVersion.trim(),accessGrantVersion:grantVersion.trim(),dataHandlingVersion:dataVersion.trim(),dailyUsd:1,calendarMonthUsd:10,budgetZone:'America/New_York'}:null;void run({kind:'save',input:{accountId:account.id,accountRevision:account.revision,expectedRevision:view.revision,approvedRulesVersion:LINKEDIN_POSTING_RULES.version,generation,commandId:crypto.randomUUID()}});};
 const disabled=busy||pending!==null;
 return <section aria-label="LinkedIn standing posting policy" className="space-y-3 rounded-lg border border-border p-4 text-sm">
  <h2 className="font-medium">LinkedIn standing posting policy</h2>
  <p>Existing David Cui personal LinkedIn only, text-only. Tuesday and Thursday at 10AM America/New_York, at most two posts per week. Skip unready posts, no catch-up bursts or automatic increases.</p>
  <p>Original developed, spaced-out prose about real founder/building work and technical tradeoffs. Maintenance insights must come from actual useful work. News and technology need a relevant original-source check and link.</p>
  <p>Reuse only approved sanitized facts and build updates with provenance, distinguishing planned, local and shipped work. No arbitrary private ingestion, private conversations, identifiable customer stories, confidential code, invented experiences, results, metrics, promises, expertise, endorsements or personal opinions. Structural voice inspiration only, never copied anecdotes or sentences. The rejected LinkedIn-automation sample is not approved.</p>
  <p>Unsupported drafts stop that post for skip or review. New personal positions and sensitive topics require owner review. Account warnings, stale account/policy or uncertain submission pause the lane. Unknown attempts are inspected, never replayed.</p>
  <p>Bedrock aws_bedrock.social_draft, claude-haiku-4-5, for approved sanitized facts and permitted public-source material only. $1 per New York calendar day and $10 per New York calendar month within stricter shared ceilings and holds. Reserve a defensible maximum before paid drafting/source checks, settle unknown costs conservatively. No automatic increase, carryover, provider switch or cross-lane pooling.</p>
  <p>Saving is not account readiness, configured/available budget, accepted runtime or Enable. No automatic publishing is enabled here. Substantive sales replies and manual per-post approval outside the standing path are unchanged.</p>
  {view&&<>
   <p>{label(view)}</p>
   <ul aria-label="Posting readiness holds">{view.holds.map(h=><li key={h}>{h.replaceAll('_',' ')}</li>)}</ul>
   {view.history.length>0&&<details><summary>Posting policy audit, latest 25 revisions</summary><ul>{view.history.map(h=><li key={h.revision}>Revision {h.revision}: {h.state}, account revision {h.accountRevision}, {new Date(h.recordedAt).toLocaleString()}</li>)}</ul></details>}
   {view.candidates.length>0&&<details><summary>Owner-staged candidates, latest 25 bindings</summary><ul>{view.candidates.map(c=><li key={`${c.postId}:${c.postRevision}`}>Post revision {c.postRevision}, policy revision {c.policyRevision}: {c.submissionState}, {c.current?'current policy only':c.reason.replaceAll('_',' ')}. Attempted submissions remain inspection-only.</li>)}</ul></details>}
   <label className="block">Posting account<select aria-label="Posting account" disabled={disabled} value={accountId} onChange={e=>{setAccountId(e.target.value);setApproved(false);}}><option value="">Choose the existing personal account</option>{view.accounts.filter(a=>a.externalId===LINKEDIN_POSTING_RULES.account).map(a=><option key={a.id} value={a.id}>{a.displayName} · {a.externalId} · revision {a.revision} · {a.state}</option>)}</select></label>
   {view.policy&&<p>Saved binding: {view.policy.accountExternalId}, account revision {view.policy.accountRevision}, policy scope {view.policy.rules.version}.</p>}
   <label className="block"><input type="checkbox" disabled={disabled} checked={configured} onChange={e=>{setConfigured(e.target.checked);setApproved(false);}}/> Record the approved Bedrock drafting configuration</label>
   {configured&&<div><p>Opaque configuration versions only, never credentials or private factual inputs. These values do not prove working setup or available allowance.</p>{[{name:'Route version',value:routeVersion,set:setRouteVersion},{name:'Access grant version',value:grantVersion,set:setGrantVersion},{name:'Data handling version',value:dataVersion,set:setDataVersion}].map(f=><label key={f.name} className="block">{f.name}<input aria-label={f.name} disabled={disabled} maxLength={200} value={f.value} onChange={e=>{f.set(e.target.value);setApproved(false);}}/></label>)}</div>}
   <label className="block"><input type="checkbox" disabled={disabled} checked={approved} onChange={e=>setApproved(e.target.checked)}/> I approve this exact posting scope, account revision and stated provider/data/spend limits</label>
   <div className="flex gap-2"><Button disabled={disabled||!approved||!account||(configured&&![routeVersion,grantVersion,dataVersion].every(v=>v.trim()))} onClick={save}>{view.revision?'Save revised posting policy':'Save standing posting policy'}</Button>{view.revision>0&&<><Button variant="outline" disabled={disabled||view.state==='disabled'||view.state==='revoked'} onClick={()=>void run({kind:'disabled',input:{expectedRevision:view.revision,commandId:crypto.randomUUID()}})}>Disable posting policy</Button><Button variant="outline" disabled={disabled||view.state==='revoked'} onClick={()=>void run({kind:'revoked',input:{expectedRevision:view.revision,commandId:crypto.randomUUID()}})}>Revoke posting policy</Button></>}</div>
   <p>Revoking invalidates pending bound candidates, not published posts. Original submission evidence remains available for inspection. An owner-staged binding is not automatic scheduling or semantic grounding acceptance.</p>
  </>}
  {error&&<p role="status">{error}</p>}
  {pending&&!busy&&<Button onClick={()=>void run(pending)}>Retry same policy change</Button>}
  <Button variant="outline" disabled={busy||pending!==null} onClick={()=>{const g=live.current;void port.current.read().then(a=>{if(g===live.current&&a.view){accept(a.view);setError(null);}}).catch(()=>{if(g===live.current)setError('Posting settings are unavailable.');});}}>Refresh posting policy</Button>
 </section>;
}
