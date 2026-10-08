import {afterAll,beforeAll,expect,it} from 'vitest';
import {outreachSenderStandingV2ResponseSchema,outreachSenderStandingResponseSchema,wireDrift} from '@fss/contracts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {readProviderBinding,recordProviderIncident} from '@fss/domain/outbound/providerIncidents.ts';
import {dispatch,type ApiRequest} from '../src/server.ts';
import {createAuthFixture,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
let fixture:AuthFixture,admin:string,salesperson:string,mailboxId:string;
beforeAll(async()=>{
 fixture=await createAuthFixture();
 admin=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
 salesperson=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
 mailboxId=(await fixture.db.query<{id:string}>(`INSERT INTO mailboxes(workspace_id,owner_user_id,email_address) VALUES($1,$2,'incident@example.test') RETURNING id`,[fixture.alpha.workspaceId,fixture.alpha.salesperson.userId])).rows[0]!.id;
 const ctx=repositoryContext(workspaceScope(fixture.alpha.workspaceId,{kind:'user',userId:fixture.alpha.admin.userId,role:'admin'}),fixture.db);
 await recordProviderIncident(ctx,{mailboxId,sourceKind:'admin_report',sourceId:mailboxId,classification:'unknown',reason:'unknown_provider_failure',binding:(await readProviderBinding(ctx,mailboxId))!,now:new Date('2026-10-08T09:00:00Z')});
});
afterAll(async()=>fixture?.stop());
const post=(path:string,token:string,body:unknown={})=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body} satisfies ApiRequest,{session:fixture.db,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,auth:fixture.deps});
it('shows a coded actionable incident to the admin through standing v2 while keeping the installed standing read exact',async()=>{
 const read=await post('/outreach/senders/standing/v2',admin);
 expect(read.status).toBe(200);
 expect(wireDrift(outreachSenderStandingV2ResponseSchema,read.body)).toEqual([]);
 expect(read.body).toMatchObject({senders:[{mailboxId,incidents:[{classification:'unknown',reason:'unknown_provider_failure',state:'action_required',retryAt:null,sourceKind:'admin_report',sourceId:mailboxId}]}]});
 expect(wireDrift(outreachSenderStandingResponseSchema,(await post('/outreach/senders/standing',admin)).body)).toEqual([]);
 expect((await post('/outreach/senders/standing/v2',salesperson)).status).toBe(403);
 expect((await post('/outreach/senders/standing/v2',admin,{clear:true})).status).toBe(400);
});
