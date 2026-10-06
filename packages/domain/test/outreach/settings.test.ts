import {afterAll,beforeAll,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {readOutreachControl,readRoutineSettings,saveRoutineSettings} from '../../outreach/settings.ts';
let db:TestDatabase,s:TwoWorkspaces;
const ctx=()=>repositoryContext(workspaceScope(s.alpha.workspaceId,{kind:'user',userId:s.alpha.admin.userId,role:'admin'}),db.session);
beforeAll(async()=>{db=await createTestDatabase();s=await seedTwoWorkspaces(db.session);});afterAll(async()=>db.drop());
it('defaults routine replies off and will not enable them without approved content',async()=>{
 expect(await readRoutineSettings(ctx())).toEqual({revision:0,enabled:false,sequenceVersionId:null,bookingUrl:null});
 expect(await withTransaction(db.session,()=>saveRoutineSettings(ctx(),{expectedRevision:0,enabled:true,sequenceVersionId:null,bookingUrl:null}))).toEqual({ok:false,reason:'approved_reply_content_required'});
 expect((await readOutreachControl(ctx())).settings.enabled).toBe(false);
});
it('keeps configuration revisions and rejects stale updates or an unsafe booking URL',async()=>{
 const save=(input:unknown)=>withTransaction(db.session,()=>saveRoutineSettings(ctx(),input));
 expect(await save({expectedRevision:0,enabled:false,sequenceVersionId:null,bookingUrl:'https://cal.com/david/demo'})).toEqual({ok:true,value:{revision:1}});
 expect(await save({expectedRevision:0,enabled:false,sequenceVersionId:null,bookingUrl:null})).toEqual({ok:false,reason:'stale_revision'});
 expect(await save({expectedRevision:1,enabled:false,sequenceVersionId:null,bookingUrl:'https://cal.com@evil.example/test'})).toEqual({ok:false,reason:'booking_link_invalid'});
 expect((await readRoutineSettings(ctx())).bookingUrl).toBe('https://cal.com/david/demo');
});
