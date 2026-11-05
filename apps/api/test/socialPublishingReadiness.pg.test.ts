import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {createAuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {dispatch} from '../src/server.ts';
import type {SessionQueryable,QueryResultRowLike} from '@fss/domain/db/queryable.ts';
import {socialPublishingReadinessSchema,type SocialPublisherBinding} from '@fss/contracts';
import {SocialBufferPublisher,postgresPublisherCredentials} from '@fss/social-publisher';
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
it.each(['revoke','principal_expiry','replacement'])('real revoked-key readiness defers invalidation until authority release and preserves %s fences',async mode=>{
 const f=await createAuthFixture();try{
  const runtime=await f.database.appRuntimeSession(),providerDb=await f.database.appRuntimeSession(),credentials=postgresPublisherCredentials(providerDb,Buffer.alloc(32,17));
  await runtime.query("SET statement_timeout='2s'");await providerDb.query("SET statement_timeout='2s'");
  const owner={workspaceId:f.alpha.workspaceId,ownerUserId:f.alpha.admin.userId},identity={organizationId:'1'.repeat(24),channelId:'2'.repeat(24),externalId:'native-service-id',displayName:'Fixture owner'};
  const binding=await credentials.save(owner,randomUUID(),identity,'fixture-key',async()=>{}),token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
  let rejected=false,replacement:SocialPublisherBinding|null=null;
  const publisher=new SocialBufferPublisher({credentials,executionSide:'api',mediaOrigin:'https://app.example.test'},{transport:async()=>{rejected=true;return new Response(null,{status:401});}});
  const session:SessionQueryable={async query<Row extends QueryResultRowLike>(text:string,values?:readonly unknown[]){
   const answer=await runtime.query<Row>(text,values);
   if(mode==='principal_expiry'&&text.startsWith('SELECT id FROM social_accounts')&&text.includes('FOR UPDATE'))f.advance(2*60*60*1000);
   if(mode==='replacement'&&rejected&&text==='COMMIT'&&!replacement)replacement=await credentials.save(owner,binding.accountId,identity,'replacement-key',async()=>{});
   return answer;
  }};
  const result=await dispatch({method:'POST',path:'/social/publishing/readiness',query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body:{}},{session,auth:{...f.deps,db:session},socialPublisher:publisher,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
  if(mode==='principal_expiry'){
   expect(result).toMatchObject({status:401,body:{error:'unauthenticated'}});
   expect(await credentials.read(binding)).toBe('fixture-key');
  }else{
   expect(result.status).toBe(200);
   expect(socialPublishingReadinessSchema.parse(result.body).accounts[0]).toMatchObject({currentAccountVerified:false,holds:expect.arrayContaining(['current_account_unverified'])});
   expect(JSON.stringify(result.body)).not.toMatch(/credentialId|credentialRevision|channelId|organizationId|fixture-key/u);
   if(mode==='replacement'){if(!replacement)throw Error('replacement was not installed');expect(await credentials.read(replacement)).toBe('replacement-key');}
   else expect((await providerDb.query('SELECT encrypted_state,state FROM social_publisher_credentials WHERE workspace_id=$1 AND id=$2',[owner.workspaceId,binding.credentialId])).rows).toEqual([{encrypted_state:null,state:'disconnected'}]);
  }
 }finally{await f.stop();}
});
