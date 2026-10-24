import type {ManualProspect} from '@fss/contracts';
import {discoveryFirmName,isDiscoveryDirectory} from './discoveryIdentity.ts';

/** Navigational suggestions over retained names only, never a canonical identity. */
export function manualProspectPresentation(name:string,website:string|null):NonNullable<ManualProspect['presentation']>{
 let safe:string|null=null;
 try{if(website){const url=new URL(website);if(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password)safe=url.href;}}catch{/* Invalid retained sites do not establish identity. */}
 const label=discoveryFirmName(name,safe??'https://unknown.invalid/');
 const nonCompany=/\b(?:certificate|degree|university|department of|housing authority|directory|top \d+|best \d+|how to|guide to)\b/iu.test(name)
  ||(safe!==null&&(isDiscoveryDirectory(safe)||/\.gov\.?$/iu.test(new URL(safe).hostname)));
 const apparent=!nonCompany&&/\b(?:property management|property group|realty|rentals|PM|LLC|incorporated)\b/iu.test(label);
 return {label,basis:'retained_name',kind:nonCompany?'non_company':apparent?'apparent_company':'unresolved',
  reason:nonCompany?'Retained label or site suggests a directory, institution or informational page.':apparent?'Retained label suggests a business, not verified identity or fit.':'Retained label does not establish a company identity.'};
}
