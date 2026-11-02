import {expect,it} from 'vitest';
import type {MailDomainResolver} from '../../crm/routeValidation.ts';
import {dnsEmailVerifier,emailVerificationDecides,emailVerificationKey} from '../../outreach/emailVerification.ts';

// The free in-house pre-admission check: syntax, a real MX, no consumer/disposable domain, no SMTP, fail closed on resolver errors.
const dns=(answers:{mx?:string[]|Error;a?:string[]|Error}):MailDomainResolver=>({
 resolveMx:async()=>{const mx=answers.mx??[];if(mx instanceof Error)throw mx;return mx.map((exchange,priority)=>({exchange,priority}));},
 resolve4:async()=>{const a=answers.a??[];if(a instanceof Error)throw a;return a;},
 resolve6:async()=>[],
});
const code=(name:string)=>Object.assign(new Error(name),{code:name});
it.each([
 ['a real MX record',dns({mx:['mail.peakpm.org']}),'office@peakpm.org','valid'],
 ['a null MX',dns({mx:['']}),'office@peakpm.org','invalid'],
 ['no MX and only an A record (the implicit MX does not admit)',dns({mx:code('ENODATA'),a:['192.0.2.1']}),'office@peakpm.org','invalid'],
 ['a missing domain',dns({mx:code('ENOTFOUND')}),'office@peakpm.org','invalid'],
 ['a consumer mailbox',dns({mx:['mx.google.com']}),'peakpm@gmail.com','invalid'],
 ['a disposable domain',dns({mx:['mx.mailinator.com']}),'peak@mailinator.com','invalid'],
 ['a malformed address',dns({mx:['mx.example.com']}),'office@@peak','invalid'],
 ['a reserved name',dns({mx:['mx.example.com']}),'office@peak.test','invalid'],
 ['a resolver timeout (no answer, asked again later)',dns({mx:code('ETIMEOUT')}),'office@peakpm.org',null],
 ['a SERVFAIL (no answer, asked again later)',dns({mx:code('ESERVFAIL')}),'office@peakpm.org',null],
] as const)('%s',async(_label,resolver,address,expected)=>{
 expect(await dnsEmailVerifier(resolver,50).verify(address)).toBe(expected);
});
it('keys by a lowercase digest and bounds how long an answer decides',()=>{
 expect(emailVerificationKey(' Office@PeakPM.org ')).toBe(emailVerificationKey('office@peakpm.org'));
 const now=Date.parse('2026-11-02T12:00:00Z'),at=(days:number)=>new Date(now-days*86400000);
 expect(emailVerificationDecides({result:'valid',outcome:'ok',checkedAt:at(6)},now)).toBe(true);
 expect(emailVerificationDecides({result:'valid',outcome:'ok',checkedAt:at(8)},now)).toBe(false);
 expect(emailVerificationDecides({result:'invalid',outcome:'drop',checkedAt:at(29)},now)).toBe(true);
 expect(emailVerificationDecides({result:'invalid',outcome:'drop',checkedAt:at(31)},now)).toBe(false);
});
