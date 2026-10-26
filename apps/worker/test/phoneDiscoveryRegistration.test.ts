import {describe,expect,it,vi} from 'vitest';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers,workerDueWorkSources} from '../src/bootstrap/main.ts';

describe('explicit phone discovery registered composition',()=>{
 it('requires the existing page provider and keeps one-attempt outbound fencing without dispatch during composition',()=>{
  const empty={classifier:undefined,mail:undefined,send:undefined,research:undefined};
  expect(registerHandlers(new HandlerRegistry(),empty).get('sourcing.phone_discover')).toBeUndefined();
  const fetchPages=vi.fn(async()=>({ok:false as const,costCents:0,failureCode:'unavailable'}));
  const handler=registerHandlers(new HandlerRegistry(),{...empty,research:{pageFetch:{providerKey:'controlled',fetchPages}}}).get('sourcing.phone_discover');
  expect(handler).toMatchObject({kind:'sourcing.phone_discover',protection:'outbound_fence',maxAttempts:1,leaseSeconds:180});
  expect(fetchPages).not.toHaveBeenCalled();
 });
 it('keeps only the finite expiry source present with all acquisition options disabled',()=>{
  const sources=workerDueWorkSources();
  expect(sources.filter(source=>source.name==='prospect-phone-discovery-expiry')).toHaveLength(1);
  expect(sources.filter(source=>source.name.includes('phone-discovery')).map(source=>source.name)).toEqual(['prospect-phone-discovery-expiry']);
 });
});
