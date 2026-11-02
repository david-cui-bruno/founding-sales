import {expect,it} from 'vitest';
import {resolveBusinessName,type BusinessNameInput} from '../../sourcing/businessName.ts';
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
it.each([
 ['Brubaker Property Management','brubakerpm.com','Frisco'],['Martin Realty Management','martinrealtymanagement.com','Quincy'],['Tlj Rentals, Llc','tljrentals.com','El Paso'],['Pearl Properties','pearlelpaso.com','El Paso'],
 ['Northern Pass Properties','nppelpaso.com','El Paso'],['El Paso Renters LLC','elpasorenters.com','El Paso'],['Severo Hughston LLC.','shllcep.com','El Paso'],['Iroc Asset Management Company','irocamc.com','El Paso'],
 ['Jaxon Texas Property Management','jaxontexas.com','El Paso'],['Guardian Property Management','guardianpropertymanagement.net','El Paso'],['Rose Residential','roseresidentials.com','San Antonio'],['Burke Properties','myindianhills.com','San Antonio'],
 ['Re-homing Texas, Llc','rehomingtexas.com','San Antonio'],['Property Management Services Of Texas','pmstx.com','San Antonio'],['DB Broker','dbbroker.com','San Antonio'],
])('place record %s is the business name',(name,host,locality)=>expect(resolve(name,host,locality,'place')).toBe(name));
it('strips location and service phrases around a brand',()=>{
 expect(resolve('Acme Realty | Property Management in Dallas, TX','acmerealty.com','Dallas')).toBe('Acme Realty');
 expect(resolve('Property Management in Dallas, TX | Acme Realty','acmerealty.com','Dallas')).toBe('Acme Realty');
 expect(resolve('Brubaker Property Management in Frisco, TX','brubakerpm.com','Frisco')).toBe('Brubaker Property Management');
 expect(resolve('Best Property Management Company in Plano','x.com','Plano')).toBeNull();
});
it('rejects a location-and-service place record unless it carries a legal form',()=>{
 expect(resolve('Denton Property Management','dentonpm.com','Denton','place')).toBeNull();
 expect(resolve('Denton Property Management LLC','dentonpm.com','Denton','place')).toBe('Denton Property Management LLC');
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
