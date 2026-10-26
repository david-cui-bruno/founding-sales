import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {TableCoverage} from './coverage.ts';
export const SOCIAL_DRAFT_RETENTION_COVERAGE:Readonly<Record<string,TableCoverage>>={
 social_voice_preferences:{dispositions:['retained','deletion_removes','departure_revokes'],note:'Durable owner-curated private style until explicit remove or normal owner/workspace lifecycle erasure. No expiry or source dependency. Migration0136 synchronously NULLs entries on membership departure and cascades on membership/workspace deletion. Migration0141 also erases dependent guided-generation suggestions and private compositions on guide changes or owner loss. Tombstone fences stale writes. No prose history, receipt or audit content.'},
 social_draft_requests:{dispositions:['retained','deletion_redacts','departure_revokes'],note:'Source references/hashes and draft suggestions, never copied transcripts or curated-guide prose. Optional guide identity/revision is opaque. Migration0141 clears guide-dependent suggestions on guide changes or owner loss, retaining request identity and uncertainty; current source checks still fence generation/result acceptance.'},
 social_private_drafts:{dispositions:['swept','deletion_redacts','departure_revokes'],note:'Current PRIVATE prose only, no history. Fixed first-save maximum90day expiry and earlier source freshness. Normal source/association/fact DELETE/UPDATE and owner departure synchronously erase current bytes, origin and source snapshots through migration0135 triggers; migration0141 also erases guide-dependent compositions when the selected guide changes or its owner loses authority. Terminal opaque identity/revision prevents resurrection. Existing canceled_drafts retention sweeps expired text; no publication/job authority.'},
};
/** Independent per-row horizon. Never use the unrelated held-outbound30day
 * policy to extend or shorten a private composition's fixed first-save lifetime. */
export async function sweepPrivateDrafts(ctx:RepositoryContext,limit:number):Promise<number>{
 const result=await ctx.db.query(`UPDATE social_private_drafts SET text=NULL,origin=NULL,source_selection=NULL,source_hash=NULL,dependencies='{}',reason='expired',revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id IN (SELECT id FROM social_private_drafts WHERE workspace_id=$1 AND reason IS NULL AND expires_at<=clock_timestamp() ORDER BY expires_at,id LIMIT $2) AND reason IS NULL AND expires_at<=clock_timestamp()`,[ctx.scope.workspaceId,limit]);
 return result.rowCount??0;
}
