import type {CanonicalSourceReference} from '@fss/contracts';
import type {Queryable} from '../db/queryable.ts';

/** Private exact-distance adapter. Arrays stay authoritative so erase/invalidation
 * needs no second store. Installing an extension is an operator action, never a
 * runtime side effect. Capability absence falls back; query errors propagate. */
export async function rankCanonicalVectors(db:Queryable,input:{workspaceId:string;ownerUserId:string;configFingerprint:string;queryVector:readonly number[];eligibleSources:readonly Pick<CanonicalSourceReference,'kind'|'sourceId'|'revision'|'contentHash'>[]}){
 const extension=(await db.query<{schema_name:string}>(`SELECT n.nspname AS schema_name FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector' AND has_schema_privilege(n.oid,'USAGE')`)).rows[0];
 const narrowed=input.queryVector.map(value=>Math.fround(value));
 const compatible=narrowed.every(Number.isFinite)&&narrowed.some(value=>value!==0);
 const schema=extension?`"${extension.schema_name.replaceAll('"','""')}"`:null;
 const native=schema!==null&&compatible;
 const cosine="(SELECT sum(a*b)/nullif(sqrt(sum(a*a))*sqrt(sum(b*b)),0) FROM unnest(w.embedding,$5::double precision[]) pair(a,b))";
 // pgvector stores float32; a valid float64 historical vector can exceed its
 // range or underflow to zero. Keep that row's exact array computation rather
 // than throwing or dropping evidence. Normal provider vectors use pgvector.
 const score=native?`CASE WHEN (SELECT bool_and(abs(v)<=3.4028234663852886e38) AND bool_or(abs(v)>=1.401298464324817e-45) FROM unnest(w.embedding) v) THEN 1-(w.embedding::${schema}.vector OPERATOR(${schema}.<=>) $5::double precision[]::${schema}.vector) ELSE ${cosine} END`:cosine;
 const rows=(await db.query<Record<string,unknown>>(`SELECT w.*, ${score} AS score FROM crm_ask_canonical_windows w WHERE w.workspace_id=$1 AND w.owner_user_id=$2 AND w.state='current' AND w.config_fingerprint=$3 AND w.dimensions=$4 AND EXISTS(SELECT 1 FROM jsonb_to_recordset($6::jsonb) r(kind text,"sourceId" uuid,revision integer,"contentHash" text) WHERE r.kind=w.source_kind AND r."sourceId"=w.source_id AND r.revision=w.source_revision AND r."contentHash"=w.source_hash) ORDER BY score DESC NULLS LAST,w.source_id,w.locator LIMIT 1000`,[input.workspaceId,input.ownerUserId,input.configFingerprint,input.queryVector.length,[...input.queryVector],JSON.stringify(input.eligibleSources.slice(0,1000))])).rows;
 return {backend:native?'pgvector_exact' as const:'array_exact' as const,rows};
}
