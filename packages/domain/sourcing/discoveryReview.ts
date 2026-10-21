import {discoveryCandidatePayloadSchema,discoveryReviewInputSchema,discoveryReviewSavedSchema,discoveryUsefulListInputSchema,discoveryUsefulListSchema,type DiscoveryReviewInput} from '@fss/contracts';
import type {z} from 'zod';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {decideAdminOnly} from '../crm/authorization.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {databaseNow} from '../policy/clock.ts';
import {isPublicResearchUrl} from '../research/sourcePolicy.ts';
import {discoveryReviewContent,discoveryReviewValue,DISCOVERY_REVIEW_HORIZON_MS,type DiscoveryReviewRow,type DiscoveryReview} from './discoveryReviewPolicy.ts';
import {DISCOVERY_REVIEW_VISIBLE_SQL} from './discoveryReviewVisibility.ts';

type Result<T>={ok:true;value:T}|{ok:false;reason:string};
type Saved=z.infer<typeof discoveryReviewSavedSchema>;
const refused=(reason:string):{ok:false;reason:string}=>({ok:false,reason});
interface CandidateRow extends Record<string,unknown>{id:string;payload:unknown;revision:number;status:string}

/** Caller owns the normal command transaction. Candidate lock serializes review,
 * origin attachment, correction and deletion. Never changes candidate revision. */
export async function recordDiscoveryReview(ctx:RepositoryContext,input:DiscoveryReviewInput):Promise<Result<Saved>> {
  if(!decideAdminOnly(ctx).permitted||ctx.scope.actor.kind!=='user')return refused('admin_only');
  const parsed=discoveryReviewInputSchema.safeParse(input);if(!parsed.success)return refused('invalid_input');
  const value=parsed.data,w=ctx.scope.workspaceId;
  await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sourcing-discovery-review:${w}`]);
  const candidate=(await ctx.db.query<CandidateRow>('SELECT id,payload,revision,status FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,value.candidateId])).rows[0];
  if(!candidate)return refused('not_found');
  if(!discoveryCandidatePayloadSchema.safeParse(candidate.payload).success)return refused('candidate_format_not_supported');
  if(candidate.revision!==value.expectedRevision)return refused('candidate_changed');
  if(candidate.status==='dismissed')return refused('candidate_dismissed');
  const now=Date.parse(await databaseNow(ctx)),urls=new Set<string>();
  for(const page of value.evidence){
    if(!isPublicResearchUrl(page.url))return refused('source_not_permitted');
    if(Date.parse(page.retrievedAt)>now)return refused('retrieval_in_future');
    if(Date.parse(page.retrievedAt)<=now-DISCOVERY_REVIEW_HORIZON_MS)return refused('evidence_expired');
    if(urls.has(page.url))return refused('duplicate_or_conflicting_page');urls.add(page.url);
  }
  const missing=(await ctx.db.query<{missing:boolean}>(`SELECT EXISTS(SELECT 1 FROM jsonb_array_elements($3::jsonb) page
    WHERE NOT EXISTS(SELECT 1 FROM sourcing_candidate_discovery_origins o WHERE o.workspace_id=$1 AND o.candidate_id=$2
      AND o.provider=page->'source'->>'provider' AND o.release=page->'source'->>'release' AND o.record_id=page->'source'->>'recordId')) AS missing`,[w,candidate.id,JSON.stringify(value.evidence)])).rows[0];
  if(missing?.missing)return refused('source_not_member');
  const lost=(await ctx.db.query<{lost:boolean}>(`SELECT EXISTS(
    SELECT 1 FROM sourcing_candidates c WHERE c.workspace_id=$1 AND c.source_check->>'state'='unavailable'
      AND c.source_check->>'reason' IN ('source_unavailable','source_not_permitted','no_readable_text')
      AND (rtrim(c.payload->>'sourceUrl','/')=ANY($2::text[]) OR rtrim(c.source_check->'lastSuccess'->>'url','/')=ANY($2::text[]))
    UNION ALL SELECT 1 FROM evidence_items e WHERE e.workspace_id=$1 AND rtrim(e.source_reference,'/')=ANY($2::text[])
      AND (e.retention_expires_at<=now() OR (NOT e.terms_allow_retention AND e.retention_expires_at IS NULL))) AS lost`,[w,[...urls].map(url=>url.replace(/\/+$/u,''))])).rows[0];
  if(lost?.lost)return refused('source_unavailable');
  const content=discoveryReviewContent(value);
  // jsonb adds whitespace, so check the database's byte representation before insert.
  const bounds=(await ctx.db.query<{evidence_bytes:number;assessment_bytes:number}>('SELECT octet_length(($1::jsonb)::text) evidence_bytes,octet_length(($2::jsonb)::text) assessment_bytes',[JSON.stringify(content.evidence),JSON.stringify(content.assessment)])).rows[0];
  if(!bounds||bounds.evidence_bytes>32768||bounds.assessment_bytes>8192)return refused('review_payload_too_large');
  const previous=(await ctx.db.query<DiscoveryReviewRow>(`SELECT * FROM sourcing_candidate_discovery_reviews WHERE workspace_id=$1 AND candidate_id=$2 AND candidate_revision=$3 AND review_version=$4 AND content_digest=$5`,[w,candidate.id,candidate.revision,value.reviewVersion,content.digest])).rows[0];
  if(previous)return {ok:true,value:{review:discoveryReviewValue(previous),alreadyRecorded:true}};
  const row=(await ctx.db.query<DiscoveryReviewRow>(`INSERT INTO sourcing_candidate_discovery_reviews
    (workspace_id,candidate_id,candidate_revision,review_version,evidence,assessment,content_digest,reviewed_by)
    VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) RETURNING *`,[w,candidate.id,candidate.revision,value.reviewVersion,JSON.stringify(content.evidence),JSON.stringify(content.assessment),content.digest,ctx.scope.actor.userId])).rows[0];
  if(!row)throw Error('Discovery review insert returned no identity');
  await recordCrmAuditEvent(ctx,{action:'sourcing.discovery_review_saved',subjectKind:'sourcing_candidate',subjectId:candidate.id,detail:{reviewId:row.id,candidateRevision:candidate.revision}});
  return {ok:true,value:{review:discoveryReviewValue(row),alreadyRecorded:false}};
}

/** Receipt rehydration is current-only. Never store excerpts in command receipts. */
export async function readVisibleDiscoveryReview(ctx:RepositoryContext,id:string):Promise<DiscoveryReview|null> {
  if(!decideAdminOnly(ctx).permitted)return null;
  const row=(await ctx.db.query<DiscoveryReviewRow>(`SELECT r.* FROM sourcing_candidate_discovery_reviews r JOIN sourcing_candidates c ON c.workspace_id=r.workspace_id AND c.id=r.candidate_id
    WHERE r.workspace_id=$1 AND r.id=$2 AND c.payload->>'kind'='discovery-v1' AND (${DISCOVERY_REVIEW_VISIBLE_SQL})`,[ctx.scope.workspaceId,id])).rows[0];
  return row?discoveryReviewValue(row):null;
}

export async function listUsefulDiscoveryCandidates(ctx:RepositoryContext,input:z.infer<typeof discoveryUsefulListInputSchema>):Promise<Result<z.infer<typeof discoveryUsefulListSchema>>> {
  if(!decideAdminOnly(ctx).permitted)return refused('admin_only');
  const parsed=discoveryUsefulListInputSchema.safeParse(input);if(!parsed.success)return refused('invalid_input');
  const value=parsed.data;
  // Latest review first, then visibility. An expired correction never revives older
  // interpretations. One statement binds revision, origin membership, and evidence.
  const rows=(await ctx.db.query<Record<string,unknown>&{review:unknown}>(`WITH current_rows AS (
    SELECT c.id,c.status,c.revision,c.created_at,c.payload,
      (SELECT jsonb_agg(jsonb_build_object('source',o.source,'sourceMetadata',o.source_metadata,'licenses',o.licenses,'notices',o.notices) ORDER BY o.provider,o.release,o.record_id)
       FROM sourcing_candidate_discovery_origins o WHERE o.workspace_id=c.workspace_id AND o.candidate_id=c.id) origins,
      CASE WHEN (${DISCOVERY_REVIEW_VISIBLE_SQL}) THEN jsonb_build_object('id',r.id,'candidateId',r.candidate_id,'candidateRevision',r.candidate_revision,'reviewVersion',r.review_version,'contentDigest',r.content_digest,'evidence',r.evidence,'assessment',r.assessment,'reviewedAt',r.reviewed_at) ELSE NULL END review
    FROM sourcing_candidates c LEFT JOIN LATERAL(SELECT r.* FROM sourcing_candidate_discovery_reviews r WHERE r.workspace_id=c.workspace_id AND r.candidate_id=c.id ORDER BY r.reviewed_at DESC,r.id DESC LIMIT 1) r ON true
    WHERE c.workspace_id=$1 AND c.status=$2 AND c.payload->>'kind'='discovery-v1'
  ), ranked AS (SELECT *,CASE
    WHEN review IS NULL OR jsonb_array_length(review->'evidence')=0 OR review->'assessment'->>'serviceSignal'='unknown' THEN 'unreviewed'
    WHEN review->'assessment'->>'serviceSignal'='contradicted' THEN 'contradicted'
    WHEN review->'assessment'->>'websiteAssociation'='ambiguous' OR EXISTS(SELECT 1 FROM jsonb_array_elements(review->'evidence') p WHERE p->>'association'='ambiguous') THEN 'tentative'
    WHEN review->'assessment'->>'serviceSignal'='paragraph_supported' AND EXISTS(SELECT 1 FROM jsonb_array_elements(review->'evidence') p,jsonb_array_elements(p->'blocks') b WHERE b->>'kind'='paragraph') THEN 'review_first'
    ELSE 'tentative' END band FROM current_rows)
    SELECT * FROM ranked WHERE ($3::text IS NULL OR band=$3) ORDER BY CASE band WHEN 'review_first' THEN 0 WHEN 'tentative' THEN 1 WHEN 'unreviewed' THEN 2 ELSE 3 END,
    (SELECT max((p->>'retrievedAt')::timestamptz) FROM jsonb_array_elements(review->'evidence') p) DESC NULLS LAST,created_at DESC,id DESC LIMIT 51 OFFSET $4`,[ctx.scope.workspaceId,value.status,value.band??null,value.offset])).rows;
  return {ok:true,value:discoveryUsefulListSchema.parse({candidates:rows.slice(0,50).map(row=>({candidate:{id:row['id'],status:row['status'],revision:row['revision'],createdAt:(row['created_at'] as Date).toISOString(),payload:row['payload'],origins:row['origins']},review:row.review,band:row['band'],admissionAuthorized:false,runtimeCallable:false})),hasMore:rows.length>50})};
}
