import type {JSX} from 'react';
import type {qualificationViewSchema} from '@fss/contracts';
import type {z} from 'zod';
import {qualificationResearchPassages} from './qualificationResearchPassages.ts';

const labels={phone:'Published phone passage',person:'Possible person or role lead',location:'Office and location context'};
type QualificationView=z.infer<typeof qualificationViewSchema>;
/** A reading aid for returned originals, with no contact, identity or policy decision. */
export function QualificationResearchPassages({view,companyName,website}:{view:QualificationView;companyName:string;website:string}):JSX.Element|null{
 if(view.reason!==null||!['review','eligible','admitted'].includes(view.status)||(view.currentCandidateRevision??view.candidateRevision)!==view.candidateRevision)return null;
 const result=qualificationResearchPassages({companyName,website,observations:view.observations,facts:view.facts});
 if(!result.passages.length)return null;
 return <details className="qualification-research-passages"><summary>Phone, people and office context</summary>
  <p>Captured passages to guide research. Check current roles, office association and contact readiness before using them. A service area can differ from an office location.</p>
  <ul>{result.passages.map(passage=><li key={`${passage.kind}:${passage.observationId}:${passage.blocks.map(block=>block.id).join(':')}`}>
   <h6>{labels[passage.kind]}</h6>
   <p>Captured {new Date(passage.retrievedAt).toLocaleString()} · {passage.sourceUrl}</p>
   {passage.blocks.map(block=><div key={block.id}><small>Original block {block.id}</small><blockquote>{block.text}</blockquote></div>)}
  </li>)}</ul>
  {result.hasMore?<p>Some matching passages were omitted to keep this view bounded. Review the captured original blocks below for more context.</p>:null}
 </details>;
}
