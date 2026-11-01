import {expect,it} from 'vitest';
import {classifyPreparedPassage} from '../../sourcing/preparedProspectFields.ts';

it.each([
 'For our tenants, an online portal lets them pay rent and review payments. Owners can review property income through the management software used by our staff.',
 'We market each rental property on relevant rental websites to support prompt tenant occupancy.',
 'We qualify each tenant using identity, employment and rental-history checks before a tenancy begins.',
 'Our thorough tenant-screening process helps us select reliable tenants for rental properties.',
 'Homeowners may not want to screen tenants or collect rent themselves. Our thorough tenant-screening process has helped us select reliable tenants for rental properties.',
])('retains a substantive service-handling field from its whole block: %s',text=>{
 expect(classifyPreparedPassage(text,false)).toMatchObject({usefulOperations:true,contrary:false,kinds:expect.arrayContaining(['workflow'])});
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
])('does not make labels, attributed promotion or unsupported service claims operational evidence: %s',text=>{
 expect(classifyPreparedPassage(text,false)).toMatchObject({usefulOperations:false});
});

it.each([
 'Our staff uses property management software to track tenant requests and rent payments for rental properties.',
 'Our team coordinates repairs for residential tenants using software built for our own staff.',
 'All maintenance is taken care of promptly to support resident satisfaction and tenant retention.',
 'Our tenants submit maintenance requests through the portal.',
])('preserves substantive operational evidence and legitimate software use: %s',text=>{
 expect(classifyPreparedPassage(text,false)).toMatchObject({usefulOperations:true,contrary:false});
});

it('does not invent operations from unrelated support text or a bare label',()=>{
 expect(classifyPreparedPassage('Our team processes customer support requests for software users within one business day.',false)).toMatchObject({usefulOperations:false});
 expect(classifyPreparedPassage('Property management',false)).toMatchObject({usefulOperations:false});
});

it('keeps known contrary evidence visible even beyond the displayed quote bound',()=>{
 const text='We do not manage residential homes. '+'Retained scope explanation. '.repeat(100);
 expect(text.length).toBeGreaterThan(2000);
 expect(classifyPreparedPassage(text,false)).toMatchObject({contrary:true,usefulOperations:false,kinds:expect.arrayContaining(['contrary'])});
});

it('does not present a customer endorsement as the management company describing its own business',()=>{
 const text='Our network of churches has properties requiring professional management across the state. We wish Cedar were able to clone itself into every community. These are great professionals regarding maintenance and keeping tenants. We breathe easy with Cedar managing our property.';
 expect(classifyPreparedPassage(text,false)).toMatchObject({usefulOperations:false,kinds:[]});
});

it.each(['Owner Resources','Executive Vice President, Northern California, Sacramento and East Bay','Meet Our Team'])('does not put a navigation or role heading into people evidence: %s',text=>{
 expect(classifyPreparedPassage(text,false).kinds).not.toContain('person');
});

it.each([
 'Our founder Mira Cedar leads the local residential property team.',
 'Beran Redwood serves as Executive Vice President for Cedar Residential California, overseeing operations across Northern California.',
 'Ted Cedar, Owner/Broker, leads the local property management office.',
])('retains a named person tied to a role without treating it as buying authority: %s',text=>{
 expect(classifyPreparedPassage(text,false).kinds).toContain('person');
});

it.each([
 'Preventive maintenance programs',
 'To learn more about how Cedar Residential can serve your Sacramento community or to request a proposal, click here.',
 'If you are a current resident, please see your resident portal for any requests or questions regarding your community.',
 'Sacramento property management company | Our Services',
 'Discover the leading Sacramento property management company',
 'Learn how this independently operated franchise office serves Boston.',
])('does not turn headings or navigation into location/workflow evidence: %s',text=>{
 const kinds=classifyPreparedPassage(text,false).kinds;
 expect(kinds).not.toContain('location');expect(kinds).not.toContain('workflow');
});

it('preserves actual address, service geography and operational evidence independently',()=>{
 expect(classifyPreparedPassage('2530 Fictional Street Sacramento, CA 95816',false).kinds).toContain('location');
 expect(classifyPreparedPassage('Serving Sacramento, Placer, El Dorado and Yolo Counties since 1976.',false).kinds).toContain('location');
 expect(classifyPreparedPassage('All maintenance is taken care of promptly to support resident satisfaction and tenant retention.',false).kinds).toContain('workflow');
});

it('recognizes a declarative franchise-office service area without losing its portfolio limitation',()=>{
 const text='This independently operated franchise office serves Boston. National network totals are not this office portfolio.';
 expect(classifyPreparedPassage(text,false)).toEqual({kinds:['location'],usefulOperations:false,contrary:false});
});

it('does not hide known contrary evidence inside an otherwise attributed passage',()=>{
 expect(classifyPreparedPassage('Customer review: We do not manage residential homes. Our firm serves commercial owners only.',false).kinds).toContain('contrary');
});

it('retains the company describing its maintenance process even when it recommends a portal',()=>{
 const text='We highly recommend that tenants use our maintenance portal. Our team schedules property repairs and tracks tenant requests every day.';
 expect(classifyPreparedPassage(text,false)).toMatchObject({usefulOperations:true,contrary:false,kinds:expect.arrayContaining(['workflow'])});
});

it('does not promote an unlabelled customer recommendation of a named manager',()=>{
 const text="We highly recommend Cedar Property Management. Our tenants submit maintenance requests through the manager's portal and all property repairs are tracked.";
 expect(classifyPreparedPassage(text,false)).toMatchObject({usefulOperations:false,kinds:[]});
});

it.each(['Executive Vice President Northern California','Regional Director Northern California'])('does not infer a named person from a role followed by geographic heading text: %s',text=>{
 expect(classifyPreparedPassage(text,false).kinds).not.toContain('person');
});

it('retains an explicit name followed by its source role without needing a narrative sentence',()=>{
 expect(classifyPreparedPassage('Mira Cedar, Founder',false).kinds).toContain('person');
});

it('retains the whole tenant-portal process as workflow rather than treating serve-as contact handling as geography',()=>{
 const text='When you partner with Astoria Charm, you can rest assured that your tenants are in capable hands. We serve as a reliable point of contact for tenants, addressing concerns, handling inquiries, and providing residents with an online portal for rent payments, maintenance requests, and access to their ledgers. With our proactive approach and personalized service we ensure that every detail is managed efficiently and effectively.';
 expect(classifyPreparedPassage(text,false)).toEqual({kinds:['workflow'],usefulOperations:true,contrary:false});
});

it.each([
 'We serve as a point of contact for tenants. Please visit the resident portal for questions.',
 'Serving as your tenant point of contact, our office is available for any questions.',
 'Our office serves as a point of contact for tenants. Visit the resident portal for questions.',
])('does not invent geography or a concrete process from a serve-as contact statement: %s',text=>{
 expect(classifyPreparedPassage(text,false)).toMatchObject({kinds:[],usefulOperations:false});
});

it('still retains an explicit serve-area statement alongside a serve-as role',()=>{
 const text='We serve as a point of contact for tenants. We serve Boston and the surrounding communities.';
 expect(classifyPreparedPassage(text,false).kinds).toEqual(['location']);
});

// Business context is the qualification model's selection (David, Nov 1); the guards still apply.
it('marks a model-selected block as business context, keeping its other kinds',()=>{
 expect(classifyPreparedPassage('Full Property Management',true)).toEqual({kinds:['business'],usefulOperations:false,contrary:false});
 expect(classifyPreparedPassage('Property Management',false).kinds).toEqual([]);
 expect(classifyPreparedPassage('Our office at 42 Fictional Street manages rental homes; call (617) 555-0123.',true).kinds).toEqual(['business','location','contact']);
});
it('keeps contrary text ahead of a model selection and drops a selection of attributed text',()=>{
 expect(classifyPreparedPassage('We do not manage residential homes or apartments in this area.',true)).toMatchObject({contrary:true,kinds:['contrary','business']});
 expect(classifyPreparedPassage('Customer review: Cedar manages our rental homes very well.',true).kinds).toEqual([]);
});
