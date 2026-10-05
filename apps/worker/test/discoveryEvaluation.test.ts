import {afterEach,it,expect,vi} from 'vitest';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {evaluateDiscovery} from '../src/sourcing/evaluateDiscovery.ts';
const dirs:string[]=[];async function directory(){const d=await mkdtemp(join(tmpdir(),'callie-discovery-'));dirs.push(d);return d;}
afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
const queries=[{id:'test-v1',query:'Dallas maintenance PM',cohort:'fit_only'}];
const now='2026-10-05T12:00:00.000Z';
const success={ok:true as const,credits:1,requestId:'native',hits:[{url:'https://pm.example',title:'PM',snippet:'unverified'}]};
it('durably debits before network, preserves provenance, and does not replay today after restart',async()=>{
 const dir=await directory();const discover=vi.fn(async()=>{
  const state=JSON.parse(await readFile(join(dir,'state.json'),'utf8'));expect(state.attempts).toHaveLength(1);expect(state.attempts[0].status).toBe('reserved');return success;
 });
 const options={directory:dir,provider:{providerKey:'test',discover},queries,now:()=>now};
 const first=await evaluateDiscovery(options);expect(first.results).toHaveLength(1);expect(first.results[0]).toMatchObject({queryId:'test-v1',result:success});
 expect((await evaluateDiscovery(options)).results).toHaveLength(0);expect(discover).toHaveBeenCalledTimes(1);
});
it('retains charged attempts on throw and stops the batch without retry',async()=>{
 const dir=await directory();const discover=vi.fn(async()=>{throw new Error('SECRET');});
 const report=await evaluateDiscovery({directory:dir,provider:{providerKey:'test',discover},queries:[...queries,{...queries[0]!,id:'second'}],now:()=>now});
 expect(discover).toHaveBeenCalledTimes(1);expect(JSON.stringify(report)).not.toContain('SECRET');
 const state=JSON.parse(await readFile(join(dir,'state.json'),'utf8'));expect(state.attempts).toHaveLength(1);
});
it('enforces daily and monthly reservations including abandoned attempts',async()=>{
 for(const [count,at] of [[20,now],[600,'2026-10-01T12:00:00.000Z']] as const){
  const dir=await directory();await writeFile(join(dir,'state.json'),JSON.stringify({version:1,halted:false,attempts:Array.from({length:count},(_,i)=>({id:crypto.randomUUID(),at,queryId:`past-${i}`,status:'reserved'}))}));
  const discover=vi.fn(async()=>success);const report=await evaluateDiscovery({directory:dir,provider:{providerKey:'test',discover},queries,now:()=>now});
  expect(report.stopReason).toBe(count===20?'daily_limit':'monthly_limit');expect(discover).not.toHaveBeenCalled();
 }
});
it('fails closed on a concurrent lock or corrupt ledger',async()=>{
 const dir=await directory();await mkdir(join(dir,'run.lock'));const discover=vi.fn(async()=>success);
 await expect(evaluateDiscovery({directory:dir,provider:{providerKey:'test',discover},queries})).rejects.toThrow('evaluation_locked');
 await rm(join(dir,'run.lock'),{recursive:true});await writeFile(join(dir,'state.json'),'broken');
 await expect(evaluateDiscovery({directory:dir,provider:{providerKey:'test',discover},queries})).rejects.toThrow('ledger_invalid');expect(discover).not.toHaveBeenCalled();
});
it('unexpected provider usage halts this ledger until operator review',async()=>{
 const dir=await directory();const discover=vi.fn(async()=>({ok:false as const,code:'usage_unexpected' as const}));
 await evaluateDiscovery({directory:dir,provider:{providerKey:'test',discover},queries,now:()=>now});
 expect((await evaluateDiscovery({directory:dir,provider:{providerKey:'test',discover},queries,now:()=> '2026-10-06T12:00:00.000Z'})).stopReason).toBe('usage_review_required');expect(discover).toHaveBeenCalledTimes(1);
});
