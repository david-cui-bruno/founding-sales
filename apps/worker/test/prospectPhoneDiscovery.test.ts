import {beforeEach,expect,it,vi} from 'vitest';
import {workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import type {JobHandlerInput} from '@fss/domain/jobs/handlerRegistry.ts';
import type {PageFetchProvider} from '@fss/domain/research/providers.ts';
import {prospectPhoneDiscoveryHandler} from '../src/handlers/prospectPhoneDiscovery.ts';
const mocks=vi.hoisted(()=>({run:vi.fn()}));
vi.mock('@fss/domain/sourcing/prospectPhoneDiscovery.ts',()=>({runProspectPhoneDiscovery:mocks.run}));
const id='10000000-0000-4000-8000-000000000001';
const pageFetch:PageFetchProvider={providerKey:'controlled',fetchPages:vi.fn(async()=>{throw Error('Handler must delegate fetch ownership, never call directly');})};
const session={query:vi.fn(async()=>{throw Error('Handler must delegate transaction ownership, never query directly');})};
const input=(payload:Readonly<Record<string,unknown>>):JobHandlerInput=>({session,scope:workspaceScope(id,{kind:'system',component:'worker'}),job:{id,workspaceId:id,kind:'sourcing.phone_discover',idempotencyKey:`phone:${id}`,payload,attempt:1,maxAttempts:1,fencingToken:'1',leaseOwner:'controlled',leaseExpiresAt:'2026-10-26T06:03:00Z'}});
beforeEach(()=>{vi.clearAllMocks();mocks.run.mockResolvedValue(undefined);});
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
