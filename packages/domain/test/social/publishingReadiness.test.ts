import {expect,it,vi} from 'vitest';
import {SOCIAL_BROWSER_ADAPTER} from '@fss/contracts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import type {QueryResultRowLike,SessionQueryable} from '../../db/queryable.ts';
import {readSocialPublishingReadiness} from '../../social/publishingReadiness.ts';
import {PrivateDraftAuthorityChanged} from '../../social/privateDrafts.ts';
const id='10000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000002';
const row={id,revision:7,platform:'linkedin',account_kind:'profile',display_name:'Fictional owner',state:'connected',external_id:'https://www.linkedin.com/in/fictional',session_id:null,session_revision:null,session_account_revision:null};
function fixture(rows:Record<string,unknown>[]=[row],active=true,runtimeAvailable=false){
 const queries:{text:string;values:readonly unknown[]|undefined}[]=[],authority=vi.fn(async()=>true);
 const db:SessionQueryable={async query<Row extends QueryResultRowLike>(text:string,values?:readonly unknown[]){
  queries.push({text,values});let result:Record<string,unknown>[]=[];
  if(text.includes('workspace_memberships'))result=active?[{present:1}]:[];
  else if(text.includes('social_standing_plans'))result=[];
  else if(text.includes('social_accounts'))result=rows;
  else if(text.includes('social_publisher_runtime'))result=runtimeAvailable?[{present:1}]:[];
  else if(text==='SELECT clock_timestamp() AS now')result=[{now:new Date('2026-10-29T12:00:00Z')}];
  else throw Error('Unexpected query');
  return {rows:result as Row[],rowCount:result.length};
 }};
 const ctx=repositoryContext(workspaceScope(id,{kind:'user',userId:other,role:'admin'}),db);
 return {ctx,queries,authority};
}
it('reads only exact owner metadata, retaining a historical connection as blocked with zero writes',async()=>{
 const f=fixture(),answer=await readSocialPublishingReadiness(f.ctx,f.authority);
 expect(answer).toMatchObject({ok:true,value:{runnerAvailable:false,publishingActivated:false,accounts:[{
  accountId:id,revision:7,historicalState:'connected',currentAccountVerified:false,
  holds:['adapter_unavailable','current_account_unverified','current_publication_policy_unavailable'],
 }]}});
 const read=f.queries.find(query=>query.text.includes('social_accounts'))!;
 expect(read.values).toEqual([id,other]);expect(read.text).toContain('owner_user_id=$2');expect(read.text).toContain('LIMIT 31 FOR SHARE');
 expect(read.text).not.toMatch(/encrypted_state|adapter_version|SELECT \*/u);
 expect(f.queries.every(query=>query.text.startsWith('SELECT'))).toBe(true);expect(f.authority).toHaveBeenCalledTimes(2);
});
it.each([['facebook','page'],['facebook','profile'],['x','profile'],['linkedin','page']])('marks %s/%s as an unsupported current route',async(platform,account_kind)=>{
 const f=fixture([{...row,platform,account_kind}]);const answer=await readSocialPublishingReadiness(f.ctx,f.authority);
 expect(answer).toMatchObject({ok:true,value:{accounts:[{holds:expect.arrayContaining(['unsupported_route'])}]}});
});
it('empty owner inventory remains blocked, while overflow refuses rather than truncating the read',async()=>{
 const empty=fixture([]);expect(await readSocialPublishingReadiness(empty.ctx,empty.authority)).toMatchObject({ok:true,value:{accounts:[],publishingActivated:false}});
 const excess=fixture(Array.from({length:31},()=>row));expect(await readSocialPublishingReadiness(excess.ctx,excess.authority)).toEqual({ok:false,reason:'account_limit_exceeded'});
});
it('inactive or non-admin owners never read accounts',async()=>{
 const f=fixture([],false);expect(await readSocialPublishingReadiness(f.ctx,f.authority)).toEqual({ok:false,reason:'owner_unavailable'});
 const ctx=repositoryContext(workspaceScope(id,{kind:'user',userId:other,role:'salesperson'}),f.ctx.db);
 expect(await readSocialPublishingReadiness(ctx,f.authority)).toEqual({ok:false,reason:'admin_required'});
 expect(f.queries.some(query=>query.text.includes('social_accounts'))).toBe(false);expect(f.authority).not.toHaveBeenCalled();
});
it('authority loss after the account read withholds all metadata',async()=>{
 const f=fixture();f.authority.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
 await expect(readSocialPublishingReadiness(f.ctx,f.authority)).rejects.toBeInstanceOf(PrivateDraftAuthorityChanged);
});
it('requires fresh runner heartbeat AND real session self-readback rather than metadata/configuration',async()=>{
 const session={...row,session_id:id,session_revision:2,session_account_revision:7};
 const f=fixture([session],true,true),verify=vi.fn(async()=>({usable:true,externalId:row.external_id,adapter:SOCIAL_BROWSER_ADAPTER}));
 const answer=await readSocialPublishingReadiness(f.ctx,f.authority,{verify});
 expect(answer).toMatchObject({ok:true,value:{runnerAvailable:true,publishingActivated:false,accounts:[{currentAccountVerified:true,holds:['current_publication_policy_unavailable']}]}});
 expect(verify).toHaveBeenCalledWith({workspaceId:id,ownerUserId:other,accountId:id,accountRevision:7,sessionId:id,sessionRevision:2,externalId:row.external_id});
 const stale=fixture([{...session,session_account_revision:6}],true,true);verify.mockClear();
 expect(await readSocialPublishingReadiness(stale.ctx,stale.authority,{verify})).toMatchObject({ok:true,value:{accounts:[{currentAccountVerified:false}]}});
 expect(verify).not.toHaveBeenCalled();
});
it('withholds readiness if exact principal is revoked while real capability read is waiting',async()=>{
 const f=fixture([{...row,session_id:id,session_revision:1,session_account_revision:7}],true,true);
 const started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const pending=readSocialPublishingReadiness(f.ctx,f.authority,{verify:async()=>{started.resolve();await release.promise;return {usable:true,externalId:row.external_id,adapter:SOCIAL_BROWSER_ADAPTER};}});
 await started.promise;f.authority.mockResolvedValue(false);release.resolve();
 await expect(pending).rejects.toBeInstanceOf(PrivateDraftAuthorityChanged);
});
