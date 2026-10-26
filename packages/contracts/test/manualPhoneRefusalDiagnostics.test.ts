import {expect,it} from 'vitest';
import {manualProspectPhoneEvidenceSchema} from '../src/index.ts';
const entry={reason:'unattached_label_content',runId:'00000000-0000-4000-8000-000000000001',observationId:'00000000-0000-4000-8000-000000000002',blockId:'retained',url:'https://phone.example.test/contact',retrievedAt:'2026-10-26T20:00:00.000Z',contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),parser:'manual-literal-phone-v1',label:'Phone',labelStart:3,labelEnd:8,authority:{kind:'candidate_source',sourceUrl:'https://phone.example.test/contact'},lineage:{kind:'provider_original'}};
const phone={state:'conflicting',reason:'unresolved_retained_literal',sources:[],diagnostics:{entries:[entry],truncated:false}};
it('accepts only closed bounded refusal locations on conflicting evidence',()=>{
 expect(manualProspectPhoneEvidenceSchema.safeParse(phone).success).toBe(true);
 for(const invalid of [
  {...phone,diagnostics:{entries:Array.from({length:17},()=>entry),truncated:true}},
  {...phone,diagnostics:{entries:[entry]}},
  {...phone,diagnostics:{entries:[{...entry,labelEnd:9}],truncated:false}},
  {...phone,diagnostics:{entries:[{...entry,reason:'arbitrary_explanation'}],truncated:false}},
  {...phone,diagnostics:{entries:[{...entry,normalizedValue:'+12145550123'}],truncated:false}},
  {...phone,diagnostics:{entries:[{...entry,prose:'original text'}],truncated:false}},
  {...phone,state:'observed',value:'+12145550123'},
 ])expect(manualProspectPhoneEvidenceSchema.safeParse(invalid).success).toBe(false);
});
