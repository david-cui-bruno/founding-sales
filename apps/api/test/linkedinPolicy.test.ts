import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {dispatch} from '../src/server.ts';
it('saves the approved standing policy through owner settings without enabling outreach',async()=>{
 const f=await createAuthFixture();try{
 const token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
 const call=(path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body},{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
 const accountId=randomUUID();
 await call('/social/accounts/connect',{accountId,platform:'linkedin',externalId:'controlled-founder',displayName:'Founder',accountKind:'profile',commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
 const input={commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,expectedRevision:0,accountId,accountRevision:1,approved:true,dataScope:'founder_sales_business',generation:null};
 expect((await call('/social/linkedin-policy/save',input)).status).toBe(200);
 expect((await call('/social/linkedin-policy/read',{})).body).toMatchObject({revision:1,state:'saved',enabled:false,technicallyReady:false,policy:{accountId,rules:{invitations:{rolling24Hours:20,rolling7Days:140,notes:'never'},directMessages:{rolling24Hours:20},cadence:{days:[0,3,7,14]}}}});
 }finally{await f.stop();}
});
