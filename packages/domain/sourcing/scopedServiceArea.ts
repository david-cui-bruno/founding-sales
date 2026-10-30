import type {QualificationCandidateContext} from './qualificationCitationRoles.ts';
import {supportsCurrentUSServiceLocation} from './currentUSBusinessGeography.ts';
const fold=(value:string)=>value.normalize('NFKC').replace(/\s+/gu,' ').trim().toLowerCase();
const literal=(value:string,part:string)=>` ${fold(value).replace(/[^\p{L}\p{N}]+/gu,' ')} `.includes(` ${fold(part).replace(/[^\p{L}\p{N}]+/gu,' ')} `);
const stateNames:Record<string,string>={TX:'texas',RI:'rhode island',MA:'massachusetts'};
/** One source-block scope predicate for selection and its native read consumer. */
export function supportsScopedServiceArea(value:string,candidate:QualificationCandidateContext,currentUS=false):boolean {
 return (currentUS?supportsCurrentUSServiceLocation(value,candidate.region,candidate.locality)
  :literal(value,candidate.locality)&&(literal(value,candidate.region)||literal(value,stateNames[candidate.region]??'__unknown__')))
  &&! /\b(?:utility|vendor|testimonial|customer review|powered by|web design)\b/iu.test(value)
  &&(literal(value,candidate.firmName)||/\b(?:we (?:serve|manage|provide)|our service area)\b/iu.test(value))
  &&/\b(?:serve|service|manag|office)/iu.test(value);
}
