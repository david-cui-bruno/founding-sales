import {MANUAL_PROSPECT_ROWS_SQL} from './manualProspectRows.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
export interface PriorityRow extends Record<string,unknown>{candidate_id:string;candidate_revision:number;revision:number;fit:'positive'|'unknown'|'negative';value:'positive'|'unknown';timing:'positive'|'unknown';source_url:string;source_key:string;roles:unknown;decided_at:Date;expires_at:Date}
export interface PriorityOrderRow{ id:string;revision:number;assessment_revision:number;fit:'positive'|'unknown'|'negative';value:'positive'|'unknown';timing:'positive'|'unknown';source_url:string|null;roles:unknown;decided_at:string|null;expires_at:string|null;last_considered_at:string|null;considered_count:number}
/** Four evidence-supported slots then one ordinary slot. A considered record ages out
 * of the supported lane for seven days; ordinary order is least-recently-considered.
 * The bound is positional: an ordinary item is at most every fifth available slot,
 * assuming both lanes have items. No read counts as consideration. */
const pool=`WITH permitted AS (${MANUAL_PROSPECT_ROWS_SQL}), facts AS (
 SELECT p.id,p.revision,p.created_at,encode(sha256(convert_to(p.payload::text||COALESCE(p.origins::text,'')||COALESCE(p.source_check::text,''),'UTF8')),'hex') AS source_key,
 COALESCE(a.revision,stale.revision,0) AS assessment_revision,COALESCE(a.fit,'unknown') AS fit,COALESCE(a.value,'unknown') AS value,COALESCE(a.timing,'unknown') AS timing,
 a.source_url,a.roles,a.decided_at,a.expires_at,
 h.last_considered_at,COALESCE(h.considered_count,0)::integer AS considered_count,
 COALESCE(h.last_considered_at>clock_timestamp()-interval '7 days',false) AS recent
 FROM permitted p LEFT JOIN sourcing_prospect_priorities stale ON stale.workspace_id=$1 AND stale.candidate_id=p.id AND stale.candidate_revision=p.revision
 LEFT JOIN sourcing_prospect_priorities a ON a.workspace_id=$1 AND a.candidate_id=p.id AND a.candidate_revision=p.revision
 AND a.expires_at>clock_timestamp() AND rtrim(a.source_url,'/')=ANY(p.source_urls)
 AND a.source_key=encode(sha256(convert_to(p.payload::text||COALESCE(p.origins::text,'')||COALESCE(p.source_check::text,''),'UTF8')),'hex')
 AND EXISTS(SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=a.workspace_id AND m.user_id=a.owner_user_id AND m.status='active' AND m.role='admin')
 LEFT JOIN LATERAL(SELECT max(c.occurred_at) AS last_considered_at,count(*) AS considered_count FROM sourcing_prospect_considerations c WHERE c.workspace_id=$1 AND c.candidate_id=p.id AND c.candidate_revision=p.revision AND c.expires_at>clock_timestamp()) h ON true
), lanes AS (
 SELECT facts.*,CASE WHEN fit<>'negative' AND (fit='positive' OR value='positive' OR timing='positive') AND NOT recent THEN 0 ELSE 1 END AS lane FROM facts
), numbered AS (
 SELECT lanes.*,row_number() OVER(PARTITION BY lane ORDER BY
 CASE WHEN lane=0 AND timing='positive' THEN 0 ELSE 1 END,
 CASE WHEN lane=0 AND fit='positive' THEN 0 ELSE 1 END,
 CASE WHEN lane=0 AND value='positive' THEN 0 ELSE 1 END,
 last_considered_at NULLS FIRST,created_at,id) AS n FROM lanes
), ordered AS (
 SELECT numbered.*,CASE WHEN lane=0 THEN ((n-1)/4)*5+(n-1)%4 ELSE (n-1)*5+4 END AS slot FROM numbered
), context AS (
 SELECT encode(sha256(convert_to(COALESCE(string_agg(jsonb_build_array(id,revision,source_key,assessment_revision,fit,value,timing,source_url,roles,decided_at,expires_at,last_considered_at,considered_count,lane)::text,'' ORDER BY id),''),'UTF8')),'hex') AS view_revision FROM ordered
)`;
export async function priorityOrder(ctx:RepositoryContext,state:string,offset:number):Promise<{rows:PriorityOrderRow[];viewRevision:string}>{
 const answer=(await ctx.db.query<{rows:PriorityOrderRow[];view_revision:string}>(`${pool} SELECT context.view_revision,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'revision',revision,'assessment_revision',assessment_revision,'fit',fit,'value',value,'timing',timing,'source_url',source_url,'roles',COALESCE(roles,'[]'),'decided_at',decided_at,'expires_at',expires_at,'last_considered_at',last_considered_at,'considered_count',considered_count) ORDER BY slot,id)
 FROM (SELECT * FROM ordered ORDER BY slot,id LIMIT 51 OFFSET $3) page),'[]'::jsonb) AS rows FROM context`,[ctx.scope.workspaceId,state,offset])).rows[0]!;
 return {rows:answer.rows,viewRevision:answer.view_revision};
}
export async function priorityAssessment(ctx:RepositoryContext,candidateId:string):Promise<PriorityRow|null>{
 return (await ctx.db.query<PriorityRow>('SELECT * FROM sourcing_prospect_priorities WHERE workspace_id=$1 AND candidate_id=$2',[ctx.scope.workspaceId,candidateId])).rows[0]??null;
}
