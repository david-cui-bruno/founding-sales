import {qualificationEvidenceSchema,type SourceObservation,type QualificationFact} from '@fss/contracts';
import {randomUUID} from 'node:crypto';
import type {QualificationCandidateContext} from '../sourcing/qualificationCitationRoles.ts';
import {qualificationCitationRoles} from '../sourcing/qualificationCitationRoles.ts';
import {verifiedFirmEvidence} from '../sourcing/verifiedFirmPolicy.ts';
import {qualificationSelectionSchema} from '../sourcing/qualificationPrompt.ts';
import {parsePageText} from './pageText.ts';
import type {FetchedPage} from './providers.ts';
import type {OfficeSelection} from './officeAssessmentContract.ts';
import {OFFICE_FACT_BYTE_LIMIT,OFFICE_OBSERVATION_BYTE_LIMIT} from './officeAssessmentContract.ts';
import {OFFICE_SOURCE_MILLISECONDS} from './officeAssessmentContract.ts';
import {officeHash} from './officeAssessmentTarget.ts';
export function buildOfficeObservations(pages:readonly FetchedPage[]):SourceObservation[]|null {
 if(!pages.length||pages.length>8||new Set(pages.map(p=>p.url)).size!==pages.length)return null;
 const observations=pages.map(page=>{const parsed=parsePageText(page.body,page.contentType,{omitNavigation:true,includeArticles:true});return {id:randomUUID(),url:page.url,contentHash:page.contentHash,relevantTextHash:officeHash(JSON.stringify(parsed.blocks)),retrievedAt:page.retrievedAt,publishedAt:null,publishedAtBlockId:null,firstParty:page.firstParty,truncated:parsed.truncated,blocks:[...parsed.blocks]};});
 return validOfficeProof(observations,[])?observations:null;
}
export function validOfficeProof(observations:readonly SourceObservation[],facts:readonly QualificationFact[]):boolean {
 return qualificationEvidenceSchema.safeParse({observations,facts}).success&&observations.length>0&&observations.every(s=>s.firstParty&&!s.truncated&&s.relevantTextHash===officeHash(JSON.stringify(s.blocks)))
 && Buffer.byteLength(JSON.stringify(observations))<=OFFICE_OBSERVATION_BYTE_LIMIT&&Buffer.byteLength(JSON.stringify(facts))<=OFFICE_FACT_BYTE_LIMIT
 && facts.every(f=>observations.find(s=>s.id===f.observationId)?.blocks.find(b=>b.id===f.blockId)?.text===f.value);
}
/** Completeness applies to every fetched source, not just selected citations. */
export function currentOfficeSources(candidate:QualificationCandidateContext,observations:readonly SourceObservation[],now:string):boolean {
 const host=(url:string)=>{try{return new URL(url).hostname.toLowerCase().replace(/^www\./u,'');}catch{return null;}};
 const expected=host(candidate.website),time=Date.parse(now);
 return !!expected&&Number.isFinite(time)&&validOfficeProof(observations,[])&&observations.every(source=>host(source.url)===expected&&Date.parse(source.retrievedAt)<=time&&time<Date.parse(source.retrievedAt)+OFFICE_SOURCE_MILLISECONDS);
}
export function reconstructOfficeSelections(candidate:QualificationCandidateContext,observations:readonly SourceObservation[],selections:readonly OfficeSelection[]):QualificationFact[]|null {
 if(!qualificationSelectionSchema.safeParse({selections,openingQuestion:null}).success)return null;
 const facts:QualificationFact[]=[];
 for(const selected of selections){const block=observations.find(s=>s.id===selected.observationId)?.blocks.find(b=>b.id===selected.blockId);if(!block||block.text.length>2000)return null;facts.push({...selected,value:block.text});}
 if(!validOfficeProof(observations,facts))return null;
 const roles=qualificationCitationRoles(candidate,facts,observations);
 return roles.ok?roles.facts:null;
}
export function evaluateOfficeAssessment(candidate:QualificationCandidateContext,observations:readonly SourceObservation[],facts:readonly QualificationFact[],endpointHash:string,now:string):{result:'supported'|'pending'|'unclear';reason:string|null}{
 if(!validOfficeProof(observations,facts)||!currentOfficeSources(candidate,observations,now))return {result:'pending',reason:'invalid_evidence'};
 const roles=qualificationCitationRoles(candidate,facts,observations);
 if(!roles.ok)return {result:'pending',reason:'invalid_evidence'};
 const verified=verifiedFirmEvidence({candidate,observations,facts:roles.facts,now});
 if(verified.kind!=='verified')return {result:verified.kind,reason:verified.reason};
 if(!verified.phone)return {result:'pending',reason:'office_phone_unproven'};
 return officeHash(verified.phone)===endpointHash?{result:'supported',reason:null}:{result:'unclear',reason:'route_phone_mismatch'};
}
