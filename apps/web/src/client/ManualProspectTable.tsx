import type {JSX} from 'react';
import type {ManualProspect} from '@fss/contracts';
import {manualPhoneLabel,manualProspectLabel,manualProspectSite} from './manualProspectPresentation.ts';
import {useCurrentPhoneEvidence} from './useCurrentPhoneEvidence.ts';

function ManualProspectRow({prospect:p,selected,select}:{prospect:ManualProspect;selected:boolean;select:(id:string)=>void}):JSX.Element{
 const phone=useCurrentPhoneEvidence(p.phoneEvidence);
 return <tr data-candidate-id={p.candidateId} className={selected?'manual-current':''}>
  <td><button id={`manual-row-${p.candidateId}`} className="manual-company-button" aria-current={selected?'true':undefined} onClick={()=>select(p.candidateId)}>{manualProspectLabel(p)}<span>{manualProspectSite(p)??'Site unknown'}</span></button><span className="manual-row-kind">{p.presentation?.kind.replaceAll('_',' ')??'unresolved'} · unverified</span></td>
  <td><span className={`manual-phone-state manual-phone-${phone?.state??'not_extracted'}`}>{manualPhoneLabel({...p,phoneEvidence:phone})}</span>{p.state==='wrong_number'?<span className="manual-row-kind manual-wrong-note">Manual flag only, evidence unchanged</span>:null}</td>
  <td>{p.locality??'Unknown'}, {p.region??'unknown'}</td>
  <td><span className={`manual-state manual-state-${p.state}`}>{p.state.replaceAll('_',' ')}</span></td>
 </tr>;
}

export function ManualProspectTable({prospects,selected,select}:{prospects:ManualProspect[];selected:string|null;select:(id:string)=>void}):JSX.Element{
 return <div className="manual-list-surface">
  <div className="manual-list-bar"><strong>{prospects.length} retained observations on this page</strong><span>Not a unique Firm count</span></div>
  <div className="manual-table-scroll" tabIndex={0} role="region" aria-label="Scrollable prospect observations">
   <table className="manual-table"><caption className="manual-sr-only">Retained observations. Select a company to inspect its exact evidence and manual review.</caption>
    <thead><tr><th scope="col">Company / site</th><th scope="col">Phone evidence</th><th scope="col">Apparent area</th><th scope="col">Manual state</th></tr></thead>
    <tbody>{prospects.map(p=><ManualProspectRow key={`${p.candidateId}:${p.revision}`} prospect={p} selected={p.candidateId===selected} select={select}/>)}</tbody>
   </table>
  </div>
 </div>;
}
