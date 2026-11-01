import {expect,it} from 'vitest';
import {classifyDiscoveryPage,companyHost,discoveryFirmName,isDiscoveryDirectory} from '../../sourcing/discoveryIdentity.ts';
it('separates branded names from the production SEO titles without treating them as evidence',()=>{
 for(const [title,name] of [
  ['Property Management Company Providence, RI | Lyon Property Group','Lyon Property Group'],
  ['RentProv Realty - Rentals, Sales, and Property Management','RentProv Realty'],
  ['Providence Property Management, Providence Property Managers, Providence Property Management Company | Zanno Property Management','Zanno Property Management'],
 ] as const)expect(discoveryFirmName(title,'https://example.test/')).toBe(name);
});
it('keeps ambiguous titles intact and does not guess unfamiliar brands',()=>{
 for(const title of ['Acme Realty | Other Realty','Nexus™ | Rhode Island Property Management','Property Management Providence'] as const)expect(discoveryFirmName(title,'https://example.test/')).toBe(title);
});
it('excludes known directories with hostname boundaries',()=>{
 expect(isDiscoveryDirectory('https://www.allpropertymanagement.com/property-management/ri/providence')).toBe(true);
 expect(isDiscoveryDirectory('https://allpropertymanagement.com.evil.test/')).toBe(false);
 expect(isDiscoveryDirectory('https://realty.test/allpropertymanagement.com')).toBe(false);
});
it('routes the October31 audit pages: companies stay, lists become leads, reference pages drop',()=>{
 for(const [url,title,kind] of [
  ['https://www.homeriver.com/pennsylvania/pittsburgh-property-management','Property Management in Pittsburgh: Premier Real Estate Solutions','company'],
  ['https://www.fsresidential.com/washington-dc/news-events/articles/property-management-basics','Washington DC property management: Services, costs, benefits','company'],
  ['https://www.trlawing.com/','T.R. Lawing Realty','company'],
  ['https://www.managemyproperty.com/find/district-of-columbia-property-management-companies','District of Columbia Property Management Companies','list'],
  ['https://www.charlotteproperty.management/blog/6-best-property-management-companies-in-charlotte','6 Best Property Management Companies in Charlotte','list'],
  ['https://belonghome.com/blog/top-property-management-companies-north-carolina','9 Top Property Management Companies in North Carolina in 2026','list'],
  ['https://example-office.test/','Top 21 Office property management companies based in Baltimore, United States','list'],
  ['https://en.wikipedia.org/wiki/Providence,_Rhode_Island','Providence, Rhode Island - Wikipedia','noise'],
  ['https://www.merriam-webster.com/dictionary/providence','PROVIDENCE Definition & Meaning - Merriam-Webster','noise'],
  ['https://www.dchousing.gov/property/williston','Williston Apartments | District of Columbia Housing Authority (DCHA)','noise'],
 ] as const)expect(classifyDiscoveryPage({url,title})).toBe(kind);
});
it('keys a company by host without www and keeps distinct hosts distinct',()=>{
 expect(companyHost('https://WWW.Alarca.com/charlotte')).toBe('alarca.com');
 expect(companyHost('https://pittsburgh.homeriver.com/')).toBe('pittsburgh.homeriver.com');
 expect(companyHost('https://www.homeriver.com/pennsylvania')).toBe('homeriver.com');
});
