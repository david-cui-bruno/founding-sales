import {createHash,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import type {SourceObservation} from '@fss/contracts';
import {discoverSameSiteUrls,ownSitePageKind} from '../../research/sourcePolicy.ts';
import {buildPreparedCapture} from '../../sourcing/preparedCapture.ts';

const site='https://www.ownsite.example.test';
it('orders one contact, about and team page first from the landing page\'s own same-site links',()=>{
 const hrefs=['/services','https://elsewhere.example.test/contact','/faq','/contact-us','/contact-us/','#top','/company','/property-management-company','/contact','/leadership/','http://www.ownsite.example.test/about','/about-us','tel:5550100','mailto:a@b.test','https://ownsite.example.test/our-team'];
 const urls=discoverSameSiteUrls({firmWebsite:`${site}/`,maxPagesPerFirm:4,prioritizeContactPages:true},{from:`${site}/`,hrefs});
 expect(urls).toEqual([`${site}/contact-us`,`${site}/company`,`${site}/leadership`,`${site}/contact`,`${site}/services`,`${site}/faq`,`${site}/about-us`,'https://ownsite.example.test/our-team']);
 // Other research keeps its existing filter and page order.
 expect(discoverSameSiteUrls({firmWebsite:`${site}/`,maxPagesPerFirm:4},{from:`${site}/`,hrefs})).toEqual([`${site}/services`,`${site}/faq`,`${site}/contact-us`,`${site}/contact`,`${site}/about-us`,'https://ownsite.example.test/our-team']);
 expect(['/contact-us','/about','/who-we-are/','/meet-the-team','/staff','/property-management-company','/teamwork','/'].map(path=>ownSitePageKind(site+path))).toEqual(['contact','about','about','team','team',null,null,null]);
});

const blocks=(text:string)=>[{id:'b1',text}];
const observation=(url:string,text='Fictional company text.'):SourceObservation=>({id:randomUUID(),url,contentHash:'a'.repeat(64),relevantTextHash:createHash('sha256').update(JSON.stringify(blocks(text))).digest('hex'),retrievedAt:'2026-11-01T01:00:00.000Z',publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:blocks(text)});
const trace=(...urls:string[])=>({version:'page-redirect-trace-v1' as const,urls});
const binding={candidateId:'10000000-0000-4000-8000-000000000001',candidateRevision:1,sourceUrl:`${site}/`};
it('associates at most one linked contact, about and team page through the landing page\'s exact traced chain',()=>{
 const landing=observation(`${site}/`),contact=observation(`${site}/contact-us`),moved=observation(`${site}/about/company-story`),team=observation(`${site}/our-team`),second=observation(`${site}/contact`),services=observation(`${site}/services`);
 const pages=[
  {source:landing,trace:trace(`${site}/`)},
  {source:contact,trace:trace(`${site}/contact-us`),linkedFrom:`${site}/`},
  {source:moved,trace:trace(`${site}/about-us`,`${site}/about/company-story`),linkedFrom:`${site}/`},
  {source:team,trace:trace(`${site}/our-team`),linkedFrom:`${site}/`},
  {source:second,trace:trace(`${site}/contact`),linkedFrom:`${site}/`},
  {source:services,trace:trace(`${site}/services`),linkedFrom:`${site}/`},
 ];
 expect(buildPreparedCapture(binding,pages)?.pages.map(p=>[p.observationId,p.redirectUrls])).toEqual([
  [contact.id,[`${site}/`,`${site}/contact-us`]],
  [moved.id,[`${site}/`,`${site}/about-us`,`${site}/about/company-story`]],
  [team.id,[`${site}/`,`${site}/our-team`]],
 ]);
 // V1 never associates a linked page; an untraced or unlinked landing supplies nothing.
 expect(buildPreparedCapture(binding,pages,'prepared-source-association-v1')).toBeNull();
 expect(buildPreparedCapture(binding,[{source:landing,trace:undefined},pages[1]!])).toBeNull();
 expect(buildPreparedCapture(binding,[pages[0]!,{...pages[1]!,linkedFrom:`${site}/elsewhere`}])).toBeNull();
 // A linked chain that loops back or leaves the site is not an association.
 expect(buildPreparedCapture(binding,[pages[0]!,{source:contact,trace:trace(`${site}/`,`${site}/contact-us`),linkedFrom:`${site}/`}])).toBeNull();
 const offsite=observation('https://partner.example.test/contact');
 expect(buildPreparedCapture(binding,[pages[0]!,{source:{...offsite,firstParty:false},trace:trace(`${site}/contact-x`,'https://partner.example.test/contact'),linkedFrom:`${site}/`}])).toBeNull();
});
