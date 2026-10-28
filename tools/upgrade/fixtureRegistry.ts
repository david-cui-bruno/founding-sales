import type {RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {publishTestRegistrySnapshot} from '@fss/domain/test/support/nationalRegistry.ts';
/** Synthetic fixture prerequisite only. Registry execution freshness uses the
 * real database clock; the fixture's separate historical business-policy clock
 * still controls weekday/hour/posture evaluation. No provider or live registry. */
export async function publishFixtureDialRegistry(context:RepositoryContext,routeId:string):Promise<void>{
 const row=(await context.db.query<{e164:string;at:Date}>('SELECT e164,clock_timestamp() AS at FROM phone_routes WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,routeId])).rows[0];
 if(!row?.e164||!Number.isFinite(row.at.getTime()))throw Error('Fixture needs its exact current phone route and database clock');
 const now=row.at.toISOString();await publishTestRegistrySnapshot(context.db,context.scope.workspaceId,{downloadedAt:now,publishedAt:now,e164s:[{e164:row.e164,result:'clear'}]});
}
