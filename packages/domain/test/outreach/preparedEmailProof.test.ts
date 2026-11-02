import {beforeEach,expect,it,vi} from 'vitest';
import type {RepositoryContext} from '../../db/workspaceScope.ts';
import type {EmailCampaignRow} from '../../outreach/emailCampaignAuthority.ts';
import type {PreparedEmailTarget} from '../../outreach/emailCampaignSource.ts';

// The proof's validUntil is the earliest of the provider contact's expiry, the campaign's expiry and the prepared company's evidence deadline (the deadline
// the earlier page-route proof carried), so an admission cannot outlive the evidence that made the company prepared.
const mocks=vi.hoisted(()=>({read:vi.fn(),person:vi.fn(),verified:vi.fn()}));
vi.mock('../../sourcing/preparedEmailRead.ts',()=>({readPreparedEmail:mocks.read}));
vi.mock('../../outreach/peopleContacts.ts',()=>({currentPeopleContact:mocks.person}));
vi.mock('../../outreach/emailVerification.ts',()=>({currentValidEmailVerification:mocks.verified}));
vi.mock('../../outreach/emailCampaignAutomatic.ts',()=>({automaticCampaignActor:()=>true}));
const {preparedEmailProof}=await import('../../outreach/preparedEmailProof.ts');
const DAY=86_400_000,base=Date.parse('2026-11-02T12:00:00.000Z');
const target:PreparedEmailTarget={candidateId:'c',candidateRevision:1,runId:'r',address:'jordan@acme.example'} as PreparedEmailTarget;
const campaign=(days:number)=>({owner_user_id:'u',regions:['OH'],expires_at:new Date(base+days*DAY)}) as unknown as EmailCampaignRow;
const page=(url:string,deadline:number,...blocks:string[])=>({observationId:`o-${url}`,url,blocks:blocks.map(id=>({id,text:'x'})),deadline:base+deadline*DAY});
const proof=(input:{evidence:number;person:number;campaign:number;pages?:ReturnType<typeof page>[];source?:{url:string;blockId:string;quote:string}})=>{
 mocks.read.mockResolvedValue({candidateId:'c',candidateRevision:1,runId:'r',host:'acme.example',region:'OH',locality:'Columbus',businessName:'Acme',pages:input.pages??[],evidenceDeadline:base+input.evidence*DAY});
 mocks.person.mockResolvedValue({id:'p',provider:input.source?'own_site':'apollo',source:input.source??null,email:'jordan@acme.example',host:'acme.example',firstName:'Jordan',lastName:'Blake',title:'Owner',matchConfidence:'high',expiresAt:new Date(base+input.person*DAY)});
 return preparedEmailProof({db:{query:vi.fn()}} as unknown as RepositoryContext,campaign(input.campaign),target);
};
beforeEach(()=>{mocks.verified.mockResolvedValue(true);});
it.each([
 ['the prepared evidence deadline',{evidence:3,person:30,campaign:20},3],
 ['the provider contact expiry',{evidence:6,person:2,campaign:20},2],
 ['the campaign expiry',{evidence:6,person:30,campaign:1},1],
])('is valid only until %s when that is the earliest',async(_name,input,days)=>{
 expect((await proof(input))?.validUntil).toBe(base+days*DAY);
});
it('carries an already-passed evidence deadline, which the campaign authority then refuses (now is not before validUntil)',async()=>{
 const expired=await proof({evidence:-1,person:30,campaign:20});
 expect(expired?.validUntil).toBe(base-DAY);
 expect(base>=expired!.validUntil).toBe(true);
});

// ADR0037: an own-site person is read from one cited page and block. That page must still be among the admitted pages, and its own deadline bounds the proof.
const cite={url:'https://acme.example/team',blockId:'b2',quote:'Jordan Blake, Owner'};
it('is valid only until the cited page\'s own deadline when that page expires before the company\'s other evidence',async()=>{
 expect((await proof({evidence:6,person:30,campaign:20,source:cite,pages:[page('https://acme.example/',6,'b1'),page(cite.url,2,'b1','b2')]}))?.validUntil).toBe(base+2*DAY);
 expect((await proof({evidence:6,person:30,campaign:20,source:cite,pages:[page(cite.url,6,'b2')]}))?.validUntil).toBe(base+6*DAY);
});
it.each([
 ['no longer admitted (expired or removed)',[page('https://acme.example/',6,'b1','b2')]],
 ['admitted but without the cited block',[page(cite.url,6,'b1','b3')]],
 ['admitted under no page at all',[]],
])('refuses an own-site person whose cited page is %s',async(_name,pages)=>{
 expect(await proof({evidence:6,person:30,campaign:20,source:cite,pages})).toBeNull();
});
it('does not require a cited page of a provider person, which cites none',async()=>{
 expect((await proof({evidence:6,person:30,campaign:20,pages:[]}))?.validUntil).toBe(base+6*DAY);
});
