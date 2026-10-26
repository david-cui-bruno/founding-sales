import {beforeEach,expect,it,vi} from 'vitest';
import {workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import type {JobHandlerInput} from '@fss/domain/jobs/handlerRegistry.ts';
import type {PageFetchProvider} from '@fss/domain/research/providers.ts';
import type {QueryResultRowLike,SessionQueryable} from '@fss/domain/db/queryable.ts';
import {prospectPhoneDiscoveryHandler,prospectPhoneDiscoverySource} from '../src/handlers/prospectPhoneDiscovery.ts';
const mocks=vi.hoisted(()=>({run:vi.fn(),expire:vi.fn()}));
vi.mock('@fss/domain/sourcing/prospectPhoneDiscovery.ts',()=>({runProspectPhoneDiscovery:mocks.run,expireProspectPhoneDiscoveryInTransaction:mocks.expire}));
const id='10000000-0000-4000-8000-000000000001';
const pageFetch:PageFetchProvider={providerKey:'controlled',fetchPages:vi.fn(async()=>{throw Error('Handler must delegate fetch ownership, never call directly');})};
const session={query:vi.fn(async()=>{throw Error('Handler must delegate transaction ownership, never query directly');})};
const input=(payload:Readonly<Record<string,unknown>>):JobHandlerInput=>({session,scope:workspaceScope(id,{kind:'system',component:'worker'}),job:{id,workspaceId:id,kind:'sourcing.phone_discover',idempotencyKey:`phone:${id}`,payload,attempt:1,maxAttempts:1,fencingToken:'1',leaseOwner:'controlled',leaseExpiresAt:'2026-10-26T06:03:00Z'}});
beforeEach(()=>{vi.clearAllMocks();mocks.run.mockResolvedValue(undefined);mocks.expire.mockResolvedValue(undefined);});
it('exports a finite outbound-fenced one-attempt handler',()=>{
 expect(prospectPhoneDiscoveryHandler({pageFetch})).toMatchObject({kind:'sourcing.phone_discover',protection:'outbound_fence',maxAttempts:1,leaseSeconds:180});
 expect(prospectPhoneDiscoveryHandler({pageFetch}).chunked).not.toBe(true);
});
it('delegates exactly once with workspace-scoped context and only the existing PageFetchProvider',async()=>{
 const job=input({runId:id,candidateId:'ignored',model:'ignored',evaluate:true});
 await prospectPhoneDiscoveryHandler({pageFetch}).handle(job);
 expect(mocks.run).toHaveBeenCalledExactlyOnceWith({scope:job.scope,db:session},{runId:id},{pageFetch});
 expect(pageFetch.fetchPages).not.toHaveBeenCalled();expect(session.query).not.toHaveBeenCalled();
});
it.each([{}, {runId:null}, {runId:5}, {runId:''}, {runId:'not-a-uuid'}])('refuses malformed run IDs before delegating %j',async payload=>{
 await prospectPhoneDiscoveryHandler({pageFetch}).handle(input(payload));expect(mocks.run).not.toHaveBeenCalled();
});
it('does not swallow an unknown dispatch outcome or initiate an adapter retry',async()=>{
 const failure=Error('controlled uncertain outcome');mocks.run.mockRejectedValueOnce(failure);
 await expect(prospectPhoneDiscoveryHandler({pageFetch}).handle(input({runId:id}))).rejects.toBe(failure);
 expect(mocks.run).toHaveBeenCalledTimes(1);expect(pageFetch.fetchPages).not.toHaveBeenCalled();
});
it('expires only due workspace runs through the existing domain owner and never returns capture jobs',async()=>{
 const other='20000000-0000-4000-8000-000000000002',now='2026-10-26T06:05:00Z';
 const query=vi.fn(async()=>({rows:[{workspace_id:other},{workspace_id:id}],rowCount:2}));
 const schedulerSession:SessionQueryable={query:async<Row extends QueryResultRowLike>(sql:string,values?:readonly unknown[])=>{
  expect(sql).toContain('sourcing_prospect_phone_discoveries');expect(sql).toContain("state IN ('pending','running')");
  expect(sql).toContain('deadline_at<=$1');expect(sql).toContain('expires_at<=$1');expect(sql).toContain('LIMIT 25');expect(values).toEqual([now]);
  const result=await query();return {rows:result.rows as unknown as Row[],rowCount:result.rowCount};
 }};
 const source=prospectPhoneDiscoverySource();expect(source.name).toBe('prospect-phone-discovery-expiry');
 expect(await source.find(schedulerSession,now)).toEqual([]);
 expect(query).toHaveBeenCalledTimes(1);
 expect(mocks.expire.mock.calls).toEqual([
  [{scope:workspaceScope(id,{kind:'system',component:'scheduler'}),db:schedulerSession}],
  [{scope:workspaceScope(other,{kind:'system',component:'scheduler'}),db:schedulerSession}],
 ]);
 expect(mocks.run).not.toHaveBeenCalled();expect(pageFetch.fetchPages).not.toHaveBeenCalled();
});
it('does no work for an empty due-workspace batch and propagates expiry failure without capture fallback',async()=>{
 const empty:SessionQueryable={query:async()=>({rows:[],rowCount:0})};
 expect(await prospectPhoneDiscoverySource().find(empty,'2026-10-26T06:05:00Z')).toEqual([]);expect(mocks.expire).not.toHaveBeenCalled();
 const due:SessionQueryable={query:async<Row extends QueryResultRowLike>()=>({rows:[{workspace_id:id}] as unknown as Row[],rowCount:1})};
 const error=Error('controlled expiry failure');mocks.expire.mockRejectedValueOnce(error);
 await expect(prospectPhoneDiscoverySource().find(due,'2026-10-26T06:05:00Z')).rejects.toBe(error);
 expect(mocks.run).not.toHaveBeenCalled();expect(pageFetch.fetchPages).not.toHaveBeenCalled();
});
