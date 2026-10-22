import {emailCampaignPolicySchema,type EmailCampaignPolicy,type EmailCampaignControl,type EmailCampaignCommandResult} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {researchActor} from '../sourcing/qualifiedResearchProof.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {authorizationForMailbox} from './authorization.ts';
import {campaignKind} from './settings.ts';
import {admitQualifiedResearchFirmToCampaign,lockEmailCampaignAdmission} from './emailCampaignAdmission.ts';
import {campaignDatabaseNow,campaignExpiryAllowed,campaignView,type EmailCampaignRow,type CurrentCampaignAuthority} from './emailCampaignAuthority.ts';
type Result={ok:true;value:EmailCampaignCommandResult}|{ok:false;reason:string};
async function policySavepoint(ctx:RepositoryContext,work:()=>Promise<Result>):Promise<Result>{
 await ctx.db.query('SAVEPOINT email_campaign_policy');
 try{const result=await work();if(!result.ok)await ctx.db.query('ROLLBACK TO SAVEPOINT email_campaign_policy');await ctx.db.query('RELEASE SAVEPOINT email_campaign_policy');return result;}
 catch(error){await ctx.db.query('ROLLBACK TO SAVEPOINT email_campaign_policy');await ctx.db.query('RELEASE SAVEPOINT email_campaign_policy');throw error;}
}
export async function approveEmailCampaign(ctx:RepositoryContext,input:EmailCampaignPolicy,currentAuthority:CurrentCampaignAuthority=async()=>researchActor(ctx)):Promise<Result>{
 const parsed=emailCampaignPolicySchema.safeParse(input);if(!parsed.success)return {ok:false,reason:'invalid_input'};
 if(ctx.scope.actor.kind!=='user'||!await researchActor(ctx))return {ok:false,reason:'admin_required'};
 const owner=ctx.scope.actor.userId,old=await lockEmailCampaignAdmission(ctx);
 if(!await currentAuthority())return {ok:false,reason:'authority_changed'};
 if(old)return {ok:false,reason:'campaign_already_approved'};
 const policy=parsed.data,now=await campaignDatabaseNow(ctx);
 if(!campaignExpiryAllowed(policy.expiresAt,now))return {ok:false,reason:'campaign_expiry_invalid'};
 const box=(await ctx.db.query('SELECT id FROM mailboxes WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 AND status=\'connected\' FOR SHARE',[ctx.scope.workspaceId,policy.mailboxId,owner])).rows[0];
 const auth=await authorizationForMailbox(ctx,policy.mailboxId);
 if(!box||!auth.allowed||auth.revision!==policy.authorizationRevision)return {ok:false,reason:'mailbox_not_authorized'};
 if(await campaignKind(ctx,policy.sequenceVersionId)!=='email_first')return {ok:false,reason:'approved_five_email_sequence_required'};
 return policySavepoint(ctx,async()=>{
  if(!await currentAuthority()||!await researchActor(ctx))return {ok:false,reason:'authority_changed'};
  const row=(await ctx.db.query<EmailCampaignRow>(`INSERT INTO outreach_email_campaigns(workspace_id,owner_user_id,mailbox_id,sequence_version_id,authorization_revision,regions,max_enrollments,daily_admission_limit,approved_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[ctx.scope.workspaceId,owner,policy.mailboxId,policy.sequenceVersionId,policy.authorizationRevision,policy.regions,policy.maxEnrollments,policy.dailyAdmissionLimit,now,policy.expiresAt])).rows[0]!;
  // At most25 canonical Firms, never unqualified raw rows or provider acquisition.
  const backlog=(await ctx.db.query<{firm_id:string}>(`SELECT DISTINCT l.firm_id FROM sourcing_discovery_research_firms l JOIN firms f ON f.workspace_id=l.workspace_id AND f.id=l.firm_id WHERE l.workspace_id=$1 AND f.assigned_user_id=$2 AND f.status='active' ORDER BY l.firm_id LIMIT 25`,[ctx.scope.workspaceId,owner])).rows;
  for(const firm of backlog){const result=await admitQualifiedResearchFirmToCampaign(ctx,firm.firm_id,currentAuthority);if(!result.ok&&result.reason==='campaign_limit')break;}
  if(!await currentAuthority()||!await researchActor(ctx))return {ok:false,reason:'authority_changed'};
  await recordCrmAuditEvent(ctx,{action:'outreach.email_campaign_approved',subjectKind:'email_campaign',subjectId:row.id,detail:{revision:row.revision,mailboxId:policy.mailboxId,sequenceVersionId:policy.sequenceVersionId,authorizationRevision:policy.authorizationRevision}});
  if(!await currentAuthority())return {ok:false,reason:'authority_changed'};
  return {ok:true,value:{campaignId:row.id,revision:row.revision}};
 });
}
export async function revokeEmailCampaign(ctx:RepositoryContext,input:{id:string;expectedRevision:number},currentAuthority:CurrentCampaignAuthority=async()=>researchActor(ctx)):Promise<Result>{
 if(!await researchActor(ctx))return {ok:false,reason:'admin_required'};
 const row=await lockEmailCampaignAdmission(ctx);
 if(!await currentAuthority())return {ok:false,reason:'authority_changed'};
 if(!row||row.id!==input.id)return {ok:false,reason:'campaign_unavailable'};
 if(row.revision!==input.expectedRevision)return {ok:false,reason:'stale_revision'};
 return policySavepoint(ctx,async()=>{
  await ctx.db.query('UPDATE outreach_email_campaigns SET revoked_at=clock_timestamp(),revision=revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,row.id]);
  await recordCrmAuditEvent(ctx,{action:'outreach.email_campaign_revoked',subjectKind:'email_campaign',subjectId:row.id,detail:{revision:row.revision+1}});
  if(!await currentAuthority()||!await researchActor(ctx))return {ok:false,reason:'authority_changed'};
  return {ok:true,value:{campaignId:row.id,revision:row.revision+1}};
 });
}
/** Private current-admin-only control. Receipts are deliberately read separately. */
export async function readEmailCampaignControl(ctx:RepositoryContext):Promise<EmailCampaignControl|null>{
 if(ctx.scope.actor.kind!=='user'||!await researchActor(ctx))return null;
 const w=ctx.scope.workspaceId,owner=ctx.scope.actor.userId,now=await campaignDatabaseNow(ctx);
 const rows=(await ctx.db.query<EmailCampaignRow & {admitted_count:string}>(`SELECT c.*,(SELECT count(*)::text FROM outreach_email_campaign_admissions a WHERE a.workspace_id=c.workspace_id AND a.campaign_id=c.id) AS admitted_count FROM outreach_email_campaigns c WHERE c.workspace_id=$1 AND c.owner_user_id=$2 ORDER BY c.approved_at DESC,c.id LIMIT 25`,[w,owner])).rows;
 const admissions=(await ctx.db.query<{campaign_id:string;firm_id:string;contact_id:string;route_id:string;plan_id:string;enrollment_id:string;candidate_id:string;qualification_run_id:string;admitted_at:Date}>(`SELECT a.* FROM outreach_email_campaign_admissions a JOIN outreach_email_campaigns c ON c.workspace_id=a.workspace_id AND c.id=a.campaign_id WHERE a.workspace_id=$1 AND c.owner_user_id=$2 ORDER BY a.admitted_at DESC,a.firm_id LIMIT 25`,[w,owner])).rows;
 const senders:EmailCampaignControl['senders']=[];
 for(const box of (await ctx.db.query<{id:string;email_address:string}>(`SELECT id,email_address FROM mailboxes WHERE workspace_id=$1 AND owner_user_id=$2 AND status='connected' ORDER BY id LIMIT 20`,[w,owner])).rows){const auth=await authorizationForMailbox(ctx,box.id);if(auth.allowed&&auth.revision)senders.push({id:box.id,label:box.email_address,authorizationRevision:auth.revision});}
 const sequences:EmailCampaignControl['sequences']=[];
 for(const sequence of (await ctx.db.query<{id:string;name:string;version:number}>(`SELECT v.id,s.name,v.version FROM sequence_versions v JOIN sequences s ON s.workspace_id=v.workspace_id AND s.id=v.sequence_id WHERE v.workspace_id=$1 AND v.state='published' ORDER BY s.name,v.version DESC LIMIT 100`,[w])).rows)if(await campaignKind(ctx,sequence.id)==='email_first')sequences.push({id:sequence.id,label:`${sequence.name} · version ${sequence.version}`});
 if(!await researchActor(ctx))return null;
 return {campaigns:rows.map(row=>campaignView(row,now,Number(row.admitted_count))),admissions:admissions.map(a=>({campaignId:a.campaign_id,firmId:a.firm_id,contactId:a.contact_id,routeId:a.route_id,planId:a.plan_id,enrollmentId:a.enrollment_id,candidateId:a.candidate_id,qualificationRunId:a.qualification_run_id,admittedAt:a.admitted_at.toISOString()})),senders,sequences,sendingAuthority:'unchanged'};
}
