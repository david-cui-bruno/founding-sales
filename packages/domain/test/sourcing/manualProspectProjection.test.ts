import {expect,it} from 'vitest';
import {discoveryIntakeSaveInputSchema} from '@fss/contracts';
import {projectManualProspect,safeManualReference} from '../../sourcing/manualProspectProjection.ts';
import {manualDiscoveryFixture} from './support/manualProspectFixture.ts';
it('preserves every mandatory notice across the full sixteen-origin retained contract',()=>{
 const fixture=manualDiscoveryFixture(),first=fixture.origins[0]!;
 const origins=Array.from({length:16},(_,i)=>({...first,source:{...first.source,recordId:`notice-origin-${i}`},
  licenses:Array.from({length:16},(_,j)=>`License ${i}:${j}`),notices:Array.from({length:16},(_,j)=>({label:`Notice ${i}:${j}`,url:`https://source.example.test/license/${i}/${j}`,sha256:'a'.repeat(64)}))}));
 const input=discoveryIntakeSaveInputSchema.parse({row:{...fixture.row,source:origins[0]!.source,observations:origins.map(origin=>origin.source)},origins});
 const result=projectManualProspect({id:'00000000-0000-4000-8000-000000000001',revision:1,created_at:new Date('2026-10-24T00:00:00Z'),manual_state:'new',duplicate_count:0,payload:{kind:'discovery-v1',row:input.row},origins:input.origins});
 expect(result?.sourceNotices).toHaveLength(512);expect(result?.sources).toHaveLength(16);
 expect(result?.sourceNotices.at(-1)).toEqual({label:'Notice 15:15',url:'https://source.example.test/license/15/15'});
});
it('never makes unsafe or credential-bearing retained references navigable',()=>{
 for(const value of ['javascript:alert(1)','data:text/html,body','https://secret@example.test/','https://u:p@example.test/','not a URL'])expect(safeManualReference(value)).toBeNull();
 expect(safeManualReference('https://example.test/CaseSensitive')).toBe('https://example.test/CaseSensitive');
});
it('775 composes explicit retained absence without losing changed scan uncertainty or competing literals',()=>{
 const fixture=manualDiscoveryFixture(),row={id:'00000000-0000-4000-8000-000000000001',revision:1,created_at:new Date('2026-10-24T00:00:00Z'),manual_state:'new',duplicate_count:0,payload:{kind:'discovery-v1',row:{...fixture.row,officePhoneEvidence:'absent'}},origins:fixture.origins};
 expect(projectManualProspect(row)?.phoneEvidence).toMatchObject({state:'absent'});
 expect(projectManualProspect(row,{state:'not_extracted',reason:'optional_source_changed',coverage:{parser:'manual-literal-phone-v1',state:'changed',observations:0,blocks:0}})?.phoneEvidence).toMatchObject({state:'not_extracted',coverage:{state:'changed'}});
 expect(projectManualProspect(row,{state:'conflicting',reason:'unresolved_retained_literal',sources:[],coverage:{parser:'manual-literal-phone-v1',state:'complete',observations:1,blocks:1}})?.phoneEvidence).toMatchObject({state:'conflicting',coverage:{state:'complete'}});
});
