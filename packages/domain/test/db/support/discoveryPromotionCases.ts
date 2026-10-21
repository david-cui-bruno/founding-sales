import {randomUUID,createHash} from 'node:crypto';
import type {SessionQueryable} from '../../../db/queryable.ts';
type Fixture={session:SessionQueryable;seeded:{alpha:{workspaceId:string}}};
type Row=Record<string,unknown>;
type Case={constraint:string;run:(f:Fixture)=>Promise<unknown>};
const absent='00000000-0000-4000-8000-000000000128';
async function insert(f:Fixture,table:string,row:Row){const keys=Object.keys(row);return f.session.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));}
async function candidate(f:Fixture){const id=randomUUID();await insert(f,'sourcing_candidates',{workspace_id:f.seeded.alpha.workspaceId,id,identity_key:createHash('sha256').update(id).digest('hex'),payload:'{}'});return id;}
async function origin(f:Fixture,id:string){const source={provider:'overture_places',release:'fixture128',recordId:randomUUID()};const row={workspace_id:f.seeded.alpha.workspaceId,candidate_id:id,provider:source.provider,release:source.release,record_id:source.recordId,source:JSON.stringify(source),source_metadata:'{"sourcesJson":"[]"}',licenses:'["fixture"]',notices:'[{}]'};await insert(f,'sourcing_candidate_discovery_origins',row);return row;}
async function promotion(f:Fixture){const raw=await candidate(f),legacy=await candidate(f),o=await origin(f,raw);return {workspace_id:f.seeded.alpha.workspaceId,id:randomUUID(),raw_candidate_id:raw,raw_candidate_revision:1,legacy_candidate_id:legacy,legacy_candidate_revision:1,provider:o.provider,release:o.release,record_id:o.record_id,input_digest:'a'.repeat(64)};}
const bad=(constraint:string,changes:Row):Case=>({constraint,run:async f=>insert(f,'sourcing_discovery_promotions',{...await promotion(f),...changes})});
async function researchLink(f:Fixture){const p=await promotion(f);await insert(f,'sourcing_discovery_promotions',p);const firmId=randomUUID();await insert(f,'firms',{workspace_id:f.seeded.alpha.workspaceId,id:firmId,name:'Synthetic constraint research draft'});return {workspace_id:f.seeded.alpha.workspaceId,promotion_id:p.id,firm_id:firmId};}

/** Real128 storage failures, included in the normal central inventory without
 * expanding its hotspot. The redundant parent unique is isolated transactionally
 * from the older narrower primary key so the named constraint is actually exercised. */
export const DISCOVERY_PROMOTION_CONSTRAINT_CASES:readonly Case[]=[
 {constraint:'sourcing_discovery_origin_candidate_identity',run:async f=>{const o=await origin(f,await candidate(f));await f.session.query('ALTER TABLE sourcing_candidate_discovery_origins DROP CONSTRAINT sourcing_candidate_discovery_origins_pkey');return insert(f,'sourcing_candidate_discovery_origins',o);}},
 bad('sourcing_discovery_promotion_revisions',{raw_candidate_revision:0}),
 bad('sourcing_discovery_promotion_revisions',{legacy_candidate_revision:0}),
 bad('sourcing_discovery_promotion_digest',{input_digest:'bad'}),
 {constraint:'sourcing_discovery_promotion_distinct',run:async f=>{const p=await promotion(f);return insert(f,'sourcing_discovery_promotions',{...p,legacy_candidate_id:p.raw_candidate_id});}},
 bad('sourcing_discovery_promotions_workspace_id_raw_candidate_i_fkey',{raw_candidate_id:absent}),
 bad('sourcing_discovery_promotions_workspace_id_legacy_candidat_fkey',{legacy_candidate_id:absent}),
 bad('sourcing_discovery_promotion_workspace_id_raw_candidate_i_fkey1',{record_id:'missing-origin'}),
 {constraint:'sourcing_discovery_promotions_pkey',run:async f=>{const p=await promotion(f);await insert(f,'sourcing_discovery_promotions',p);return insert(f,'sourcing_discovery_promotions',p);}},
 {constraint:'sourcing_discovery_promotions_workspace_id_raw_candidate_id_key',run:async f=>{const p=await promotion(f);await insert(f,'sourcing_discovery_promotions',p);return insert(f,'sourcing_discovery_promotions',{...p,id:randomUUID()});}},
 {constraint:'sourcing_discovery_research_firms_pkey',run:async f=>{const p=await researchLink(f);await insert(f,'sourcing_discovery_research_firms',p);return insert(f,'sourcing_discovery_research_firms',p);}},
 {constraint:'sourcing_discovery_research_firm_workspace_id_promotion_id_fkey',run:async f=>insert(f,'sourcing_discovery_research_firms',{...await researchLink(f),promotion_id:absent})},
 {constraint:'sourcing_discovery_research_firms_workspace_id_firm_id_fkey',run:async f=>insert(f,'sourcing_discovery_research_firms',{...await researchLink(f),firm_id:absent})},
];

// Exact reviewed127 SQL is a prerequisite to local128. These storage-only cases
// do not import its runtime, interpretation rules, contracts or renderer lane.
async function review(f:Fixture){return {workspace_id:f.seeded.alpha.workspaceId,candidate_id:await candidate(f),id:randomUUID(),candidate_revision:1,review_version:'discovery-review-v1',evidence:'[]',assessment:'{"serviceSignal":"unknown","websiteAssociation":"unknown","unknowns":[]}',content_digest:'a'.repeat(64),reviewed_by:randomUUID()};}
const badReview=(constraint:string,changes:Row):Case=>({constraint,run:async f=>insert(f,'sourcing_candidate_discovery_reviews',{...await review(f),...changes})});
export const DISCOVERY_REVIEW_PREDECESSOR_CONSTRAINT_CASES:readonly Case[]=[
 badReview('sourcing_discovery_review_revision',{candidate_revision:0}),
 badReview('sourcing_discovery_review_version',{review_version:'wrong'}),
 badReview('sourcing_discovery_review_digest',{content_digest:'bad'}),
 badReview('sourcing_discovery_review_evidence',{evidence:'{}'}),
 badReview('sourcing_discovery_review_assessment',{assessment:'{}'}),
 badReview('sourcing_candidate_discovery_rev_workspace_id_candidate_id_fkey',{candidate_id:absent}),
 {constraint:'sourcing_candidate_discovery_reviews_pkey',run:async f=>{const r=await review(f);await insert(f,'sourcing_candidate_discovery_reviews',r);return insert(f,'sourcing_candidate_discovery_reviews',r);}},
 {constraint:'sourcing_candidate_discovery__workspace_id_candidate_id_can_key',run:async f=>{const r=await review(f);await insert(f,'sourcing_candidate_discovery_reviews',r);return insert(f,'sourcing_candidate_discovery_reviews',{...r,id:randomUUID()});}},
 {constraint:'sourcing_candidate_discovery_review_decisions_pkey',run:async f=>{const r={workspace_id:f.seeded.alpha.workspaceId,candidate_id:await candidate(f),review_id:randomUUID(),reviewed_at:'2026-10-21T00:00:00Z'};await insert(f,'sourcing_candidate_discovery_review_decisions',r);return insert(f,'sourcing_candidate_discovery_review_decisions',r);}},
 {constraint:'sourcing_candidate_discovery_re_workspace_id_candidate_id_fkey1',run:async f=>insert(f,'sourcing_candidate_discovery_review_decisions',{workspace_id:f.seeded.alpha.workspaceId,candidate_id:absent,review_id:randomUUID(),reviewed_at:'2026-10-21T00:00:00Z'})},
];
