import {useSessionEpoch} from '../app/drafts.tsx';
import {useEffect,useState} from 'react';
import type {LearningReport} from '@fss/contracts';
import {operations} from '../app/bridges.ts';
import {ExperimentsWorkspace,type ExperimentCatalog} from './ExperimentsWorkspace.tsx';
import type {ExperimentProps} from './Experiments.tsx';
const client=()=>{const api=operations();if(!api)throw new Error('unavailable');return api;};
const ports:Omit<ExperimentProps,'proposal'|'approvedSequences'>={
 read:async()=>{const r=await client().read('sourcing.experiments',{});if(!r.view)throw new Error(r.reason??'unavailable');return r.view;},
 save:async input=>{const r=await client().command('sourcing.saveExperiment',input);if(!r.result)throw new Error(r.reason??'unavailable');return r.result;},
 activate:async input=>{const r=await client().command('sourcing.activateExperiment',input);if(!r.result)throw new Error(r.reason??'unavailable');},
 stop:async input=>{const r=await client().command('sourcing.stopExperiment',input);if(!r.result)throw new Error(r.reason??'unavailable');},
 erase:async input=>{const r=await client().command('sourcing.eraseExperiment',input);if(!r.result)throw new Error(r.reason??'unavailable');}
};
const sessionKeys=new WeakMap<object,number>();let nextSessionKey=0;
export function ExperimentsPanel(props:{report:LearningReport}){const epoch=useSessionEpoch();let key=0;if(epoch){key=sessionKeys.get(epoch)??++nextSessionKey;sessionKeys.set(epoch,key);}return <PanelSession key={key} {...props}/>;}
function PanelSession({report}:{report:LearningReport}){
 const [catalog,setCatalog]=useState<ExperimentCatalog|null>(null),[failed,setFailed]=useState(false);
 useEffect(()=>{let alive=true;const api=operations();if(!api){setFailed(true);return;}void Promise.all([api.read('sourcing.targeting',{}),api.read('sequences.state',{}),api.read('outreach.control',{})]).then(([targeting,sequences,control])=>{
  if(!alive)return;
  if(!targeting.view||!control.view||sequences.readErrors.templates||!sequences.online){setFailed(true);return;}
  setCatalog({policy:targeting.view.policy,templates:sequences.templates.filter(t=>t.approvedAt!==null&&t.retiredAt===null).map(t=>({id:t.id,name:t.name,subject:t.subject,body:t.body})),sequences:control.view.sequences.filter(s=>s.kind==='email_first').map(s=>({id:s.id,label:s.label}))});
 }).catch(()=>{if(alive)setFailed(true);});return()=>{alive=false;};},[]);
 return failed?<p role="alert">Experiment scope is unavailable. Existing proposals and controls have not been changed.</p>:catalog?<ExperimentsWorkspace report={report} catalog={catalog} ports={ports}/>:<p role="status">Loading experiment scope…</p>;
}
