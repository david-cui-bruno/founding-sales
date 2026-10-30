import {randomUUID} from 'node:crypto';
import type {SessionQueryable} from '../../../db/queryable.ts';
type Fixture={session:SessionQueryable;seeded:{alpha:{workspaceId:string}}};
const proof={producerVersion:'prepared-source-identity-v1',observationId:'11111111-1111-4111-8111-111111111111',blockId:'name',contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),blockTextHash:'c'.repeat(64)};
async function pending(f:Fixture,producer='prepared-source-identity-v1'){
 const candidate=randomUUID(),run=randomUUID(),workspace=f.seeded.alpha.workspaceId;
 await f.session.query('INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload) VALUES($1,$2,$3,$4::jsonb)',[workspace,candidate,candidate.replaceAll('-','').padEnd(64,'0'),'{}']);
 await f.session.query(`INSERT INTO sourcing_qualification_runs(workspace_id,id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name,producer_version)
  VALUES($1,$2,$3,1,repeat('a',64),'qualification-context-v7','qualification-v5','claude-haiku-4-5',$4)`,[workspace,run,candidate,producer]);
 return {workspace,run};
}
export const PREPARED_SOURCE_IDENTITY_CONSTRAINT_CASES=[
 {constraint:'sourcing_qualification_producer_supported',run:async(f:Fixture)=>pending(f,'future-unreviewed-producer')},
 ...[null,{},[],{...proof,producerVersion:null},{...proof,observationId:'unknown'},{...proof,blockTextHash:'invalid'},{...proof,name:'Copied name is forbidden'}].map(value=>({constraint:'sourcing_qualification_prepared_identity_shape',run:async(f:Fixture)=>{
  const r=await pending(f);return f.session.query("UPDATE sourcing_qualification_runs SET state='review',prepared_identity=$3::jsonb WHERE workspace_id=$1 AND id=$2",[r.workspace,r.run,JSON.stringify(value)]);
 }})),
 {constraint:'sourcing_qualification_producer_immutable',run:async(f:Fixture)=>{const r=await pending(f);return f.session.query("UPDATE sourcing_qualification_runs SET producer_version='qualification-context-v7' WHERE workspace_id=$1 AND id=$2",[r.workspace,r.run]);}},
 {constraint:'sourcing_qualification_prepared_identity_immutable',run:async(f:Fixture)=>{const r=await pending(f);return f.session.query('UPDATE sourcing_qualification_runs SET prepared_identity=$3::jsonb WHERE workspace_id=$1 AND id=$2',[r.workspace,r.run,JSON.stringify(proof)]);}},
];
