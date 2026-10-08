import {meetingFollowThroughViewSchema,meetingFollowThroughViewV2Schema} from '@fss/contracts';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { templateContentHash } from '@fss/domain/src/rules/templates.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { readMeetingOutcomes } from '@fss/domain/meetings/outcomes.ts';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm } from './support/crmSeed.ts';
describe('meeting follow-through API', () => {
  let f: AuthFixture, token: string, firmId: string, meetingId: string, planId: string;
  const call=(path:string,body?:unknown,query=new URLSearchParams({meetingId}))=>dispatch({method:body===undefined?'GET':'POST',path,query,headers:{authorization:`Bearer ${token}`},body},{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://example.test/update'});
  beforeAll(async()=>{
    f=await createAuthFixture(); token=(await issueSessionFor(f,f.alpha,f.alpha.salesperson)).accessToken;
    firmId=await seedFirm(f,{name:'Recap API fixture',regionCode:'TX',assignedUserId:f.alpha.salesperson.userId}); meetingId=randomUUID(); planId=randomUUID();
    await f.db.query("INSERT INTO meetings(workspace_id,id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at) VALUES($1,$2,$3,'recap-api','recap-api','booked',now(),now(),now())",[f.alpha.workspaceId,meetingId,firmId]);
  });
  afterAll(async()=>{await f.stop();});
  it('reads an empty plan without inventing a sendable recap',async()=>{
    expect((await call('/meetings/follow-through')).body).toMatchObject({planId:null,currentDraft:null,sendingPaused:true});
  });
  it('negotiates extended metadata without breaking strict legacy readers',async()=>{
    const old=await call('/meetings/follow-through');expect(meetingFollowThroughViewSchema.safeParse(old.body).success).toBe(true);expect(old.body).not.toHaveProperty('approvalRequired');
    const current=await call('/meetings/follow-through',undefined,new URLSearchParams({meetingId,version:'2'}));expect(meetingFollowThroughViewV2Schema.safeParse(current.body).success).toBe(true);expect(current.body).toHaveProperty('approvalRequired',false);
  });
  it('guards editing by version, keeps receipts free of content and reauthorizes replay',async()=>{
    const workspace=f.alpha.workspaceId,context=repositoryContext(workspaceScope(workspace,{kind:'user',userId:f.alpha.salesperson.userId,role:'salesperson'}),f.db);
    const source=(await readMeetingOutcomes(context,{meetingId}))!.sourceHash,templateId=randomUUID(),templateVersionId=randomUUID();
    const subject='Meeting details',body='Private recap words.\n\nDavid';
    await f.db.query(`INSERT INTO template_versions(workspace_id,id,template_id,version,name,subject,body,content_hash,footer_sign_off,required_variables,approved_at,approved_by_user_id) VALUES($1,$2,$3,1,'Recap',$4,$5,$6,'David','{}',now(),$7)`,[workspace,templateVersionId,templateId,subject,body,templateContentHash({templateId,version:1,subject,body}),f.alpha.admin.userId]);
    await f.db.query(`INSERT INTO meeting_follow_through(workspace_id,id,meeting_id,firm_id,owner_user_id,source_hash,notes_revision,current_draft_version) VALUES($1,$2,$3,$4,$5,$6,0,1)`,[workspace,planId,meetingId,firmId,f.alpha.salesperson.userId,source]);
    await f.db.query(`INSERT INTO meeting_follow_through_drafts(workspace_id,plan_id,version,subject,body,rendered_hash,template_version_id,template_content_hash,source_hash,created_at,not_before) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,now(),now()+interval '30 minutes')`,[workspace,planId,subject,body,'a'.repeat(64),templateVersionId,templateContentHash({templateId,version:1,subject,body}),source]);
    const begin={planId,expectedPlanVersion:1,expectedDraftVersion:1,action:'begin_edit',commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
    const begun=await call('/meetings/recap/edit',begin); expect(begun.status).toBe(200); expect(begun.body).toMatchObject({result:{currentDraft:{state:'editing'}}});
    expect(meetingFollowThroughViewSchema.safeParse((begun.body as {result:unknown}).result).success).toBe(true);
    const version=(begun.body as {result:{version:number}}).result.version;
    expect((await call('/meetings/recap/edit',{...begin,action:'save',subject,body:'A stale edit',commandId:randomUUID()})).status).toBe(409);
    const save={...begin,expectedPlanVersion:version,action:'save',subject,body:'Revised private recap.\n\nDavid',commandId:randomUUID()};
    expect((await call('/meetings/recap/edit',save)).body).toMatchObject({result:{currentDraft:{version:2,body:save.body}}});
    expect((await call('/meetings/recap/edit',save)).body).toMatchObject({replayed:true,result:{currentDraft:{version:2}}});
    const v2=await call('/meetings/recap/edit',save,new URLSearchParams({version:'2'}));expect(v2.body).toMatchObject({replayed:true,result:{approvalRequired:true}});expect(meetingFollowThroughViewV2Schema.safeParse((v2.body as {result:unknown}).result).success).toBe(true);
    expect(JSON.stringify((await f.db.query('SELECT result FROM command_receipts WHERE command_id=$1',[save.commandId])).rows)).not.toContain('private recap');
    await f.db.query('UPDATE firms SET assigned_user_id=$2 WHERE id=$1',[firmId,f.alpha.admin.userId]);
    expect((await call('/meetings/recap/edit',save)).status).toBe(404);
    expect((await call('/meetings/follow-through')).status).toBe(404);
  });
  it('exposes recap configuration only when requested, initially unset',async()=>{
    expect((await call('/settings/integrations')).body).not.toHaveProperty('meetingFollowThrough');
    expect((await call('/settings/integrations',undefined,new URLSearchParams({include:'meeting_follow_through'}))).body).toMatchObject({meetingFollowThrough:{setting:{sequenceVersionId:null},choices:[]}});
  });
});
