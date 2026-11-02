import {expect,it} from 'vitest';
import {businessIdentityKey,isHostPlaceholder,resolveBusinessName,type BusinessNameInput} from '../../sourcing/businessName.ts';
const resolve=(name:string,host:string,locality:string,source:BusinessNameInput['source']='title',blocks?:string[],query?:string)=>resolveBusinessName({name,host,locality,source,...(blocks?{blocks}:{}),...(query?{query}:{})});
// The production prepared-email preview of 2026-11-02 (names as stored, host and locality as listed there).
it.each([
 ['Denton TX Property Management','tcsmgt.com','Denton',null],
 ['Cambridge, MA Property Management Company','thayerassociates.com','Cambridge',null],
 ['Property Management Services in Denton, TX | New Earth Residential - New Earth Residential','newearthres.com','Denton','New Earth Residential'],
 ['Denton Property Management - Silberman Realty','silbermanrealty.com','Denton','Silberman Realty'],
 ['Cranston, Rhode Island Property Management Services From the ...','olympusgrouprealestate.com','Cranston',null],
 ['Cranston & Rhode Island Property Management','26nmanagement.com','Cranston',null],
 ['Residential Property Management for Brookline, Massachusetts - EDGE Realty Advisors','edgerealty.com','Somerville','EDGE Realty Advisors'],
 ['Dallas-Fort Worth Property Management','frontdoormgmt.com','DFW',null],
 ['Dallas-Fort Worth Property Management','ellishomesource.com','DFW',null],
 ['Cash Home Buyer San Antonio - We Buy Houses | Sell My House Fast','cashhomebuyersanantonio.com','San Antonio',null],
])('title %s (%s) is %s',(name,host,locality,expected)=>expect(resolve(name,host,locality)).toBe(expected));
// [place record as stored, host, locality, business name shown]: the legal form is dropped from the name, and a short first word that begins the host and is an initialism is upper-cased.
it.each([
 ['Brubaker Property Management','brubakerpm.com','Frisco','Brubaker Property Management'],['Martin Realty Management','martinrealtymanagement.com','Quincy','Martin Realty Management'],['Tlj Rentals, Llc','tljrentals.com','El Paso','TLJ Rentals'],['Pearl Properties','pearlelpaso.com','El Paso','Pearl Properties'],
 ['Northern Pass Properties','nppelpaso.com','El Paso','Northern Pass Properties'],['El Paso Renters LLC','elpasorenters.com','El Paso','El Paso Renters'],['Severo Hughston LLC.','shllcep.com','El Paso','Severo Hughston'],['Iroc Asset Management Company','irocamc.com','El Paso','IROC Asset Management Company'],
 ['Jaxon Texas Property Management','jaxontexas.com','El Paso','Jaxon Texas Property Management'],['Guardian Property Management','guardianpropertymanagement.net','El Paso','Guardian Property Management'],['Rose Residential','roseresidentials.com','San Antonio','Rose Residential'],['Burke Properties','myindianhills.com','San Antonio','Burke Properties'],
 ['Re-homing Texas, Llc','rehomingtexas.com','San Antonio','Re-homing Texas'],['Property Management Services Of Texas','pmstx.com','San Antonio','Property Management Services Of Texas'],['DB Broker','dbbroker.com','San Antonio','DB Broker'],
])('place record %s (%s) is shown as %s',(name,host,locality,expected)=>expect(resolve(name,host,locality,'place')).toBe(expected));
it('strips trailing legal forms, repeated and in any case, and nothing else',()=>{
 for(const [name,expected] of [['Foo Co., Inc.','Foo'],['Foo Realty, L.L.C.','Foo Realty'],['Foo Realty llc','Foo Realty'],['Foo Realty Inc','Foo Realty'],['Foo Realty Corp.','Foo Realty'],['Foo Realty, Ltd','Foo Realty'],['Foo Realty PLLC','Foo Realty'],['Foo Realty LP','Foo Realty'],['Foo Realty, LLP.','Foo Realty'],['Foo Realty','Foo Realty'],['Co-op Realty','Co-op Realty'],['Foo Property Management Company','Foo Property Management Company'],['Foo Incorporated Homes','Foo Incorporated Homes']] as const)expect(resolve(name,'x.com','Dallas','place')).toBe(expected);
 expect(resolve('Foo Realty | Property Management in Dallas, TX','x.com','Dallas')).toBe('Foo Realty');
 expect(resolve('Foo Realty, LLC | Property Management in Dallas, TX','x.com','Dallas')).toBe('Foo Realty');
 expect(resolve('Cambridge, MA Property Management Company','acmerealty.com','Cambridge','title',['© 2024 Acme Realty, LLC. All rights reserved.'])).toBe('Acme Realty');
});
it('upper-cases a short first word only when it is an initialism of the host',()=>{
 expect(resolve('Tlj Rentals','www.tljrentals.com','El Paso','place')).toBe('TLJ Rentals');
 expect(resolve('tlj rentals','shop.tljrentals.com','El Paso','place')).toBe('TLJ rentals');
 expect(resolve('Iroc Asset Management Company','irocamc.co.uk','El Paso','place')).toBe('IROC Asset Management Company');
 expect(resolve('Acme Realty','acmerealty.com','Dallas')).toBe('Acme Realty');
 expect(resolve('Dunn Property Management','dunnpm.com','Dallas','place')).toBe('Dunn Property Management');
 expect(resolve('Zion Homes','zionhomes.com','Dallas','place')).toBe('Zion Homes');
 expect(resolve('Rose Residential','roserealty.com','San Antonio','place')).toBe('Rose Residential');
 expect(resolve('Tlj Rentals','example.com','El Paso','place')).toBe('Tlj Rentals');
 expect(resolve('Tlj','tlj.com','El Paso','place')).toBe('Tlj');
});
it('strips location and service phrases around a brand',()=>{
 expect(resolve('Acme Realty | Property Management in Dallas, TX','acmerealty.com','Dallas')).toBe('Acme Realty');
 expect(resolve('Property Management in Dallas, TX | Acme Realty','acmerealty.com','Dallas')).toBe('Acme Realty');
 expect(resolve('Brubaker Property Management in Frisco, TX','brubakerpm.com','Frisco')).toBe('Brubaker Property Management');
 expect(resolve('Best Property Management Company in Plano','x.com','Plano')).toBeNull();
});
it('rejects a location-and-service place record unless it carries a legal form',()=>{
 expect(resolve('Denton Property Management','dentonpm.com','Denton','place')).toBeNull();
 expect(resolve('Denton Property Management LLC','dentonpm.com','Denton','place')).toBe('Denton Property Management');
 expect(resolve('Dallas Fort Worth Property Management','dfwpm.com','DFW','place',undefined,'Dallas Fort Worth residential property management')).toBeNull();
});
it('reads the company\'s own ©-line only when it names the host, and only when the stored name is no business name',()=>{
 const name='Cambridge, MA Property Management Company';
 expect(resolve(name,'thayerassociates.com','Cambridge','title',['Office hours','© 2024 Thayer Associates. All rights reserved.'])).toBe('Thayer Associates');
 expect(resolve(name,'olympusgrouprealestate.com','Cambridge','title',['Copyright © 2023 Olympus Group Real Estate | Privacy Policy | Terms'])).toBe('Olympus Group Real Estate');
 expect(resolve(name,'thayerassociates.com','Cambridge','title',['© 2024 Wix.com Inc. All rights reserved.'])).toBeNull();
 expect(resolve(name,'thayerassociates.com','Cambridge','title',['© 2024 Cambridge MA Property Management'])).toBeNull();
 expect(resolve(name,'thayerassociates.com','Cambridge','title',['Thayer Associates manages 400 homes in Cambridge.'])).toBeNull();
 expect(resolve('Acme Realty','acmerealty.com','Dallas','title',['© 2024 Other Company LLC'])).toBe('Acme Realty');
});
it('treats several different brand-looking parts as ambiguous unless exactly one names the host',()=>{
 expect(resolve('Foo Realty | Bar Homes','foorealty.com','Dallas')).toBe('Foo Realty');
 expect(resolve('Foo Realty | Bar Homes','example.com','Dallas')).toBeNull();
});
// A state's full name is a place in a title, so a title of only state and service words names no business; a place record keeps the state (it is part of the registered name).
it.each([
 ['Rhode Island Property Management','rhodeislandpm.com','Cranston',null],['New York Property Management Company','nypm.com','Albany',null],['North Carolina Property Management','ncpm.com','Raleigh',null],['West Virginia Property Management Services','wvpm.com','Charleston',null],
 ['District of Columbia Property Management','dcpm.com','Washington',null],['State Property Management Company','statepm.com','Dallas',null],['Texas Rental Group','texasrentalgroup.com','Dallas',null],
 ['Rhode Island Property Management - Thayer Associates','thayerassociates.com','Cranston','Thayer Associates'],['Property Management | New York Capital Realty','nycapital.com','Albany','New York Capital Realty'],
 ['Island Realty','islandrealty.com','Cranston','Island Realty'],['Texas Capital Realty','texascapital.com','Dallas','Texas Capital Realty'],
])('title %s (%s) is %s',(name,host,locality,expected)=>expect(resolve(name,host,locality)).toBe(expected));
it('keeps a state in a place record name',()=>{
 expect(resolve('Texas Rental Group','texasrentalgroup.com','Dallas','place')).toBe('Texas Rental Group');
 expect(resolve('Rhode Island Property Management LLC','rhodeislandpm.com','Cranston','place')).toBe('Rhode Island Property Management');
 expect(resolve('Rhode Island Property Management','rhodeislandpm.com','Cranston','place')).toBe('Rhode Island Property Management');
 expect(resolve('Rhode Island Property Management','thayerassociates.com','Cranston','title',['© 2024 Thayer Associates. All rights reserved.'])).toBe('Thayer Associates');
});
it('treats a stored name that is the host, or a bare domain, as absent',()=>{
 const footer=['© 2024 Peak Property Management. All rights reserved.'];
 for(const name of ['peakpm.com','www.peakpm.com','PeakPM.COM','WWW.PEAKPM.COM','https://www.peakpm.com/','other-site.net']){
  expect(resolve(name,'peakpm.com','Dallas')).toBeNull();
  expect(resolve(name,'peakpm.com','Dallas','place')).toBeNull();
  expect(resolve(name,'peakpm.com','Dallas','title',footer)).toBe('Peak Property Management');
  expect(resolve(name,'peakpm.com','Dallas','place',footer)).toBe('Peak Property Management');
 }
 expect(resolve('Peak PM | www.peakpm.com','peakpm.com','Dallas')).toBe('Peak PM');
 expect(resolve('Peak PM','peakpm.com','Dallas')).toBe('Peak PM');
 expect(isHostPlaceholder('Www.Peakpm.com','peakpm.com')).toBe(true);
 expect(isHostPlaceholder('portal.peakpm.co.uk','portal.peakpm.co.uk')).toBe(true);
 expect(isHostPlaceholder('Peak PM','peakpm.com')).toBe(false);
 expect(isHostPlaceholder('','peakpm.com')).toBe(false);
});
it('keys business names by case, spacing and trailing legal form only',()=>{
 expect(businessIdentityKey(' Acme  Realty, LLC. ')).toBe('acme realty');
 expect(businessIdentityKey('Acme Realty')).toBe('acme realty');
 expect(businessIdentityKey('ACME REALTY INC')).toBe('acme realty');
 expect(businessIdentityKey('Acme Realty Partners LLC')).not.toBe(businessIdentityKey('Acme Realty'));
});
