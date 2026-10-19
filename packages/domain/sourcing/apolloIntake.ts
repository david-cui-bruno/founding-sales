import {z} from 'zod';
import {isPublicResearchUrl} from '../research/sourcePolicy.ts';
import {isDiscoveryDirectory} from './discoveryIdentity.ts';
import {saveCandidate} from './candidates.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {ApolloReservation} from './apolloAllowance.ts';
import type {DiscoveryOrganization} from './discoveryProvider.ts';

const organizationSchema=z.object({name:z.string().trim().min(1).max(300),domain:z.string().min(1).max(253),hqCity:z.string().trim().min(1).max(120).nullable(),hqState:z.enum(['TX','RI','MA']).nullable(),employeeCount:z.number().int().min(1).max(10).nullable()});
export const APOLLO_PREPARED_BY='Apollo Free company search · not verified';
/** Internal intake only. Vendor company metadata is not source evidence, a Keep,
 * first-party qualification, or permission to contact/admit a firm.
 */
export async function intakeApolloOrganizations(ctx:RepositoryContext,attempt:ApolloReservation,organizations:readonly DiscoveryOrganization[]):Promise<{created:number;deduplicated:number;incomplete:number}>{
 let created=0,deduplicated=0,incomplete=0;
 const date=(await ctx.db.query<{day:string}>("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day")).rows[0]!.day;
 for(const value of organizations){
  // Repeat the allowlist at persistence even for an injected/changed adapter.
  const parsed=organizationSchema.safeParse(value);
  if(!parsed.success){incomplete++;continue;}
  const row=parsed.data,domain=row.domain.toLowerCase().replace(/^www\./u,''),url=`https://${domain}/`;
  if(!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(domain)||!isPublicResearchUrl(url)||isDiscoveryDirectory(url)||!row.hqCity||row.hqState!==attempt.region||row.employeeCount===null){incomplete++;continue;}
  // Serialize normalized identity intake across concurrent Apollo accounts. The
  // existing Tavily path and its global quota are intentionally untouched.
  await ctx.db.query("SELECT pg_advisory_xact_lock(hashtextextended('apollo-intake:'||$1,0))",[ctx.scope.workspaceId]);
  const duplicate=(await ctx.db.query(`SELECT id FROM sourcing_candidates WHERE workspace_id=$1 AND
   (regexp_replace(lower(split_part(payload->>'website','/',3)),'^www\\.','')=$2 OR lower(regexp_replace(trim(payload->>'firmName'),'\\s+',' ','g'))=lower(regexp_replace(trim($3),'\\s+',' ','g')))
   UNION ALL SELECT id FROM firms WHERE workspace_id=$1 AND
   (regexp_replace(lower(split_part(website,'/',3)),'^www\\.','')=$2 OR lower(regexp_replace(trim(name),'\\s+',' ','g'))=lower(regexp_replace(trim($3),'\\s+',' ','g'))) LIMIT 1`,[ctx.scope.workspaceId,domain,row.name])).rows.length>0;
  if(duplicate){deduplicated++;continue;}
  const saved=await saveCandidate(ctx,{firmName:row.name,website:url,locality:row.hqCity,region:row.hqState,signal:'fit_only',evidence:'Company discovery suggestion only. First-party verification required.',sourceUrl:url,observedOn:date,preparedBy:APOLLO_PREPARED_BY});
  if(!saved.ok)throw new Error('apollo_candidate_invalid');
  if(saved.value.duplicate){deduplicated++;continue;}
  await ctx.db.query(`INSERT INTO sourcing_apollo_candidate_origins(workspace_id,candidate_id,candidate_revision,attempt_id,organization_name,domain,hq_city,hq_state,employee_count) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8)`,[ctx.scope.workspaceId,saved.value.id,attempt.id,row.name,domain,row.hqCity,row.hqState,row.employeeCount]);
  created++;
 }
 return {created,deduplicated,incomplete};
}
