import {randomUUID} from 'node:crypto';
import type {SessionQueryable} from '../../../db/queryable.ts';
type Fixture={session:SessionQueryable;seeded:{alpha:{workspaceId:string}}};
const source='https://capture-fixture.example.test/services',final=source+'/';
export async function pendingPreparedCapture(f:Fixture,policy='prepared-source-association-v1'){
 const candidate=randomUUID(),run=randomUUID(),workspace=f.seeded.alpha.workspaceId,observationId=randomUUID();
 await f.session.query('INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload) VALUES($1,$2,$3,$4::jsonb)',[workspace,candidate,candidate.replaceAll('-','').padEnd(64,'0'),'{}']);
 await f.session.query(`INSERT INTO sourcing_qualification_runs(workspace_id,id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name,capture_policy_version)
  VALUES($1,$2,$3,1,repeat('a',64),'qualification-context-v7','qualification-v5','claude-haiku-4-5',$4)`,[workspace,run,candidate,policy]);
 const page={observationId,url:final,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:'2026-10-30T12:00:00.000Z',redirectUrls:[source,final]};
 const manifest={version:'prepared-source-association-v1',candidateId:candidate,candidateRevision:1,sourceUrl:source,pages:[page]};
 const observations=[{id:observationId,url:final,contentHash:page.contentHash,relevantTextHash:page.relevantTextHash,retrievedAt:page.retrievedAt,
  publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[{id:'business',text:'Our company manages residential homes for local owners.'}]}];
 return {workspace,run,candidate,page,manifest,observations};
}
export const completePreparedCapture=(f:Fixture,r:Awaited<ReturnType<typeof pendingPreparedCapture>>,manifest:unknown=r.manifest)=>f.session.query(
 "UPDATE sourcing_qualification_runs SET state='review',observations=$3::jsonb,prepared_capture=$4::jsonb WHERE workspace_id=$1 AND id=$2",
 [r.workspace,r.run,JSON.stringify(r.observations),JSON.stringify(manifest)]);

export const PREPARED_CAPTURE_CONSTRAINT_CASES=[
 {constraint:'sourcing_qualification_capture_policy_supported',run:async(f:Fixture)=>pendingPreparedCapture(f,'unreviewed-capture')},
 {constraint:'sourcing_qualification_capture_policy_immutable',run:async(f:Fixture)=>{const r=await pendingPreparedCapture(f,'legacy');return f.session.query("UPDATE sourcing_qualification_runs SET capture_policy_version='prepared-source-association-v1' WHERE id=$1",[r.run]);}},
 ...[null,{},[],{version:'prepared-source-association-v1'}].map(value=>({constraint:'sourcing_qualification_prepared_capture_shape',run:async(f:Fixture)=>completePreparedCapture(f,await pendingPreparedCapture(f),value)})),
 ...[
  (r:Awaited<ReturnType<typeof pendingPreparedCapture>>)=>({...r.manifest,candidateId:randomUUID()}),
  (r:Awaited<ReturnType<typeof pendingPreparedCapture>>)=>({...r.manifest,candidateRevision:2}),
  (r:Awaited<ReturnType<typeof pendingPreparedCapture>>)=>({...r.manifest,pages:[]}),
  (r:Awaited<ReturnType<typeof pendingPreparedCapture>>)=>({...r.manifest,extra:'Unapproved text'}),
  (r:Awaited<ReturnType<typeof pendingPreparedCapture>>)=>({...r.manifest,pages:[{...r.page,contentHash:'invalid'}]}),
  (r:Awaited<ReturnType<typeof pendingPreparedCapture>>)=>({...r.manifest,pages:[{...r.page,retrievedAt:'unknown'}]}),
  (r:Awaited<ReturnType<typeof pendingPreparedCapture>>)=>({...r.manifest,pages:[{...r.page,redirectUrls:[source]}]}),
  (r:Awaited<ReturnType<typeof pendingPreparedCapture>>)=>({...r.manifest,pages:[{...r.page,redirectUrls:[source,...Array<string>(6).fill(final)]}]}),
  (r:Awaited<ReturnType<typeof pendingPreparedCapture>>)=>({...r.manifest,pages:[{...r.page,redirectUrls:['https://other.example.test/',final]}]}),
  (r:Awaited<ReturnType<typeof pendingPreparedCapture>>)=>({...r.manifest,pages:[{...r.page,redirectUrls:[source,'https://other.example.test/']}]}),
  (r:Awaited<ReturnType<typeof pendingPreparedCapture>>)=>({...r.manifest,pages:[r.page,r.page]}),
 ].map(mutate=>({constraint:'sourcing_qualification_prepared_capture_shape',run:async(f:Fixture)=>{const r=await pendingPreparedCapture(f);return completePreparedCapture(f,r,mutate(r));}})),
 {constraint:'sourcing_qualification_prepared_capture_shape',run:async(f:Fixture)=>completePreparedCapture(f,await pendingPreparedCapture(f,'legacy'))},
 {constraint:'sourcing_qualification_prepared_capture_immutable',run:async(f:Fixture)=>{const r=await pendingPreparedCapture(f);return f.session.query(`INSERT INTO sourcing_qualification_runs(workspace_id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name,capture_policy_version,state,observations,prepared_capture)
  VALUES($1,$2,1,repeat('f',64),'qualification-context-v7','qualification-v5','claude-haiku-4-5','prepared-source-association-v1','review',$3::jsonb,$4::jsonb)`,[r.workspace,r.candidate,JSON.stringify(r.observations),JSON.stringify(r.manifest)]);}},
 {constraint:'sourcing_qualification_prepared_capture_immutable',run:async(f:Fixture)=>{const r=await pendingPreparedCapture(f);return f.session.query('UPDATE sourcing_qualification_runs SET observations=$2::jsonb,prepared_capture=$3::jsonb WHERE id=$1',[r.run,JSON.stringify(r.observations),JSON.stringify(r.manifest)]);}},
 {constraint:'sourcing_qualification_prepared_capture_immutable',run:async(f:Fixture)=>{const r=await pendingPreparedCapture(f);await completePreparedCapture(f,r);return f.session.query('UPDATE sourcing_qualification_runs SET prepared_capture=$2::jsonb WHERE id=$1',[r.run,JSON.stringify({...r.manifest,pages:[{...r.page,contentHash:'c'.repeat(64)}]})]);}},
 {constraint:'sourcing_qualification_prepared_capture_immutable',run:async(f:Fixture)=>{const r=await pendingPreparedCapture(f);await f.session.query("UPDATE sourcing_qualification_runs SET state='unavailable',observations=$2::jsonb WHERE id=$1",[r.run,JSON.stringify(r.observations)]);return f.session.query('UPDATE sourcing_qualification_runs SET prepared_capture=$2::jsonb WHERE id=$1',[r.run,JSON.stringify(r.manifest)]);}},
 {constraint:'sourcing_qualification_prepared_capture_immutable',run:async(f:Fixture)=>{const r=await pendingPreparedCapture(f);return f.session.query("UPDATE sourcing_qualification_runs SET state='review',prepared_capture=$2::jsonb WHERE id=$1",[r.run,JSON.stringify(r.manifest)]);}},
];
