import {repositoryContext} from '@fss/domain/db/workspaceScope.ts';
import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
import type {JobSpecification} from '@fss/domain/jobs/jobStore.ts';
import {jobIdempotencyKey} from '@fss/domain/jobs/jobKinds.ts';
import {runPeopleEnrichment} from '@fss/domain/outreach/peopleEnrichment.ts';
import type {PeopleProvider} from '@fss/domain/outreach/peopleProvider.ts';
import type {DueWorkSource} from '../scheduler/schedulerPass.ts';
import type {Logger} from '../bootstrap/log.ts';

/** ADR0036/0037. The domain owns every reservation, call, cap and commit. An `outbound_fence` handler runs outside any transaction, so each
 * reservation commits before a paid call and each settlement on its own: a crash never lets a company be paid for twice. */
export function personEnrichHandler(deps:{provider:PeopleProvider;log?:Logger}):JobHandler {
 return {kind:'outreach.person_enrich',protection:'outbound_fence',maxAttempts:1,leaseSeconds:120,
  handle:async input=>{
   const pass=await runPeopleEnrichment(repositoryContext(input.scope,input.session),{provider:deps.provider});
   // Counts and a provider failure code only: no company, person, address or provider text.
   if(deps.log&&(pass.looked||pass.halted))try{deps.log.log(pass.halted?'warn':'info','people_enrichment',{looked:pass.looked,found:pass.found,none:pass.none,credits:pass.credits,halted:pass.halted,stopped:pass.stopped});}catch{ /* A log sink cannot change enrichment custody. */ }
  }};
}

/** One pass per workspace every ten minutes while an admin has switched people enrichment on. The daily credit cap is not a condition: the
 * own-site source (ADR0037) costs nothing, and a source that costs credits stops itself at the cap (`stopped: 'disabled'` at zero). Listed
 * always and materializing only where the worker composed a source. */
export function personEnrichSource(enabled:boolean):DueWorkSource {
 return {name:'people-enrichment',find:async(session,now)=>{
  if(!enabled)return [];
  const rows=(await session.query<{workspace_id:string}>(`SELECT workspace_id FROM workspace_settings WHERE setting_key='people_enrichment' AND superseded_at IS NULL
   AND value->>'enabled'='true' ORDER BY 1 LIMIT 25`)).rows;
  return rows.map((row):JobSpecification=>({workspaceId:row.workspace_id,kind:'outreach.person_enrich',idempotencyKey:jobIdempotencyKey.outreachPersonEnrich(row.workspace_id,now),payload:{},maxAttempts:1}));
 }};
}
