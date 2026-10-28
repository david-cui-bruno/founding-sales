import type {RepositoryContext} from '../db/workspaceScope.ts';
import {lockPreparationCleanup} from '../calling/preparationLifecycle.ts';
/** Shared source-loss owner calls before removing a native denial predicate. */
export async function eraseProspectPhoneDiscoveriesForSources(ctx:RepositoryContext,urls:readonly string[]):Promise<number>{
 if(!urls.length)return 0;
 await lockPreparationCleanup(ctx);
 const result=await ctx.db.query<{count:number}>('SELECT erase_prospect_phone_sources($1,$2::text[]) AS count',[ctx.scope.workspaceId,urls.map(url=>url.replace(/\/+$/u,''))]);
 return result.rows[0]?.count??0;
}
/** Existing evidence retention target owns bounded physical erasure, not another service. */
export async function sweepProspectPhoneDiscoveries(ctx:RepositoryContext,input:{limit:number}):Promise<number>{
 await lockPreparationCleanup(ctx);
 const result=await ctx.db.query<{count:number}>('SELECT sweep_prospect_phone_discoveries($1,$2) AS count',[ctx.scope.workspaceId,input.limit]);
 return result.rows[0]?.count??0;
}
