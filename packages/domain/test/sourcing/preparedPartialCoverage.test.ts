import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {preparedProspectBriefSchema,type CandidateInput,type SourceObservation} from '@fss/contracts';
import {projectPreparedProspect} from '../../sourcing/preparedProspectProjection.ts';
import type {ManualProspectRow} from '../../sourcing/manualProspectProjection.ts';
import type {ManualPhoneSnapshot} from '../../sourcing/manualProspectPhone.ts';
import {parsePageText} from '../../research/pageText.ts';
import {residentialFacts} from './support/modelSelections.ts';

const id='20000000-0000-4000-8000-000000000001',run='20000000-0000-4000-8000-000000000002',pageId='20000000-0000-4000-8000-000000000003';
const description='Cedar Property Management manages residential homes for owners across Boston, Massachusetts.';
function fixture(){
 const now=Date.parse('2026-10-31T05:00:00Z'),website='https://cedar.example.test/';
 const payload:CandidateInput={firmName:'Home | Cedar',website,sourceUrl:website,locality:'Boston',region:'MA',signal:'fit_only',evidence:'Fictional public-business discovery',observedOn:'2026-10-31',preparedBy:'Controlled partial coverage'};
 const parsed=parsePageText(new TextEncoder().encode('<p>'+description+'</p>'+'<p>Additional source context.</p>'.repeat(100)),'text/html',{omitNavigation:true,includeArticles:true});
 const source:SourceObservation={id:pageId,url:website,blocks:[...parsed.blocks],contentHash:'a'.repeat(64),relevantTextHash:'',retrievedAt:new Date(now-1000).toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:parsed.truncated};
 const row:ManualProspectRow={id,revision:1,payload,origins:[],created_at:new Date(now-2000),manual_state:'new',duplicate_count:0};
 const snapshot:ManualPhoneSnapshot={id:run,candidate_id:id,candidate_revision:1,payload,origins:[],observations:[source],facts:residentialFacts([source]),permitted_urls:[website]};
 const rehash=()=>{source.relevantTextHash=createHash('sha256').update(JSON.stringify(source.blocks)).digest('hex');};rehash();
 const read=(expirations:ReadonlyMap<string,number>=new Map())=>projectPreparedProspect(row,snapshot,{id:run,candidate_revision:1},now,expirations)!;
 return {source,row,snapshot,now,website,read,rehash};
}

it('shows intact positive blocks from a genuinely bounded page with explicit partial coverage',()=>{
 const f=fixture();expect(f.source.truncated).toBe(true);expect(f.source.blocks).toHaveLength(100);
 const brief=preparedProspectBriefSchema.parse(f.read());
 expect(brief).toMatchObject({state:'prepared',policyVersion:'prepared-prospect-v2',coverage:'partial_retained_pages',contactAuthority:'not_granted'});
 expect(brief.passages).toContainEqual(expect.objectContaining({kind:'business',quote:description,sourceCoverage:'partial_page',observationId:pageId,blockId:'b1'}));
 expect(brief.unknowns.join(' ')).toMatch(/omitted|incomplete/iu);
 expect(brief.unknowns.join(' ')).not.toMatch(/no current (?:contact|named buyer).*available/iu);
});

it('keeps known contrary context from partial pages and its earliest source deadline',()=>{
 const f=fixture();f.source.blocks=[{id:'positive',text:description},{id:'contrary',text:'We do not manage residential homes. Our company serves commercial owners only.'}];f.rehash();
 const brief=f.read(new Map([[f.website,f.now+1000]]));
 expect(brief).toMatchObject({state:'needs_research',coverage:'partial_retained_pages',validUntil:new Date(f.now+1000).toISOString()});
 expect(brief.passages).toContainEqual(expect.objectContaining({kind:'contrary',sourceCoverage:'partial_page'}));
});

it('does not lose over-bound contrary text from the assessment when a page is partial',()=>{
 const f=fixture();f.source.blocks=[{id:'positive',text:description},{id:'oversized',text:'We do not manage residential homes. '+'Additional scope explanation. '.repeat(100)}];f.rehash();
 expect(f.read()).toMatchObject({state:'needs_research'});expect(f.read().unknowns.join(' ')).toMatch(/contrary wording exceeds/iu);
});

it.each(['denied','wrong_hash','future','duplicate_ids','expired'] as const)('keeps the source fence for partial-page context: %s',reason=>{
 const f=fixture();let expiry=new Map<string,number>();
 if(reason==='denied')f.snapshot.permitted_urls=[];
 if(reason==='wrong_hash')f.source.relevantTextHash='f'.repeat(64);
 if(reason==='future')f.source.retrievedAt=new Date(f.now+1).toISOString();
 if(reason==='duplicate_ids')f.snapshot.observations=[f.source,f.source];
 if(reason==='expired')expiry=new Map([[f.website,f.now]]);
 expect(f.read(expiry)).toMatchObject({state:'needs_research',coverage:'no_usable_retained_pages',passages:[]});
});
