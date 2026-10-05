import {mkdir,open,readFile,rename,rmdir,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {DiscoverySearchProvider,DiscoverySearchResult} from '@fss/domain/sourcing/discoveryProvider.ts';
export interface EvaluationQuery {id:string;query:string;cohort:string}
const ledgerSchema=z.object({version:z.literal(1),halted:z.boolean(),attempts:z.array(z.object({
 id:z.uuid(),at:z.iso.datetime(),queryId:z.string().min(1).max(100),status:z.enum(['reserved','complete','failed']),
})).max(10000)});
type Ledger=z.infer<typeof ledgerSchema>;
export interface EvaluationReport {
 provider:string;results:Array<{attemptId:string;queryId:string;query:string;cohort:string;observedAt:string;result:DiscoverySearchResult}>;
 stopReason:string|null;
}
/** Persist before network. A failed fsync/rename prevents the call, never refunds it. */
async function store(directory:string,state:Ledger):Promise<void>{
 const temp=join(directory,`state-${randomUUID()}.tmp`),target=join(directory,'state.json');
 const handle=await open(temp,'wx',0o600);
 try{await handle.writeFile(JSON.stringify(state));await handle.sync();}finally{await handle.close();}
 try{await rename(temp,target);const dir=await open(directory,'r');try{await dir.sync();}finally{await dir.close();}}
 finally{await unlink(temp).catch(()=>{});}
}
/** Single-host evaluation only, not a production scheduler or a global account quota. */
export async function evaluateDiscovery(input:{directory:string;provider:DiscoverySearchProvider;queries:readonly EvaluationQuery[];now?:()=>string}):Promise<EvaluationReport>{
 if(input.queries.length>12||input.queries.some(q=>!q.id||q.id.length>100||!q.query.trim()||q.query.length>400))throw new Error('invalid_queries');
 await mkdir(input.directory,{recursive:true,mode:0o700});
 const lock=join(input.directory,'run.lock');
 try{await mkdir(lock,{mode:0o700});}catch{throw new Error('evaluation_locked');}
 try{
  let state:Ledger;
  try{const text=await readFile(join(input.directory,'state.json'),'utf8');if(text.length>2_000_000)throw new Error('large');state=ledgerSchema.parse(JSON.parse(text));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')state={version:1,halted:false,attempts:[]};else throw new Error('ledger_invalid');}
  const report:EvaluationReport={provider:input.provider.providerKey,results:[],stopReason:null};
  if(state.halted)return {...report,stopReason:'usage_review_required'};
  for(const query of input.queries){
   const at=(input.now??(()=>new Date().toISOString()))();if(!z.iso.datetime().safeParse(at).success)throw new Error('clock_invalid');
   const day=at.slice(0,10),month=at.slice(0,7);
   if(state.attempts.some(a=>a.at>at))throw new Error('clock_regressed');
   if(state.attempts.some(a=>a.at.slice(0,10)===day&&a.queryId===query.id))continue;
   if(state.attempts.filter(a=>a.at.slice(0,10)===day).length>=20){report.stopReason='daily_limit';break;}
   if(state.attempts.filter(a=>a.at.slice(0,7)===month).length>=600){report.stopReason='monthly_limit';break;}
   if(state.attempts.length>=10000){report.stopReason='ledger_full';break;}
   const attempt:Ledger['attempts'][number]={id:randomUUID(),at,queryId:query.id,status:'reserved'};
   state.attempts.push(attempt);await store(input.directory,state);
   let result:DiscoverySearchResult;
   try{result=await input.provider.discover({query:query.query});}catch{result={ok:false,code:'unavailable'};}
   // Every future adapter must obey the same credit contract before another call.
   if(result.ok&&result.credits!==1)result={ok:false,code:'usage_unexpected'};
   attempt.status=result.ok?'complete':'failed';
   if(!result.ok&&result.code==='usage_unexpected')state.halted=true;
   await store(input.directory,state);
   const item={attemptId:attempt.id,queryId:query.id,query:query.query,cohort:query.cohort,observedAt:at,result};
   const evidence=await open(join(input.directory,`${attempt.id}.json`),'wx',0o600);
   try{await evidence.writeFile(JSON.stringify({provider:input.provider.providerKey,...item},null,2));await evidence.sync();}finally{await evidence.close();}
   report.results.push(item);
   if(!result.ok){report.stopReason=result.code;break;}
  }
  return report;
 }finally{await rmdir(lock);}
}
