import {createHash} from 'node:crypto';
import {z} from 'zod';
import {candidateInputSchema,sourceObservationSchema,sourcingUrlSchema,instant,uuid,type SourceObservation} from '@fss/contracts';
import type {FetchedPage} from '../research/providers.ts';
import {isPublicResearchUrl} from '../research/sourcePolicy.ts';
import type {ManualPhoneSnapshot} from './manualProspectPhone.ts';

export const PREPARED_CAPTURE_POLICY='prepared-source-association-v1';
const digest=z.string().regex(/^[a-f0-9]{64}$/u);
const captureTime=instant.refine(value=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value));
const pageSchema=z.strictObject({observationId:uuid,url:sourcingUrlSchema,contentHash:digest,relevantTextHash:digest,retrievedAt:captureTime,redirectUrls:z.array(sourcingUrlSchema).min(2).max(6)});
const manifestSchema=z.strictObject({version:z.literal(PREPARED_CAPTURE_POLICY),candidateId:uuid,candidateRevision:z.number().int().positive(),sourceUrl:sourcingUrlSchema,pages:z.array(pageSchema).min(1).max(8)});
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

/** Strict binding is independent of model facts and cannot repair old captures. */
export function validatePreparedCapture(value:unknown,binding:PreparedCaptureBinding):PreparedCapture|null {
 const parsed=manifestSchema.safeParse(value);if(!parsed.success)return null;
 const manifest=parsed.data;
 if(Buffer.byteLength(JSON.stringify(manifest))>32768||manifest.candidateId!==binding.candidateId||manifest.candidateRevision!==binding.candidateRevision||manifest.sourceUrl!==binding.sourceUrl||new Set(manifest.pages.map(p=>p.observationId)).size!==manifest.pages.length||new Set(binding.observations.map(p=>p.id)).size!==binding.observations.length)return null;
 for(const page of manifest.pages){
  const source=binding.observations.find(p=>p.id===page.observationId);
  if(!source||!sourceObservationSchema.safeParse(source).success||!source.firstParty||page.url!==source.url||page.contentHash!==source.contentHash||page.relevantTextHash!==source.relevantTextHash||page.retrievedAt!==source.retrievedAt||createHash('sha256').update(JSON.stringify(source.blocks)).digest('hex')!==source.relevantTextHash||!slashRedirects(page.redirectUrls,manifest.sourceUrl,page.url))return null;
 }
 return manifest;
}

/** The caller pairs each newly parsed observation with the adapter page that
 * supplied its bytes. Metadata stays outside observations and model inputs. */
export function buildPreparedCapture(binding:Omit<PreparedCaptureBinding,'observations'>,pages:readonly {source:SourceObservation;trace:FetchedPage['redirectTrace']}[]):PreparedCapture|null {
 const matched=pages.flatMap(({source,trace})=>trace?.version==='page-redirect-trace-v1'&&source.firstParty&&slashRedirects(trace.urls,binding.sourceUrl,source.url)?[{observationId:source.id,url:source.url,contentHash:source.contentHash,relevantTextHash:source.relevantTextHash,retrievedAt:source.retrievedAt,redirectUrls:[...trace.urls]}]:[]);
 if(!matched.length)return null;
 return validatePreparedCapture({version:PREPARED_CAPTURE_POLICY,...binding,pages:matched},{...binding,observations:pages.map(p=>p.source)});
}

/** Only the prepared projection consumes these grants. The shared phone/native/
 * email authority resolver remains exact and does not inspect this manifest. */
export function preparedCaptureObservationIds(snapshot:ManualPhoneSnapshot):ReadonlySet<string> {
 if(snapshot['capture_policy_version']!==PREPARED_CAPTURE_POLICY||!['review','unavailable','eligible','admitted'].includes(String(snapshot['capture_state']))||snapshot.retained_identity_decision_id)return new Set();
 const candidate=candidateInputSchema.safeParse(snapshot.payload);
 if(!candidate.success||!Array.isArray(snapshot.observations))return new Set();
 const parsed=snapshot.observations.map(value=>sourceObservationSchema.safeParse(value));
 if(parsed.some(value=>!value.success))return new Set();
 const observations=parsed.flatMap(value=>value.success?[value.data]:[]);
 const manifest=validatePreparedCapture(snapshot['prepared_capture'],{candidateId:snapshot.candidate_id,candidateRevision:snapshot.candidate_revision,sourceUrl:candidate.data.sourceUrl,observations});
 /* permitted_urls has been freshly re-read under the existing candidate/run and
 * evidence locks. Its per-page loss/expiry vetoes cover every recorded slash hop,
 * not just the final URL, because their raw rtrim groups must be identical above. */
 return new Set(manifest?.pages.filter(page=>snapshot.permitted_urls.includes(page.url)).map(page=>page.observationId)??[]);
}
