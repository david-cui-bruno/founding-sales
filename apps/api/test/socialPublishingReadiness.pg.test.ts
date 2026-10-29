import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {createAuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {dispatch} from '../src/server.ts';
import type {SessionQueryable,QueryResultRowLike} from '@fss/domain/db/queryable.ts';
import {socialPublishingReadinessSchema} from '@fss/contracts';

// Author-only until Root grants a fresh PG16 lane. Real signed fixture requests;
// no external account, credential, runner, publishing or model port exists here.
it('signed read is exact-owner only, then session expiry during the account read withholds metadata',async()=>{
 const f=await createAuthFixture();
 try{
  const runtime=await f.database.appRuntimeSession(),id=randomUUID(),foreign=randomUUID();
  for(const [account,workspace,owner]of [[id,f.alpha.workspaceId,f.alpha.admin.userId],[foreign,f.beta.workspaceId,f.beta.admin.userId]])
   await f.db.query(`INSERT INTO social_accounts(workspace_id,id,owner_user_id,platform,external_id,display_name,account_kind,state)
    VALUES($1,$2,$3,'linkedin',$4,'Fictional historical profile','profile','connected')`,[workspace,account,owner,account]);
  const token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
  let expire=false;
  const session:SessionQueryable={query:async<Row extends QueryResultRowLike>(text:string,values?:readonly unknown[])=>{
   const answer=await runtime.query<Row>(text,values);
   if(expire&&text.includes('FROM social_accounts'))f.advance(2*60*60*1000);
   return answer;
  }};
  const call=(body:unknown={},authorization:string|undefined=`Bearer ${token}`)=>dispatch({method:'POST',path:'/social/publishing/readiness',
   query:new URLSearchParams(),headers:authorization?{authorization}:{},body},{session,auth:{...f.deps,db:session},
   supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
  const read=await call();expect(read.status).toBe(200);const value=socialPublishingReadinessSchema.parse(read.body);
  expect(value.accounts.map(account=>account.accountId)).toEqual([id]);expect(value.accounts[0]?.currentAccountVerified).toBe(false);
  expect((await call({activate:true})).status).toBe(400);
  expire=true;expect((await call()).status).toBe(401);
  for(const table of ['social_posts','social_post_approvals','social_deliveries','outbound_messages','provider_reservations'])
   expect((await f.db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']).toBe(0);
 }finally{await f.stop();}
});
