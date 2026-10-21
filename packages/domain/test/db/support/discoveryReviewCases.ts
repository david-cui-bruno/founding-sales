import {randomUUID} from 'node:crypto';
import type {SessionQueryable} from '../../../db/queryable.ts';
type Fixture={session:SessionQueryable;seeded:{alpha:{workspaceId:string}}};
type Case={constraint:string;run:(f:Fixture)=>Promise<unknown>};
async function row(f:Fixture){const id=randomUUID();await f.session.query('INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload) VALUES($1,$2,$3,$4::jsonb)',[f.seeded.alpha.workspaceId,id,'a'.repeat(64),'{}']);return {workspace_id:f.seeded.alpha.workspaceId,candidate_id:id,id:randomUUID(),candidate_revision:1,review_version:'discovery-review-v1',evidence:'[]',assessment:'{"serviceSignal":"unknown","websiteAssociation":"unknown","unknowns":[]}',content_digest:'a'.repeat(64),reviewed_by:randomUUID()};}
async function insert(f:Fixture,value:Record<string,unknown>){const keys=Object.keys(value);return f.session.query(`INSERT INTO sourcing_candidate_discovery_reviews(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(value));}
const bad=(constraint:string,changes:Record<string,unknown>):Case=>({constraint,run:async f=>insert(f,{...await row(f),...changes})});
export const DISCOVERY_REVIEW_CONSTRAINT_CASES:readonly Case[]=[
  bad('sourcing_candidate_discovery_rev_workspace_id_candidate_id_fkey',{candidate_id:'00000000-0000-4000-8000-000000000127'}),
  bad('sourcing_discovery_review_revision',{candidate_revision:0}),
  bad('sourcing_discovery_review_version',{review_version:'native_observation'}),
  bad('sourcing_discovery_review_digest',{content_digest:'invalid'}),
  bad('sourcing_discovery_review_evidence',{evidence:'{}'}),
  bad('sourcing_discovery_review_evidence',{evidence:JSON.stringify(Array.from({length:9},()=>({})))}),
  bad('sourcing_discovery_review_evidence',{evidence:JSON.stringify([{text:'x'.repeat(32768)}])}),
  bad('sourcing_discovery_review_assessment',{assessment:'{}'}),
  bad('sourcing_discovery_review_assessment',{assessment:'{"serviceSignal":"verified","websiteAssociation":"unknown","unknowns":[]}'}),
  bad('sourcing_discovery_review_assessment',{assessment:'{"serviceSignal":"unknown","websiteAssociation":"verified","unknowns":[]}'}),
  bad('sourcing_discovery_review_assessment',{assessment:JSON.stringify({serviceSignal:'unknown',websiteAssociation:'unknown',unknowns:Array.from({length:31},()=> 'unknown')})}),
  bad('sourcing_discovery_review_assessment',{assessment:'{"serviceSignal":"unknown","websiteAssociation":"unknown","unknowns":[],"body":"private"}'}),
  bad('sourcing_discovery_review_assessment',{assessment:JSON.stringify({serviceSignal:'unknown',websiteAssociation:'unknown',unknowns:['x'.repeat(8192)]})}),
  {constraint:'sourcing_candidate_discovery_reviews_pkey',run:async f=>{const value=await row(f);await insert(f,value);return insert(f,{...value,content_digest:'b'.repeat(64)});}},
  {constraint:'sourcing_candidate_discovery__workspace_id_candidate_id_can_key',run:async f=>{const value=await row(f);await insert(f,value);return insert(f,{...value,id:randomUUID()});}},
];
