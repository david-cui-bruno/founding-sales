import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import type {EmailCampaignPolicy} from '@fss/contracts';
import {createAuthFixture} from '../../../../apps/api/test/support/authFixture.ts';
import {withTransaction} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {setProspectingAuthorization} from '../../outreach/authorization.ts';
import {approveEmailCampaign,readEmailCampaignControl} from '../../outreach/emailCampaign.ts';
import {createSequence,createDraftVersion,publishVersion} from '../../sequences/definitions.ts';
import {createTemplateVersion} from '../../templates/templates.ts';

it('approves an initial-email-only campaign after publication without requiring follow-ups',async()=>{
 const f=await createAuthFixture();
 try{
  const w=f.alpha.workspaceId,owner=f.alpha.admin.userId;
  const context=repositoryContext(workspaceScope(w,{kind:'user',userId:owner,role:'admin'}),f.db);
  const tx=<T>(work:()=>Promise<T>)=>withTransaction(f.db,work);
  const mailbox=(await f.db.query<{id:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,$3,$4,'connected') RETURNING id",[w,owner,'founder@example.test',randomUUID()])).rows[0]!;
  const authorization=await tx(()=>setProspectingAuthorization(context,{mailboxId:mailbox.id,expectedRevision:0,enabled:true,basis:'owner_reported_google_permission'}));
  expect(authorization.ok).toBe(true);if(!authorization.ok)throw new Error(authorization.reason);
  const template=await tx(()=>createTemplateVersion(context,{name:'Discovery initial email',subject:'A question for {firm_name}',body:'Hello,\n\nCould we discuss maintenance at {firm_name}?',footer:{signOff:'Sam Example\nCallie'},requiredVariables:['firm_name'],approve:true}));
  expect(template.ok).toBe(true);if(!template.ok)throw new Error(template.reason);
  const sequence=await tx(()=>createSequence(context,{name:'Initial email only'}));
  expect(sequence.ok).toBe(true);if(!sequence.ok)throw new Error(sequence.reason);
  const draft=await tx(()=>createDraftVersion(context,{sequenceId:sequence.value.id,steps:[{ordinal:1,channel:'email',delay:{unit:'elapsed',hours:0},templateVersionId:template.value.id}]}));
  expect(draft.ok).toBe(true);if(!draft.ok)throw new Error(draft.reason);
  const policy:EmailCampaignPolicy={mailboxId:mailbox.id,authorizationRevision:authorization.value.revision,sequenceVersionId:draft.value.sequenceVersionId,regions:['TX'],maxEnrollments:25,dailyAdmissionLimit:5,expiresAt:new Date(Date.now()+86_400_000).toISOString()};
  expect((await tx(()=>approveEmailCampaign(context,policy))).ok).toBe(false);
  const publication=await tx(()=>publishVersion(context,{sequenceVersionId:draft.value.sequenceVersionId}));
  expect(publication.ok).toBe(true);if(!publication.ok)throw new Error(publication.reason);
  const approval=await tx(()=>approveEmailCampaign(context,policy));
  expect(approval.ok,approval.ok?'':approval.reason).toBe(true);if(!approval.ok)throw new Error(approval.reason);
  const control=await tx(()=>readEmailCampaignControl(context));
  expect(control?.campaigns).toContainEqual(expect.objectContaining({id:approval.value.campaignId,state:'active',sequenceVersionId:draft.value.sequenceVersionId}));
  expect(control?.sequences).toContainEqual(expect.objectContaining({id:draft.value.sequenceVersionId}));
 }finally{await f.stop();}
});
