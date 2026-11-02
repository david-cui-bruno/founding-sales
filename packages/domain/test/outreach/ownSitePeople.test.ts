import {describe,expect,it} from 'vitest';
import {extractOwnSitePeople,ownSitePeople} from '../../outreach/ownSitePeople.ts';
import type {PreparedPageText} from '../../sourcing/preparedEmailRead.ts';
import {acceptablePerson,rankDecisionMakerTitle} from '../../outreach/peopleProvider.ts';

/** Captured text blocks (`b1`, `b2`, …) of one own-site page, as `parsePageText` returns them: one block per paragraph, heading, list item, line break or table cell. */
const page=(url:string,...texts:string[])=>({observationId:`obs-${url}`,url,blocks:texts.map((text,index)=>({id:`b${String(index+1)}`,text}))});
const top=(host:string,...pages:PreparedPageText[])=>extractOwnSitePeople(pages,host)[0];
const brief=(host:string,...pages:PreparedPageText[])=>{const person=top(host,...pages);return person&&{name:`${person.firstName} ${person.lastName}`,title:person.title,email:person.email};};

/** Shapes taken from the R1 research table (ticket #909, 50 hosts, 2026-11-02): host, the page text blocks the capture would keep, and who the extractor must name. */
const R1:[string,string,PreparedPageText[],{name:string;title:string;email:string|null}|null][]=[
 ['rentcobalt.com team cards: name, title, address blocks','rentcobalt.com',[page('https://www.rentcobalt.com/about','Meet the Team','Doc Nicolson','Designated Broker / Principal','doc@rentcobalt.com','William "Hoss" Evey','Senior Property Manager, Principal','hoss@rentcobalt.com')],{name:'Doc Nicolson',title:'Designated Broker / Principal',email:'doc@rentcobalt.com'}],
 ['woodpropertymanagement.com licence footer "Name, Broker CABRE"','woodpropertymanagement.com',[page('https://woodpropertymanagement.com/','Property management in San Diego.','© 2026 Wood Property Management | Vicki Franklin, Broker CABRE #01234567 | woodproperty@gmail.com')],{name:'Vicki Franklin',title:'Broker',email:null}],
 ['choosermg.com blog byline with a DRE number; an address in the next block is not claimed (a byline is not a card)','choosermg.com',[page('https://www.choosermg.com/about','Authored by Scott Engle, Broker DRE #01234567','scott@choosermg.com'),],{name:'Scott Engle',title:'Broker',email:null}],
 ['rpgre.com about: "Name, President-Broker"; homepage line that names Bob and gives his address','rpgre.com',[page('https://www.rpgre.com/about-us','Bob Rodrigues, President-Broker'),page('https://www.rpgre.com/','Email Bob at bob@rpgre.com')],{name:'Bob Rodrigues',title:'President-Broker',email:'bob@rpgre.com'}],
 ['bargeproperties.com team: fifteen staff, name/title/address triples','bargeproperties.com',[page('https://www.bargeproperties.com/team','Our Team','V. W. (Bill) Barge III','Chairman & Founder','Tyler Bradford','President, CPM','tyler@bargeproperties.com','Amy Lowe','Leasing Agent','amy@bargeproperties.com','Raul Ortiz','Maintenance Supervisor','raul@bargeproperties.com')],{name:'Tyler Bradford',title:'President, CPM',email:'tyler@bargeproperties.com'}],
 ['sophiaassociates TX licence footer; the address on the page is a consumer domain','sophiaassociatesrealestatellc.propertywaresites.com',[page('https://sophiaassociatesrealestatellc.propertywaresites.com/about-us/','Kyle James Wheatley, Broker Texas License #444878','Aracelis Wheatley, Property Manager','kyle.wheatley@me.com')],{name:'Kyle Wheatley',title:'Broker',email:null}],
 ['colonialrepm.com: "Designated Broker ~ Name TREC #"; ceo@ and president@ are role aliases','colonialrepm.com',[page('https://www.colonialrepm.com/team','Designated Broker ~ Ethan D. Autry TREC # 754551-B','CEO: Ethan D. Autry — ceo@colonialrepm.com','Tonya Autry, President','president@colonialrepm.com')],{name:'Ethan Autry',title:'CEO',email:null}],
 ['stetson.management footer with the licence number first','stetson.management',[page('https://www.stetson.management/','TX License #597044-B Ryan Stetson, Broker')],{name:'Ryan Stetson',title:'Broker',email:null}],
 ['simplepmgroup.com homepage signature "- Name, Owner / Broker"','simplepmgroup.com',[page('https://simplepmgroup.com/','Great communication and fast repairs.','- Jon Smith, Owner / Broker')],{name:'Jon Smith',title:'Owner / Broker',email:null}],
 ['elevatesdproperties.com signature "- Name, Broker/CEO"','elevatesdproperties.com',[page('https://www.elevatesdproperties.com/about','- Irina Polyak, Broker/CEO')],{name:'Irina Polyak',title:'Broker/CEO',email:null}],
 ['westromgroup.com "Name, Broker/Owner"','westromgroup.com',[page('https://westromgroup.com/about/','Jon Westrom, Broker/Owner')],{name:'Jon Westrom',title:'Broker/Owner',email:null}],
 ['ipipropertymanagement.com: president without an address; the property manager\'s address is another domain','ipipropertymanagement.com',[page('https://www.ipipropertymanagement.com/about-us','Ken Weiner','President & Founder','Benjamin Weiner','Property Manager','ben@ipisandiego.com')],{name:'Ken Weiner',title:'President & Founder',email:null}],
 ['talkpropertymanagement.com "Name, Owner, Founder & Realtor"','talkpropertymanagement.com',[page('https://www.talkpropertymanagement.com/about-us/','Dona Brown, Owner, Founder & Realtor')],{name:'Dona Brown',title:'Owner, Founder & Realtor',email:null}],
 ['homelabpm.com card with the address under it','homelabpm.com',[page('https://www.homelabpm.com/about','Christopher Wood','Property Manager, Owner & CEO','christopher@homelabpm.com')],{name:'Christopher Wood',title:'Property Manager, Owner & CEO',email:'christopher@homelabpm.com'}],
 ['dbbroker.com name, title and address in one block','dbbroker.com',[page('https://dbbroker.com/about','Dru Lassley, Broker — dru@dbbroker.com')],{name:'Dru Lassley',title:'Broker',email:'dru@dbbroker.com'}],
 ['rivercitypropertymanagement.com: the address is on a different domain; a second person has no title','rivercitypropertymanagement.com',[page('https://www.rivercitypropertymanagement.com/about','Julie Alexander, Property Manager, Owner','Julie@RiverCityMG.com','Al Shacklett','Bio coming soon')],{name:'Julie Alexander',title:'Property Manager, Owner',email:null}],
 ['sunshinerentals-leecounty.com contact page: assistant skipped','sunshinerentals-leecounty.com',[page('https://sunshinerentals-leecounty.com/contact','Crystal Garland, Asst. Property Manager crystal@sunshinerentals-leecounty.com','Laura Schuette, Property Manager laura@sunshinerentals-leecounty.com')],{name:'Laura Schuette',title:'Property Manager',email:'laura@sunshinerentals-leecounty.com'}],
 ['ramaustin.com owner without an address (info@ only)','ramaustin.com',[page('https://www.ramaustin.com/about-us','Sam Archer, Broker & Owner','info@ramaustin.com')],{name:'Sam Archer',title:'Broker & Owner',email:null}],
 ['whiterobbins.com /owner-faqs: the address is another domain','whiterobbins.com',[page('https://www.whiterobbins.com/about','Tucker Robbins, President / Broker / Owner tucker@robbinsrealestate.com')],{name:'Tucker Robbins',title:'President / Broker / Owner',email:null}],
 ['gossmanagement.com principal broker','gossmanagement.com',[page('https://www.gossmanagement.com/owner-faqs/','Who do I contact?','Anika Dixon, Principal Broker','info@gossmanagement.com')],{name:'Anika Dixon',title:'Principal Broker',email:null}],
 ['thelasleycompany.com: initial-and-last address, a relative with no title','thelasleycompany.com',[page('https://thelasleycompany.com/about/our-agents/','Jimmy Lasley','Principal Broker','jlasley@thelasleycompany.com','Brian Lasley','brianlasley@thelasleycompany.com')],{name:'Jimmy Lasley',title:'Principal Broker',email:'jlasley@thelasleycompany.com'}],
 ['completepmalabama.com owners with the address on the card','completepmalabama.com',[page('https://www.completepmalabama.com/about','Brandy Herschbach','Owner & CEO','Joseph Dabbs','Owner','joseph@completepmalabama.com')],{name:'Joseph Dabbs',title:'Owner',email:'joseph@completepmalabama.com'}],
 ['megaagentrentals.com owner and director with addresses','megaagentrentals.com',[page('https://megaagentrentals.com/our-team/','Collier Swecker, Broker / Owner collier@megaagentrentals.com','Trista Ehlers, Director of Property Management trista@megaagentrentals.com')],{name:'Collier Swecker',title:'Broker / Owner',email:'collier@megaagentrentals.com'}],
 ['redrockrg.com "Name - Principal, EVP & Qualifying Broker"','redrockrg.com',[page('https://www.redrockrg.com/about/our-team/','Thomas N. Carruthers III - Principal, EVP & Qualifying Broker')],{name:'Thomas Carruthers III',title:'Principal, EVP & Qualifying Broker',email:null}],
 ['sterlingmanagement.net founder, hyphenated surname, office aliases','sterlingmanagement.net',[page('https://www.sterlingmanagement.net/about-us','Jami Sterling-Christopherson, Founder & (Acting) Principal Broker','eugene@sterlingmanagement.net','Billy Benner, General Manager')],{name:'Jami Sterling-Christopherson',title:'Founder & (Acting) Principal Broker',email:null}],
 ['northwoodspm.com licensed property managers, nobody owns','northwoodspm.com',[page('https://www.northwoodspm.com/about-us','Mike Gamble, Licensed Property Manager','Jason Licato, Licensed Property Manager')],{name:'Mike Gamble',title:'Licensed Property Manager',email:null}],
 ['sovproperties.com "Name, President / CEO"','sovproperties.com',[page('https://www.sovproperties.com/pages/about.asp','Paul Chantler, President / CEO','Michael Iacono, Director of Residential Operations')],{name:'Paul Chantler',title:'President / CEO',email:null}],
 ['robertcwhite.com: "Director" alone is not a decision-maker title, a property manager is','robertcwhite.com',[page('https://www.robertcwhite.com/meet-the-team','Luke Eddinger, Director','John Mcleod, Property Manager')],{name:'John Mcleod',title:'Property Manager',email:null}],
 ['propertydoctorservices.com CEO and COO','propertydoctorservices.com',[page('https://propertydoctorservices.com/about/','Danielle Worsham, COO','Rey Diaz, CEO')],{name:'Rey Diaz',title:'CEO',email:null}],
 ['tsionasinc.com: "family-owned since 1970", no names','tsionasinc.com',[page('https://tsionasinc.com/','Family-owned since 1970. Call us for a free quote.','service@tsionasinc.com')],null],
 ['overwatchrem.com: the founder is only in JSON-LD, which the capture drops','overwatchrem.com',[page('https://overwatchrem.com/about-us','About Overwatch','We manage homes across the metro.')],null],
 ['rpmsignature.com franchise page names nobody','rpmsignature.com',[page('https://www.rpmsignature.com/about-us','Real Property Management Signature is locally owned and operated.')],null],
];
describe('own-site people on the shapes of the R1 table',()=>{
 it.each(R1)('%s',(_label,host,pages,expected)=>{expect(brief(host,...pages)??null).toEqual(expected);});
 it('measures the yield of the reconstructed R1 shapes: names every reconstructed shape that names a decision-maker (29 of 32) and an own-domain address for 9',()=>{
  const people=R1.map(([,host,pages])=>top(host,...pages));
  expect(R1).toHaveLength(32);expect(people.filter(Boolean)).toHaveLength(29);
  expect(people.filter(person=>person?.email).length).toBe(9);
 });
});

describe('ranking',()=>{
 const blocks=(host:string,...texts:string[])=>extractOwnSitePeople([page(`https://${host}/team`,...texts)],host).map(person=>`${person.firstName} ${person.lastName}`);
 it('orders owner, then president/CEO/founder/principal, then designated or managing broker, then broker, then property manager',()=>{
  expect(blocks('peak.org','Pat Roe, Property Manager','Bo Lin, Broker','Cy Moss, Designated Broker','Di Park, President','Ed Hale, Owner')).toEqual(['Ed Hale','Di Park','Cy Moss','Bo Lin','Pat Roe']);
  expect(['Owner','Founder & CEO','Principal','Principal Broker','Managing Broker','Broker of Record','Broker','Property Manager'].map(rankDecisionMakerTitle)).toEqual([0,1,1,2,2,2,3,5]);
  expect(rankDecisionMakerTitle('Director of Property Management')).toBe(4);
  expect(rankDecisionMakerTitle('Owner & Associate Broker')).toBe(null);
 });
 it('puts a person with a published address before a higher title without one, because the campaign needs an address', ()=>{
  const people=extractOwnSitePeople([page('https://peak.org/team','Ed Hale, Owner','Pat Roe, Property Manager pat@peak.org')],'peak.org');
  expect(people.map(person=>[person.firstName,person.email])).toEqual([['Pat','pat@peak.org'],['Ed',null]]);
 });
 it('merges one person named in several places into one entry carrying the address and the best title',()=>{
  const people=extractOwnSitePeople([page('https://peak.org/about','Ed Hale, Owner'),page('https://peak.org/contact','Ed Hale, Broker ed@peak.org')],'peak.org');
  expect(people).toHaveLength(1);expect(people[0]).toMatchObject({email:'ed@peak.org',title:'Broker',source:{url:'https://peak.org/contact'}});
 });
});

describe('what is never a person or an address',()=>{
 const none=(...texts:string[])=>extractOwnSitePeople([page('https://peak.org/about',...texts)],'peak.org');
 it('rejects generic roles and names with no decision-maker title',()=>{
  expect(none('Property Manager','Our Team','Owner','Contact Us','Meet the Owner','Property Management, Broker')).toEqual([]);
  expect(none('Al Shacklett','Bio coming soon','Jordan Lee')).toEqual([]);
 });
 it('rejects customers, tenants, leasing agents and other junior titles, and customer-signed testimonials',()=>{
  expect(none('"They fixed our sink the same day." - Sarah Lee, Tenant','- Mike Ross, Property Owner','- Jane Doe, Owner','"Great service!" — Pat Kim, Homeowner')).toEqual([]);
  expect(none('Tom Reed, Leasing Agent','Ann Cole, Associate Broker','Bea Fox, Assistant Property Manager','Gus Hart, Maintenance Supervisor','Ivy Stone, Vice President of Finance','Joe Hill, Real Estate Agent')).toEqual([]);
  expect(none('Lee Park, Tenant Relations Coordinator','Max Dean, Resident Manager')).toEqual([]);
 });
 it('keeps a company-side signature as a medium-confidence person, but never a bare "Owner" signature',()=>{
  expect(extractOwnSitePeople([page('https://peak.org/','- Jon Smith, Owner / Broker')],'peak.org')[0]).toMatchObject({firstName:'Jon',confidence:'medium'});
  expect(none('- Jon Smith, Owner')).toEqual([]);
 });
 it('refuses company names and page labels as names',()=>{expect(none('Wood Property Management, Broker','Peak Realty Group, Owner','San Diego, Broker','Meet Our Team, Owner')).toEqual([]);});
 it('keeps a person but never takes an address that is another domain, a consumer domain or a role mailbox, and never builds one from a name',()=>{
  const email=(text:string)=>none(text)[0]?.email;
  expect(email('Jon Smith, Owner jon@other.com')).toBeNull();expect(email('Jon Smith, Owner jon.smith@gmail.com')).toBeNull();
  for(const role of ['info','office','contact','admin','sales','leasing','support','ceo','president','owner','broker'])expect(email(`Jon Smith, Owner ${role}@peak.org`),role).toBeNull();
  expect(email('Jon Smith, Owner jon@mail.peak.org')).toBeNull();
  expect(none('Jon Smith, Owner')[0]).toMatchObject({firstName:'Jon',email:null});
  expect(email('Jon Smith, Owner jon@peak.org')).toBe('jon@peak.org');
 });
 it('takes an address only when it belongs to the person: adjacent blocks of another person\'s name, and an unrelated mailbox beside a card, are not theirs',()=>{
  const people=extractOwnSitePeople([page('https://peak.org/team','Jon Smith','Owner','Amy Lowe','Broker','amy@peak.org','Zed Bay','Property Manager','accounts2@peak.org')],'peak.org');
  expect(people.map(person=>[person.firstName,person.email])).toEqual([['Amy','amy@peak.org'],['Jon',null],['Zed',null]]);
  expect(none('Contact: jon@peak.org','Jon Smith, Owner')[0]?.email).toBeNull();
 });
 it('does not read prose paragraphs, only whole short statements',()=>{
  expect(none('Jon Smith, Owner Occupied properties are a niche we do not serve and have never served in this city for any client at all ever, so ask.'.repeat(5))).toEqual([]);
 });
 it('reads title-first, pipe-delimited and unspaced-dash statements, hyphenated and apostrophe names, and an all-capitals dash line with its acronym',()=>{
  const read=(text:string)=>none(text)[0]&&[none(text)[0]!.firstName,none(text)[0]!.lastName,none(text)[0]!.title,none(text)[0]!.email];
  expect(read('Owner: Jane Doe - jane@peak.org')).toEqual(['Jane','Doe','Owner','jane@peak.org']);
  expect(read('Jane Doe | Broker | jane@peak.org')).toEqual(['Jane','Doe','Broker','jane@peak.org']);
  expect(read('Mary-Jane O’Neil, Principal Broker')).toEqual(['Mary-Jane','O’Neil','Principal Broker',null]);
  expect(read('RYAN STETSON—CEO')).toEqual(['Ryan','Stetson','CEO',null]);
 });
 it('does not take places, board seats or prose about customers as people',()=>{
  expect(none('Greater Austin, Broker','Houston Texas, Broker','Matt Smith, President of the Board','Our property manager Sarah Lee handles all requests.','Jane Doe, Property Manager, reviewed the lease.','Peak Properties Inc., Owner')).toEqual([]);
 });
 it('reads an all-capitals licence line',()=>{expect(none('TX LICENSE #597044-B RYAN STETSON, BROKER')[0]).toMatchObject({firstName:'Ryan',lastName:'Stetson',title:'Broker'});});
});

describe('the own_site provider',()=>{
 const ask=(host:string,...pages:PreparedPageText[])=>ownSitePeople().findDecisionMaker({domain:host,companyName:'Peak',candidateId:'c1',pages});
 it('is free and answers the best person with the page citation, published when the page publishes the address',async()=>{
  const provider=ownSitePeople();
  expect(provider).toMatchObject({providerKey:'own_site',maxCreditsPerLookup:0});
  const result=await ask('peak.org',page('https://peak.org/team','Tyler Bradford, President tyler@peak.org'));
  expect(result).toMatchObject({ok:true,creditsUsed:0,person:{firstName:'Tyler',lastName:'Bradford',title:'President',email:'tyler@peak.org',emailStatus:'published',matchConfidence:'high',source:{url:'https://peak.org/team',blockId:'b1',quote:'Tyler Bradford, President tyler@peak.org'}}});
  if(result.ok&&result.person)expect(acceptablePerson(result.person,'peak.org')).toMatchObject({ok:true,person:{email:'tyler@peak.org',emailStatus:'published'}});
 });
 it('answers an unavailable person when no address is published, and nobody when no person is',async()=>{
  const named=await ask('peak.org',page('https://peak.org/','Ryan Stetson, Broker'));
  expect(named).toMatchObject({ok:true,creditsUsed:0,person:{email:null,emailStatus:'unavailable'}});
  if(named.ok&&named.person)expect(acceptablePerson(named.person,'peak.org')).toMatchObject({ok:true,person:{email:null,emailStatus:'unavailable',firstName:'Ryan'}});
  expect(await ask('peak.org',page('https://peak.org/','We manage homes.'))).toEqual({ok:true,person:null,creditsUsed:0});
 });
});
