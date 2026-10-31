import {pendingPreparedCapture,completePreparedCapture} from './preparedCaptureCases.ts';
type Fixture=Parameters<typeof pendingPreparedCapture>[0];
const pending=async(f:Fixture)=>{const r=await pendingPreparedCapture(f,'prepared-source-association-v2');r.manifest.version='prepared-source-association-v2';return r;};
export const PREPARED_CAPTURE_V2_CONSTRAINT_CASES=[
 {constraint:'sourcing_qualification_prepared_capture_shape',run:async(f:Fixture)=>{const r=await pending(f);return completePreparedCapture(f,r,{...r.manifest,version:'prepared-source-association-v1'});}},
 {constraint:'sourcing_qualification_prepared_capture_shape',run:async(f:Fixture)=>{const r=await pendingPreparedCapture(f);return completePreparedCapture(f,r,{...r.manifest,version:'prepared-source-association-v2'});}},
 {constraint:'sourcing_qualification_capture_policy_immutable',run:async(f:Fixture)=>{const r=await pending(f);return f.session.query("UPDATE sourcing_qualification_runs SET capture_policy_version='prepared-source-association-v1' WHERE id=$1",[r.run]);}},
 {constraint:'sourcing_qualification_prepared_capture_immutable',run:async(f:Fixture)=>{const r=await pending(f);return f.session.query('UPDATE sourcing_qualification_runs SET observations=$2::jsonb,prepared_capture=$3::jsonb WHERE id=$1',[r.run,JSON.stringify(r.observations),JSON.stringify(r.manifest)]);}},
 {constraint:'sourcing_qualification_prepared_capture_immutable',run:async(f:Fixture)=>{const r=await pending(f);await completePreparedCapture(f,r);return f.session.query('UPDATE sourcing_qualification_runs SET prepared_capture=$2::jsonb WHERE id=$1',[r.run,JSON.stringify({...r.manifest,pages:[{...r.page,contentHash:'c'.repeat(64)}]})]);}},
 {constraint:'sourcing_qualification_prepared_capture_immutable',run:async(f:Fixture)=>{const r=await pending(f);await completePreparedCapture(f,r);await f.session.query('UPDATE sourcing_qualification_runs SET prepared_capture=NULL WHERE id=$1',[r.run]);return f.session.query("UPDATE sourcing_qualification_runs SET state='running' WHERE id=$1",[r.run]);}},
];
