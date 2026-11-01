import {createHash,randomUUID} from 'node:crypto';
import {discoveryCandidatePayloadSchema,discoveryOriginSchema,type DiscoveryIntakeRowV1,type DiscoveryOrigin} from '@fss/contracts';
import type {RepositoryContext} from '../../../db/workspaceScope.ts';

/** A stored raw `discovery-v1` candidate and its origins, as the retired intake left them. */
export interface DiscoverySeed {row:DiscoveryIntakeRowV1;origins:DiscoveryOrigin[]}

/** Seeds one stored `discovery-v1` candidate (ADR0034 retired its write intake; readers of
 * stored rows remain). Inserts the candidate at revision 1 and one origin row per origin. */
export async function seedDiscoveryCandidate(ctx:RepositoryContext,input:DiscoverySeed):Promise<{id:string;revision:number}> {
 const payload=discoveryCandidatePayloadSchema.parse({kind:'discovery-v1',row:input.row}),id=randomUUID(),w=ctx.scope.workspaceId,source=input.row.source;
 const key=createHash('sha256').update(JSON.stringify(['discovery-v1',source.provider,source.release,source.recordId])).digest('hex');
 await ctx.db.query('INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload) VALUES($1,$2,$3,$4::jsonb)',[w,id,key,JSON.stringify(payload)]);
 for(const value of input.origins){
  const origin=discoveryOriginSchema.parse(value);
  await ctx.db.query('INSERT INTO sourcing_candidate_discovery_origins(workspace_id,candidate_id,provider,release,record_id,source,source_metadata,licenses,notices) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb)',
   [w,id,origin.source.provider,origin.source.release,origin.source.recordId,JSON.stringify(origin.source),JSON.stringify(origin.sourceMetadata),JSON.stringify(origin.licenses),JSON.stringify(origin.notices)]);
 }
 return {id,revision:1};
}
