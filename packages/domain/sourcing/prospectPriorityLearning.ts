import {prospectPriorityLearningInputSchema,prospectPriorityLearningSchema} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {lockDiscoveryReviewSources} from './discoveryReviewVisibility.ts';
import {MANUAL_ACTIVITY_RAW_SQL,requireManualActivityAuthority,type ManualActivityAuthority} from './manualProspectActivityAccess.ts';
/** Selection-window cohort; only current retained reports at/after selection and
 * before the end of the window. Each candidate contributes at most once per result.
 * Reported conversation is not a confirmed appropriate-Person conversation. */
export async function readProspectPriorityLearning(ctx:RepositoryContext,input:{from:string;to:string},authority:ManualActivityAuthority=async()=>true){
 if(!prospectPriorityLearningInputSchema.safeParse(input).success)return {ok:false as const,reason:'invalid_input'};
 await lockDiscoveryReviewSources(ctx);await requireManualActivityAuthority(ctx,authority);
 const query=async()=>{
  const row=(await ctx.db.query<{considered:number;selected:number;reported_attempts:number;unplaced_reported_attempts:number;conversation:number;no_answer:number;callback_requested:number;not_interested:number;unknown:number;reportedAttempts:number;unplacedReportedAttempts:number}>(`WITH permitted AS (${MANUAL_ACTIVITY_RAW_SQL}), cohort AS (
   SELECT c.candidate_id,(array_agg(c.candidate_revision ORDER BY (c.disposition='selected') DESC,c.occurred_at,c.id))[1] AS candidate_revision,min(c.occurred_at) AS considered_at,min(c.occurred_at) FILTER(WHERE c.disposition='selected') AS selected_at
   FROM sourcing_prospect_considerations c JOIN permitted p ON p.id=c.candidate_id
   WHERE c.workspace_id=$1 AND c.occurred_at>=$3 AND c.occurred_at<$4 AND c.expires_at>clock_timestamp() GROUP BY c.candidate_id
  ), outcomes AS (
   SELECT c.candidate_id,bool_or(a.content->>'result'='conversation' AND a.content->'occurrence'->>'kind'='known' AND (a.content->'occurrence'->>'occurredAt')::timestamptz>=c.selected_at AND (a.content->'occurrence'->>'occurredAt')::timestamptz<$4) AS conversation,bool_or(a.content->>'result'='no_answer' AND a.content->'occurrence'->>'kind'='known' AND (a.content->'occurrence'->>'occurredAt')::timestamptz>=c.selected_at AND (a.content->'occurrence'->>'occurredAt')::timestamptz<$4) AS no_answer,
   bool_or(a.content->>'result'='callback_requested' AND a.content->'occurrence'->>'kind'='known' AND (a.content->'occurrence'->>'occurredAt')::timestamptz>=c.selected_at AND (a.content->'occurrence'->>'occurredAt')::timestamptz<$4) AS callback_requested,bool_or(a.content->>'result'='not_interested' AND a.content->'occurrence'->>'kind'='known' AND (a.content->'occurrence'->>'occurredAt')::timestamptz>=c.selected_at AND (a.content->'occurrence'->>'occurredAt')::timestamptz<$4) AS not_interested,
   count(a.id) FILTER(WHERE a.content->'occurrence'->>'kind'='known' AND (a.content->'occurrence'->>'occurredAt')::timestamptz>=c.selected_at AND (a.content->'occurrence'->>'occurredAt')::timestamptz<$4)::integer AS reported_attempts,count(a.id) FILTER(WHERE a.content->'occurrence'->>'kind'='unknown')::integer AS unplaced_reported_attempts,bool_or(a.content IS NOT NULL AND a.content->>'result'<>'unknown' AND a.content->'occurrence'->>'kind'='known' AND (a.content->'occurrence'->>'occurredAt')::timestamptz>=c.selected_at AND (a.content->'occurrence'->>'occurredAt')::timestamptz<$4) AS known
   FROM cohort c LEFT JOIN sourcing_manual_prospect_attempts a ON a.workspace_id=$1 AND a.candidate_id=c.candidate_id AND a.candidate_revision=c.candidate_revision AND a.content IS NOT NULL
   AND c.selected_at IS NOT NULL AND a.recorded_at>=c.selected_at AND a.recorded_at<$4
   GROUP BY c.candidate_id
  ) SELECT count(*)::integer AS considered,count(*) FILTER(WHERE c.selected_at IS NOT NULL)::integer AS selected,COALESCE(sum(o.reported_attempts),0)::integer AS reported_attempts,COALESCE(sum(o.unplaced_reported_attempts),0)::integer AS unplaced_reported_attempts,
  count(*) FILTER(WHERE o.conversation)::integer AS conversation,count(*) FILTER(WHERE o.no_answer)::integer AS no_answer,
  count(*) FILTER(WHERE o.callback_requested)::integer AS callback_requested,count(*) FILTER(WHERE o.not_interested)::integer AS not_interested,
  count(*) FILTER(WHERE c.selected_at IS NOT NULL AND NOT COALESCE(o.known,false))::integer AS unknown
  FROM cohort c JOIN outcomes o USING(candidate_id)`,[ctx.scope.workspaceId,'all',input.from,input.to])).rows[0]!;
  const cohorts=(await ctx.db.query<{fit:string;value:string;timing:string;roles:string[];considered:number;selected:number;reported_attempts:number;unplaced_reported_attempts:number;conversation:number;noAnswer:number;unknown:number;reportedAttempts:number;unplacedReportedAttempts:number}>(`WITH permitted AS (${MANUAL_ACTIVITY_RAW_SQL}), events AS (
   SELECT c.* FROM sourcing_prospect_considerations c JOIN permitted p ON p.id=c.candidate_id
   WHERE c.workspace_id=$1 AND c.occurred_at>=$3 AND c.occurred_at<$4 AND c.expires_at>clock_timestamp()
  ), first AS (
   SELECT DISTINCT ON(candidate_id) * FROM events ORDER BY candidate_id,(disposition='selected') DESC,occurred_at,id
  ), members AS (
   SELECT f.*,(SELECT min(e.occurred_at) FROM events e WHERE e.candidate_id=f.candidate_id AND e.disposition='selected') AS selected_at,
   f.role_kinds AS role_keys FROM first f
  ), outcomes AS (
   SELECT m.candidate_id,bool_or(a.content->>'result'='conversation' AND a.content->'occurrence'->>'kind'='known' AND (a.content->'occurrence'->>'occurredAt')::timestamptz>=m.selected_at AND (a.content->'occurrence'->>'occurredAt')::timestamptz<$4) AS conversation,bool_or(a.content->>'result'='no_answer' AND a.content->'occurrence'->>'kind'='known' AND (a.content->'occurrence'->>'occurredAt')::timestamptz>=m.selected_at AND (a.content->'occurrence'->>'occurredAt')::timestamptz<$4) AS no_answer,
    count(a.id) FILTER(WHERE a.content->'occurrence'->>'kind'='known' AND (a.content->'occurrence'->>'occurredAt')::timestamptz>=m.selected_at AND (a.content->'occurrence'->>'occurredAt')::timestamptz<$4)::integer AS reported_attempts,count(a.id) FILTER(WHERE a.content->'occurrence'->>'kind'='unknown')::integer AS unplaced_reported_attempts,bool_or(a.content IS NOT NULL AND a.content->>'result'<>'unknown' AND a.content->'occurrence'->>'kind'='known' AND (a.content->'occurrence'->>'occurredAt')::timestamptz>=m.selected_at AND (a.content->'occurrence'->>'occurredAt')::timestamptz<$4) AS known
   FROM members m LEFT JOIN sourcing_manual_prospect_attempts a ON a.workspace_id=$1 AND a.candidate_id=m.candidate_id AND a.candidate_revision=m.candidate_revision
    AND m.selected_at IS NOT NULL AND a.recorded_at>=m.selected_at AND a.recorded_at<$4 AND a.content IS NOT NULL GROUP BY m.candidate_id
  ) SELECT m.fit,m.value,m.timing,m.role_keys AS roles,COALESCE(sum(o.reported_attempts),0)::integer AS "reportedAttempts",COALESCE(sum(o.unplaced_reported_attempts),0)::integer AS "unplacedReportedAttempts",count(*)::integer AS considered,count(*) FILTER(WHERE m.selected_at IS NOT NULL)::integer AS selected,
   count(*) FILTER(WHERE o.conversation)::integer AS conversation,count(*) FILTER(WHERE o.no_answer)::integer AS "noAnswer",
   count(*) FILTER(WHERE m.selected_at IS NOT NULL AND NOT COALESCE(o.known,false))::integer AS unknown
   FROM members m JOIN outcomes o USING(candidate_id) GROUP BY m.fit,m.value,m.timing,m.role_keys ORDER BY m.fit,m.value,m.timing,m.role_keys LIMIT 101`,[ctx.scope.workspaceId,'all',input.from,input.to])).rows;
  return prospectPriorityLearningSchema.parse({...input,reportedAttempts:row.reported_attempts,unplacedReportedAttempts:row.unplaced_reported_attempts,elapsedMinutes:'unavailable',considered:row.considered,selected:row.selected,observations:{conversation:row.conversation,no_answer:row.no_answer,callback_requested:row.callback_requested,not_interested:row.not_interested,unknown:row.unknown},coverage:'current_retained_only',appropriatePerson:'unavailable',cohorts:cohorts.slice(0,100),cohortsHasMore:cohorts.length>100,paidAdoption:'unavailable',retention:'unavailable'});
 };
 const first=await query();await requireManualActivityAuthority(ctx,authority);const last=await query();
 if(JSON.stringify(first)!==JSON.stringify(last))return {ok:false as const,reason:'view_changed'};
 return {ok:true as const,value:last};
}
