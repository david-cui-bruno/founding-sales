import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {supportedBusinessEmail} from '../../outreach/selection.ts';
import type {QualificationFact,SourceObservation} from '@fss/contracts';
const identity={status:'resolved' as const,name:'Example PM',website:'https://example.test',locality:'Dallas',region:'TX'};
const now='2026-10-05T12:00:00.000Z';
function evidence(text:string,url='https://example.test/contact'){
 const source:SourceObservation={id:randomUUID(),url,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:now,publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[{id:'contact',text}]};
 const fact={kind:'business_email',value:text,observationId:source.id,blockId:'contact'} as QualificationFact;
 return {facts:[fact],observations:[source],identity,now};
}
it('accepts a source-associated office mailbox as a role, without inventing a person',()=>{
 expect(supportedBusinessEmail(evidence('Example PM Dallas TX office email: info@example.test'))).toMatchObject({address:'info@example.test',identityKind:'role',displayName:'Office'});
 expect(supportedBusinessEmail(evidence('Example PM Dallas TX contact Jane Doe at jane@example.test'))).toMatchObject({address:'jane@example.test',identityKind:'named',displayName:'Jane Doe'});
});
it('holds guessed, personal, referral, shared-branch, mismatched and stale addresses',()=>{
 for(const text of ['Email info@example.test','Example PM Dallas TX reach our vendor at vendor@example.test','Example PM Houston TX office info@example.test','Example PM Dallas TX office example@gmail.com','Example PM Dallas TX suggested address: info@example.test','Example PM Dallas TX office info@other.test'])expect(supportedBusinessEmail(evidence(text))).toBeNull();
 expect(supportedBusinessEmail(evidence('Example PM Dallas TX office info@example.test','https://another.test/contact'))).toBeNull();
 const stale=evidence('Example PM Dallas TX office info@example.test');stale.observations[0]!.retrievedAt='2026-09-01T00:00:00.000Z';expect(supportedBusinessEmail(stale)).toBeNull();
 const bad=evidence('Example PM Dallas TX office info@example.test');bad.facts[0]!.value='Example PM Dallas TX office invented@example.test';expect(supportedBusinessEmail(bad)).toBeNull();
});
function officeCard(lines=['Example PM','(401) 223-2222','admin@example.test','Office Location','1290 Westminster St.','Dallas TX 02909']){
 const input=evidence('admin@example.test');
 input.observations[0]!.blocks=lines.map((text,i)=>({id:`b${i}`,text}));
 input.facts[0]!.blockId=`b${lines.indexOf('admin@example.test')}`;
 return input;
}
it('accepts a compact first-party office contact card with separate name, email and address blocks',()=>{
 expect(supportedBusinessEmail(officeCard())).toMatchObject({address:'admin@example.test',identityKind:'role',blockId:'b2'});
});
it('does not stitch together separate firms, offices, vendor credits or long page sections',()=>{
 const rejected=[
 ['Example PM','Other PM','admin@example.test','Dallas TX'],
 ['Example PM','Houston TX','admin@example.test','Dallas TX'],
 ['Example PM','admin@example.test','Our vendor','Dallas TX'],
 ['Example PM','admin@example.test','other@example.test','Dallas TX'],
 ['Example PM','admin@example.test','Office Location','1290 Westminster St.','Suite 2','Phone','Dallas TX'],
 ['Other PM','admin@example.test','Dallas TX'],
 ];
 for(const lines of rejected)expect(supportedBusinessEmail(officeCard(lines))).toBeNull();
 const home=officeCard();home.observations[0]!.url='https://example.test/';expect(supportedBusinessEmail(home)).toBeNull();
 const truncated=officeCard();truncated.observations[0]!.truncated=true;expect(supportedBusinessEmail(truncated)).toBeNull();
 const stale=officeCard();stale.observations[0]!.retrievedAt='2026-09-01T00:00:00Z';expect(supportedBusinessEmail(stale)).toBeNull();
 const wrong=officeCard();wrong.identity={...identity,locality:'Houston'};expect(supportedBusinessEmail(wrong)).toBeNull();
});
