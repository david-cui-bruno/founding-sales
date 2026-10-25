import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {dispatch} from '../src/server.ts';
import {payloadHashOf} from '../src/auth/tokens.ts';
it('app_runtime private commands use ordinary opaque receipts and strict current owner/device/hash projection',async()=>{
 const f=await createAuthFixture();try{
 const runtime=await f.database.appRuntimeSession(),auth={...f.deps,db:runtime};
 let token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
 const call=(path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body},{session:runtime,auth,supportedClientVersions:auth.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
 const payload={operation:'create',kind:'comment',text:'Neutral private receipt fixture.',origin:{kind:'manual'}},command={...payload,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
 const saved=await call('/social/private-drafts/save',command);expect(saved.status).toBe(200);expect(saved.body).toMatchObject({status:'accepted',replayed:false,result:{revision:1}});
 const result=(saved.body as {result:{draftId:string;revision:number}}).result;
 expect(await call('/social/private-drafts/save',command)).toMatchObject({status:200,body:{status:'accepted',replayed:true,result}});
 expect(await call('/social/private-drafts/save',{...command,text:'Changed payload'})).toMatchObject({status:409,body:{reason:'command_payload_mismatch'}});
 const receipt={commandId:command.commandId,payloadSHA256:payloadHashOf(payload)};
 expect(await call('/social/private-drafts/receipt',receipt)).toMatchObject({status:200,body:{state:'accepted',result}});
 expect(await call('/social/private-drafts/receipt',{...receipt,payloadSHA256:'a'.repeat(64)})).toMatchObject({status:200,body:{state:'unknown'}});
 expect(await call('/social/private-drafts/receipt',{...receipt,commandId:randomUUID()})).toMatchObject({status:200,body:{state:'unknown'}});
 expect(await call('/social/private-drafts/read',{draftId:result.draftId})).toMatchObject({status:200,body:{draft:{text:payload.text,availability:'available'}}});
 const stored=(await runtime.query('SELECT result FROM command_receipts WHERE command_id=$1',[command.commandId])).rows[0]?.['result'];expect(stored).toEqual(result);expect(JSON.stringify(stored)).not.toContain(payload.text);
 expect(await call('/social/private-drafts/save',{...command,commandId:randomUUID(),accountId:randomUUID()})).toMatchObject({status:400});
 token=(await issueSessionFor(f,f.alpha,f.alpha.salesperson)).accessToken;
 expect(await call('/social/private-drafts/read',{draftId:result.draftId})).toMatchObject({status:404});expect(await call('/social/private-drafts/receipt',receipt)).toMatchObject({status:200,body:{state:'unknown'}});
 token=(await issueSessionFor(f,f.beta,f.beta.admin)).accessToken;expect(await call('/social/private-drafts/list',{})).toMatchObject({status:200,body:{drafts:[]}});
 }finally{await f.stop();}
});
