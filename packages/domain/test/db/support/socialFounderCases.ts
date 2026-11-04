import {randomUUID} from 'node:crypto';
import type {SessionQueryable} from '../../../db/queryable.ts';
import type {TwoWorkspaces} from './fixtures.ts';
type Fixture={session:SessionQueryable;seeded:TwoWorkspaces};
const missing='00000000-0000-4000-8000-000000000163';
const founderRow=(f:Fixture)=>({workspace_id:f.seeded.alpha.workspaceId,owner_user_id:f.seeded.alpha.admin.userId,id:randomUUID(),revision:1,bullets:'Fictional owner-supplied current college update.',context:'Actual fixture opinion.',experience_date:null,public_safe:true,created_at:'2026-11-01T00:00:00Z',expires_at:'2027-01-30T00:00:00Z'});
const examples=()=>JSON.stringify(Array.from({length:3},()=>({draftId:randomUUID(),revision:1})));
const calibrationRow=(f:Fixture)=>({workspace_id:f.seeded.alpha.workspaceId,owner_user_id:f.seeded.alpha.admin.userId,id:randomUUID(),examples:examples(),guide_ref:null});
async function insert(f:Fixture,table:'social_founder_inputs'|'social_founder_calibrations',row:Record<string,unknown>){const keys=Object.keys(row);return f.session.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));}
const badInput=(constraint:string,patch:Record<string,unknown>)=>({constraint,run:(f:Fixture)=>insert(f,'social_founder_inputs',{...founderRow(f),...patch})});
const badCalibration=(constraint:string,patch:Record<string,unknown>)=>({constraint,run:(f:Fixture)=>insert(f,'social_founder_calibrations',{...calibrationRow(f),...patch})});
export const SOCIAL_FOUNDER_CONSTRAINT_CASES=[
 badInput('social_founder_inputs_workspace_id_fkey',{workspace_id:missing}),
 badInput('social_founder_inputs_workspace_id_owner_user_id_fkey',{owner_user_id:missing}),
 badInput('social_founder_inputs_revision_check',{revision:0}),
 badInput('social_founder_inputs_reason_check',{bullets:null,context:null,public_safe:false,reason:'published'}),
 badInput('social_founder_inputs_check',{expires_at:'2027-01-31T00:00:00Z'}),
 badInput('social_founder_inputs_check',{expires_at:'2026-11-01T00:00:00Z'}),
 badInput('social_founder_inputs_check1',{bullets:'   '}),
 badInput('social_founder_inputs_check1',{bullets:'x'.repeat(10001)}),
 badInput('social_founder_inputs_check1',{context:'x'.repeat(1001)}),
 badInput('social_founder_inputs_check1',{reason:'removed'}),
 badInput('social_founder_inputs_check1',{bullets:null,context:null,public_safe:true,reason:'removed'}),
 badInput('social_founder_inputs_check1',{bullets:null,context:null,experience_date:'2026-11-01',public_safe:false,reason:'removed'}),
 badInput('social_founder_inputs_check2',{bullets:'x'.repeat(9500),context:'x'.repeat(501)}),
 badInput('social_founder_inputs_experience_date_check',{experience_date:'not-a-date'}),
 {constraint:'social_founder_inputs_pkey',run:async(f:Fixture)=>{const row=founderRow(f);await insert(f,'social_founder_inputs',row);return insert(f,'social_founder_inputs',row);}},
 badCalibration('social_founder_calibrations_workspace_id_fkey',{workspace_id:missing}),
 badCalibration('social_founder_calibrations_workspace_id_owner_user_id_fkey',{owner_user_id:missing}),
 badCalibration('social_founder_calibrations_examples_check',{examples:'[]'}),
 badCalibration('social_founder_calibrations_examples_check',{examples:'[1,2,3]'}),
 badCalibration('social_founder_calibrations_examples_check',{examples:JSON.stringify(Array.from({length:3},()=>({draftId:missing,revision:1})))}),
 badCalibration('social_founder_calibrations_examples_check',{examples:JSON.stringify(Array.from({length:3},()=>({draftId:randomUUID(),revision:0})))}),
 badCalibration('social_founder_calibrations_examples_check',{examples:JSON.stringify(Array.from({length:3},()=>({draftId:randomUUID(),revision:1,text:'Forbidden copied example prose.'})))}),
 badCalibration('social_founder_calibrations_guide_ref_check',{guide_ref:JSON.stringify({guideId:randomUUID(),revision:1,entries:['Forbidden copied guidance.']})}),
 badCalibration('social_founder_calibrations_guide_ref_check',{guide_ref:JSON.stringify({guideId:randomUUID(),revision:0})}),
 {constraint:'social_founder_calibrations_pkey',run:async(f:Fixture)=>{const row=calibrationRow(f);await insert(f,'social_founder_calibrations',row);return insert(f,'social_founder_calibrations',{...row,id:randomUUID()});}},
 {constraint:'social_founder_calibrations_workspace_id_id_key',run:async(f:Fixture)=>{const row=calibrationRow(f);await insert(f,'social_founder_calibrations',row);return insert(f,'social_founder_calibrations',{...row,owner_user_id:f.seeded.alpha.salesperson.userId});}},
];
