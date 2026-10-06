import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
let f:AuthFixture,token:string;
const call=(path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body},{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://example.test/update'});
beforeAll(async()=>{f=await createAuthFixture();token=(await issueSessionFor(f,f.alpha,f.alpha.salesperson)).accessToken;});afterAll(async()=>f.stop());
it('exposes a scoped read but does not let a salesperson change the discovery policy',async()=>{
 const now=new Date().toISOString();expect((await call('/sourcing/learning',{from:'2026-01-01T00:00:00.000Z',to:now,asOf:now})).body).toMatchObject({cohorts:[],firms:[]});
 expect((await call('/sourcing/learning',{from:'bad',to:now,asOf:now})).status).toBe(400);
 expect((await call('/sourcing/targeting',{})).body).toMatchObject({canEdit:false,proposals:[]});
 const input={basePolicyVersion:'targeting-v1',queryChanges:[],rankOrder:['help_request','operational_burden','investigation','fit_only'],evidenceIds:[],rationale:'Test the current policy.',commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
 expect((await call('/sourcing/targeting/save',input)).body).toMatchObject({reason:'admin_only'});
});
it('admin proposal replay does not duplicate or approve it; approval replay does not make another version',async()=>{
 token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
 const input={basePolicyVersion:'targeting-v1',queryChanges:[],rankOrder:['help_request','operational_burden','investigation','fit_only'],evidenceIds:[],rationale:'Keep the hypothesis ordering while collecting call outcomes.',commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
 const first=await call('/sourcing/targeting/save',input);expect(first.status).toBe(200);
 expect((await call('/sourcing/targeting/save',input)).body).toMatchObject({replayed:true});
 expect((await call('/sourcing/targeting',{})).body).toMatchObject({policy:{version:'targeting-v1'}});
 const result=first.body as {result:{id:string;revision:number}};const approval={id:result.result.id,expectedRevision:result.result.revision,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
 const applied=await call('/sourcing/targeting/apply',approval);expect(applied.status).toBe(200);expect((await call('/sourcing/targeting/apply',approval)).body).toMatchObject({replayed:true});
 expect((await f.db.query('SELECT version FROM sourcing_targeting_versions WHERE workspace_id=$1',[f.alpha.workspaceId])).rows).toHaveLength(2);
});
