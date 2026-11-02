import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import type {CandidateInput,SourceObservation} from '@fss/contracts';
import type {ManualPhoneSnapshot} from '../../sourcing/manualProspectPhone.ts';
import {preparedEmailRoute} from '../../sourcing/preparedEmailRoute.ts';

// ADR0035. Fictional own-site pages: an address counts only when the company itself published it, exactly.
const now=Date.parse('2026-11-02T15:00:00Z'),website='https://peak.example.test/',id='20000000-0000-4000-8000-000000000001',run='20000000-0000-4000-8000-000000000002';
const business='Peak Property Management manages rental properties for landlords and investors throughout the Richmond area.';
function snapshot(texts:string[],options:{url?:string;deadlines?:Record<string,number>|null;retrievedAt?:number}={}):ManualPhoneSnapshot{
 const url=options.url??website,candidate:CandidateInput={firmName:'Peak Property Management',website,locality:'Richmond',region:'VA',signal:'fit_only',evidence:'Retained discovery context',sourceUrl:website,observedOn:'2026-11-02',preparedBy:'Fictional retained acceptance'};
 const blocks=texts.map((text,index)=>({id:`b${index}`,text}));
 const page:SourceObservation={id,url,blocks,contentHash:'a'.repeat(64),relevantTextHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex'),retrievedAt:new Date(options.retrievedAt??now-1000).toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false};
 return {id:run,candidate_id:id,candidate_revision:1,payload:candidate,origins:[],observations:[page],facts:[],permitted_urls:[url],...(options.deadlines===null?{}:{prepared_source_deadlines:options.deadlines??{}})};
}
const route=(texts:string[],options?:Parameters<typeof snapshot>[1])=>preparedEmailRoute(snapshot(texts,options),now)?.address??null;

it('returns the exact address a company published on its own page, with its page and block',()=>{
 expect(preparedEmailRoute(snapshot([business,'Questions? Email the office at Info@Peak.example.test or call us.']),now)).toMatchObject({address:'info@peak.example.test',observationId:id,blockId:'b1',url:website});
});
it.each([
 ['a consumer mailbox','Email us at peakpm@gmail.com'],
 ['an address at another company\'s domain','Email us at office@someone-else.example.test'],
 ['a subdomain it does not own','Email us at office@mail.peak.example.test'],
 ['a suggestion','Try emailing sales@peak.example.test if you are unsure.'],
 ['a vendor credit','Website by Acme Web Designer, contact designer@peak.example.test'],
 ['a no-reply mailbox','Automated notices come from noreply@peak.example.test'],
 ['no literal address (a guess is never made)','Email the office, our usual first-initial last-name addresses work.'],
])('refuses %s',(_label,text)=>{expect(route([business,text])).toBeNull();});
it('prefers a role mailbox in a fixed order, then the first alphabetically',()=>{
 expect(route([business,'Sales: sales@peak.example.test | Office: office@peak.example.test | General: info@peak.example.test'])).toBe('info@peak.example.test');
 expect(route([business,'Reach zed@peak.example.test or amy@peak.example.test'])).toBe('amy@peak.example.test');
});
it('reads nothing from a page on another host that has no capture manifest',()=>{
 expect(route([business,'Email office@peak-moved.example.test'],{url:'https://peak-moved.example.test/contact'})).toBeNull();
});
it('fails closed without the prepared collection\'s deadlines and once a page deadline has passed',()=>{
 expect(route([business,'Email info@peak.example.test'],{deadlines:null})).toBeNull();
 expect(route([business,'Email info@peak.example.test'],{deadlines:{[website]:now-1}})).toBeNull();
 expect(route([business,'Email info@peak.example.test'],{deadlines:{[website]:now+60_000}})).toBe('info@peak.example.test');
});
it('expires seven days after retrieval and ignores an oversized block',()=>{
 expect(route([business,'Email info@peak.example.test'],{retrievedAt:now-8*86400000})).toBeNull();
 expect(preparedEmailRoute(snapshot([business,'Email info@peak.example.test'],{retrievedAt:now-86400000}),now)?.expiresAt).toBe(now-86400000+7*86400000);
 expect(route([business,`Email info@peak.example.test ${'padding '.repeat(300)}`])).toBeNull();
});
