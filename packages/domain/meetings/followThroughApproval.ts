import type {AnswerBlock} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readSequenceVersion} from '../sequences/rows.ts';
import {readTemplateVersion,renderTemplateVersion} from '../templates/templates.ts';
import {templateVariablesFor} from '../sequences/variables.ts';
import {composeBodyForWorkspace} from '../outbound/footer.ts';
import {createHash} from 'node:crypto';
import {readApprovedAnswerBlocks} from '../outreach/facts.ts';
import type {FollowThroughRow,FollowThroughDraftRow} from './followThroughTypes.ts';
type Result<T>={ok:true;value:T}|{ok:false;reason:string};
/** Exact approved template bytes remain authority; matching shared claims add their current version authority. */
export async function meetingPlanSources(ctx:RepositoryContext,plan:FollowThroughRow,draft:FollowThroughDraftRow):Promise<Result<{templates:{id:string;hash:string}[];facts:AnswerBlock[]}>> {
 const version=plan.sequence_version_id===null?null:await readSequenceVersion(ctx,plan.sequence_version_id);
 if(version===null||version.state!=='published'||version.steps.length<1||version.steps.length>3||version.steps.some(s=>s.channel!=='email'))return {ok:false,reason:'recap_sequence_required'};
 const templates:{id:string;hash:string}[]=[];const texts=[draft.subject,draft.body];
 for(const step of version.steps){const t=step.templateVersionId===null?null:await readTemplateVersion(ctx,step.templateVersionId);if(t===null||t.approvedAt===null||t.retiredAt!==null)return {ok:false,reason:'template_unapproved'};templates.push({id:t.id,hash:t.contentHash});if(step.ordinal>draft.ordinal)texts.push(t.subject,t.body);}
 const refs=(await ctx.db.query<{id:string;version:number}>(`SELECT DISTINCT ON (b.id) b.id,v.version FROM outreach_answer_blocks b JOIN outreach_answer_block_versions v ON v.workspace_id=b.workspace_id AND v.block_id=b.id WHERE b.workspace_id=$1 AND strpos($2,v.text)>0 ORDER BY b.id,v.version DESC LIMIT 21`,[ctx.scope.workspaceId,texts.join('\n')])).rows;
 if(refs.length>20)return {ok:false,reason:'facts_catalogue_too_large'};
 const facts=refs.length===0?{ok:true as const,value:[]}:await readApprovedAnswerBlocks(ctx,refs);
 return facts.ok?{ok:true,value:{templates,facts:facts.value}}:{ok:false,reason:`facts_${facts.reason}`};
}
export async function verifyMeetingPlanApproval(ctx:RepositoryContext,plan:FollowThroughRow,draft:FollowThroughDraftRow|null):Promise<string|null>{
 if(plan.approval_mode==='legacy_template')return null;
 if(plan.approval===null)return 'approval_required';
 if(draft===null)return 'draft_not_ready';
 const a=plan.approval;
 if(a.sourceHash!==plan.source_hash||a.sequenceVersionId!==plan.sequence_version_id)return 'source_changed';
 if(a.facts.length){const current=await readApprovedAnswerBlocks(ctx,a.facts);if(!current.ok)return `facts_${current.reason}`;}
 const sources=await meetingPlanSources(ctx,plan,draft);if(!sources.ok)return sources.reason;
 if(JSON.stringify(sources.value.templates)!==JSON.stringify(a.templates))return 'template_changed';
 if(sources.value.facts.some(f=>!a.facts.some(old=>old.id===f.id&&old.version===f.version)))return 'facts_changed';
 const approvedHash=a.draftHashes[String(draft.ordinal)];
 if(approvedHash!==undefined)return approvedHash===draft.rendered_hash?null:'content_changed';
 return 'approval_required';
}

export async function meetingPlannedMessages(ctx:RepositoryContext,plan:FollowThroughRow,draft:FollowThroughDraftRow):Promise<{ordinal:number;subject:string;body:string}[]> {
 const version=plan.sequence_version_id===null?null:await readSequenceVersion(ctx,plan.sequence_version_id);
 const messages=[{ordinal:draft.ordinal,subject:draft.subject,body:draft.body}];
 if(version===null||plan.contact_id===null)return messages;
 for(const step of version.steps){if(step.ordinal===draft.ordinal||step.ordinal<draft.ordinal)continue;
  const t=step.templateVersionId===null?null:await readTemplateVersion(ctx,step.templateVersionId);if(t===null||t.approvedAt===null||t.retiredAt!==null)continue;
  const rendered=renderTemplateVersion(t,await templateVariablesFor(ctx,{firmId:plan.firm_id,contactId:plan.contact_id}));if(!rendered.rendered||t.requiredVariables.includes('meeting_recap'))continue;
  const composed=await composeBodyForWorkspace(ctx,{body:rendered.body,signOff:t.footerSignOff});if(composed.composed)messages.push({ordinal:step.ordinal,subject:rendered.subject,body:composed.body});
 }
 return messages;
}

/** A view token binds future rendered bytes too; plan integers alone do not track fact/variable changes. */
export async function meetingApprovalHash(ctx:RepositoryContext,plan:FollowThroughRow,draft:FollowThroughDraftRow):Promise<string|null>{
 const sources=await meetingPlanSources(ctx,plan,draft);if(!sources.ok)return null;
 const messages=await meetingPlannedMessages(ctx,plan,draft);
 return createHash('sha256').update(JSON.stringify({sourceHash:plan.source_hash,sequenceVersionId:plan.sequence_version_id,draftVersion:draft.version,renderedHash:draft.rendered_hash,...sources.value,messages})).digest('hex');
}
