import {createHash} from 'node:crypto';
import {z} from 'zod';
import {candidateInputSchema,sourceObservationSchema,sourcingUrlSchema,instant,uuid,type SourceObservation} from '@fss/contracts';
import type {FetchedPage} from '../research/providers.ts';
import {isPublicResearchUrl,isSameResearchSite,ownSitePageKind} from '../research/sourcePolicy.ts';
import type {ManualPhoneSnapshot} from './manualProspectPhone.ts';

export const PREPARED_CAPTURE_V1='prepared-source-association-v1';
export const PREPARED_CAPTURE_POLICY='prepared-source-association-v2';
export type PreparedCapturePolicy=typeof PREPARED_CAPTURE_V1|typeof PREPARED_CAPTURE_POLICY;
export const isPreparedCapturePolicy=(value:unknown):value is PreparedCapturePolicy=>value===PREPARED_CAPTURE_V1||value===PREPARED_CAPTURE_POLICY;
const digest=z.string().regex(/^[a-f0-9]{64}$/u);
const captureTime=instant.refine(value=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value));
const pageSchema=z.strictObject({observationId:uuid,url:sourcingUrlSchema,contentHash:digest,relevantTextHash:digest,retrievedAt:captureTime,redirectUrls:z.array(sourcingUrlSchema).min(2).max(6)});
const manifestSchema=z.strictObject({version:z.enum([PREPARED_CAPTURE_V1,PREPARED_CAPTURE_POLICY]),candidateId:uuid,candidateRevision:z.number().int().positive(),sourceUrl:sourcingUrlSchema,pages:z.array(pageSchema).min(1).max(8)});
export type PreparedCapture=z.infer<typeof manifestSchema>;
export interface PreparedCaptureBinding {candidateId:string;candidateRevision:number;sourceUrl:string;observations:readonly SourceObservation[]}

/** An actual redirect supplies the association. Similar URLs alone never do.
 * This first policy accepts only a single slash addition/removal on the SAME
 * origin. Every dependency shares the existing conservative rtrim denial group. */
function slashRedirects(urls:readonly string[],sourceUrl:string,finalUrl:string):boolean {
 if(urls.length<2||urls.length>6||urls[0]!==sourceUrl||urls.at(-1)!==finalUrl||new Set(urls).size!==urls.length)return false;
 for(let i=0;i<urls.length;i++){
  const value=urls[i]!;if(!isPublicResearchUrl(value))return false;
  if(i===0)continue;
  const prior=urls[i-1]!;
  if(new URL(prior).origin!==new URL(value).origin||prior===value||prior.replace(/\/$/u,'')!==value.replace(/\/$/u,''))return false;
 }
 return true;
}
function tracedRedirects(urls:readonly string[],sourceUrl:string,finalUrl:string,policy:PreparedCapturePolicy):boolean {
 if(policy===PREPARED_CAPTURE_V1)return slashRedirects(urls,sourceUrl,finalUrl);
 return urls.length>=2&&urls.length<=6&&urls[0]===sourceUrl&&urls.at(-1)===finalUrl&&new Set(urls).size===urls.length&&urls.every(url=>isPublicResearchUrl(url)&&isSameResearchSite(sourceUrl,url));
}

/** Strict binding is independent of model facts and cannot repair old captures. */
export function validatePreparedCapture(value:unknown,binding:PreparedCaptureBinding):PreparedCapture|null {
 const parsed=manifestSchema.safeParse(value);if(!parsed.success)return null;
 const manifest=parsed.data;
 if(Buffer.byteLength(JSON.stringify(manifest))>32768||manifest.candidateId!==binding.candidateId||manifest.candidateRevision!==binding.candidateRevision||manifest.sourceUrl!==binding.sourceUrl||new Set(manifest.pages.map(p=>p.observationId)).size!==manifest.pages.length||new Set(binding.observations.map(p=>p.id)).size!==binding.observations.length)return null;
 for(const page of manifest.pages){
  const source=binding.observations.find(p=>p.id===page.observationId);
  if(!source||!sourceObservationSchema.safeParse(source).success||!source.firstParty||page.url!==source.url||page.contentHash!==source.contentHash||page.relevantTextHash!==source.relevantTextHash||page.retrievedAt!==source.retrievedAt||createHash('sha256').update(JSON.stringify(source.blocks)).digest('hex')!==source.relevantTextHash||!tracedRedirects(page.redirectUrls,manifest.sourceUrl,page.url,manifest.version))return null;
 }
 return manifest;
}

/** The caller pairs each newly parsed observation with the adapter page that
 * supplied its bytes. Metadata stays outside observations and model inputs.
 * V2 also associates at most one contact, about and team page that the traced landing
 * page itself linked to (ADR0034): its lineage is the landing page's request chain from
 * the exact source followed by the linked page's own chain, so every URL the association
 * depends on keeps its own loss/expiry/denial check. Any other auxiliary page stays unassociated. */
export function buildPreparedCapture(binding:Omit<PreparedCaptureBinding,'observations'>,pages:readonly {source:SourceObservation;trace:FetchedPage['redirectTrace'];linkedFrom?:string|undefined}[],policy:PreparedCapturePolicy=PREPARED_CAPTURE_POLICY):PreparedCapture|null {
 const traced=(urls:readonly string[]|undefined,url:string)=>urls!==undefined&&urls[0]===binding.sourceUrl&&urls.at(-1)===url;
 const kinds=new Set<string>();
 const matched=pages.flatMap(({source,trace,linkedFrom})=>{
  if(trace?.version!=='page-redirect-trace-v1'||!source.firstParty)return [];
  let urls:readonly string[]=trace.urls;
  if(policy===PREPARED_CAPTURE_POLICY&&linkedFrom!==undefined){
   const landing=pages.find(page=>page.source.url===linkedFrom&&page.linkedFrom===undefined&&page.source.firstParty&&traced(page.trace?.urls,linkedFrom));
   const kind=ownSitePageKind(source.url);
   if(!landing||kind===null||kinds.has(kind))return [];
   urls=[...landing.trace!.urls,...trace.urls];
   if(!tracedRedirects(urls,binding.sourceUrl,source.url,policy))return [];
   kinds.add(kind);
  }
  return tracedRedirects(urls,binding.sourceUrl,source.url,policy)?[{observationId:source.id,url:source.url,contentHash:source.contentHash,relevantTextHash:source.relevantTextHash,retrievedAt:source.retrievedAt,redirectUrls:[...urls]}]:[];
 });
 if(!matched.length)return null;
 return validatePreparedCapture({version:policy,...binding,pages:matched},{...binding,observations:pages.map(p=>p.source)});
}

/** Only the prepared projection consumes these grants. The shared phone/native/
 * email authority resolver remains exact and does not inspect this manifest. */
export function preparedCaptureManifest(snapshot:ManualPhoneSnapshot):PreparedCapture|null {
 if(!isPreparedCapturePolicy(snapshot['capture_policy_version'])||!['review','unavailable','eligible','admitted'].includes(String(snapshot['capture_state']))||snapshot.retained_identity_decision_id)return null;
 const candidate=candidateInputSchema.safeParse(snapshot.payload);
 if(!candidate.success||!Array.isArray(snapshot.observations))return null;
 const parsed=snapshot.observations.map(value=>sourceObservationSchema.safeParse(value));
 if(parsed.some(value=>!value.success))return null;
 const observations=parsed.flatMap(value=>value.success?[value.data]:[]);
 const manifest=validatePreparedCapture(snapshot['prepared_capture'],{candidateId:snapshot.candidate_id,candidateRevision:snapshot.candidate_revision,sourceUrl:candidate.data.sourceUrl,observations});
 return manifest?.version===snapshot['capture_policy_version']?manifest:null;
}
export interface PreparedCaptureAuthority {observationIds:ReadonlySet<string>;dependencyUrls:readonly string[];validUntil:string|null}
/** V2 depends on the prepared store's repeated live source checks, never the
 * shared exact authority resolver or a website-host assertion. */
export function preparedCaptureAuthority(snapshot:ManualPhoneSnapshot):PreparedCaptureAuthority {
 const none={observationIds:new Set<string>(),dependencyUrls:[],validUntil:null},manifest=preparedCaptureManifest(snapshot);if(!manifest)return none;
 const dependencyUrls=[...new Set(manifest.pages.flatMap(page=>page.redirectUrls))].sort();
 if(manifest.version===PREPARED_CAPTURE_POLICY){
  const current=snapshot['prepared_capture_authority'] as {dependencyUrls?:unknown;denied?:unknown;validUntil?:unknown}|undefined;
  if(!current||JSON.stringify(current.dependencyUrls)!==JSON.stringify(dependencyUrls)||current.denied!==false||!(current.validUntil===null||typeof current.validUntil==='string'&&Number.isFinite(Date.parse(current.validUntil))))return none;
  return {observationIds:new Set(manifest.pages.map(page=>page.observationId)),dependencyUrls,validUntil:current.validUntil};
 }
 /* permitted_urls has been freshly re-read under the existing candidate/run and
 * evidence locks. Its per-page loss/expiry vetoes cover every recorded slash hop,
 * not just the final URL, because their raw rtrim groups must be identical above. */
 return {observationIds:new Set(manifest.pages.filter(page=>snapshot.permitted_urls.includes(page.url)).map(page=>page.observationId)),dependencyUrls,validUntil:null};
}
export const preparedCaptureObservationIds=(snapshot:ManualPhoneSnapshot):ReadonlySet<string>=>preparedCaptureAuthority(snapshot).observationIds;
