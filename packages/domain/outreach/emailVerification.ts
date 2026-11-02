import {createHash} from 'node:crypto';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {checkMailDomain,isReservedMailDomain,parseEmailAddress,type MailDomainResolver} from '../crm/routeValidation.ts';
import {CONSUMER_EMAIL_DOMAINS} from './consumerEmailDomains.ts';

/** A published address is checked before admission, free and in-house: strict syntax, a real MX record, no consumer or disposable domain.
 * No SMTP probing, no third party. Anything this cannot answer (a DNS error) is neither valid nor invalid: it is asked again later. */
export type EmailVerificationResult='valid'|'invalid';
export type EmailVerificationOutcome='ok'|'drop';
/** The seam a paid verifier could fill later. `null`: no answer now (a resolver error), nothing is recorded or admitted. */
export interface EmailVerifier {verify(address:string):Promise<EmailVerificationResult|null>}
/** A valid answer admits for seven days; an invalid one is not asked again for thirty. */
export const EMAIL_VERIFICATION_VALID_DAYS=7;
export const EMAIL_VERIFICATION_RECHECK_DAYS=30;
export const emailVerificationOutcome=(result:EmailVerificationResult):EmailVerificationOutcome=>result==='valid'?'ok':'drop';

/** The reviewed `email-validation.1` syntax and DNS rules, stricter in one place: the domain must publish a real MX record, so the
 * RFC 5321 implicit-MX fallback (an A record alone) does not admit. Reserved names, a null MX, a missing domain: invalid. */
export function dnsEmailVerifier(resolver:MailDomainResolver,deadlineMilliseconds?:number):EmailVerifier{
 return {verify:async address=>{
  const parsed=parseEmailAddress(address);
  if(!parsed||CONSUMER_EMAIL_DOMAINS.has(parsed.domain)||isReservedMailDomain(parsed.domain))return 'invalid';
  const verdict=await checkMailDomain(resolver,parsed.domain,{deadlineMilliseconds});
  if(verdict.verdict==='deferred')return null;
  return verdict.verdict==='passed'&&verdict.reason==='mx_present'?'valid':'invalid';
 }};
}

/** The table holds no address: a lowercase digest is the lookup key, so private addresses are not retained twice. */
export const emailVerificationKey=(address:string):string=>createHash('sha256').update(address.trim().toLowerCase()).digest('hex');
export interface EmailVerificationRecord {result:EmailVerificationResult;outcome:EmailVerificationOutcome;checkedAt:Date}
export async function latestEmailVerification(ctx:RepositoryContext,address:string):Promise<EmailVerificationRecord|null>{
 const row=(await ctx.db.query<{result:EmailVerificationResult;outcome:EmailVerificationOutcome;checked_at:Date}>('SELECT result,outcome,checked_at FROM outreach_email_verifications WHERE workspace_id=$1 AND address_key=$2 ORDER BY checked_at DESC,id DESC LIMIT 1',[ctx.scope.workspaceId,emailVerificationKey(address)])).rows[0];
 return row?{result:row.result,outcome:row.outcome,checkedAt:row.checked_at}:null;
}
/** Valid and recent by database time: the only answer admission accepts. */
export async function currentValidEmailVerification(ctx:RepositoryContext,address:string):Promise<boolean>{
 return (await ctx.db.query(`SELECT 1 FROM outreach_email_verifications WHERE workspace_id=$1 AND address_key=$2 AND outcome='ok' AND checked_at>clock_timestamp()-make_interval(days=>$3) LIMIT 1`,[ctx.scope.workspaceId,emailVerificationKey(address),EMAIL_VERIFICATION_VALID_DAYS])).rows.length>0;
}
/** Whether a recorded check still decides: a valid one for seven days, an invalid one for thirty. */
export function emailVerificationDecides(record:EmailVerificationRecord,now:number):boolean{
 const days=(now-record.checkedAt.getTime())/86400000;
 return days<(record.outcome==='ok'?EMAIL_VERIFICATION_VALID_DAYS:EMAIL_VERIFICATION_RECHECK_DAYS);
}
export async function recordEmailVerification(ctx:RepositoryContext,address:string,result:EmailVerificationResult):Promise<void>{
 await ctx.db.query('INSERT INTO outreach_email_verifications(workspace_id,address_key,provider,result,outcome) VALUES($1,$2,$3,$4,$5)',[ctx.scope.workspaceId,emailVerificationKey(address),'dns_mx',result,emailVerificationOutcome(result)]);
}
