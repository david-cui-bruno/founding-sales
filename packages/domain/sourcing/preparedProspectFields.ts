import type {PreparedProspectBrief} from '@fss/contracts';

export type PreparedPassageKind=PreparedProspectBrief['passages'][number]['kind'];
export interface PreparedPassageClassification {kinds:PreparedPassageKind[];usefulBusiness:boolean;usefulOperations:boolean;residentialContext:boolean;contrary:boolean}
const attribution=/\b(?:testimonial|customer review|powered by|website by|web design|we help property managers|software for property managers|platform for property managers)\b/iu;
const residential=/\b(?:residential|single.family|multi.family|multifamily|homes|houses|apartments|condominiums|residences)\b/iu;
const management=/\b(?:manag(?:e|es|ed|ing|ement)|leasing|rental management)\b/iu;
const vendor=/\b(?:software|platform|tools?|technology)\b[^.!?\n]{0,100}\b(?:helps?|enables?|empowers?|for)\b[^.!?\n]{0,60}\b(?:property managers?|management companies|landlords?)\b|\b(?:we|our company)\b[^.!?\n]{0,60}\b(?:sell|build|develop|provide|offer)\b[^.!?\n]{0,60}\b(?:software|platform|tools?)\b/iu;
const ownManager=/\b(?:we|our (?:team|company|firm|office|management|property|residential|rental))\b[^.!?\n]{0,200}\b(?:manag(?:e|es|ed|ing|ement)|leasing)\b/iu;
const namedManager=/\b(?:[A-Z][\p{L}\d&'-]*\s+){1,5}(?:Property Management|Properties|Realty|Management|Residential)\b[^.!?\n]{0,100}\b(?:manages?|provides?|offers?|speciali[sz]es?|serves?|is|has been)\b/u;
const contrary=/\b(?:do not|does not|don't|doesn't|never|no longer)\s+(?:\w+\s+){0,4}(?:manage|offer|provide|speciali[sz]e)\b[^.!?\n]{0,120}\b(?:residential|homes|houses|apartments|residences)\b|\b(?:commercial|industrial)\b[^.!?\n]{0,60}\b(?:only|exclusively)\b|\b(?:only|exclusively)\b[^.!?\n]{0,60}\b(?:commercial|industrial)\b/iu;
const propertyManagementService=/\b(?:property|rental|real estate|community|association|residential)\s+management\b|\bmanag(?:e|es|ed|ing)\b[^.!?\n]{0,100}\b(?:propert(?:y|ies)|rentals?|homes|houses|apartments|condominiums|communities|buildings?)\b/iu;
const businessDenial=/\b(?:we|our (?:company|firm|team|office))\b[^.!?\n]{0,60}\b(?:(?:do not|don't|does not|doesn't|never|no longer)\s+(?:provide|offer|manage|handle|speciali[sz]e)\b[^.!?\n]{0,80}\b(?:propert(?:y|ies)|rental|residential|homes|apartments|leasing|tenants?)\b|(?:is|are)\s+not\s+(?:a|an)\s+(?:property|rental)\s+management\b)/iu;
const productOffering=/\b(?:we|our (?:company|team|firm))\b[^.!?\n]{0,60}\b(?:sell|market|license|develop|build|offer|provide)\s+(?:(?:a|an|the|our|this|new|cloud|powerful|management)\s+){0,3}(?:software|platform|tools?|technology)\b/iu;
const educationalOffering=/\b(?:we|our (?:company|firm|team))\b[^.!?\n]{0,60}\b(?:provides?|offers?|sells?|teach(?:es)?)\s+(?:(?:a|an|the|our|online|professional|property|management|investment|tenant|screening)\s+){0,5}(?:education|training|courses?|tutorials?|guides?|advice)\b|\b(?:we|our (?:company|firm|team))\s+teach(?:es)?\s+(?:landlords?|property managers?|investors?)\b/iu;
const managementServiceAction=/\b(?:manag(?:e|es|ed|ing)|provid(?:e|es|ed|ing)|offer(?:s|ed|ing)?|serv(?:e|es|ed|ing)|speciali[sz](?:e|es|ed|ing)|oversee(?:s|ing)?|support(?:s|ed|ing)?|deliver(?:s|ed|ing)?)\b/iu;
const explicitManagementService=/\b(?:property|rental|real estate|community|association|residential)\s+management\s+(?:services?|company|firm|team)\b/iu;
const nonServiceBusiness=/\b(?:investment portfolios?|investment funds?|financial returns|securities|wealth management|investment education|management training)\b/iu;
const substantive=(text:string)=>text.length>=50&&text.trim().split(/\s+/u).length>=8;
const question=(text:string)=>/\?\s*$/u.test(text)||/^\s*(?:why|how|what|when|where|who|which|do|does|did|can|could|should|would|is|are)\b[^.!?\n]*$/iu.test(text);
function business(text:string):boolean {
 return substantive(text)&&management.test(text)&&propertyManagementService.test(text)&&managementServiceAction.test(text)&&(ownManager.test(text)||namedManager.test(text))&&(!nonServiceBusiness.test(text)||explicitManagementService.test(text))&&!question(text)&&!vendor.test(text)&&!productOffering.test(text)&&!educationalOffering.test(text)&&!attribution.test(text)&&!contrary.test(text)&&!businessDenial.test(text);
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
 return substantive(text)&&workflowTopic.test(text)&&propertyOperationsDomain.test(text)&&(ownOperations.test(text)||passiveOperations.test(text)||ownServiceProcess.test(text))&&!question(text)&&!vendor.test(text)&&!productOffering.test(text)&&!educationalOffering.test(text)&&!operationalVendor.test(text)&&!operationalNegation.test(text)&&!attribution.test(text)&&!contrary.test(text)&&!businessDenial.test(text);
}
const passageKinds=(text:string,locality:string,usefulBusiness:boolean,hasContrary:boolean):PreparedPassageKind[]=>{
 const result:PreparedPassageKind[]=[];
 if(hasContrary)result.push('contrary');
 if(usefulBusiness)result.push('business');
 if(/\b(?:office|located|location|service area|serving|we serve|headquarters)\b|\b\d{5}(?:-\d{4})?\b/iu.test(text)||locality.trim().length>1&&text.toLowerCase().includes(locality.toLowerCase()))result.push('location');
 if(workflowTopic.test(text)&&text.length>=30)result.push('workflow');
 if(/\b(?:CEO|president|founder|owner|principal|director|leadership|our team|meet our)\b/iu.test(text)&&/\b[A-Z][\p{Ll}]+(?:\s+[A-Z][\p{Ll}]+){1,3}\b/u.test(text))result.push('person');
 if(/\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:\+?1[ .-]?)?\(?[2-9]\d{2}\)?[ .-]?\d{3}[ .-]?\d{4}/iu.test(text))result.push('contact');
 return result;
};

/** Classification of this one intact retained block; never source, identity or contact authority. */
export function classifyPreparedPassage(text:string,locality:string):PreparedPassageClassification {
 const usefulBusiness=business(text),usefulOperations=operations(text),hasContrary=contrary.test(text)||businessDenial.test(text);
 return {kinds:passageKinds(text,locality,usefulBusiness,hasContrary),usefulBusiness,usefulOperations,residentialContext:usefulBusiness&&residential.test(text),contrary:hasContrary};
}
