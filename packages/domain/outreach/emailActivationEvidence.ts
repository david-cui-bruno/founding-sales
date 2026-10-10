import {EMAIL_EVALUATION_MANIFEST} from './emailEvaluationManifest.ts';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {emailAdmissionEvaluationSchema} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readReleaseRecord,bindReleaseRecord} from '../release/records.ts';
import {readSequenceVersion} from '../sequences/rows.ts';
import {readTemplateVersion,renderTemplateVersion} from '../templates/templates.ts';
import {EMAIL_FIT_POLICY_VERSION} from './selection.ts';
import {QUALIFICATION_PROMPT_VERSION} from '../sourcing/qualificationStore.ts';
import type {EmailAdmissionActivationProof,EmailAdmissionRuntime} from './emailActivation.ts';
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const guards=['does not create a prospect when automatic email admission is off','rejects a changed exact-version evaluation without partial admission','rejects revoked and reauthorized mailbox bindings until reevaluation','does not reassign a supported firm owned by someone else','refuses a retired evaluated sequence','sees a concurrent recipient stop committed while the worker waits for the send gate','concurrent workers and later retries preserve one enrollment and its original scheduled execution','refuses new admission when the sender ramp has no room','preserves the original manually enrolled Key prospect without rearming or enrolling it again'];
const evaluationReport=z.object({version:z.literal(1),implementationCommit:z.string(),policyVersion:z.string(),promptVersion:z.string(),promptSourceSha256:z.string(),evidenceAsOf:z.iso.datetime(),recordedPromptMatches:z.literal(true),complete:z.literal(true),scope:z.string().min(1),limitations:z.array(z.string()).min(1),corpus:z.array(z.object({path:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/u)})).min(2),reviewedEligible:z.number().int().positive(),falseEligible:z.literal(0),tests:z.array(z.object({name:z.string(),status:z.literal('passed')})).min(1),requiredGuardTests:z.array(z.string()),cases:z.array(z.object({id:z.string(),provenance:z.object({kind:z.string(),reviewNote:z.string().min(1)}).passthrough(),evidence:z.array(z.unknown()),expectedAdmission:z.boolean(),expectedEvidenceAccepted:z.boolean(),expectedRank:z.string().nullable().optional(),actual:z.object({actualAdmission:z.boolean(),evidenceAccepted:z.boolean(),actualRank:z.string().nullable()})})).min(1)});
const deployment=z.object({commit:z.string(),to_schema:z.number().int().positive(),status:z.string(),production:z.object({commit:z.string(),schema:z.number(),passed:z.literal(true),failures:z.array(z.unknown()).length(0),services:z.array(z.object({stable:z.literal(true),running:z.number().int().positive(),desired:z.number().int().positive()})).min(2)}),smoke:z.object({passed:z.literal(true),results:z.array(z.object({name:z.string(),passed:z.literal(true)}))}),release_record:z.object({reference:z.string(),outcome:z.enum(['existing','created']),apiDigest:z.string(),workerDigest:z.string()})});
const rendering=z.strictObject({variables:z.record(z.string(),z.string()),steps:z.array(z.strictObject({ordinal:z.number().int().positive(),templateVersionId:z.string().uuid(),subject:z.string(),body:z.string()})).length(5)});
const interruption=z.strictObject({implementationCommit:z.string(),tests:z.array(z.strictObject({scenario:z.enum(['reply','booking','opt_out']),status:z.literal('passed')})).length(3),scope:z.literal('real_postgres_controlled_provider')});
function timestamp(value:string){const t=Date.parse(value);return Number.isFinite(t)&&t<=Date.now()+300_000;}
/** Retained artifacts are independently checked for identity and content, but
 * remain authenticated operator-reviewed observations, never cryptographic
 * verification of the originating provider or deployment tool. */
export async function inspectEmailAdmissionProof(ctx:RepositoryContext,input:{proof:EmailAdmissionActivationProof;evaluation:unknown;ownerUserId:string;mailboxId:string;sequenceVersionId:string},runtime:EmailAdmissionRuntime):Promise<string|null>{
 const p=input.proof;
 try{
  if(Buffer.byteLength(JSON.stringify(p),'utf8')>1900000)return 'evidence_size_invalid';
  if(p.version!==1||[p.release.observedAt,p.received.observedAt,p.interruptions.observedAt].some(v=>!timestamp(v)))return 'evidence_time_invalid';
  if(p.evaluationReportJson.length>1048576||p.release.deploymentReceiptJson.length>262144||p.received.headerText.length>32768||p.sequence.renderedEvidenceJson.length>65536||p.interruptions.integrationEvidenceJson.length>65536)return 'evidence_size_invalid';
  const e=emailAdmissionEvaluationSchema.parse(input.evaluation),report=evaluationReport.parse(JSON.parse(p.evaluationReportJson));
  if(sha(p.evaluationReportJson)!==e.reportSha256||report.implementationCommit!==runtime.implementationCommit||report.policyVersion!==EMAIL_FIT_POLICY_VERSION||report.promptVersion!==QUALIFICATION_PROMPT_VERSION||report.reviewedEligible!==e.reviewedEligible||report.falseEligible!==e.falseEligible)return 'evaluation_report_mismatch';
  if(!guards.every(name=>report.requiredGuardTests.includes(name)&&report.tests.some(t=>t.name.endsWith(name)))||report.tests.length<=report.cases.length||new Set(report.cases.map(c=>c.id)).size!==report.cases.length||report.cases.some(c=>c.expectedAdmission!==c.actual.actualAdmission||c.expectedEvidenceAccepted!==c.actual.evidenceAccepted||(c.expectedAdmission&&c.expectedRank!==c.actual.actualRank)))return 'evaluation_incomplete';
  if(report.reviewedEligible!==report.cases.filter(c=>c.provenance.kind==='recorded_first_party_extraction'&&c.expectedAdmission&&c.actual.actualAdmission).length||report.falseEligible!==report.cases.filter(c=>!c.expectedAdmission&&c.actual.actualAdmission).length)return 'evaluation_incomplete';
  const manifest=EMAIL_EVALUATION_MANIFEST;
  if(report.promptSourceSha256!==manifest.promptSourceSha256||report.evidenceAsOf!==manifest.evidenceAsOf||canonical(report.corpus)!==canonical(manifest.corpus)||report.cases.length!==manifest.cases.length)return 'evaluation_incomplete';
  for(const expected of manifest.cases){
   const actual=report.cases.find(c=>c.id===expected.id);
   if(!actual||actual.expectedAdmission!==expected.expectedAdmission||actual.expectedEvidenceAccepted!==expected.expectedEvidenceAccepted||actual.expectedRank!==expected.expectedRank||canonical(actual.provenance)!==canonical(expected.provenance)||canonical(actual.evidence)!==canonical(expected.evidence)||!report.tests.some(t=>t.name.endsWith('evaluates labeled email admission: '+expected.id)))return 'evaluation_incomplete';
  }
  const bound=await bindReleaseRecord(ctx,p.release.recordReference,runtime.side,runtime.imageDigest,{production:runtime.production});if(!bound.ok)return bound.reason;
  const record=await readReleaseRecord(ctx,p.release.recordReference);
  if(!record||record.apiDigest!==p.release.apiDigest||record.workerDigest!==p.release.workerDigest||record.desktopCommitStamp!==runtime.implementationCommit||!record.enablesSending)return 'release_evidence_mismatch';
  const d=deployment.parse(JSON.parse(p.release.deploymentReceiptJson));
  if(!['verified_backend_release_complete_desktop_activation_pending','verified_backend_release_complete'].includes(d.status)||d.commit!==runtime.implementationCommit||d.production.commit!==runtime.implementationCommit||d.to_schema!==runtime.schemaVersion||d.production.schema!==runtime.schemaVersion||p.release.schemaVersion!==runtime.schemaVersion||d.production.services.some(s=>s.running!==s.desired)||d.release_record.reference!==record.reference||d.release_record.apiDigest!==record.apiDigest||d.release_record.workerDigest!==record.workerDigest||d.release_record.outcome!==p.release.postSmokeReadback||!['health','readiness','schema_range','connectivity','canary','sending_enabled'].every(name=>d.smoke.results.some(r=>r.name===name)))return 'release_evidence_mismatch';
  const mailbox=(await ctx.db.query<{email_address:string;owner_user_id:string}>('SELECT email_address,owner_user_id FROM mailboxes WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,input.mailboxId])).rows[0];
  if(!mailbox||mailbox.owner_user_id!==input.ownerUserId||p.received.mailboxId!==input.mailboxId||p.received.senderAddress.toLowerCase()!==mailbox.email_address.toLowerCase()||!p.received.messageReference||!p.received.reviewReference)return 'received_authentication_binding_mismatch';
  const headers=p.received.headerText.replace(/\r?\n[ \t]+/gu,' '),address=mailbox.email_address.toLowerCase(),domain=address.split('@')[1]!,escaped=domain.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
  const from=/^From:\s*(?:[^\r\n]*<)?([^<>\s]+@[^<>\s]+)>?\s*$/imu.exec(headers)?.[1]?.toLowerCase(),returnPath=/^Return-Path:\s*<([^<>\s]+)>\s*$/imu.exec(headers)?.[1]?.toLowerCase();
  const auth=/^Authentication-Results:\s*mx\.google\.com\s*;([^\r\n]*)$/imu.exec(headers)?.[1]??'';
  if(from!==address||returnPath!==address||!new RegExp(`\\bspf=pass\\b[^;]*\\bsmtp\\.mailfrom=${address.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')}(?:\\s|;|$)`,'iu').test(auth)||!new RegExp(`\\bdkim=pass\\b[^;]*\\bheader\\.i=@${escaped}(?:\\s|;|$)`,'iu').test(auth)||!new RegExp(`\\bdmarc=pass\\b[^;]*\\bheader\\.from=${escaped}(?:\\s|;|$)`,'iu').test(auth))return 'received_authentication_unverified';
  if(p.sequence.sequenceVersionId!==input.sequenceVersionId)return 'rendered_sequence_mismatch';
  const version=await readSequenceVersion(ctx,input.sequenceVersionId),rendered=rendering.parse(JSON.parse(p.sequence.renderedEvidenceJson));
  if(!version||version.steps.length!==5)return 'rendered_sequence_mismatch';
  if(version.steps.some((step,i)=>step.ordinal!==i+1||step.channel!=='email'||step.delay.unit!=='elapsed'||step.delay.hours!==[0,72,96,144,168][i]))return 'approved_email_cadence_required';
  for(const [i,step] of version.steps.entries()){
   const template=step.templateVersionId?await readTemplateVersion(ctx,step.templateVersionId):null,expected=rendered.steps[i];if(!template||!expected||expected.ordinal!==step.ordinal||expected.templateVersionId!==template.id)return 'rendered_sequence_mismatch';
   const actual=renderTemplateVersion(template,rendered.variables);if(!actual.rendered||actual.subject!==expected.subject||actual.body!==expected.body)return 'rendered_sequence_mismatch';
  }
  const original=(await ctx.db.query<{provider_message_id:string|null;enrollment_id:string;state:string;sent_at:Date|null}>(`SELECT o.provider_message_id,s.enrollment_id,o.state,o.sent_at FROM outbound_messages o JOIN step_executions s ON s.workspace_id=o.workspace_id AND s.id=o.step_execution_id WHERE o.workspace_id=$1 AND o.id=$2 AND o.mailbox_id=$3`,[ctx.scope.workspaceId,p.interruptions.originalOutboundId,input.mailboxId])).rows[0];
  if(!original||original.state!=='sent'||!original.sent_at||original.provider_message_id!==p.interruptions.providerId||original.enrollment_id!==p.interruptions.originalEnrollmentId||!p.interruptions.reviewReference)return 'original_send_unverified';
  const stops=interruption.parse(JSON.parse(p.interruptions.integrationEvidenceJson));
  if(stops.implementationCommit!==runtime.implementationCommit||new Set(stops.tests.map(t=>t.scenario)).size!==3)return 'interruption_evidence_mismatch';
  return null;
 }catch{return 'activation_evidence_invalid';}
}

function canonical(value:unknown):string {
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';
}
