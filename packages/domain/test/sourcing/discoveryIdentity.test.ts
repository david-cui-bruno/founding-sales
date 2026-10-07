import {expect,it} from 'vitest';
import {discoveryFirmName,isDiscoveryDirectory} from '../../sourcing/discoveryIdentity.ts';
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
