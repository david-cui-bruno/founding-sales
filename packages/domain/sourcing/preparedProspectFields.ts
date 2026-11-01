import type {PreparedProspectBrief} from '@fss/contracts';
import {US_BUSINESS_REGIONS} from '../../contracts/src/usBusinessGeography.ts';

export type PreparedPassageKind=PreparedProspectBrief['passages'][number]['kind'];
export interface PreparedPassageClassification {kinds:PreparedPassageKind[];usefulBusiness:boolean;usefulOperations:boolean;residentialContext:boolean;contrary:boolean}
const attribution=/\b(?:testimonial|customer review|powered by|website by|web design|we help property managers|software for property managers|platform for property managers)\b/iu;
const customerPerspective=/\b(?:we|I)\s+(?:breathe easy|could(?:n't| not) be happier)\b|\b(?:we|I)\s+wish\b[^.!?\n]{0,100}\b(?:were|could|would)\b/iu;
const customerRecommendation=/\b(?:[Ww]e|I)\s+(?:highly\s+)?recommend\s+(?:(?:this|the)\s+(?:company|team|firm|property managers?)|[\p{Lu}][\p{Ll}]+(?:\s+[\p{Lu}][\p{Ll}]+){1,4})\b/u;
const attributed=(text:string)=>attribution.test(text)||customerPerspective.test(text)||customerRecommendation.test(text);
// Residential property-management context: explicit housing types, association
// management, or the people a residential manager serves. People terms alone do
// not count beside commercial/industrial scope (commercial tenants, office space).
const residential=/\b(?:residential|single.family|multi.family|multifamily|homes|houses|townhomes?|apartments?|condominiums?|condos?|residences|HOAs?|homeowners?\s+associations?|(?:community|condominium)\s+associations?)\b/iu;
const residentialPeople=/\b(?:tenants?|residents?|landlords?|rental\s+propert(?:y|ies))\b/iu;
const nonResidentialScope=/\b(?:commercial|industrial|retail|office)\s+(?:tenants?|landlords?|propert(?:y|ies)|real estate|space|buildings?|leasing)\b/iu;
const management=/\b(?:manag(?:e|es|ed|ing|ement)|leasing|rental management)\b/iu;
const vendor=/\b(?:software|platform|tools?|technology)\b[^.!?\n]{0,100}\b(?:helps?|enables?|empowers?|for)\b[^.!?\n]{0,60}\b(?:property managers?|management companies|landlords?)\b|\b(?:we|our company)\b[^.!?\n]{0,60}\b(?:sell|build|develop|provide|offer)\b[^.!?\n]{0,60}\b(?:software|platform|tools?)\b/iu;
const ownManager=/\b(?:we|our (?:team|company|firm|office|management|property|residential|rental))\b[^.!?\n]{0,200}\b(?:manag(?:e|es|ed|ing|ement)|leasing)\b/iu;
const namedManager=/\b(?:[A-Z][\p{L}\d&'-]*\s+){1,5}(?:Property Management|Properties|Realty|Management|Residential)\b[^.!?\n]{0,100}\b(?:manages?|provides?|offers?|speciali[sz]es?|serves?|is|has been)\b/u;
const contrary=/\b(?:do not|does not|don't|doesn't|never|no longer)\s+(?:\w+\s+){0,4}(?:manage|offer|provide|speciali[sz]e)\b[^.!?\n]{0,120}\b(?:residential|homes|houses|apartments|residences)\b|\b(?:commercial|industrial)\b[^.!?\n]{0,60}\b(?:only|exclusively)\b|\b(?:only|exclusively)\b[^.!?\n]{0,60}\b(?:commercial|industrial)\b/iu;
const propertyManagementService=/\b(?:property|rental|real estate|community|association|residential)\s+management\b|\bmanag(?:e|es|ed|ing)\b[^.!?\n]{0,100}\b(?:propert(?:y|ies)|rentals?|homes|houses|apartments|condominiums|communities|buildings?|real estate)\b/iu;
const businessDenial=/\b(?:we|our (?:company|firm|team|office))\b[^.!?\n]{0,60}\b(?:(?:do not|don't|does not|doesn't|never|no longer)\s+(?:provide|offer|manage|handle|speciali[sz]e)\b[^.!?\n]{0,80}\b(?:propert(?:y|ies)|rental|residential|homes|apartments|leasing|tenants?)\b|(?:is|are)\s+not\s+(?:a|an)\s+(?:property|rental)\s+management\b)/iu;
const productOffering=/\b(?:we|our (?:company|team|firm))\b[^.!?\n]{0,60}\b(?:sell|market|license|develop|build|offer|provide)\s+(?:(?:a|an|the|our|this|new|cloud|powerful|management)\s+){0,3}(?:software|platform|tools?|technology)\b/iu;
const educationalOffering=/\b(?:we|our (?:company|firm|team))\b[^.!?\n]{0,60}\b(?:provides?|offers?|sells?|teach(?:es)?)\s+(?:(?:a|an|the|our|online|professional|property|management|investment|tenant|screening)\s+){0,5}(?:education|training|courses?|tutorials?|guides?|advice)\b|\b(?:we|our (?:company|firm|team))\s+teach(?:es)?\s+(?:landlords?|property managers?|investors?)\b/iu;
const managementServiceAction=/\b(?:manag(?:e|es|ed|ing)|provid(?:e|es|ed|ing)|offer(?:s|ed|ing)?|serv(?:e|es|ed|ing)|speciali[sz](?:e|es|ed|ing)|oversee(?:s|ing)?|support(?:s|ed|ing)?|deliver(?:s|ed|ing)?)\b/iu;
const explicitManagementService=/\b(?:property|rental|real estate|community|association|residential)\s+management\s+(?:services?|company|firm|team)\b/iu;
const nonServiceBusiness=/\b(?:investment portfolios?|investment funds?|financial returns|securities|wealth management|investment education|management training|real estate (?:investment )?(?:funds?|portfolios?|assets|capital|investment trusts?)|REITs?)\b|\b(?:investments|assets|funds?|capital|securities) for (?:institutional |accredited )?investors\b/iu;
// A whole-block tagline names the publisher's own residential service without a verb:
// "Franchise-owner-operated residential property management offices in New Mexico, Colorado, and Arizona."
// Only an ownership/quality lead, the service phrase and a place tail: a lead word outside the
// allowlist ("Directory of", "Jobs at") or any further clause ("… love our app") is no self-description.
// Sentences with a subject use the verb path.
const residentialTagline=/(?:[Rr]esidential|[Ss]ingle.[Ff]amily|[Mm]ulti.?[Ff]amily)\s+(?:[Pp]roperty|[Rr]ental)\s+[Mm]anagement\s+(?:[Cc]ompany|[Ff]irm|[Oo]ffices?|[Tt]eam|[Ss]ervices?)(?:\s+(?:in|across|serving|throughout)\s+(?:the\s+)?\p{Lu}[\p{L}.'’-]*(?:(?:,\s*|\s+|,?\s+and\s+|\s+&\s+)(?:the\s+)?\p{Lu}[\p{L}.'’-]*)*)?\.?$/u;
const leadToken="(?:(?:\\p{L}+-)*\\p{L}+-(?:owned|operated|based)|full-service|local|trusted|professional|premier|boutique|experienced|independent|family|locally|owned|operated|award-winning|leading|dedicated|reliable)";
const taglineLead=new RegExp(`^(?:an?\\s+)?(?:${leadToken}(?:(?:,?\\s+(?:&|and)\\s+|,\\s*|\\s+)${leadToken}){0,3}\\s+)?$`,'iu');
const residentialSelfTagline=(text:string)=>{const trimmed=text.trim(),match=residentialTagline.exec(trimmed);return match!==null&&taglineLead.test(trimmed.slice(0,match.index));};
const substantive=(text:string)=>text.length>=50&&text.trim().split(/\s+/u).length>=8;
const question=(text:string)=>/\?\s*$/u.test(text)||/^\s*(?:why|how|what|when|where|who|which|do|does|did|can|could|should|would|is|are)\b[^.!?\n]*$/iu.test(text);
// A service heading on the company's own page names the service it sells: "Property Management Services",
// "Full-Service Property Management Company in Boston", "Property Management Grand Rapids MI". It needs a
// service word or a place, so a bare "Property Management" menu label or "… Software" is none.
const serviceHeading=new RegExp(`(?:(?:[Rr]esidential|[Ss]ingle.[Ff]amily|[Mm]ulti.?[Ff]amily|[Rr]ental)\\s+)?(?:[Pp]roperty|[Rr]ental)\\s+[Mm]anagement(?:\\s+([Ss]ervices?|[Cc]ompany|[Ff]irm|[Tt]eam|[Oo]ffices?))?(\\s+(?:in|across|serving|throughout)\\s+(?:the\\s+)?\\p{Lu}[\\p{L}.'’-]*(?:(?:,\\s*|\\s+|,?\\s+and\\s+|\\s+&\\s+)(?:the\\s+)?\\p{Lu}[\\p{L}.'’-]*)*|\\s+\\p{Lu}[\\p{L}.'’-]*(?:\\s+\\p{Lu}[\\p{L}.'’-]*){0,3},?\\s+(?:${US_BUSINESS_REGIONS.join('|')}))?\\.?$`,'u');
// Product, job, directory and review headings name no company's own service, wherever the word sits.
const nonServiceHeading=/\b(?:software|platforms?|apps?|tools?|systems?|jobs?|careers?|hiring|directory|directories|lists?|listings?|reviews?|near me|companies)\b/iu;
const serviceHeadingText=(text:string)=>{const trimmed=text.trim(),match=serviceHeading.exec(trimmed);return trimmed.length<=120&&!nonServiceHeading.test(trimmed)&&match!==null&&(match[1]!==undefined||match[2]!==undefined)&&taglineLead.test(trimmed.slice(0,match.index));};
// The company placing itself in the industry: "Being in property management we're …", "As your property management company, we …".
// Only allowlisted adjectives may sit between "As a" and the service, so a tenant, owner or client of one is never the company.
const industryMember=new RegExp(`\\b(?:being in property management|as (?:a|an|your)(?:\\s+${leadToken}){0,2}\\s+(?:(?:residential|rental)\\s+)?property management\\s+(?:company|firm|team|professionals?|provider)),?\\s+(?:we|our)\\b`,'iu');
// Source policy (David, Nov 1): looser own-page context. A self-introduction names the company as a management
// company: "Welcome to Brown, Brown & West, a local real estate management company located in …", "Acme Realty is a
// property management company …". Only the introduced name span may not be a customer, tenant or owner role; the
// company noun may not be qualified as a directory, review, listing, software or similar product, and no such word
// may appear in the introduction at all.
const introducedRole='(?:tenants?|landlords?|owners?|clients?|customers?|residents?|investors?|members?|my|our|your)';
const introducedName=(first:string)=>`(?!${introducedRole}\\b)${first}(?:(?!\\b${introducedRole}\\b)[^.!?\\n]){1,80}?`;
const selfIntroduction=new RegExp(`(?:\\bwelcome to\\s+${introducedName('[^.!?\\n,]')},|^(?!(?:my|our|your|the|this|that|a|an)\\b)${introducedName('\\p{Lu}')}\\s+is)\\s+(?:an?|your)(?:\\s+${leadToken}){0,3}\\s+(?:(?:residential|rental)\\s+)?(?:real estate|property|rental)\\s+management\\s+(?:company|firm)\\b(?!\\s+(?:director(?:y|ies)|reviews?|listings?|marketplace|software|platforms?|apps?|sites?|portals?|finder|search)\\b)`,'iu');
const introductionNonService=/\b(?:director(?:y|ies)|reviews?|listings?|marketplace|software|platforms?|apps?|portals?|websites?|finder|near me|jobs?|careers?|hiring|compare|comparison)\b/iu;
// "Full Property Management", "Full Management Services" as an own-page service heading; product/job/directory words still refuse.
const fullServiceHeading=/^(?:Full|Complete|Full[- ]Service)\s+(?:Property\s+Management(?:\s+Services?)?|Management\s+Services?)\.?$/iu;
// The company's own NARPM membership line (a residential-management trade body); a whole block, never a mention in prose.
const narpmMember=/^(?:(?:we are|we're|proud|a|an)\s+){0,3}members?\s+of\s+(?:the\s+)?National Association of Residential Property Managers(?:\s*\(NARPM\))?\.?$/iu;
function business(text:string):boolean {
 return (serviceHeadingText(text)||fullServiceHeading.test(text.trim())&&!nonServiceHeading.test(text)||narpmMember.test(text.trim())||substantive(text)&&(residentialSelfTagline(text)||industryMember.test(text)||selfIntroduction.test(text.trim())&&!introductionNonService.test(text)||management.test(text)&&propertyManagementService.test(text)&&managementServiceAction.test(text)&&(ownManager.test(text)||namedManager.test(text))))&&(!nonServiceBusiness.test(text)||explicitManagementService.test(text))&&!question(text)&&!vendor.test(text)&&!productOffering.test(text)&&!educationalOffering.test(text)&&!attributed(text)&&!contrary.test(text)&&!businessDenial.test(text);
}
const workflowTopic=/\b(?:maintenance|repair|vendors?|tenants?|requests?|dispatch|rent collection|screening|leasing|after.hours|market(?:s|ed|ing)?|qualif(?:y|ies|ied|ying)|payments?|portal)\b/iu;
const propertyOperationsDomain=/\b(?:propert(?:y|ies)|tenants?|residents?|landlords?|rent(?:al)?|leasing|homes|houses|apartments|buildings?|condominiums)\b/iu;
const operationalAction='(?:coordinat(?:e|es|ed|ing)|handl(?:e|es|ed|ing)|respond(?:s|ed|ing)?|complet(?:e|es|ed|ing)|schedul(?:e|es|ed|ing)|process(?:es|ed|ing)?|track(?:s|ed|ing)?|dispatch(?:es|ed|ing)?|collect(?:s|ed|ing)?|screen(?:s|ed|ing)?|inspect(?:s|ed|ing)?|assign(?:s|ed|ing)?|submit(?:s|ted|ting)?|report(?:s|ed|ing)?|market(?:s|ed|ing)?|qualif(?:y|ies|ied|ying)|select(?:s|ed|ing)?|plac(?:e|es|ed|ing)|pay(?:s|ing)?|review(?:s|ed|ing)?|taken care of)';
const nonOperationalAgent='(?!\\s+(?:by|via)\\s+(?:call(?:ing)?|dial(?:ling|ing)?|email(?:ing)?|phon(?:e|ing)|telephone|contact(?:ing)?|(?:our|the|this)\\s+(?:software|platform|tools?))\\b)';
const ownOperations=new RegExp('\\b(?:we|our (?:team|staff|office|managers?|company|property managers?|maintenance team|tenants?|residents?))\\b[^.!?\\n]{0,200}\\b'+operationalAction+'\\b'+nonOperationalAgent,'iu');
const passiveOperations=new RegExp('\\b(?:is|are|was|were|be|been)\\s+(?:(?:[a-z]+ly|always|also)\\s+){0,3}'+operationalAction+'\\b'+nonOperationalAgent,'iu');
const operationalNegation=new RegExp('\\b(?:we|our (?:team|staff|office|managers?|company|property managers?|maintenance team|tenants?|residents?))\\b[^.!?\\n]{0,80}\\b(?:do not|does not|don\'t|doesn\'t|never|no longer)\\b[^.!?\\n]{0,80}\\b'+operationalAction+'\\b|\\b(?:maintenance|repairs?|tenant requests|rent collection)\\b[^.!?\\n]{0,60}\\b(?:is|are)\\s+not\\s+'+operationalAction+'\\b','iu');
const operationalVendor=/\b(?:software|platform|tools?|technology)\b[^.!?\n]{0,80}\b(?:we|our (?:team|company))\s+(?:sell|market|offer|build|develop)\b[^.!?\n]{0,80}\b(?:property managers?|management companies|landlords?)\b/iu;
const ownServiceProcess=/\bour\s+(?:\w+\s+){0,4}(?:tenant[- ]screening|rental[- ]marketing|property[- ]maintenance|leasing|rent[- ]collection)\s+(?:process|procedures?|services?|team)\b[^.!?\n]{0,100}\b(?:has|have|includes?|uses?|lets|enables?|helps?|verifies|checks?|selects?|qualifies|is based on)\b/iu;
function operations(text:string):boolean {
 return substantive(text)&&workflowTopic.test(text)&&propertyOperationsDomain.test(text)&&(ownOperations.test(text)||passiveOperations.test(text)||ownServiceProcess.test(text))&&!question(text)&&!vendor.test(text)&&!productOffering.test(text)&&!educationalOffering.test(text)&&!operationalVendor.test(text)&&!operationalNegation.test(text)&&!attributed(text)&&!contrary.test(text)&&!businessDenial.test(text);
}
const physicalAddress=/\b\d{1,6}\s+(?:[\p{L}\d.'-]+\s+){1,6}(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|parkway|pkwy)\b/iu;
const locationStatement=/\b(?:serving(?!\s+as\b)|we serve(?!\s+as\b)|we are located|offices? (?:is|are) located|headquartered|service areas? include|locations? in)\b|(?:^|[.!?\n]\s*)(?:this|our)(?:\s+[\p{L}-]+){0,3}\s+offices?\s+serv(?:e|es)\b(?!\s+as\b)/iu;
const personalName="[\\p{Lu}][\\p{Ll}]+(?:[’'-][\\p{Lu}\\p{Ll}]+)?(?:\\s+[\\p{Lu}][\\p{Ll}]+(?:[’'-][\\p{Lu}\\p{Ll}]+)?){1,3}";
const personRole='(?:CEO|[Pp]resident|[Ff]ounder|[Oo]wner(?:/[Bb]roker)?|[Pp]rincipal|[Dd]irector|(?:[Ee]xecutive\\s+)?[Vv]ice [Pp]resident|[Bb]roker)';
const namedRole=new RegExp('\\b(?:'+personRole+'\\s+'+personalName+'\\s+(?:leads?|oversees?|manages?|serves?|founded|joined|runs?|works?|is|has)|'+personalName+'(?:,\\s*|\\s+(?:serves? as|is|was|has been)\\s+)'+personRole+')\\b','u');
const passageKinds=(text:string,usefulBusiness:boolean,usefulOperations:boolean,hasContrary:boolean):PreparedPassageKind[]=>{
 const result:PreparedPassageKind[]=[];
 if(hasContrary)result.push('contrary');
 if(attributed(text))return result;
 if(usefulBusiness)result.push('business');
 if(physicalAddress.test(text)||text.length>=30&&locationStatement.test(text)&&!question(text))result.push('location');
 if(usefulOperations||operationalNegation.test(text))result.push('workflow');
 if(namedRole.test(text))result.push('person');
 if(/\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:\+?1[ .-]?)?\(?[2-9]\d{2}\)?[ .-]?\d{3}[ .-]?\d{4}/iu.test(text))result.push('contact');
 return result;
};

/** Classification of this one intact retained block; never source, identity or contact authority.
 * `judged` is whether a business-judgment run's model selected this block as residential management: it then replaces
 * the business and residential rules; contrary, attribution and the other kinds stay these rules. Absent, the rules decide. */
export function classifyPreparedPassage(text:string,_locality:string,judged?:boolean):PreparedPassageClassification {
 const usefulBusiness=judged??business(text),usefulOperations=operations(text),hasContrary=contrary.test(text)||businessDenial.test(text);
 return {kinds:passageKinds(text,usefulBusiness,usefulOperations,hasContrary),usefulBusiness,usefulOperations,
  residentialContext:judged??((usefulBusiness||usefulOperations)&&(residential.test(text)||residentialPeople.test(text)&&!nonResidentialScope.test(text))),contrary:hasContrary};
}
