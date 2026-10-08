import type { RepositoryContext } from '../db/workspaceScope.ts';

export interface SenderRecovery {
 readonly epochId: string;
 readonly active: boolean;
 readonly startedOn: string;
 readonly stageCap: number;
 readonly earnedCap: number;
 readonly qualifyingDays: number;
 readonly nextStageAfterDays: number;
 readonly lastQualifiedOn: string | null;
 readonly stageStartedOn: string;
}
const STAGES = [5,10,15,25,35,50] as const;
export function recoveryStageIndex(qualifyingDays: number): number {
 return Math.min(Math.floor(Math.max(qualifyingDays,0)/5),STAGES.length-1);
}
export function recoveryStageCap(qualifyingDays: number): number {
 return STAGES[recoveryStageIndex(qualifyingDays)] ?? 5;
}

/** One SQL decision locks the ramp and binds the current epoch to an observed
 * activity anchor. This works outside a caller transaction as well as inside the
 * final dispatch's existing transaction. No health read can authorize a send. */
export async function assessInactivity(context: RepositoryContext, mailboxId: string, earnedCap: number, now?: Date): Promise<void> {
 await context.db.query(`WITH locked AS MATERIALIZED (
 SELECT * FROM mailbox_send_ramp WHERE workspace_id=$1 AND mailbox_id=$2 FOR UPDATE
 ), activity AS MATERIALIZED (
 SELECT COALESCE(GREATEST(
  (SELECT max(sent_at) FROM outbound_messages WHERE workspace_id=$1 AND mailbox_id=$2 AND state='sent'),
  (SELECT max(m.internal_date) FROM mail_messages m JOIN mail_message_effects e
   ON e.workspace_id=m.workspace_id AND e.mail_message_id=m.id
   WHERE m.workspace_id=$1 AND m.mailbox_id=$2 AND e.effect_kind IN ('direct_send_manual','direct_send_conversation'))
 ),m.created_at) AS at,w.business_time_zone AS zone,
 (COALESCE($4::timestamptz,clock_timestamp()) AT TIME ZONE w.business_time_zone)::date AS today
 FROM mailboxes m JOIN workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=$1 AND m.id=$2
 ), epoch AS (
 INSERT INTO mailbox_recovery_epochs(workspace_id,mailbox_id,activity_at,started_on,earned_cap,stage_started_on)
 SELECT $1,$2,a.at,a.today,$3,a.today FROM activity a,locked l
 WHERE a.today-(a.at AT TIME ZONE a.zone)::date>=14
 AND NOT EXISTS(SELECT 1 FROM mailbox_recovery_epochs e WHERE e.workspace_id=$1 AND e.id=l.recovery_epoch_id AND e.activity_at>=a.at)
 ON CONFLICT(workspace_id,mailbox_id,activity_at) DO UPDATE SET updated_at=mailbox_recovery_epochs.updated_at
 RETURNING id
 ) UPDATE mailbox_send_ramp r SET recovery_epoch_id=e.id,updated_at=now()
 FROM epoch e,locked l WHERE r.workspace_id=$1 AND r.mailbox_id=$2`,
 [context.scope.workspaceId,mailboxId,earnedCap,now?.toISOString() ?? null]);
}

export async function readRecovery(context: RepositoryContext, mailboxId: string): Promise<SenderRecovery|null> {
 const row=(await context.db.query<{id:string;started_on:string;earned_cap:number;qualifying_days:number;last_qualified_on:string|null;stage_started_on:string}>(
 `SELECT e.id,e.started_on::text,e.earned_cap,e.qualifying_days,e.last_qualified_on::text,e.stage_started_on::text
 FROM mailbox_send_ramp r JOIN mailbox_recovery_epochs e ON e.workspace_id=r.workspace_id AND e.id=r.recovery_epoch_id
 WHERE r.workspace_id=$1 AND r.mailbox_id=$2`,[context.scope.workspaceId,mailboxId])).rows[0];
 if(!row)return null;
 const stageCap=Math.min(recoveryStageCap(row.qualifying_days),row.earned_cap);
 const requiredDays=Math.max(5,STAGES.findIndex(cap=>cap>=row.earned_cap)*5);
 const active=row.qualifying_days<requiredDays;
 return {epochId:row.id,active,startedOn:row.started_on,stageCap,earnedCap:row.earned_cap,qualifyingDays:row.qualifying_days,
 nextStageAfterDays:active?5-row.qualifying_days%5:0,lastQualifiedOn:row.last_qualified_on,stageStartedOn:row.stage_started_on};
}

export async function readSenderActivity(context: RepositoryContext, mailboxId: string, now?: Date): Promise<{lastActivityAt:string|null;inactivityDays:number;activityBasis:'confirmed_send'|'mailbox_creation'}> {
 const row=(await context.db.query<{at:Date|null;days:number}>(`WITH observed AS (
 SELECT GREATEST((SELECT max(sent_at) FROM outbound_messages WHERE workspace_id=$1 AND mailbox_id=$2 AND state='sent'),
 (SELECT max(m.internal_date) FROM mail_messages m JOIN mail_message_effects e ON e.workspace_id=m.workspace_id AND e.mail_message_id=m.id
 WHERE m.workspace_id=$1 AND m.mailbox_id=$2 AND e.effect_kind IN ('direct_send_manual','direct_send_conversation'))) AS at
 ) SELECT o.at,greatest((COALESCE($3::timestamptz,clock_timestamp()) AT TIME ZONE w.business_time_zone)::date-
 (COALESCE(o.at,m.created_at) AT TIME ZONE w.business_time_zone)::date,0) AS days
 FROM observed o,mailboxes m JOIN workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=$1 AND m.id=$2`,[context.scope.workspaceId,mailboxId,now?.toISOString()??null])).rows[0];
 return {lastActivityAt:row?.at?.toISOString()??null,inactivityDays:row?.days??0,activityBasis:row?.at?'confirmed_send':'mailbox_creation'};
}
