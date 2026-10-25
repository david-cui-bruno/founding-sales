import type {RepositoryContext} from '../db/workspaceScope.ts';
import {lockDiscoveryReviewSources} from './discoveryReviewVisibility.ts';
/** Exact source lifecycle owner calls before dropping source authority. No content copies. */
export async function eraseManualActivityForSources(ctx:RepositoryContext,urls:readonly string[]):Promise<number>{
 if(!urls.length)return 0;
 await lockDiscoveryReviewSources(ctx);
 const result=await ctx.db.query<{count:string}>('SELECT erase_manual_activity_sources($1,$2::text[]) AS count',[ctx.scope.workspaceId,urls.map(url=>url.replace(/\/+$/u,''))]);
 return Number(result.rows[0]?.count??0);
}
