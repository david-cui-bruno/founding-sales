import {expect,it} from 'vitest';
import {classifyPreparedPassage} from '../../sourcing/preparedProspectFields.ts';

it('recognizes explicit property-management business without manufacturing residential scope',()=>{
 const text='Our property management company provides professional management services for landlords and property owners.';
 expect(classifyPreparedPassage(text,'')).toMatchObject({usefulBusiness:true,residentialContext:false,contrary:false,kinds:expect.arrayContaining(['business'])});
});

it.each([
 'For our tenants, an online portal lets them pay rent and review payments. Owners can review property income through the management software used by our staff.',
 'We market each rental property on relevant rental websites to support prompt tenant occupancy.',
 'We qualify each tenant using identity, employment and rental-history checks before a tenancy begins.',
 'Our thorough tenant-screening process helps us select reliable tenants for rental properties.',
 'Homeowners may not want to screen tenants or collect rent themselves. Our thorough tenant-screening process has helped us select reliable tenants for rental properties.',
])('retains a substantive service-handling field from its whole block: %s',text=>{
 expect(classifyPreparedPassage(text,'')).toMatchObject({usefulOperations:true,contrary:false,kinds:expect.arrayContaining(['workflow'])});
});

it('recognizes a management service paragraph with explicit residential context',()=>{
 const text='As a property management company, Cedar Residential serves single-family neighborhoods and condominiums. Our team works with vendors and tradespeople to support these properties.';
 expect(classifyPreparedPassage(text,'')).toMatchObject({usefulBusiness:true,residentialContext:true,contrary:false});
});

it.each([
 'Property management services | Tenant screening | Rent collection | Marketing rental properties',
 'Our property management office is located at 42 Fictional Street. Call our office for further information.',
 'Contact the rental office at (617) 555-0123 for maintenance requests and tenant information.',
 'Our firm manages property investment portfolios and financial returns for real estate investors.',
 'Our company offers property investment education and property management training for landlords.',
 'Our company provides property management training that teaches landlords tenant screening and rent collection.',
 'We teach landlords how to screen tenants, collect rent and market rental properties online.',
 'Property management is the supervision of rental properties and includes tenant screening and rent collection.',
 'How does our team manage rental properties and screen tenants for property owners?',
 'Why hire our property management company to provide rental services for your properties',
 'Customer review: Our property management company manages rental homes and screens tenants very efficiently.',
 'Our platform automates maintenance requests and tenant communication for property managers.',
 'Our team tracks tenant maintenance requests using the software platform we sell to property managers.',
 'We market software for property managers to screen tenants and collect rent online.',
 'Our marketing tools help property managers fill vacancies and handle tenant requests.',
 'Our team does not handle maintenance requests or qualify tenants for rental properties.',
 'We do not provide property management services for landlords or rental property owners.',
 'We are not a property management company and do not manage rental properties.',
])('does not make labels, attributed promotion or unsupported service claims useful: %s',text=>{
 expect(classifyPreparedPassage(text,'Boston')).toMatchObject({usefulBusiness:false,usefulOperations:false,residentialContext:false});
});

it.each([
 'Our staff uses property management software to track tenant requests and rent payments for rental properties.',
 'Our team coordinates repairs for residential tenants using software built for our own staff.',
 'All maintenance is taken care of promptly to support resident satisfaction and tenant retention.',
 'Our tenants submit maintenance requests through the portal.',
])('preserves substantive operational evidence and legitimate software use: %s',text=>{
 expect(classifyPreparedPassage(text,'')).toMatchObject({usefulOperations:true,contrary:false});
});

it('does not use locality or another call to invent property services or residential scope',()=>{
 expect(classifyPreparedPassage('Our team processes customer support requests for software users within one business day.','Residential Property Management')).toMatchObject({usefulBusiness:false,usefulOperations:false,residentialContext:false});
 classifyPreparedPassage('Our company manages residential homes for property owners across the local region.','');
 expect(classifyPreparedPassage('Property management services','')).toMatchObject({usefulBusiness:false,usefulOperations:false,residentialContext:false});
});

it('keeps known contrary evidence visible even beyond the displayed quote bound',()=>{
 const text='We do not manage residential homes. '+'Retained scope explanation. '.repeat(100);
 expect(text.length).toBeGreaterThan(2000);
 expect(classifyPreparedPassage(text,'')).toMatchObject({contrary:true,usefulBusiness:false,usefulOperations:false,kinds:expect.arrayContaining(['contrary'])});
});
