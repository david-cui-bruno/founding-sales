import {createAuthFixture} from './authFixture.ts';
import {issueSessionFor} from './sessionFixture.ts';
import {dispatch} from '../../src/server.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction,type SessionQueryable} from '@fss/domain/db/queryable.ts';
import {databaseNow} from '@fss/domain/policy/clock.ts';
import {retainSocialPublicThread} from '@fss/domain/social/publicThreads.ts';
import {publicThreadFixture} from '../../../../packages/domain/test/social/publicThreadFixture.ts';
export async function publicThreadApiFixture(){
 const f=await createAuthFixture(),runtime=await f.database.appRuntimeSession(),issued=await issueSessionFor(f,f.alpha,f.alpha.admin);
 const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'user',userId:f.alpha.admin.userId,role:'admin'}),runtime);
 const capture=async(sourceExpiresAt:string|null=null)=>{
  const input=publicThreadFixture(await databaseNow(ctx),undefined,sourceExpiresAt);
  const result=await withTransaction(runtime,()=>retainSocialPublicThread(ctx,input,{authority:async()=>true,publicationNow:now=>now}));
  if(!result.ok)throw Error(result.reason);return input;
 };
 const call=(path:string,body:unknown,session:SessionQueryable=runtime,token=issued.accessToken)=>{
  const auth={...f.deps,db:session};return dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body},
   {session,auth,supportedClientVersions:auth.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
 };
 return {f,runtime,issued,ctx,capture,call,close:()=>f.stop()};
}
