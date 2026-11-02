import {currentPreparedCandidateInputSchema,discoveryCandidatePayloadSchema,type CandidateInput} from '@fss/contracts';
import {US_BUSINESS_REGIONS} from '../../contracts/src/usBusinessGeography.ts';

/** ADR0034: a raw Overture observation with its own website is researched as the ordinary seed it implies. The seed is
 * only ever built in memory (the stored candidate keeps its raw payload) and is not authority beyond own-site research:
 * the website is the only source and an http reference is read as https. A bare host is not a website reference here, as in manual projection. */
export const DISCOVERY_RESEARCH_PREPARED_BY='Overture Maps place · not verified';
export function discoveryResearchSeed(value:unknown):CandidateInput|null {
 const raw=discoveryCandidatePayloadSchema.safeParse(value);if(!raw.success)return null;
 const row=raw.data.row,site=row.website?.trim();
 if(!site||!/^https?:\/\//iu.test(site))return null;
 // The fetcher records pages by their normalized href; the seed names the landing page the same way.
 let website:string;try{const url=new URL(site.replace(/^http:/iu,'https:'));url.hash='';website=url.href;}catch{return null;}
 const seed=currentPreparedCandidateInputSchema.safeParse({firmName:row.firmName,website,locality:row.locality??'',region:row.region??'',signal:'fit_only',
  evidence:'Overture Maps place record; the company, website and place are not independently verified.',sourceUrl:website,observedOn:(row.source.retrievedAt??row.source.release).slice(0,10),preparedBy:DISCOVERY_RESEARCH_PREPARED_BY});
 return seed.success?seed.data:null;
}
/** The payload qualification reads: an ordinary prepared candidate, or the research seed of a raw Overture observation. */
export function preparedCandidatePayload(value:unknown):CandidateInput|null {
 const ordinary=currentPreparedCandidateInputSchema.safeParse(value);
 return ordinary.success?ordinary.data:discoveryResearchSeed(value);
}
/** Scheduling predicate for `discoveryResearchSeed` (alias = sourcing_candidates). It must not admit a row the seed refuses,
 * or a refused row would keep its place at the head of the never-researched queue. A manually skipped row is left alone. */
export const discoveryResearchEligibleSql=(c:string)=>`(${c}.payload->>'kind'='discovery-v1' AND ${c}.status='needs_review'
 AND btrim(${c}.payload->'row'->>'website') ~* '^https?://([a-z0-9-]+[.])+[a-z]{2,}(/[^[:space:]]*)?$'
 AND NOT btrim(${c}.payload->'row'->>'website') ~* '^https?://[^/]*[.](local|internal|localhost)(/|$)' AND char_length(btrim(${c}.payload->'row'->>'website'))<=490
 AND char_length(btrim(${c}.payload->'row'->>'locality')) BETWEEN 1 AND 120
 AND ${c}.payload->'row'->>'region' IN (${US_BUSINESS_REGIONS.map(region=>`'${region}'`).join(',')})
 AND (${c}.payload->'row'->'source'->>'retrievedAt' IS NOT NULL OR ${c}.payload->'row'->'source'->>'release' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}')
 AND NOT EXISTS(SELECT 1 FROM sourcing_manual_prospect_states skipped WHERE skipped.workspace_id=${c}.workspace_id AND skipped.candidate_id=${c}.id AND skipped.state='skipped'))`;
/** One company, one research: the candidate that stands for each company host in workspace $1 (companyHost: lowercase, no www.), so
 * David is not given two briefs for one company. Order: a kept or Tavily candidate, then an Overture place that already has a run,
 * then the earliest place that would otherwise be scheduled. A place that is not its host's winner is not due. */
export const DISCOVERY_RESEARCH_WINNERS_CTE=`winners AS MATERIALIZED (SELECT DISTINCT ON (host) id FROM (
 SELECT o.id,o.created_at,CASE WHEN o.payload->>'kind' IS DISTINCT FROM 'discovery-v1' THEN 0 WHEN EXISTS(SELECT 1 FROM sourcing_qualification_runs q WHERE q.workspace_id=o.workspace_id AND q.candidate_id=o.id) THEN 1 ELSE 2 END AS rank,
  regexp_replace(regexp_replace(lower(substring(btrim(CASE WHEN o.payload->>'kind'='discovery-v1' THEN o.payload->'row'->>'website' ELSE o.payload->>'website' END) from '^[A-Za-z]+://([^/?#:@]+)')),'[.]$',''),'^www[.]','') AS host
 FROM sourcing_candidates o WHERE o.workspace_id=$1 AND o.status<>'dismissed' AND (
  (o.payload->>'kind' IS DISTINCT FROM 'discovery-v1' AND (o.status='kept' OR o.payload->>'preparedBy'='Tavily Basic search · not verified'))
  OR (o.payload->>'kind'='discovery-v1' AND (EXISTS(SELECT 1 FROM sourcing_qualification_runs q WHERE q.workspace_id=o.workspace_id AND q.candidate_id=o.id) OR ${discoveryResearchEligibleSql('o')})))
) hosts WHERE host IS NOT NULL ORDER BY host,rank,created_at,id)`;
