import {candidateCorrectNameInputSchema,qualificationEvidenceSchema,type CandidateInput} from '@fss/contracts';
import type {z} from 'zod';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {decideAdminOnly} from '../crm/authorization.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {databaseNow} from '../policy/clock.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {candidateIdentityKey} from './candidates.ts';
import type {QualificationRunRow,SourcingResult} from './qualificationStore.ts';
const fold=(s:string)=>s.normalize('NFKC').replace(/\s+/gu,' ').trim().toLowerCase();
const host=(s:string)=>new URL(s).hostname.toLowerCase().replace(/^www\./u,'');
/** Caller transaction: send gate, candidate, then evidence. Never changes an admitted CRM firm. */
export async function correctCandidateName(ctx:RepositoryContext,input:z.infer<typeof candidateCorrectNameInputSchema>):Promise<SourcingResult<{id:string;revision:number}>> {
 if(!decideAdminOnly(ctx).permitted)return {ok:false,reason:'admin_only'};
 const parsed=candidateCorrectNameInputSchema.safeParse(input);if(!parsed.success)return {ok:false,reason:'invalid_input'};
 const v=parsed.data,w=ctx.scope.workspaceId;await lockSendGateForStopFact(ctx);
 const row=(await ctx.db.query<{payload:CandidateInput;revision:number;status:string;qualification_blocked:boolean}>('SELECT payload,revision,status,qualification_blocked FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,v.id])).rows[0];
 if(!row)return {ok:false,reason:'not_found'};
 if(row.revision!==v.expectedRevision)return {ok:false,reason:'candidate_changed'};
 if(row.status==='dismissed'||row.qualification_blocked)return {ok:false,reason:'identity_review_required'};
 if((await ctx.db.query(`SELECT candidate_id FROM sourcing_admissions WHERE workspace_id=$1 AND candidate_id=$2
 UNION ALL SELECT candidate_id FROM outreach_email_sources WHERE workspace_id=$1 AND candidate_id=$2
 UNION ALL SELECT candidate_id FROM outreach_plans WHERE workspace_id=$1 AND candidate_id=$2`,[w,v.id])).rows.length)return {ok:false,reason:'candidate_already_admitted'};
 const run=(await ctx.db.query<QualificationRunRow>('SELECT * FROM sourcing_qualification_runs WHERE workspace_id=$1 AND candidate_id=$2 AND id=$3 FOR UPDATE',[w,v.id,v.qualificationRunId])).rows[0];
 if(!run||run.candidate_revision!==row.revision||run.reason||!['review','eligible'].includes(run.state)||!qualificationEvidenceSchema.safeParse({observations:run.observations,facts:run.facts}).success)return {ok:false,reason:'evidence_unavailable'};
 const source=run.observations.find(s=>s.id===v.observationId),fact=run.facts.find(f=>f.kind==='firm_identity'&&f.observationId===v.observationId&&f.blockId===v.blockId&&fold(f.value).includes(fold(v.firmName)));
 const now=Date.parse(await databaseNow(ctx)),age=source?now-Date.parse(source.retrievedAt):Infinity;
 if(!source||!fact||!source.firstParty||source.truncated||host(source.url)!==host(row.payload.website)||age<0||age>7*86400000)return {ok:false,reason:'identity_evidence_required'};
 if(row.payload.firmName===v.firmName)return {ok:true,value:{id:v.id,revision:row.revision}};
 const payload={...row.payload,firmName:v.firmName},key=candidateIdentityKey(payload);
 if((await ctx.db.query('SELECT id FROM sourcing_candidates WHERE workspace_id=$1 AND identity_key=$2 AND id<>$3',[w,key,v.id])).rows.length)return {ok:false,reason:'candidate_identity_conflict'};
 await ctx.db.query("UPDATE sourcing_candidates SET payload=$3::jsonb,identity_key=$4,revision=revision+1,status='needs_review',source_check=NULL,next_source_check_at=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2",[w,v.id,JSON.stringify(payload),key]);
 // Old runs and discovery hits stay intact; revision checks invalidate them for admission and sending.
 await recordCrmAuditEvent(ctx,{action:'sourcing.candidate_name_corrected',subjectKind:'sourcing_candidate',subjectId:v.id,detail:{previousRevision:row.revision,previousName:row.payload.firmName,firmName:v.firmName,reason:v.reason,runId:run.id,observationId:source.id,blockId:v.blockId}});
 return {ok:true,value:{id:v.id,revision:row.revision+1}};
}
