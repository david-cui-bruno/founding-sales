import type {RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {admitAutomaticEmailCandidate,type AutomaticEmailInput} from '@fss/domain/outreach/automaticEmail.ts';
export type {AutomaticEmailInput};
/** Single-prospect entry; scheduling and activation are separate releases. */
export async function admitAutomaticEmailProspect(ctx:RepositoryContext,input:AutomaticEmailInput){
 return withTransaction(ctx.db,()=>admitAutomaticEmailCandidate(ctx,input));
}
