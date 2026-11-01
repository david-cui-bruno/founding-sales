import {it,expect} from 'vitest';
import {discoveryListLeads,routeDiscoveryHits,DISCOVERY_LIST_LEAD_LIMIT} from '../../sourcing/discoveryListLeads.ts';
import {MAX_PAGE_BYTES} from '../../research/pageText.ts';

const LIST='https://www.blog.example.test/top-10-dallas';
const page=(html:string,contentType='text/html; charset=utf-8',url=LIST)=>({url,contentType,body:new TextEncoder().encode(html)});

it('takes absolute links to other company hosts in page order, one per host, with the anchor text as label',()=>{
 const html=`<nav><a href="/about">About</a><a href="https://blog.example.test/contact">Us</a></nav>
  <ol><li><a class="x" href="https://www.alpha-pm.example.test/services#top" target="_blank"><strong>Alpha</strong>  Property&nbsp;Management &amp; Leasing</a></li>
  <li><a href='http://beta-realty.example.test/'>Beta Realty</a></li>
  <li><a href=https://ALPHA-PM.example.test/other>Alpha again</a></li>
  <li><a href="https://www.yelp.com/biz/gamma">Gamma on Yelp</a><a href="https://facebook.com/gamma">Gamma</a><a href="https://hud.gov/">HUD</a></li>
  <li><a href="https://lists.example.test/">Top 10 property management companies</a></li>
  <li><a href="mailto:a@b.test">Mail</a><a href="javascript:void(0)">JS</a><a href="//proto.example.test/">Proto</a><a href="https://delta&#45;pm.example.test/">Delta PM</a></li></ol>`;
 expect(discoveryListLeads(LIST,page(html))).toEqual([
  {url:'https://www.alpha-pm.example.test/services',host:'alpha-pm.example.test',label:'Alpha Property Management & Leasing'},
  {url:'https://beta-realty.example.test/',host:'beta-realty.example.test',label:'Beta Realty'},
  {url:'https://delta-pm.example.test/',host:'delta-pm.example.test',label:'Delta PM'},
 ]);
});

it('excludes the fetched page host after a redirect and bounds leads per page',()=>{
 const html=Array.from({length:30},(_,i)=>`<a href="https://firm-${i}.example.test/">Firm ${i}</a>`).join('')+'<a href="https://moved.example.test/">Self</a>';
 const leads=discoveryListLeads(LIST,page(html,'text/html','https://moved.example.test/list'));
 expect(leads).toHaveLength(DISCOVERY_LIST_LEAD_LIMIT);
 expect(leads.map(l=>l.host)).toEqual(Array.from({length:20},(_,i)=>`firm-${i}.example.test`));
 expect(discoveryListLeads(LIST,page('<a href="https://moved.example.test/">Self</a>',undefined,'https://moved.example.test/list'))).toEqual([]);
});

it('stores leads as https://host/path: upgrades http, strips tracking queries, and skips still-invalid links without using the page bound',()=>{
 const invalid=['https://localhost/','https://user:pw@nodot/',`https://long.example.test/${'p'.repeat(500)}`].map(href=>`<a href="${href}">Bad</a>`).join('');
 const html=invalid+'<a href="http://www.upgrade.example.test:8080/team/?utm_source=list&amp;utm_medium=web#top">Upgrade PM</a>'
  +'<a href="https://tracked.example.test/?ref=top10">Tracked PM</a>'
  +Array.from({length:25},(_,i)=>`<a href="https://firm-${i}.example.test/a?b=c">Firm ${i}</a>`).join('');
 const leads=discoveryListLeads(LIST,page(html));
 expect(leads.slice(0,3)).toEqual([
  {url:'https://www.upgrade.example.test/team/',host:'upgrade.example.test',label:'Upgrade PM'},
  {url:'https://tracked.example.test/',host:'tracked.example.test',label:'Tracked PM'},
  {url:'https://firm-0.example.test/a',host:'firm-0.example.test',label:'Firm 0'},
 ]);
 expect(leads).toHaveLength(DISCOVERY_LIST_LEAD_LIMIT);
 expect(leads.every(lead=>lead.url.startsWith('https://')&&!lead.url.includes('?')&&!lead.url.includes('#'))).toBe(true);
});

it('reads nothing from non-HTML, oversized or unterminated markup',()=>{
 expect(discoveryListLeads(LIST,page('<a href="https://a.example.test/">A</a>','text/plain'))).toEqual([]);
 expect(discoveryListLeads(LIST,page(`<a href="https://a.example.test/">A</a>${' '.repeat(MAX_PAGE_BYTES)}`))).toEqual([]);
 expect(discoveryListLeads(LIST,page('<a href="https://a.example.test/">A'))).toEqual([]);
});

it('routes every hit in result order and expands only the first three list pages',()=>{
 const hits=[
  {url:'https://one.example.test/',title:'One PM',snippet:''},
  {url:'https://www.yelp.com/search?x=1',title:'Yelp',snippet:''},
  {url:'https://en.wikipedia.org/wiki/Property_management',title:'Property management',snippet:''},
  {url:'https://blog.example.test/a',title:'Best 10 Property Management Companies in Dallas',snippet:''},
  {url:'https://www.bbb.org/x',title:'BBB',snippet:''},
  {url:'https://expertise.com/tx',title:'Expertise',snippet:''},
  {url:'https://two.example.test/',title:'Two Realty',snippet:''},
 ];
 const {routed,lists}=routeDiscoveryHits(hits);
 expect(routed.map(r=>r.kind)).toEqual(['company','list','noise','list','list','list','company']);
 expect(routed.map(r=>r.hit)).toEqual(hits);
 expect(lists.map(h=>h.url)).toEqual(['https://www.yelp.com/search?x=1','https://blog.example.test/a','https://www.bbb.org/x']);
});
