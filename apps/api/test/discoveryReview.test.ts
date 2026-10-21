import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {dispatch,type ApiRequest} from '../src/server.ts';
import {localNoopSuppressionJournal} from '../src/journal/index.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {discoveryReviewCandidate,discoveryHumanReview} from '../../../packages/domain/test/sourcing/support/discoveryReviewFixtures.ts';
let f:AuthFixture,admin:string,sales:string,beta:string;
const reviewPath='/sourcing/candidates/discovery/review-v1',listPath='/sourcing/candidates/discovery/useful-list-v1';
const envelope=(body:object)=>({...body,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
async function request(path:string,token:string|null,body:unknown,method='POST'){return dispatch({method,path,query:new URLSearchParams(),headers:token===null?{}:{authorization:`Bearer ${token}`},body} as ApiRequest,{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://example.test/update',suppressionJournal:localNoopSuppressionJournal()});}
async function candidate(){const answer=await request('/sourcing/candidates/discovery/save-v1',admin,envelope(discoveryReviewCandidate()));expect(answer.status).toBe(200);return (answer.body as {result:{id:string}}).result.id;}
beforeAll(async()=>{f=await createAuthFixture();admin=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;sales=(await issueSessionFor(f,f.alpha,f.alpha.salesperson)).accessToken;beta=(await issueSessionFor(f,f.beta,f.beta.admin)).accessToken;});
beforeEach(async()=>{await f.db.query('DELETE FROM sourcing_candidates');});
afterAll(async()=>{await f.stop();});
it('authenticates additive paths and rejects unsupported methods, salesperson and foreign candidate review',async()=>{
  expect((await request(reviewPath,null,{})).status).toBe(401);expect((await request(listPath,admin,{},'GET')).status).toBe(405);
  expect((await request(listPath,sales,{status:'needs_review',offset:0})).status).toBe(403);
  const id=await candidate(),input=envelope(discoveryHumanReview(id));
  expect((await request(reviewPath,sales,input)).body).toMatchObject({reason:'admin_only'});
  expect((await request(reviewPath,beta,envelope(discoveryHumanReview(id)))).body).toMatchObject({reason:'not_found'});
  expect((await request(listPath,beta,{status:'needs_review',offset:0})).body).toMatchObject({candidates:[],hasMore:false});
});
it('uses ordinary command replay/conflicting-payload handling, content dedupe and ID-only receipt without excerpts',async()=>{
  const id=await candidate(),input=envelope(discoveryHumanReview(id)),first=await request(reviewPath,admin,input);
  expect(first.status).toBe(200);expect(first.body).toMatchObject({status:'accepted',replayed:false,result:{alreadyRecorded:false,review:{candidateId:id,candidateRevision:1}}});
  const saved=(first.body as {result:{review:{id:string}}}).result.review.id;
  expect((await request(reviewPath,admin,input)).body).toEqual({...first.body as object,replayed:true});
  expect((await request(reviewPath,admin,{...input,assessment:{...input.assessment,serviceSignal:'tentative'}})).body).toMatchObject({reason:'command_payload_mismatch'});
  expect((await request(reviewPath,admin,{...input,commandId:randomUUID()})).body).toMatchObject({result:{alreadyRecorded:true,review:{id:saved}}});
  const receipt=(await f.db.query<{result:unknown}>('SELECT result FROM command_receipts WHERE command_id=$1',[input.commandId])).rows[0]!.result;
  expect(receipt).toEqual({reviewId:saved,alreadyRecorded:false});expect(JSON.stringify(receipt)).not.toContain(input.evidence[0]!.blocks[0]!.text);
  expect((await request(listPath,admin,{status:'needs_review',offset:0,band:'review_first'})).body).toMatchObject({candidates:[{candidate:{id,revision:1},band:'review_first',admissionAuthorized:false,runtimeCallable:false}],hasMore:false});
});
it('never replays copied text after candidate deletion, revision change, dismissal or evidence expiry',async()=>{
  for(const change of ['delete','revision','dismiss','expiry'] as const){
    await f.db.query('DELETE FROM sourcing_candidates');const id=await candidate(),input=envelope(discoveryHumanReview(id));expect((await request(reviewPath,admin,input)).status).toBe(200);
    if(change==='delete')expect((await request('/sourcing/candidates/delete',admin,envelope({id,expectedRevision:1}))).status).toBe(200);
    if(change==='revision')await f.db.query('UPDATE sourcing_candidates SET revision=revision+1 WHERE id=$1',[id]);
    if(change==='dismiss')expect((await request('/sourcing/candidates/review',admin,envelope({id,expectedRevision:1,status:'dismissed'}))).status).toBe(200);
    if(change==='expiry')await f.db.query("UPDATE sourcing_candidate_discovery_reviews SET evidence=jsonb_set(evidence,'{0,retrievedAt}',to_jsonb((now()-interval '7 days')::text))");
    const replay=await request(reviewPath,admin,input);expect(replay.body).toMatchObject({status:'refused',reason:'review_unavailable',replayed:true});expect(JSON.stringify(replay.body)).not.toContain(input.evidence[0]!.blocks[0]!.text);
    if(change!=='delete'){const listing=await request(listPath,admin,{status:change==='dismiss'?'dismissed':'needs_review',offset:0});expect(listing.body).toMatchObject({candidates:[{review:null,band:'unreviewed'}]});}
  }
});
it('does not leak a retained historical excerpt through replay or useful read after known same-workspace source loss',async()=>{
  const id=await candidate(),input=envelope(discoveryHumanReview(id));expect((await request(reviewPath,admin,input)).status).toBe(200);
  // Existing source-check state, no network/provider action. Keep the review row to
  // prove current reads hide before a physical erasure sweep runs.
  await f.db.query("UPDATE sourcing_candidates SET source_check=$2::jsonb WHERE id=$1",[id,JSON.stringify({checkId:randomUUID(),jobId:randomUUID(),requestedAt:new Date().toISOString(),state:'unavailable',reason:'source_unavailable',checkedAt:new Date().toISOString(),lastSuccess:{url:input.evidence[0]!.url,contentHash:input.evidence[0]!.contentHash,retrievedAt:input.evidence[0]!.retrievedAt,firstParty:false,excerpt:input.evidence[0]!.blocks[0]!.text,quoteMatched:false,truncated:true}})]);
  expect((await request(reviewPath,admin,input)).body).toMatchObject({reason:'review_unavailable',replayed:true});
  expect((await request(listPath,admin,{status:'needs_review',offset:0})).body).toMatchObject({candidates:[{review:null,band:'unreviewed'}]});
  expect((await request(reviewPath,admin,{...input,commandId:randomUUID()})).body).toMatchObject({reason:'source_unavailable'});
});
it('rejects malformed evidence and unrelated private/body/contact fields without creating reviews',async()=>{
  const id=await candidate(),input=envelope(discoveryHumanReview(id));
  for(const body of [{...input,rawBody:'private'},{...input,contactInventory:[]},{...input,evidence:[{...input.evidence[0],basis:'native_observation'}]},{...input,evidence:[{...input.evidence[0],blocks:[{...input.evidence[0]!.blocks[0],kind:'heading'}]}]}])expect((await request(reviewPath,admin,body)).status).toBe(400);
  expect((await request(reviewPath,admin,{...input,evidence:[{...input.evidence[0],retrievedAt:new Date(Date.now()+60000).toISOString()}]})).body).toMatchObject({reason:'retrieval_in_future'});
  expect((await request(listPath,admin,{status:'needs_review',offset:0,band:'verified'})).status).toBe(400);
  expect((await f.db.query('SELECT count(*)::int n FROM sourcing_candidate_discovery_reviews')).rows[0]?.['n']).toBe(0);
});
