import {expect,it} from 'vitest';
import {acceptablePerson,rankDecisionMakerTitle,type ProviderPerson} from '../../outreach/peopleProvider.ts';

const person=(patch:Partial<ProviderPerson>={}):ProviderPerson=>({providerPersonId:'p1',firstName:'Jordan',lastName:'Blake',title:'Owner',email:'jordan.blake@cobalt.example',emailStatus:'verified',matchConfidence:'high',...patch});
it('ranks owners above presidents and founders above the broker in charge above brokers above property managers, and never a junior or support title',()=>{
 const rank=(title:string)=>rankDecisionMakerTitle(title);
 expect(rank('Owner')).toBe(0);expect(['Founder & CEO','President','Principal','Co-Founder'].map(rank)).toEqual([1,1,1,1]);
 expect(['Managing Broker','Designated Broker','Broker of Record','Principal Broker','Qualifying Broker'].map(rank)).toEqual([2,2,2,2,2]);
 expect(['Owner/Broker','Broker / Owner','Co-Owner & Broker','Property Manager, Owner & CEO'].map(rank)).toEqual([0,0,0,0]);
 expect(rank('Broker')).toBe(3);expect(rank('Director of Property Management')).toBe(4);expect(rank('Property Manager')).toBe(5);
 for(const title of ['Assistant Property Manager','Leasing Agent','Maintenance Supervisor','Accountant','Marketing Manager','Real Estate Agent','Office Administrator','Owner Relations Coordinator','Asst. Property Manager','Tenant','Property Owner','Associate Broker',''])expect(rank(title),title).toBeNull();
});
it('accepts only a verified, medium or high, own-domain personal-name decision-maker and lower-cases the address',()=>{
 expect(acceptablePerson(person({email:'Jordan.Blake@Cobalt.Example'}),'www.cobalt.example')).toEqual({ok:true,person:{providerPersonId:'p1',firstName:'Jordan',lastName:'Blake',title:'Owner',email:'jordan.blake@cobalt.example',emailStatus:'verified',confidence:'high'}});
 expect(acceptablePerson(person({matchConfidence:'medium'}),'cobalt.example')).toMatchObject({ok:true,person:{confidence:'medium'}});
 const refused=(patch:Partial<ProviderPerson>)=>{const result=acceptablePerson(person(patch),'cobalt.example');return result.ok?'accepted':result.reason;};
 expect(acceptablePerson(null,'cobalt.example')).toEqual({ok:false,reason:'no_person'});
 expect(refused({emailStatus:'unverified'})).toBe('unverified');expect(refused({email:null})).toBe('unverified');
 expect(refused({matchConfidence:'low'})).toBe('low_confidence');expect(refused({matchConfidence:null})).toBe('low_confidence');
 expect(refused({lastName:'Bl***e'})).toBe('no_name');expect(refused({firstName:'J'})).toBe('no_name');expect(refused({lastName:''})).toBe('no_name');
 expect(refused({title:'Leasing Agent'})).toBe('title');
 expect(refused({email:'not an email'})).toBe('invalid_email');
 expect(refused({email:'jordan.blake@gmail.com'})).toBe('consumer_domain');
 for(const local of ['info','office','contact','admin','sales','support','leasing','team','no-reply','noreply','hello','Info.'])expect(refused({email:`${local}@cobalt.example`}),local).toBe(local==='Info.'?'invalid_email':'role_address');
 expect(refused({email:'jordan.blake@other.example'})).toBe('domain_mismatch');expect(refused({email:'jordan@mail.cobalt.example'})).toBe('domain_mismatch');
});
it('capitalizes a single-case provider name per word, keeps mixed case, and bounds name and title lengths',()=>{
 expect(acceptablePerson(person({firstName:'JORDAN',lastName:'mc-dowell o\'brien'}),'cobalt.example')).toMatchObject({ok:true,person:{firstName:'Jordan',lastName:'Mc-Dowell O\'Brien'}});
 expect(acceptablePerson(person({firstName:'McKenzie',lastName:'DeVries'}),'cobalt.example')).toMatchObject({ok:true,person:{firstName:'McKenzie',lastName:'DeVries'}});
 expect(acceptablePerson(person({lastName:'B'.repeat(1)+'l'.repeat(100)}),'cobalt.example')).toEqual({ok:false,reason:'no_name'});
 expect(acceptablePerson(person({title:`Owner ${'x'.repeat(200)}`}),'cobalt.example')).toEqual({ok:false,reason:'title'});
});
it('does not read "vice president" as "president": only a VP of property management is a decision-maker, an owner who is also a VP is still an owner',()=>{
 const rank=(title:string)=>rankDecisionMakerTitle(title);
 for(const title of ['Vice President of Finance','Vice President, Marketing','VP of Operations','VP Finance','SVP Sales','Vice President','EVP of Technology'])expect(rank(title),title).toBeNull();
 expect(['Vice President of Property Management','VP of Property Management','VP, Property Management','Property Management Vice President','Director of Property Management'].map(rank)).toEqual([4,4,4,4,4]);
 expect(rank('Vice President of Property Management')!).toBeGreaterThan(rank('Owner')!);
 expect(['President','President & CEO','Vice President & Principal'].map(rank)).toEqual([1,1,1]);expect(['Owner and Vice President','Co-Owner, VP of Finance'].map(rank)).toEqual([0,0]);
 expect(rank('Assistant Vice President of Property Management')).toBeNull();
});
it('refuses a placeholder or role first name before it is recorded as found, with the same predicate that blanks {first_name}',()=>{
 for(const firstName of ['Office','Team','Unknown','N/A','None','TBD','null','office'])expect(acceptablePerson(person({firstName}),'cobalt.example'),firstName).toEqual({ok:false,reason:'no_name'});
 expect(acceptablePerson(person({firstName:'Officer'}),'cobalt.example')).toMatchObject({ok:true});
});
it('accepts a cited person with no address as unavailable, never an uncited one, and refuses an initial as a first name',()=>{
 const source={observationId:'o1',url:'https://cobalt.example/team',blockId:'b1',quote:'Jordan Blake, Owner'};
 expect(acceptablePerson(person({email:null,emailStatus:'unavailable',source}),'cobalt.example')).toEqual({ok:true,person:{providerPersonId:'p1',firstName:'Jordan',lastName:'Blake',title:'Owner',email:null,emailStatus:'unavailable',confidence:'high',source}});
 expect(acceptablePerson(person({email:null,emailStatus:'unavailable'}),'cobalt.example')).toEqual({ok:false,reason:'unverified'});
 expect(acceptablePerson(person({email:'jordan@cobalt.example',emailStatus:'unavailable',source}),'cobalt.example')).toEqual({ok:false,reason:'unverified'});
 expect(acceptablePerson(person({email:'jordan@cobalt.example',emailStatus:'published',source}),'cobalt.example')).toMatchObject({ok:true,person:{emailStatus:'published',source}});
 expect(acceptablePerson(person({email:'jordan@cobalt.example',emailStatus:'published',source,firstName:'J.'}),'cobalt.example')).toEqual({ok:false,reason:'no_name'});
});
