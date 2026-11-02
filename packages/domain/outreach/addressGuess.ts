import type {RepositoryContext} from '../db/workspaceScope.ts';
import {withTransaction} from '../db/queryable.ts';
import {readPeopleEnrichmentSetting} from '../settings/peopleEnrichment.ts';
import {listPreparedEmailCandidates} from '../sourcing/preparedEmailRead.ts';
import type {EmailVerifier} from './emailVerification.ts';
import {currentPeopleContacts} from './peopleContacts.ts';
import {businessDateNow,creditsOnDate,enrichedCustody,enrichmentRegions,markStaleReservations,reservePeopleLookup,settlePeopleLookup,type PeopleCompany} from './peopleEnrichment.ts';
import {MILLIONVERIFIER_PROVIDER,OWN_SITE_PROVIDER,personalAddressAtHost,type AddressRefusal} from './peopleProvider.ts';
import {preparedAdmissionRefusedInAdvance} from './preparedEmailAssessment.ts';
import {admittedCandidateIds} from './preparedEmailSelection.ts';

/** ADR0038. The seam of a paid single-address check (MillionVerifier is the one adapter): one address in, one verdict out. `ok`: the mailbox exists; `catch_all`: the domain accepts every
 * address, so nothing is proved; `unknown`: the check could not tell; `invalid`: no such mailbox; `disposable`: a throwaway domain. Adapters never retry, never expose response bodies or
 * the key, and fail closed; whether a verdict admits an address, and what it spends, is the domain's decision. `mayHaveCharged` is true when the request went out and no usable answer came back. */
export type AddressVerdict='ok'|'catch_all'|'unknown'|'invalid'|'disposable';
export type AddressCheck={ok:true;verdict:AddressVerdict}|{ok:false;code:'auth_failed'|'quota_exhausted'|'rate_limited'|'unavailable'|'invalid_response';mayHaveCharged:boolean};
export interface AddressVerifier {check(address:string):Promise<AddressCheck>}
/** Credits one check costs, measured in research R3 (the account balance matched): `ok` and `invalid` are charged one credit, `catch_all` and `unknown` are free. The vendor's docs do not say what `disposable` costs, so it is charged one (conservative). */
export const verdictCredits=(verdict:AddressVerdict):0|1=>verdict==='catch_all'||verdict==='unknown'?0:1;
const REFUSALS:Record<AddressVerdict,AddressRefusal>={ok:'verdict_ok',catch_all:'verdict_catch_all',unknown:'verdict_unknown',invalid:'verdict_invalid',disposable:'verdict_disposable'};
/** At most this many guesses per pass, and none started after a minute: one check can wait 30 seconds and the job's lease is 120. */
const GUESS_PASS_LOOKUPS=10,PAID_PASS_MILLISECONDS=60_000;
export const paidCheckTimeAvailable=(startedAt:number):boolean=>Date.now()-startedAt<PAID_PASS_MILLISECONDS;

/** The ONE guess: `first@host`, the person's real first name lowercased ASCII with diacritics stripped (R3: it won 15 of 16 verified guesses). A first name that is not purely alphabetic after that (a hyphen, a space, an apostrophe, a letter ASCII cannot spell) is refused, never repaired, and the host must be the company's own, a valid personal-name mailbox there. Pure. */
export function guessAddress(firstName:string,host:string):string|null{
 const local=firstName.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
 if(!/^[a-z]{2,40}$/u.test(local))return null;
 const address=personalAddressAtHost(`${local}@${host}`,host);
 return address.ok?address.email:null;
}

type Paid={kind:'checked';id:string;verdict:AddressVerdict;credits:0|1}|{kind:'failed';code:string;credits:0|1}|{kind:'skipped';why:'cap'|'disabled'|'taken'|'gone'};
/** The reservation protocol of ADR0036 around ONE paid check: reserve one credit (re-reading the switch and the daily cap under lock) BEFORE the request, call once, and leave the settlement to the caller for an answer. A failure settles itself: an unusable answer after the request went out keeps the credit (`unknown`, never retried); a refusal charged nothing and is tried again after the cool-down. */
async function paidCheck(ctx:RepositoryContext,verifier:AddressVerifier,company:PeopleCompany,address:string):Promise<Paid>{
 const reservation=await reservePeopleLookup(ctx,{provider:MILLIONVERIFIER_PROVIDER,company,credits:1});
 if(reservation.kind!=='reserved')return {kind:'skipped',why:reservation.kind};
 let check:AddressCheck;
 try{check=await verifier.check(address);}catch{check={ok:false,code:'unavailable',mayHaveCharged:true};}
 if(!check.ok){await settlePeopleLookup(ctx,reservation.id,check.mayHaveCharged?{state:'unknown',reason:check.code}:{state:'failed',reason:check.code});return {kind:'failed',code:check.code,credits:check.mayHaveCharged?1:0};}
 return {kind:'checked',id:reservation.id,verdict:check.verdict,credits:verdictCredits(check.verdict)};
}

/** A PUBLISHED address's one paid check before admission (ADR0038): a custody row of its own (provider `millionverifier`, one per candidate REVISION, never renewed), counted against the daily cap like a guess, so the company is never paid for twice. The verdict is returned for the admission pass to decide on (`invalid` and `disposable` refuse; the rest admit); the settled `verdict_invalid`/`verdict_disposable` row is itself a refusal that selection and the admission proof honour (`addressRefusedByCheck`), so a crash before the drop record is written admits nothing. Null: nothing was checked (the switch is off, the cap or an earlier check holds the company, or the verifier failed): the free DNS check decides alone. */
export async function checkPublishedAddress(ctx:RepositoryContext,verifier:AddressVerifier,company:PeopleCompany,address:string,negative:(verdict:'invalid'|'disposable')=>Promise<void>):Promise<AddressVerdict|null>{
 const paid=await paidCheck(ctx,verifier,company,address);
 if(paid.kind!=='checked')return null;
 // A negative answer and its address-bound refusal record commit together (and the settled row is a refusal on its own, `addressRefusedByCheck`): a completed negative check is never an unavailable-verifier fallback.
 await withTransaction(ctx.db,async()=>{await settlePeopleLookup(ctx,paid.id,{state:'none',reason:REFUSALS[paid.verdict],credits:paid.credits});if(paid.verdict==='invalid'||paid.verdict==='disposable')await negative(paid.verdict);});
 return paid.verdict;
}

export interface AddressGuessPass {looked:number;verified:number;refused:number;credits:number;/** The verifier failure code that halted the pass, if any. */halted:string|null;stopped:'disabled'|'cap'|null}
/** ADR0038. For each prepared company (the prepared list's order, one per host) whose current named person came from its own pages WITHOUT an address: guess `first@host` once, check the host has a mail exchanger (free), reserve a credit, ask the verifier once and record the answer. Only `ok` makes an address: a `verified_guess` copy of the person (the page the NAME was read from stays cited) for the cited page's own deadline. catch_all, unknown, invalid and disposable leave the person
 * without an address and the company in custody, so it is never guessed again for that candidate revision (a new revision is a new, separately counted row); an uncharged refusal is tried again after an hour. It stops at the daily credit cap and on the first verifier failure, and starts nothing after a minute. */
export async function runAddressGuessing(ctx:RepositoryContext,deps:{verifier:AddressVerifier;mailDomain:EmailVerifier}):Promise<AddressGuessPass>{
 const pass:AddressGuessPass={looked:0,verified:0,refused:0,credits:0,halted:null,stopped:null},startedAt=Date.now();
 const setting=await readPeopleEnrichmentSetting(ctx);
 if(!setting.enabled||setting.dailyCredits<1){pass.stopped='disabled';return pass;}// Only a pre-check: every reservation re-reads and locks the switch and the cap.
 await markStaleReservations(ctx);
 if(await creditsOnDate(ctx,(await businessDateNow(ctx)).date)+1>setting.dailyCredits){pass.stopped='cap';return pass;}
 const [custody,people]=await Promise.all([enrichedCustody(ctx,MILLIONVERIFIER_PROVIDER),currentPeopleContacts(ctx)]),skip=custody.candidates,guesses=new Map<string,string>();
 for(const id of await admittedCandidateIds(ctx))skip.add(id);
 const batch=await listPreparedEmailCandidates(ctx,{limit:GUESS_PASS_LOOKUPS,regions:await enrichmentRegions(ctx),skip,accept:async read=>{
  const person=people.get(read.candidateId),address=person?guessAddress(person.firstName,read.host):null;
  if(!person||!address||person.provider!==OWN_SITE_PROVIDER||person.email!==null||!person.source||person.candidateRevision!==read.candidateRevision||person.host!==read.host||custody.hosts.has(read.host)||await preparedAdmissionRefusedInAdvance(ctx,null,read,address))return false;
  guesses.set(read.candidateId,address);return true;
 }});
 for(const company of batch){
  if(!paidCheckTimeAvailable(startedAt))break;
  const person=people.get(company.candidateId)!,address=guesses.get(company.candidateId)!;
  // A host with no mail exchanger has no mailbox to pay to ask about: refused free and recorded, so it is not looked at again.
  const mail=await deps.mailDomain.verify(address);
  if(mail===null)continue;
  if(mail==='invalid'){
   const free=await reservePeopleLookup(ctx,{provider:MILLIONVERIFIER_PROVIDER,company,credits:0});
   if(free.kind==='reserved'){await settlePeopleLookup(ctx,free.id,{state:'none',reason:'no_mail_domain',credits:0});pass.refused++;}
   continue;
  }
  const paid=await paidCheck(ctx,deps.verifier,company,address);
  if(paid.kind==='skipped'){if(paid.why==='cap'||paid.why==='disabled'){pass.stopped=paid.why;break;}continue;}
  pass.looked++;pass.credits+=paid.credits;
  if(paid.kind==='failed'){pass.halted=paid.code;break;}
  if(paid.verdict==='ok'){
   // The person is the own-site person (name, title, citation); the address is the guess. Medium confidence: the company did not publish it for them.
   await settlePeopleLookup(ctx,paid.id,{state:'found',credits:paid.credits,citedDeadline:person.expiresAt.getTime(),person:{providerPersonId:person.providerPersonId,firstName:person.firstName,lastName:person.lastName,title:person.title,email:address,emailStatus:'verified_guess',confidence:'medium',source:person.source!}});
   pass.verified++;
  }else{await settlePeopleLookup(ctx,paid.id,{state:'none',reason:REFUSALS[paid.verdict],credits:paid.credits});pass.refused++;}
 }
 return pass;
}
