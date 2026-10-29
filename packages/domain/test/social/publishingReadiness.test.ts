import {expect,it,vi} from 'vitest';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import type {QueryResultRowLike,SessionQueryable} from '../../db/queryable.ts';
import {readSocialPublishingReadiness} from '../../social/publishingReadiness.ts';
import {PrivateDraftAuthorityChanged} from '../../social/privateDrafts.ts';
const id='10000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000002';
const row={id,revision:7,platform:'linkedin',account_kind:'profile',display_name:'Fictional owner',state:'connected'};
function fixture(rows:Record<string,unknown>[]=[row],active=true){
 const queries:{text:string;values:readonly unknown[]|undefined}[]=[],authority=vi.fn(async()=>true);
 const db:SessionQueryable={async query<Row extends QueryResultRowLike>(text:string,values?:readonly unknown[]){
  queries.push({text,values});let result:Record<string,unknown>[]=[];
  if(text.includes('workspace_memberships'))result=active?[{present:1}]:[];
  else if(text.includes('social_accounts'))result=rows;
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
 expect(read.text).not.toMatch(/external_id|adapter_version|verified_at|SELECT \*/u);
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
