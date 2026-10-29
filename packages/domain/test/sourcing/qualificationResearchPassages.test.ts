import {expect,it} from 'vitest';
import {sourceObservationSchema,type SourceObservation,type QualificationFact} from '@fss/contracts';
import {verifiedOfficePhone} from '../../sourcing/verifiedOfficePhone.ts';
import {qualificationResearchPassages} from '../../sourcing/qualificationResearchPassages.ts';
const companyName='Alta Residential',website='https://alta.example.test/';
function source(texts:string[],override:Partial<SourceObservation>={}):SourceObservation{return sourceObservationSchema.parse({id:'00000000-0000-4000-8000-000000000001',url:website+'contact',contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:'2026-10-27T12:00:00Z',publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:texts.map((text,index)=>({id:`b${index}`,text})),...override});}
const fact=(s:SourceObservation,index:number):QualificationFact=>({kind:'business_phone',value:s.blocks[index]!.text,observationId:s.id,blockId:s.blocks[index]!.id});
it('shows a literal selected same-line phone/address as a dated passage without normalizing it or claiming proof',()=>{
 const observed=source(['Alta Residential','Office phone (214) 555-0123 | 42 Fictional Ave, Dallas, TX 75201']);
 const result=qualificationResearchPassages({companyName,website,observations:[observed],facts:[fact(observed,1)]});
 expect(result.passages.find(p=>p.kind==='phone')).toEqual({kind:'phone',observationId:observed.id,sourceUrl:observed.url,retrievedAt:'2026-10-27T12:00:00Z',blocks:[{id:'b0',text:'Alta Residential'},{id:'b1',text:'Office phone (214) 555-0123 | 42 Fictional Ave, Dallas, TX 75201'}]});
 expect(result.hasMore).toBe(false);expect(result.passages[0]).not.toHaveProperty('phone');
 expect(verifiedOfficePhone({identity:{status:'resolved',name:companyName,website,locality:'Dallas',region:'TX'},facts:[fact(observed,1)],observations:[observed]}).phone).toBeNull();
});
it('keeps header phone and a company-attributed named owner as separate original passages',()=>{
 const observed=source(['Real Property Management Focus','Office phone: (401) 555-0123','Meet our team','Brian Harper — Owner','Brian leads our local residential management team.']);
 const result=qualificationResearchPassages({companyName:'Real Property Management Focus',website,observations:[observed],facts:[fact(observed,1)]});
 expect(result.passages.filter(p=>p.kind==='person')).toEqual([{kind:'person',observationId:observed.id,sourceUrl:observed.url,retrievedAt:observed.retrievedAt,blocks:observed.blocks.slice(0,4)}]);
 expect(result.passages.filter(p=>p.kind==='phone')).toHaveLength(1);
});
it('shows the contiguous Pawtucket office card without turning the separate Providence service market into an office',()=>{
 const observed=source(['We manage homes in Providence, Rhode Island.','Request a response from our team.','Nexus Property Management','Pawtucket RI Office','49 Example Street Pawtucket RI 02860']);
 const result=qualificationResearchPassages({companyName:'Nexus Property Management',website,observations:[observed],facts:[]});
 expect(result).toEqual({hasMore:false,passages:[{kind:'location',observationId:observed.id,sourceUrl:observed.url,retrievedAt:observed.retrievedAt,blocks:observed.blocks.slice(2)}]});
 expect(result.passages[0]).not.toHaveProperty('city');
});
it('supports the agreed composed original pattern without deriving a location from its service paragraph',()=>{
 const observed=source(['Call us at: 401-555-0123','Each week, Synthetic Residential Manager owner Solana Reed hosts a local podcast.','Synthetic Residential Manager','Pawtucket RI Office','49 North Union St Pawtucket RI 02860','Synthetic Residential Manager manages residential properties in Providence, Rhode Island.']);
 const result=qualificationResearchPassages({companyName:'Synthetic Residential Manager',website,observations:[observed],facts:[fact(observed,0)]});
 expect(result.passages.find(p=>p.kind==='phone')?.blocks).toEqual([observed.blocks[0]]);
 expect(result.passages.find(p=>p.kind==='person')?.blocks).toEqual([observed.blocks[1]]);
 expect(result.passages.filter(p=>p.kind==='location')).toEqual([{kind:'location',observationId:observed.id,sourceUrl:observed.url,retrievedAt:observed.retrievedAt,blocks:observed.blocks.slice(2,5)}]);
});
it('deduplicates before the twelve-passage cap and discloses only omitted distinct passages',()=>{
 const observed=source(Array.from({length:13},(_,i)=>`Alta Residential phone: (214) 555-${String(1200+i)}`));
 const twelve=qualificationResearchPassages({companyName,website,observations:[observed],facts:[...observed.blocks.slice(0,12).map((_,i)=>fact(observed,i)),fact(observed,0)]});
 expect(twelve.passages).toHaveLength(12);expect(twelve.hasMore).toBe(false);
 const thirteen=qualificationResearchPassages({companyName,website,observations:[observed],facts:observed.blocks.map((_,i)=>fact(observed,i))});
 expect(thirteen.passages).toHaveLength(12);expect(thirteen.hasMore).toBe(true);
});
it.each([
 {url:'https://other.example.test/contact'},
 {url:'https://research.alta.example.test/contact'},
 {url:'https://user:secret@alta.example.test/contact'},
 {url:'javascript:alert(1)'},
 {firstParty:false},
 {truncated:true},
])('withholds incomplete or differently scoped source observations: %j',override=>{
 const original=source(['Alta Residential','Office phone: (214) 555-0123']);
 const observed={...original,...override};
 const result=qualificationResearchPassages({companyName,website,observations:[observed],facts:[fact(original,1)]});
 expect(result).toEqual({passages:[],hasMore:true});
});
it('does not promote guessed or substring phone citations into a passage',()=>{
 const observed=source(['Alta Residential','Office phone: (214) 555-0123']);
 for(const selected of [{...fact(observed,1),blockId:'missing'},{...fact(observed,1),value:'(214) 555-0123'}])expect(qualificationResearchPassages({companyName,website,observations:[observed],facts:[selected]})).toEqual({passages:[],hasMore:true});
 expect(qualificationResearchPassages({companyName,website,observations:[observed],facts:[]}).passages).toEqual([]);
});
it.each([
 'Our property owners include Brian Harper.',
 'Property owner Solana Reed needs help with a rental.',
 'Customer review: Brian Harper — Owner was helpful.',
 'Our national franchise network owner Solana Reed speaks for all offices.',
 'Former owner Solana Reed left in 2019.',
 'Next owners meeting: October 29, 2026.',
])('does not turn customer, historical or network language into a buying-role clue: %s',text=>{
 const observed=source(['Alta Residential',text]);
 expect(qualificationResearchPassages({companyName,website,observations:[observed],facts:[]}).passages).toEqual([]);
});
it('does not infer office location from a service-area paragraph or a foreign office card without company context',()=>{
 for(const texts of [['Alta Residential manages homes in Providence, Rhode Island.'],['Pawtucket RI Office','49 Example Street Pawtucket RI 02860']]){
  const observed=source(texts);expect(qualificationResearchPassages({companyName,website,observations:[observed],facts:[]}).passages).toEqual([]);
 }
});
it('refuses oversize and unbounded input while disclosing omitted material',()=>{
 const phoneBlock='Office phone: (214) 555-0123 '+ 'x'.repeat(1670),observed=source(['Alta Residential','x'.repeat(1700),'x'.repeat(1700),phoneBlock]);
 expect(qualificationResearchPassages({companyName,website,observations:[observed],facts:[fact(observed,3)]})).toEqual({passages:[],hasMore:true});
 const large=source(['Alta Residential','49 Example Street '+ 'x'.repeat(2100)]);
 expect(qualificationResearchPassages({companyName,website,observations:[large],facts:[]})).toEqual({passages:[],hasMore:true});
 expect(qualificationResearchPassages({companyName,website,observations:Array.from({length:9},()=>observed),facts:[]})).toEqual({passages:[],hasMore:true});
 expect(qualificationResearchPassages({companyName,website,observations:[observed],facts:Array.from({length:31},()=>fact(observed,3))})).toEqual({passages:[],hasMore:true});
});
it('preserves exact contiguous original blocks and never mutates or aliases input',()=>{
 const observed=source(['Alta Residential','Office phone: (214) 555-0123','Owner Solana Reed leads Alta Residential.','Office: Pawtucket RI','49 Example Street Pawtucket RI 02860']);
 for(const block of observed.blocks)Object.freeze(block);Object.freeze(observed.blocks);Object.freeze(observed);
 const input=Object.freeze({companyName,website,observations:Object.freeze([observed]),facts:Object.freeze([Object.freeze(fact(observed,1))])}),before=JSON.stringify(input);
 const result=qualificationResearchPassages(input);expect(result).toEqual(qualificationResearchPassages(input));
 for(const passage of result.passages){expect(passage.blocks.length).toBeLessThanOrEqual(5);expect(passage.blocks.reduce((n,b)=>n+b.text.length,0)).toBeLessThanOrEqual(5000);const start=observed.blocks.findIndex(b=>b.id===passage.blocks[0]?.id);expect(passage.blocks).toEqual(observed.blocks.slice(start,start+passage.blocks.length));for(const block of passage.blocks)expect(block.text.length).toBeLessThanOrEqual(2000);}
 result.passages[0]!.blocks[0]!.text='Changed output copy';expect(JSON.stringify(input)).toBe(before);
});
it('does not borrow a nearby company heading to attribute another company’s named leader',()=>{
 const observed=source(['Alta Residential','Other Realty owner Solana Reed hosts a local podcast.']);
 expect(qualificationResearchPassages({companyName,website,observations:[observed],facts:[]}).passages).toEqual([]);
});
