import {expect,it,vi} from 'vitest';
import {sourcingDiscoveryReviewHandlers} from '../src/main/sourcingDiscoveryReviewHandlers.ts';
import {sourcingDiscoveryReviewOperations} from '../src/shared/sourcingDiscoveryReviewOperations.ts';
import type {AuthedClient} from '../src/main/authedClient.ts';
import {discoveryHumanReview} from '../../../packages/domain/test/sourcing/support/discoveryReviewFixtures.ts';
import {discoveryReviewContent,discoveryPriority} from '../../../packages/domain/sourcing/discoveryReviewPolicy.ts';
const id='11111111-1111-4111-8111-111111111111',commandId='22222222-2222-4222-8222-222222222222';
const input=discoveryHumanReview(id),content=discoveryReviewContent(input);
const review={id,candidateId:id,candidateRevision:1,reviewVersion:'discovery-review-v1' as const,contentDigest:content.digest,evidence:content.evidence,assessment:content.assessment,reviewedAt:new Date().toISOString()};
it('keeps pure priority transparent: unknown identity supports review-first, heading/ambiguity tentative, contradictory never dismissal',()=>{
  expect(discoveryPriority(review)).toBe('review_first');expect(discoveryPriority(null)).toBe('unreviewed');
  expect(discoveryPriority({...review,evidence:[]})).toBe('unreviewed');
  expect(discoveryPriority({...review,evidence:review.evidence.map(page=>({...page,association:'ambiguous'}))})).toBe('tentative');
  expect(discoveryPriority({...review,assessment:{...review.assessment,websiteAssociation:'ambiguous'}})).toBe('tentative');
  expect(discoveryPriority({...review,evidence:review.evidence.map(page=>({...page,blocks:page.blocks.map(block=>({...block,kind:'heading'}))}))})).toBe('tentative');
  expect(discoveryPriority({...review,assessment:{...review.assessment,serviceSignal:'contradicted'}})).toBe('contradicted');
});
it('canonical content ignores collection order but preserves exact original source identities and text',()=>{
  expect(discoveryReviewContent({...input,assessment:{...input.assessment,unknowns:[...input.assessment.unknowns].reverse()}}).digest).toBe(content.digest);
  const different=structuredClone(input);different.evidence[0]!.source.recordId+='-other';expect(discoveryReviewContent(different).digest).not.toBe(content.digest);
  const text=structuredClone(input);text.evidence[0]!.blocks[0]!.text+='.';expect(discoveryReviewContent(text).digest).not.toBe(content.digest);
});
it('exposes only the narrow read and explicit command paths, with strict bounded payloads',()=>{
  expect(sourcingDiscoveryReviewOperations['sourcing.discoveryUsefulList'].kind).toBe('read');expect(sourcingDiscoveryReviewOperations['sourcing.discoveryReview'].kind).toBe('command');
  expect(sourcingDiscoveryReviewOperations['sourcing.discoveryReview'].input.safeParse({...input,commandId}).success).toBe(true);
  expect(sourcingDiscoveryReviewOperations['sourcing.discoveryReview'].input.safeParse({...input,commandId,privateBody:'no'}).success).toBe(false);
  const oversized=structuredClone(input);oversized.evidence=Array.from({length:8},()=>({...input.evidence[0]!,blocks:Array.from({length:20},(_,n)=>({blockId:`b${n}`,kind:'paragraph' as const,text:'é'.repeat(2000)}))}));
  expect(sourcingDiscoveryReviewOperations['sourcing.discoveryReview'].input.safeParse({...oversized,commandId}).success).toBe(false);
});
it('forwards only intended API reads and explicit command envelope while preserving raw-read handlers',async()=>{
  const api:AuthedClient={read:async(_path,parse)=>({ok:true,value:parse({candidates:[],hasMore:false})}),command:async(_path,_payload,parse)=>({ok:true,value:parse({review,alreadyRecorded:false})})};
  const read=vi.spyOn(api,'read'),command=vi.spyOn(api,'command');
  const handlers=sourcingDiscoveryReviewHandlers({api,generation:()=>0});
  expect(await handlers['sourcing.discoveryUsefulList']({status:'needs_review',offset:0})).toMatchObject({view:{candidates:[]},reason:null});expect(command).not.toHaveBeenCalled();expect(read).toHaveBeenCalledTimes(1);
  expect(await handlers['sourcing.discoveryReview']({...input,commandId})).toMatchObject({result:{review:{candidateId:id}},reason:null});
  expect(command).toHaveBeenCalledWith('/sourcing/candidates/discovery/review-v1',input,expect.any(Function),{commandId});expect(handlers['sourcing.discoveryList']).toBeTypeOf('function');
});
it.each(['read','command'] as const)('drops previous-generation late %s responses without caching copied text',async kind=>{
  let generation=1,finish:(value:unknown)=>void=()=>{};
  const pending=new Promise(resolve=>{finish=resolve;});
  const api={read:vi.fn(()=>pending),command:vi.fn(()=>pending)} as unknown as AuthedClient;
  const handlers=sourcingDiscoveryReviewHandlers({api,generation:()=>generation});
  const answer=kind==='read'?handlers['sourcing.discoveryUsefulList']({status:'needs_review',offset:0}):handlers['sourcing.discoveryReview']({...input,commandId});
  generation++;finish({ok:true,value:kind==='read'?{candidates:[],hasMore:false}:{review,alreadyRecorded:false}});
  expect(await answer).toEqual(kind==='read'?{view:null,reason:'session_changed'}:{result:null,reason:'session_changed'});
});
it('turns transport failures into unavailable without surfacing arbitrary private exceptions',async()=>{
  const api={read:vi.fn().mockRejectedValue(Error('PRIVATE')),command:vi.fn().mockRejectedValue(Error('PRIVATE'))};
  const handlers=sourcingDiscoveryReviewHandlers({api,generation:()=>0});
  expect(await handlers['sourcing.discoveryUsefulList']({status:'needs_review',offset:0})).toEqual({view:null,reason:'unavailable'});expect(await handlers['sourcing.discoveryReview']({...input,commandId})).toEqual({result:null,reason:'unavailable'});
});
