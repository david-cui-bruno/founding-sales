import {useEffect,useRef,useState,type JSX} from 'react';
import type {CallingSelection,ProspectsWorkspaceProps} from './workspaceNavigation.ts';
import {BrowserResearchQueue} from './BrowserResearchQueue.tsx';
import {usePreparedProspects} from './PreparedProspects.tsx';
import {BrowserManualProspects} from './BrowserManualProspects.tsx';
import {BrowserCandidateInventory} from './BrowserCandidateInventory.tsx';
import {ProspectConversation} from './ProspectConversation.tsx';
import {useWorkspaceNavigation} from './WorkspaceNavigationGuard.tsx';
import './workspaceProspects.css';

/** One mounted conversation owner; changing the visible supply never replaces live media. */
export function BrowserProspectsWorkspace(props:ProspectsWorkspaceProps):JSX.Element {
 const {client,onSelectionChange}=props;
 const [view,setView]=useState<'prepared'|'working'|'qualified'|'retained'|'inventory'>(()=>!props.selection&&client.current?.status==='signed_in'&&client.current.role==='admin'?'prepared':'working');
 const [localSelection,setLocalSelection]=useState<CallingSelection|null>(null);
 const [,refreshSession]=useState(0);
 const mounted=useRef(false),scope=useRef(0);
 const canLeave=useWorkspaceNavigation();
 useEffect(()=>{
  mounted.current=true;let epoch=client.epoch;
  const unsubscribe=client.subscribe(()=>{
   if(epoch!==client.epoch||client.current?.status!=='signed_in'){epoch=client.epoch;scope.current++;setLocalSelection(null);setView(client.current?.status==='signed_in'&&client.current.role==='admin'?'prepared':'working');}
   refreshSession(value=>value+1);
  });
  return()=>{mounted.current=false;scope.current+=1;unsubscribe();};
 },[client]);
 const epoch=client.epoch,version=scope.current;
 const select=(selection:CallingSelection|null):void=>{
  if(!mounted.current||scope.current!==version||!client.isCurrent(epoch)||client.current?.status!=='signed_in')return;
  if(props.selection===undefined)setLocalSelection(selection);
  onSelectionChange?.(selection);
 };
 const openFromTools=(selection:CallingSelection):void=>{if(canLeave())select(selection);};
 const selection=props.selection===undefined?localSelection:props.selection;
 const research=usePreparedProspects({client,selection,enabled:view==='prepared',onOpenCalling:select});
 const selectView=(next:typeof view):void=>{
  if(next===view)return;
  if(view!=='prepared'&&view!=='working'&&!canLeave())return;
  scope.current++;setView(next);
 };
 const toolbar=<nav className="prospects-view-switch" aria-label="Prospect supply views">
  <button aria-pressed={view==='prepared'} onClick={()=>selectView('prepared')}>Prepared research</button>
  <button aria-pressed={view==='working'} onClick={()=>selectView('working')}>Working list</button>
  <button aria-pressed={view==='qualified'} onClick={()=>selectView('qualified')}>Qualified publications</button>
  <button aria-pressed={view==='retained'} onClick={()=>selectView('retained')}>Retained review</button>
  <button aria-pressed={view==='inventory'} onClick={()=>selectView('inventory')}>Source inventory</button>
 </nav>;
 const supply=view==='prepared'?research.list:view==='working'?undefined
  :view==='qualified'?<BrowserResearchQueue client={client} onOpenCalling={openFromTools}/>
  :view==='retained'?client.current?.status==='signed_in'&&client.current.role==='admin'?<BrowserManualProspects client={client} onOpenCalling={openFromTools}/>:<p role="status">Retained review requires current administrator access.</p>
  :<BrowserCandidateInventory client={client}/>;
 const sameResearch=selection?.kind==='candidate'&&selection.candidateId===research.target?.candidateId&&selection.expectedCandidateRevision===research.target.candidateRevision;
 return <section className="workspace-prospects" aria-label="Prospects workspace">
  {view==='prepared'&&client.pendingResearch()!==null?<p role="status">A saved research request is available in Qualified publications.</p>:null}
  <ProspectConversation {...props} selection={selection} onSelectionChange={select} toolbar={toolbar} researchList={supply} researchBrief={sameResearch?research.detail:null} researchOverview={sameResearch?research.overview:null} {...(view==='prepared'?{onAdvance:()=>{void research.advance();},canAdvance:research.canAdvance}:{})}/>
 </section>;
}
