import {discoveryIntakeListSchema,discoverySourceKey} from '@fss/contracts';
import type {OperationInput,OperationOutput} from '../../shared/operations.ts';
import {exactJson,requireCurrent,type DiscoveryBatch} from './discoveryImportBatch.ts';
export type DiscoveryListPort=(input:OperationInput<'sourcing.discoveryList'>)=>Promise<OperationOutput<'sourcing.discoveryList'>>;
type Candidate=NonNullable<OperationOutput<'sourcing.discoveryList'>['view']>['candidates'][number];
export const DISCOVERY_RECONCILE_REQUESTS=240;
export interface DiscoveryPresence {present:number;missing:number;conflicts:number;dismissed:number;scans:2;requests:number}

/** Two matching bounded public-list scans are observations, not a transaction snapshot. */
export async function reconcileDiscovery(batch:DiscoveryBatch,list:DiscoveryListPort,current:()=>boolean):Promise<DiscoveryPresence> {
  let requests=0;
  const scan=async()=>{
    const candidates=new Map<string,Candidate>(),tuples=new Set<string>();
    for(const status of ['needs_review','kept','dismissed'] as const){
      for(let offset=0;;offset+=50){
        requireCurrent(current);
        if(++requests>DISCOVERY_RECONCILE_REQUESTS)throw new Error('reconciliation_limit');
        const answer=await list({status,offset});
        requireCurrent(current);
        if(answer.reason!==null)throw new Error('reconciliation_unavailable');
        const page=discoveryIntakeListSchema.safeParse(answer.view);
        if(!page.success)throw new Error('reconciliation_unavailable');
        if(page.data.hasMore&&page.data.candidates.length!==50)throw new Error('reconciliation_changing');
        for(const candidate of page.data.candidates){
          if(candidate.status!==status||candidates.has(candidate.id))throw new Error('reconciliation_changing');
          candidates.set(candidate.id,candidate);
          for(const origin of candidate.origins){
            const key=discoverySourceKey(origin.source);
            if(tuples.has(key))throw new Error('reconciliation_changing');
            tuples.add(key);
          }
        }
        if(!page.data.hasMore)break;
      }
    }
    return candidates;
  };
  const first=await scan();requireCurrent(current);
  const second=await scan();requireCurrent(current);
  const signature=(rows:Map<string,Candidate>)=>exactJson([...rows].sort(([a],[b])=>a<b?-1:a>b?1:0));
  if(signature(first)!==signature(second))throw new Error('reconciliation_changing');
  const bySource=new Map<string,Candidate>();
  for(const candidate of second.values())for(const origin of candidate.origins)bySource.set(discoverySourceKey(origin.source),candidate);
  let present=0,missing=0,conflicts=0,dismissed=0;
  for(const command of batch.commands){
    requireCurrent(current);
    const candidate=bySource.get(discoverySourceKey(command.row.source));
    if(!candidate){missing++;continue;}
    const sameRow=exactJson(candidate.payload.row)===exactJson(command.row);
    const sameOrigins=command.origins.every(expected=>candidate.origins.some(actual=>exactJson(actual)===exactJson(expected)));
    if(!sameRow||!sameOrigins){conflicts++;continue;}
    present++;if(candidate.status==='dismissed')dismissed++;
  }
  return {present,missing,conflicts,dismissed,scans:2,requests};
}
