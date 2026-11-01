import {expect,it} from 'vitest';
import {classifyPreparedPassage} from '../../sourcing/preparedProspectFields.ts';

it('recognizes explicit property-management business without manufacturing residential scope from commercial landlords',()=>{
 const text='Our property management company provides professional management services for commercial landlords and office building owners.';
 expect(classifyPreparedPassage(text,'')).toMatchObject({usefulBusiness:true,residentialContext:false,contrary:false,kinds:expect.arrayContaining(['business'])});
});

// ADR0034/Step1.6: October31 Peak Richmond, Astoria and TCS briefs showed
// "Residential fit unknown" although their own passages describe residential
// landlords, residents and single-family homes. These were red before 1.6.
it.each([
 ['Peak Richmond business','Peak Property Management manages rental properties for landlords and investors throughout the Richmond area.'],
 ['Peak Richmond resident portal','Over 90% of our residents use the resident portal to pay rent online and submit maintenance requests, which our team tracks and schedules.'],
 ['Astoria tenant portal','When you partner with Astoria Charm, you can rest assured that your tenants are in capable hands. We serve as a reliable point of contact for tenants, addressing concerns, handling inquiries, and providing residents with an online portal for rent payments, maintenance requests, and access to their ledgers. With our proactive approach and personalized service we ensure that every detail is managed efficiently and effectively.'],
 ['TCS single-family homes','Our team collects rent online and coordinates maintenance for tenants of the single-family homes in our care.'],
 ['landlord services','Our property management company provides professional management services for landlords and property owners.'],
 ['community association management','We provide community association management for HOA and condominium communities across Richmond.'],
])('recognizes residential property-management context: %s',(_case,text)=>{
 const result=classifyPreparedPassage(text,'');
 expect(result).toMatchObject({residentialContext:true,contrary:false});expect(result.usefulBusiness||result.usefulOperations).toBe(true);
});

it.each([
 'We manage commercial properties only, including office buildings and retail centers for landlords.',
 'Our property management team coordinates maintenance requests for commercial tenants in office buildings.',
 'Our platform helps landlords and property managers track tenant maintenance requests and rent payments.',
 'We teach landlords how to screen tenants and collect rent from residents.',
])('keeps contrary, commercial-only, vendor and educational refusals out of residential context: %s',text=>{
 expect(classifyPreparedPassage(text,'')).toMatchObject({residentialContext:false});
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
 expect(classifyPreparedPassage('Property management','')).toMatchObject({usefulBusiness:false,usefulOperations:false,residentialContext:false});
});

it('keeps known contrary evidence visible even beyond the displayed quote bound',()=>{
 const text='We do not manage residential homes. '+'Retained scope explanation. '.repeat(100);
 expect(text.length).toBeGreaterThan(2000);
 expect(classifyPreparedPassage(text,'')).toMatchObject({contrary:true,usefulBusiness:false,usefulOperations:false,kinds:expect.arrayContaining(['contrary'])});
});

it('does not present a customer endorsement as the management company describing its own business',()=>{
 const text='Our network of churches has properties requiring professional management across the state. We wish Cedar were able to clone itself into every community. These are great professionals regarding maintenance and keeping tenants. We breathe easy with Cedar managing our property.';
 expect(classifyPreparedPassage(text,'')).toMatchObject({usefulBusiness:false,usefulOperations:false,residentialContext:false,kinds:[]});
});

it.each(['Owner Resources','Executive Vice President, Northern California, Sacramento and East Bay','Meet Our Team'])('does not put a navigation or role heading into people evidence: %s',text=>{
 expect(classifyPreparedPassage(text,'Sacramento').kinds).not.toContain('person');
});

it.each([
 'Our founder Mira Cedar leads the local residential property team.',
 'Beran Redwood serves as Executive Vice President for Cedar Residential California, overseeing operations across Northern California.',
 'Ted Cedar, Owner/Broker, leads the local property management office.',
])('retains a named person tied to a role without treating it as buying authority: %s',text=>{
 expect(classifyPreparedPassage(text,'').kinds).toContain('person');
});

it.each([
 'Preventive maintenance programs',
 'To learn more about how Cedar Residential can serve your Sacramento community or to request a proposal, click here.',
 'If you are a current resident, please see your resident portal for any requests or questions regarding your community.',
 'Sacramento property management company | Our Services',
 'Discover the leading Sacramento property management company',
 'Learn how this independently operated franchise office serves Boston.',
])('does not turn headings or navigation into location/workflow evidence: %s',text=>{
 const kinds=classifyPreparedPassage(text,'Sacramento').kinds;
 expect(kinds).not.toContain('location');expect(kinds).not.toContain('workflow');
});

it('preserves actual address, service geography and operational evidence independently',()=>{
 expect(classifyPreparedPassage('2530 Fictional Street Sacramento, CA 95816','Sacramento').kinds).toContain('location');
 expect(classifyPreparedPassage('Serving Sacramento, Placer, El Dorado and Yolo Counties since 1976.','Sacramento').kinds).toContain('location');
 expect(classifyPreparedPassage('All maintenance is taken care of promptly to support resident satisfaction and tenant retention.','').kinds).toContain('workflow');
});

it('recognizes a declarative franchise-office service area without losing its portfolio limitation',()=>{
 const text='This independently operated franchise office serves Boston. National network totals are not this office portfolio.';
 expect(classifyPreparedPassage(text,'Boston')).toEqual({kinds:['location'],usefulBusiness:false,usefulOperations:false,residentialContext:false,contrary:false});
});

it('does not hide known contrary evidence inside an otherwise attributed passage',()=>{
 expect(classifyPreparedPassage('Customer review: We do not manage residential homes. Our firm serves commercial owners only.','').kinds).toContain('contrary');
});

it('retains the company describing its maintenance process even when it recommends a portal',()=>{
 const text='We highly recommend that tenants use our maintenance portal. Our team schedules property repairs and tracks tenant requests every day.';
 expect(classifyPreparedPassage(text,'')).toMatchObject({usefulOperations:true,contrary:false,kinds:expect.arrayContaining(['workflow'])});
});

it('does not promote an unlabelled customer recommendation of a named manager',()=>{
 const text="We highly recommend Cedar Property Management. Our tenants submit maintenance requests through the manager's portal and all property repairs are tracked.";
 expect(classifyPreparedPassage(text,'')).toMatchObject({usefulBusiness:false,usefulOperations:false,kinds:[]});
});

it.each(['Executive Vice President Northern California','Regional Director Northern California'])('does not infer a named person from a role followed by geographic heading text: %s',text=>{
 expect(classifyPreparedPassage(text,'').kinds).not.toContain('person');
});

it('retains an explicit name followed by its source role without needing a narrative sentence',()=>{
 expect(classifyPreparedPassage('Mira Cedar, Founder','').kinds).toContain('person');
});

it('retains the whole tenant-portal process as workflow rather than treating serve-as contact handling as geography',()=>{
 const text='When you partner with Astoria Charm, you can rest assured that your tenants are in capable hands. We serve as a reliable point of contact for tenants, addressing concerns, handling inquiries, and providing residents with an online portal for rent payments, maintenance requests, and access to their ledgers. With our proactive approach and personalized service we ensure that every detail is managed efficiently and effectively.';
 expect(classifyPreparedPassage(text,'')).toEqual({kinds:['workflow'],usefulBusiness:false,usefulOperations:true,residentialContext:true,contrary:false});
});

it.each([
 'We serve as a point of contact for tenants. Please visit the resident portal for questions.',
 'Serving as your tenant point of contact, our office is available for any questions.',
 'Our office serves as a point of contact for tenants. Visit the resident portal for questions.',
])('does not invent geography or a concrete process from a serve-as contact statement: %s',text=>{
 expect(classifyPreparedPassage(text,'Boston')).toMatchObject({kinds:[],usefulOperations:false});
});

it('still retains an explicit serve-area statement alongside a serve-as role',()=>{
 const text='We serve as a point of contact for tenants. We serve Boston and the surrounding communities.';
 expect(classifyPreparedPassage(text,'').kinds).toEqual(['location']);
});

// Step1.6.5: Nov 1 Brickleys and Edgerow briefs had no business context although their own pages say so.
it.each([
 'Franchise-owner-operated residential property management offices in New Mexico, Colorado, and Arizona.',
 'If we manage your real estate investment, sign in to view your statements and account notes.',
 'Family-owned single-family rental management services throughout Grand Rapids, Kentwood & Wyoming.',
 'Residential Property Management Services in Spokane, Liberty Lake and the Spokane Valley.',
 'Family-owned residential property management service throughout Boston and Cambridge.',
 'A locally-owned & award-winning residential property management company serving Spokane, WA.',
 'We manage rental homes for institutional investors across the Boston metropolitan area.',
])('recognizes a residential self-description or own real-estate management as business: %s',text=>{
 expect(classifyPreparedPassage(text,'')).toMatchObject({usefulBusiness:true,contrary:false,kinds:expect.arrayContaining(['business'])});
});
it.each([
 'Software for residential property management companies that helps landlords collect rent online every month.',
 'We do not provide residential property management services for homes or apartments in this area.',
 'Greater Grand Rapids Property Management Specialists.',
 'Our team manages real estate investment funds and securities portfolios for accredited investors nationwide.',
 'The complete accounting software for a residential property management company with offices across the country.',
 'Built for any residential property management company that wants faster owner statements and reports.',
 'We manage real estate funds for institutional investors across the United States.',
 'Residential property management offices love our app for faster owner statements.',
 'Directory of residential property management services in Boston and Cambridge.',
 'Jobs at a residential property management company in Boston and Cambridge.',
 'Residential property management offices in Boston use our platform for owner statements.',
 'Our firm manages real estate assets and capital for institutional investors in core markets nationwide.',
])('still refuses vendor, denial, short or investment-fund text: %s',text=>{
 expect(classifyPreparedPassage(text,'').usefulBusiness).toBe(false);
});

// Source policy (David, Nov 1): Shift's own pages say they are a property-management company without "we manage".
it.each([
 'Grand Rapids is attracting national attention as one of the fastest growing real estate markets in the country. With that growth, housing demand greatly increases. Being in property management we’re experiencing the forefront effects of that influx as new and existing residents need rental housing.',
 'As your property management company, we keep owners informed about every lease, inspection and repair.',
 'As a family-owned property management firm, our team answers every owner call the same business day.',
 'Property Management Services',
 'Property Management Grand Rapids MI',
 'Full-Service Property Management Company in Boston',
 'Residential Property Management in Spokane, Liberty Lake and the Spokane Valley',
 // Production brownbrownwestrox.com and empirepropertymanagement.net homepage blocks (Nov 1).
 'Welcome to Brown, Brown & West, a local real estate management company located in the heart of Knoxville, TN with apartment homes and single family homes available.',
 'Full Property Management',
 'Full Management Services',
 'Member of the National Association of Residential Property Managers',
 'Acme Realty is a full-service property management company serving Knoxville owners.',
])('recognizes the company placing itself in property management or naming its service: %s',text=>{
 expect(classifyPreparedPassage(text,'')).toMatchObject({usefulBusiness:true,contrary:false,kinds:expect.arrayContaining(['business'])});
});
it.each([
 'Property Management',
 'Property Management Software',
 'Property Management Services?',
 'Jobs in Property Management in Boston',
 'Directory of Property Management Services',
 'Being in property management for twenty years, I can say this team is the best we have hired.',
 'As a property management software company, we help property managers collect rent online.',
 'Testimonial: As your property management company, we were thrilled with their service.',
 'As a property management firm, we do not manage residential homes or apartments.',
 'Property Management Software Boston MA',
 'Property Management Jobs Austin TX',
 'Property Management Directory Phoenix AZ',
 'As a tenant of a property management company, we were never told about hidden fees until move-out.',
 'As an owner with a property management company, we expected far better communication.',
 'Full Management Software',
 'Full Property Management Jobs',
 'Full Property Management Directory',
 'Welcome to the tenant portal of Acme, a property management company that handles our lease.',
 'My landlord is a property management company that never returns calls about repairs.',
 'Our software helps every member of the National Association of Residential Property Managers.',
 'Welcome to RentTools, a property management software company for landlords and managers.',
 'Find property management companies near me, compare reviews and hire one today.',
])('still refuses labels, products, jobs, directories, testimonials and denials: %s',text=>{
 expect(classifyPreparedPassage(text,'').usefulBusiness).toBe(false);
});
