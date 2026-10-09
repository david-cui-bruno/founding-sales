import type {z} from 'zod';
import type {askReadSchema,FirmTaskDto} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {listPeople} from './people.ts';
import {lockIdentityContext,activeIdentityActor} from './identityAccess.ts';

/** Server-defined exact state, bounded display; neither a model nor source text supplies SQL. */
export async function readAsk(context:RepositoryContext,input:z.infer<typeof askReadSchema>){
 if(input.operation==='records'&&input.kind==='firms') {
  if(!await activeIdentityActor(context))return null;
  const rows=(await context.db.query<{id:string;name:string}>("SELECT id,name FROM firms WHERE workspace_id=$1 AND status='active' AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3",[context.scope.workspaceId,input.afterId??null,input.limit+1])).rows;
  const query=input.query.normalize('NFKC').toLocaleLowerCase('en-US');
  const records=rows.slice(0,input.limit).filter(row=>row.name.normalize('NFKC').toLocaleLowerCase('en-US').includes(query)).map(row=>({recordId:row.id,kind:'firm' as const,name:row.name,firmId:row.id}));
  if(!await activeIdentityActor(context))return null;
  const nextAfterId=rows.length>input.limit?rows[input.limit-1]!.id:null;
  return {operation:'records' as const,selection:nextAfterId!==null?'unresolved' as const:records.length>1?'ambiguous' as const:records.length===1?'single' as const:'none' as const,records,nextAfterId,scanComplete:nextAfterId===null,coverage:{scope:'current_permitted_crm_state' as const,acquisition:'unverified' as const,semantic:'not_requested' as const}};
 }
 if(input.operation==='records') {
  const page=await listPeople(context,{afterId:input.afterId,limit:input.limit});
  const query=input.query.normalize('NFKC').toLocaleLowerCase('en-US');
  const records=page.people.filter(person=>person.fullName.normalize('NFKC').toLocaleLowerCase('en-US').includes(query)).map(person=>({recordId:person.personId,kind:'person' as const,name:person.fullName,firmId:person.firm?.firmId??null}));
  return {operation:'records' as const,selection:page.nextAfterId!==null?'unresolved' as const:records.length>1?'ambiguous' as const:records.length===1?'single' as const:'none' as const,records,nextAfterId:page.nextAfterId,scanComplete:page.nextAfterId===null,coverage:{scope:'current_permitted_crm_state' as const,acquisition:'unverified' as const,semantic:'not_requested' as const}};
 }
 if(!await lockIdentityContext(context,{firmIds:[input.scope.firmId]}))return null;
 if(input.operation==='tasks'){
  const relation=`WITH tasks AS (
   SELECT 'callback:'||id::text AS key,'callback' AS kind,'callback' AS label,due_at,'open' AS status,NULL::jsonb AS deadline FROM callbacks WHERE workspace_id=$1 AND firm_id=$2 AND status='open'
   UNION ALL SELECT 'call_task:'||id::text,'call_task',text,due_at,'open',NULL::jsonb FROM call_tasks WHERE workspace_id=$1 AND firm_id=$2 AND status='open'
   UNION ALL SELECT 'step:'||id::text,'step',channel,due_at,CASE WHEN state='held' THEN 'held' ELSE 'open' END,NULL::jsonb FROM step_executions WHERE workspace_id=$1 AND firm_id=$2 AND state IN ('pending','held') AND channel IN ('call_task','linkedin_task')
   UNION ALL SELECT 'meeting_task:'||id::text,'meeting_task',left(label,300),due_at,'open',deadline FROM meeting_tasks WHERE workspace_id=$1 AND firm_id=$2 AND status='open'
  ), scoped AS (SELECT * FROM tasks WHERE ($3::timestamptz IS NULL OR due_at>=$3) AND ($4::timestamptz IS NULL OR due_at<$4))`;
  const params=[context.scope.workspaceId,input.scope.firmId,input.scope.from??null,input.scope.to??null];
  const count=(await context.db.query<{count:string}>(relation+' SELECT count(*)::text AS count FROM scoped',params)).rows[0]!.count;
  const rows=(await context.db.query<{key:string;kind:FirmTaskDto['kind'];label:string;due_at:Date;status:'open'|'held';deadline:FirmTaskDto['deadline']}>(relation+' SELECT * FROM scoped ORDER BY due_at,key LIMIT $5',[...params,input.limit+1])).rows;
  if(!await activeIdentityActor(context))return null;
  return {operation:'tasks' as const,scope:input.scope,dateBasis:'task_due_at' as const,count,records:rows.slice(0,input.limit).map(row=>({key:row.key,kind:row.kind,label:row.label,dueAt:row.due_at.toISOString(),status:row.status,...(row.deadline===null?{}:{deadline:row.deadline})})),truncated:rows.length>input.limit,coverage:{scope:'current_permitted_crm_state' as const,acquisition:'unverified' as const,semantic:'not_requested' as const}};
 }
 const count=(await context.db.query<{count:string}>("SELECT count(*)::text AS count FROM opportunities WHERE workspace_id=$1 AND firm_id=$2 AND ($3='all' OR status=$3) AND ($4::timestamptz IS NULL OR opened_at>=$4) AND ($5::timestamptz IS NULL OR opened_at<$5)",[context.scope.workspaceId,input.scope.firmId,input.status,input.scope.from??null,input.scope.to??null])).rows[0]!.count;
 const rows=(await context.db.query<{id:string;firm_id:string;display_name:string|null;status:'open'|'won'|'lost';stage_key:string;opened_at:Date}>(`SELECT o.id,o.firm_id,o.display_name,o.status,p.key AS stage_key,o.opened_at FROM opportunities o JOIN pipeline_stages p ON p.workspace_id=o.workspace_id AND p.id=o.stage_id WHERE o.workspace_id=$1 AND o.firm_id=$2 AND ($3='all' OR o.status=$3) AND ($4::timestamptz IS NULL OR o.opened_at>=$4) AND ($5::timestamptz IS NULL OR o.opened_at<$5) ORDER BY o.opened_at,o.id LIMIT $6`,[context.scope.workspaceId,input.scope.firmId,input.status,input.scope.from??null,input.scope.to??null,input.limit+1])).rows;
 if(!await activeIdentityActor(context))return null;
 return {operation:'opportunities' as const,scope:input.scope,dateBasis:'opportunity_opened_at' as const,count,records:rows.slice(0,input.limit).map(row=>({opportunityId:row.id,firmId:row.firm_id,name:row.display_name,status:row.status,stageKey:row.stage_key,openedAt:row.opened_at.toISOString()})),truncated:rows.length>input.limit,coverage:{scope:'current_permitted_crm_state' as const,acquisition:'unverified' as const,semantic:'not_requested' as const}};
}
