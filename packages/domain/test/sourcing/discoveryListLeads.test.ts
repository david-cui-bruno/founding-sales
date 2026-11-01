import {it,expect} from 'vitest';
import {discoveryListLeads,routeDiscoveryHits,DISCOVERY_LIST_LEAD_LIMIT} from '../../sourcing/discoveryListLeads.ts';
import {MAX_PAGE_BYTES} from '../../research/pageText.ts';

const LIST='https://www.blog.test/top-10-dallas';
const page=(html:string,contentType='text/html; charset=utf-8',url=LIST)=>({url,contentType,body:new TextEncoder().encode(html)});

it('takes absolute links to other company hosts in page order, one per host, with the anchor text as label',()=>{
 const html=`<nav><a href="/about">About</a><a href="https://blog.test/contact">Us</a></nav>
  <ol><li><a class="x" href="https://www.alpha-pm.test/services#top" target="_blank"><strong>Alpha</strong>  Property&nbsp;Management &amp; Leasing</a></li>
  <li><a href='http://beta-realty.test/'>Beta Realty</a></li>
  <li><a href=https://ALPHA-PM.test/other>Alpha again</a></li>
  <li><a href="https://www.yelp.com/biz/gamma">Gamma on Yelp</a><a href="https://facebook.com/gamma">Gamma</a><a href="https://hud.gov/">HUD</a></li>
  <li><a href="https://lists.test/">Top 10 property management companies</a></li>
  <li><a href="mailto:a@b.test">Mail</a><a href="javascript:void(0)">JS</a><a href="//proto.test/">Proto</a><a href="https://delta&#45;pm.test/">Delta PM</a></li></ol>`;
 expect(discoveryListLeads(LIST,page(html))).toEqual([
  {url:'https://www.alpha-pm.test/services',host:'alpha-pm.test',label:'Alpha Property Management & Leasing'},
  {url:'https://beta-realty.test/',host:'beta-realty.test',label:'Beta Realty'},
  {url:'https://delta-pm.test/',host:'delta-pm.test',label:'Delta PM'},
 ]);
});

it('excludes the fetched page host after a redirect and bounds leads per page',()=>{
 const html=Array.from({length:30},(_,i)=>`<a href="https://firm-${i}.test/">Firm ${i}</a>`).join('')+'<a href="https://moved.test/">Self</a>';
 const leads=discoveryListLeads(LIST,page(html,'text/html','https://moved.test/list'));
 expect(leads).toHaveLength(DISCOVERY_LIST_LEAD_LIMIT);
 expect(leads.map(l=>l.host)).toEqual(Array.from({length:20},(_,i)=>`firm-${i}.test`));
 expect(discoveryListLeads(LIST,page('<a href="https://moved.test/">Self</a>',undefined,'https://moved.test/list'))).toEqual([]);
});

it('stores leads as https://host/path: upgrades http, strips tracking queries, and skips still-invalid links without using the page bound',()=>{
 const invalid=['https://localhost/','https://user:pw@nodot/',`https://long.test/${'p'.repeat(500)}`].map(href=>`<a href="${href}">Bad</a>`).join('');
 const html=invalid+'<a href="http://www.upgrade.test:8080/team/?utm_source=list&amp;utm_medium=web#top">Upgrade PM</a>'
  +'<a href="https://tracked.test/?ref=top10">Tracked PM</a>'
  +Array.from({length:25},(_,i)=>`<a href="https://firm-${i}.test/a?b=c">Firm ${i}</a>`).join('');
 const leads=discoveryListLeads(LIST,page(html));
 expect(leads.slice(0,3)).toEqual([
  {url:'https://www.upgrade.test/team/',host:'upgrade.test',label:'Upgrade PM'},
  {url:'https://tracked.test/',host:'tracked.test',label:'Tracked PM'},
  {url:'https://firm-0.test/a',host:'firm-0.test',label:'Firm 0'},
 ]);
 expect(leads).toHaveLength(DISCOVERY_LIST_LEAD_LIMIT);
 expect(leads.every(lead=>lead.url.startsWith('https://')&&!lead.url.includes('?')&&!lead.url.includes('#'))).toBe(true);
});

it('replaces "Go to website >>" style labels with the listing item heading, else leaves the host to name the lead',()=>{
 const card=(name:string,slug:string,site:string,cta='Go to website &gt;&gt;')=>`<div class="company"><h3><a href="/profile/${slug}">${name}</a></h3><p>Serving Dallas since 2004.</p><a href="https://${site}/" rel="nofollow">${cta}</a></div>`;
 const html=card('Shift Property Management','shift','shiftpropertymanagement.test')
  +card('Access PM Group','access','www.accesspmgroup.test','Visit Website ›')
  +'<div class="company"><p>No heading here.</p><a href="https://urbanpharm.test/">Go to website &gt;&gt;</a></div>'
  +'<ul><li><strong>Edgerow Property Management</strong> — Rentals<br><a href="https://edgerow.test/">Learn more</a></li>'
  +'<li><p>Unnamed listing</p><a href="https://simplepmgroup.test/">https://www.simplepmgroup.test/</a></li>'
  +'<li><a href="https://arrow.test/">Arrow Realty &raquo;</a></li></ul>';
 expect(discoveryListLeads(LIST,page(html)).map(({host,label})=>({host,label}))).toEqual([
  {host:'shiftpropertymanagement.test',label:'Shift Property Management'},
  {host:'accesspmgroup.test',label:'Access PM Group'},
  {host:'urbanpharm.test',label:''},
  {host:'edgerow.test',label:'Edgerow Property Management'},
  // The previous item's heading never names a listing without its own.
  {host:'simplepmgroup.test',label:''},
  {host:'arrow.test',label:'Arrow Realty'},
 ]);
});

it('ends a listing item at every external link, including a repeated host, so a later item never inherits its heading',()=>{
 const html='<div><h3>Shift Property Management</h3><a href="https://shift.test/">Go to website</a></div>'
  +'<div><h3>Shift Property Management</h3><a href="https://shift.test/again">Go to website</a></div>'
  +'<div><p>No heading here.</p><a href="https://unheaded.test/">Go to website</a></div>';
 expect(discoveryListLeads(LIST,page(html)).map(({host,label})=>({host,label}))).toEqual([
  {host:'shift.test',label:'Shift Property Management'},
  {host:'unheaded.test',label:''},
 ]);
});

it('never names a lead from a page title or list heading, and keeps the lead under its host instead',()=>{
 const html='<h1>Dallas Property Managers</h1><h2>Top 10 Property Management Companies in Dallas</h2><p>Intro.</p><a href="https://first.test/">Visit website</a>';
 expect(discoveryListLeads(LIST,page(html))).toEqual([{url:'https://first.test/',host:'first.test',label:''}]);
});

it('reads nothing from non-HTML, oversized or unterminated markup',()=>{
 expect(discoveryListLeads(LIST,page('<a href="https://a.test/">A</a>','text/plain'))).toEqual([]);
 expect(discoveryListLeads(LIST,page(`<a href="https://a.test/">A</a>${' '.repeat(MAX_PAGE_BYTES)}`))).toEqual([]);
 expect(discoveryListLeads(LIST,page('<a href="https://a.test/">A'))).toEqual([]);
});

it('routes every hit in result order and expands only the first three list pages',()=>{
 const hits=[
  {url:'https://one.test/',title:'One PM',snippet:''},
  {url:'https://www.yelp.com/search?x=1',title:'Yelp',snippet:''},
  {url:'https://en.wikipedia.org/wiki/Property_management',title:'Property management',snippet:''},
  {url:'https://blog.test/a',title:'Best 10 Property Management Companies in Dallas',snippet:''},
  {url:'https://www.bbb.org/x',title:'BBB',snippet:''},
  {url:'https://expertise.com/tx',title:'Expertise',snippet:''},
  {url:'https://two.test/',title:'Two Realty',snippet:''},
 ];
 const {routed,lists}=routeDiscoveryHits(hits);
 expect(routed.map(r=>r.kind)).toEqual(['company','list','noise','list','list','list','company']);
 expect(routed.map(r=>r.hit)).toEqual(hits);
 expect(lists.map(h=>h.url)).toEqual(['https://www.yelp.com/search?x=1','https://blog.test/a','https://www.bbb.org/x']);
});

it('drops the production Tucson waste: statistic citations, the list owner\'s own subdomains and portals, keeping named listings',()=>{
 const list='https://www.evernest.co/blog/tucson-property-management-companies';
 const html=`<p>Tucson grew <a href="https://www.macrotrends.net/global-metrics/cities/23159/tucson/population">1.1% growth rate</a> last year.</p>
  <p>Rents rose <a href="https://stats.example-data.test/tucson">2.4% year over year</a>.</p>
  <h2>Rentals America</h2><p>Family owned.</p><a href="https://rentalsamericatucson.com/">Learn more here</a>
  <p>Join our <a href="https://community.evernest.co/">community</a> or <a href="https://evernest.appfolio.com/connect">Owner Login</a>.</p>
  <p>Already a client? <a href="https://clients-firm-portal.test/">Tenant Portal</a> <a href="https://pay.example-pm.test/">Pay rent</a></p>
  <p><a href="https://eliteimpactrealty.com/">Learn more here</a></p>
  <h3>100% Property Management</h3><a href="https://hundred.test/">Click here to learn more</a>
  <li><a href="https://pct.test/">5% Realty Group</a></li>`;
 expect(discoveryListLeads(list,page(html,undefined,list)).map(({host,label})=>({host,label}))).toEqual([
  {host:'rentalsamericatucson.com',label:'Rentals America'},
  // A navigation label without a heading still leaves the host to name a real listing.
  {host:'eliteimpactrealty.com',label:''},
  {host:'hundred.test',label:'100% Property Management'},
  {host:'pct.test',label:'5% Realty Group'},
 ]);
});

it('keeps another tenant of the list page\'s shared hosting suffix as a company, dropping only the publisher\'s own subdomain',()=>{
 const list='https://publisher.wixsite.com/best-tucson-pm';
 const html='<a href="https://publisher.wixsite.com/about">About us</a><a href="https://acme.wixsite.com/home">Acme Property Management</a>';
 expect(discoveryListLeads(list,page(html,undefined,list))).toEqual([{url:'https://acme.wixsite.com/home',host:'acme.wixsite.com',label:'Acme Property Management'}]);
});
