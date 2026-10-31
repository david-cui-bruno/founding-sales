import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import type {SourceObservation} from '@fss/contracts';
import {buildPreparedCapture,validatePreparedCapture,preparedCaptureAuthority} from '../../sourcing/preparedCapture.ts';
import type {ManualPhoneSnapshot} from '../../sourcing/manualProspectPhone.ts';
const candidateId='10000000-0000-4000-8000-000000000001',observationId='10000000-0000-4000-8000-000000000002';
function fixture(){
 const sourceUrl='https://capture.example.test/old',middle='https://www.capture.example.test/new',url='https://www.capture.example.test/services';
 const blocks=[{id:'body',text:'Our company manages residential homes and coordinates tenant maintenance requests.'}];
 const source:SourceObservation={id:observationId,url,contentHash:'a'.repeat(64),relevantTextHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex'),retrievedAt:'2026-10-31T01:00:00.000Z',publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks};
 const binding={candidateId,candidateRevision:1,sourceUrl},urls=[sourceUrl,middle,url];
 const manifest=buildPreparedCapture(binding,[{source,trace:{version:'page-redirect-trace-v1',urls}}]);if(!manifest)throw Error('fixture capture missing');
 return {source,binding,urls,manifest};
}
it('requires an actual paired primary trace and preserves v1 same-origin slash-only rules',()=>{
 const f=fixture();expect(f.manifest.version).toBe('prepared-source-association-v2');
 expect(buildPreparedCapture(f.binding,[{source:f.source,trace:undefined}])).toBeNull();
 expect(buildPreparedCapture(f.binding,[{source:f.source,trace:{version:'page-redirect-trace-v1',urls:f.urls}}],'prepared-source-association-v1')).toBeNull();
 expect(validatePreparedCapture({...f.manifest,version:'prepared-source-association-v1'},{...f.binding,observations:[f.source]})).toBeNull();
});
it.each([
 ['wrong primary',['https://capture.example.test/different','https://www.capture.example.test/services']],
 ['wrong final',['https://capture.example.test/old','https://capture.example.test/elsewhere']],
 ['offsite',['https://capture.example.test/old','https://another.example.test/','https://www.capture.example.test/services']],
 ['subdomain',['https://capture.example.test/old','https://mail.capture.example.test/','https://www.capture.example.test/services']],
 ['loop',['https://capture.example.test/old','https://www.capture.example.test/new','https://capture.example.test/old','https://www.capture.example.test/services']],
 ['query',['https://capture.example.test/old','https://www.capture.example.test/new?token=fictional','https://www.capture.example.test/services']],
 ['fragment',['https://capture.example.test/old','https://www.capture.example.test/new#section','https://www.capture.example.test/services']],
 ['http',['https://capture.example.test/old','http://www.capture.example.test/new','https://www.capture.example.test/services']],
 ['untraced auxiliary',['https://capture.example.test/contact','https://www.capture.example.test/services']],
] as const)('rejects %s without inventing an association',(_name,urls)=>{
 const f=fixture();expect(validatePreparedCapture({...f.manifest,pages:[{...f.manifest.pages[0]!,redirectUrls:[...urls]}]},{...f.binding,observations:[f.source]})).toBeNull();
});
it('requires current prepared-specific all-hop source authority and exact hashes in addition to stored trace metadata',()=>{
 const f=fixture(),snapshot:ManualPhoneSnapshot={id:candidateId,candidate_id:candidateId,candidate_revision:1,payload:{firmName:'Fixture',website:'https://capture.example.test/',sourceUrl:f.binding.sourceUrl,locality:'Boston',region:'MA',signal:'fit_only',evidence:'Fictional',observedOn:'2026-10-30',preparedBy:'Fixture'},observations:[f.source],facts:[],permitted_urls:[],capture_policy_version:'prepared-source-association-v2',capture_state:'unavailable',prepared_capture:f.manifest};
 expect([...preparedCaptureAuthority(snapshot).observationIds]).toEqual([]);
 snapshot['prepared_capture_authority']={dependencyUrls:[...f.urls].sort(),denied:false,validUntil:'2026-11-01T01:00:00.000Z'};
 expect(preparedCaptureAuthority(snapshot)).toMatchObject({observationIds:new Set([observationId]),dependencyUrls:[...f.urls].sort(),validUntil:'2026-11-01T01:00:00.000Z'});
 snapshot['prepared_capture_authority']={dependencyUrls:[...f.urls].sort(),denied:true,validUntil:null};expect([...preparedCaptureAuthority(snapshot).observationIds]).toEqual([]);
 snapshot['prepared_capture_authority']={dependencyUrls:[...f.urls].sort(),denied:false,validUntil:null};f.source.blocks[0]!.text+=' changed';expect([...preparedCaptureAuthority(snapshot).observationIds]).toEqual([]);
});
