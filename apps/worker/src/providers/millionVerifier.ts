import {z} from 'zod';
import type {AddressCheck,AddressVerifier} from '@fss/domain/outreach/addressGuess.ts';
import {boundedProviderRequest,type ProviderHttp} from './boundedHttp.ts';

const ENDPOINT='https://api.millionverifier.com/api/v3/';
/** The vendor's own wait for the recipient's mail server (documented range 2 to 60, default 20); the request's bound is longer than it. */
const SERVER_TIMEOUT_SECONDS=20,REQUEST_TIMEOUT_MILLISECONDS=30_000;
const RESULTS=['ok','catch_all','unknown','invalid','disposable'] as const;
// Documented single-API answer: `result`, `resultcode`, `credits` (the account balance, never a charge), `error` (empty on success), and fields this adapter never reads. z.object strips every one of them.
const answerSchema=z.object({result:z.string().trim().max(40).optional(),error:z.string().trim().max(200).optional()});
type Failure=Extract<AddressCheck,{ok:false}>;
const refusal=(status:number):Failure['code']|null=>status===401||status===403?'auth_failed':status===402?'quota_exhausted':status===429?'rate_limited':null;
/** The vendor documents `error` only as a string that is empty on success (the test keys show no-key, invalid-key, insufficient-credits, blocked-IP and internal-error answers); the words are matched loosely and anything else is `unavailable`. */
const errorCode=(error:string):Failure['code']=>/credit|quota|balance/iu.test(error)?'quota_exhausted':/\brate\b|limit|too many/iu.test(error)?'rate_limited':/\bapi\b|key|auth|\bip\b|block/iu.test(error)?'auth_failed':'unavailable';

/** ADR0038. One MillionVerifier single-address check: `GET /api/v3/?api=KEY&email=ADDRESS&timeout=20`, one request, no retry, fail closed. The key travels in the query string the vendor requires and nowhere else:
 * it is never in a thrown message, a returned code or a log, and response bodies and vendor error text never leave this file. Only a recognised `result` is a verdict; whether a verdict admits an address, and what it costs, is the domain's decision.
 * A refusal (bad key or IP, no credits, rate limit, a 4xx) or an `error` answer charged nothing; a request that went out and brought no usable answer (a 5xx, a transport failure, an unreadable or unrecognised body) may have been charged. */
export function millionVerifier(apiKey:string,options:{http?:ProviderHttp}={}):AddressVerifier {
 const http=options.http??fetch;
 return {check:async(address):Promise<AddressCheck>=>{
  if(!apiKey.trim()||/[\r\n]/u.test(apiKey))return {ok:false,code:'auth_failed',mayHaveCharged:false};
  if(address.length>254||!/^[^\s@]+@[^\s@]+$/u.test(address))return {ok:false,code:'invalid_response',mayHaveCharged:false};
  try{
   const query=new URLSearchParams({api:apiKey,email:address,timeout:String(SERVER_TIMEOUT_SECONDS)});
   const response=await boundedProviderRequest(http,`${ENDPOINT}?${query.toString()}`,{method:'GET',headers:{Accept:'application/json','Cache-Control':'no-cache'}},new AbortController().signal,REQUEST_TIMEOUT_MILLISECONDS);
   const refused=refusal(response.status);if(refused)return {ok:false,code:refused,mayHaveCharged:false};
   if(response.status>=400&&response.status<500)return {ok:false,code:'unavailable',mayHaveCharged:false};
   if(response.status<200||response.status>=300)return {ok:false,code:'unavailable',mayHaveCharged:true};
   const parsed=answerSchema.safeParse(response.body);
   if(!parsed.success)return {ok:false,code:'invalid_response',mayHaveCharged:true};
   if(parsed.data.error)return {ok:false,code:errorCode(parsed.data.error),mayHaveCharged:false};
   const verdict=RESULTS.find(known=>known===parsed.data.result?.toLowerCase());
   return verdict?{ok:true,verdict}:{ok:false,code:'invalid_response',mayHaveCharged:true};
  }catch{return {ok:false,code:'unavailable',mayHaveCharged:true};}
 }};
}

/** The key is the only input. Absent or blank means no verifier: no address is guessed and a published address is checked by the free DNS check alone. */
export function millionVerifierFromEnvironment(environment:Readonly<Record<string,string|undefined>>):AddressVerifier|undefined {
 const key=environment['FSS_MILLIONVERIFIER_API_KEY'];
 return key?.trim()?millionVerifier(key.trim()):undefined;
}
