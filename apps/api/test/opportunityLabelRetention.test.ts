import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm, seedContact } from './support/crmSeed.ts';
import { recordingSuppressionJournal } from '@fss/domain/suppression/journal.ts';

it('redacts human opportunity names with firm deletion while preserving them during contact-only deletion', async () => {
  const fixture=await createAuthFixture();
  try {
    const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
    const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},
      {session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,suppressionJournal:recordingSuppressionJournal()});
    const command=(fields:Record<string,unknown>)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
    const firmId=await seedFirm(fixture,{name:'Label privacy firm',regionCode:'TX',assignedUserId:fixture.alpha.admin.userId});
    const contactId=await seedContact(fixture,{firmId,fullName:'Contact removed independently'});
    expect((await post('/opportunities/v2/open',command({firmId,name:'Private initiative label'}))).status).toBe(200);
    const remove=async(targetKind:'contact'|'firm')=>{
      const preview=await post('/retention/deletions/preview',command({targetKind,firmId,...(targetKind==='contact'?{contactId}:{})}));
      expect(preview.status).toBe(200);
      const shown=(preview.body as {result:{requestId:string;previewHash:string;redacts:Record<string,number>}}).result;
      expect((await post('/retention/deletions/commit',command({requestId:shown.requestId,previewHash:shown.previewHash}))).status).toBe(200);
      return shown;
    };
    await remove('contact');
    expect((await post('/crm/firm-page-v3',{firmId,pageVersion:2})).body).toMatchObject({opportunities:[{displayName:'Private initiative label',stageControlMode:'human'}]});
    const firmPreview=await remove('firm');
    expect(firmPreview.redacts['opportunities']).toBe(1);
    const page=await post('/crm/firm-page-v3',{firmId,pageVersion:2});
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({opportunities:[{displayName:null,stageControlMode:'human'}]});
    expect(JSON.stringify(page.body)).not.toContain('Private initiative label');
  } finally {await fixture.stop();}
});
