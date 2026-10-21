import {randomUUID} from 'node:crypto';
import type {SessionQueryable} from '../../../db/queryable.ts';
type Fixture={session:SessionQueryable;seeded:{alpha:{workspaceId:string}}};
type Case={constraint:string;run:(f:Fixture)=>Promise<unknown>};
const table='sourcing_candidate_discovery_origins';
async function row(f:Fixture){const candidateId=randomUUID();await f.session.query('INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload) VALUES($1,$2,$3,$4::jsonb)',[f.seeded.alpha.workspaceId,candidateId,'a'.repeat(64),'{}']);return {workspace_id:f.seeded.alpha.workspaceId,candidate_id:candidateId,provider:'overture_places',release:'fixture',record_id:'fixture',source:JSON.stringify({provider:'overture_places',release:'fixture',recordId:'fixture'}),source_metadata:JSON.stringify({sourcesJson:'[]'}),licenses:'["fixture"]',notices:'[{}]'};}
async function insert(f:Fixture,value:Record<string,unknown>){const keys=Object.keys(value);return f.session.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(value));}
const bad=(constraint:string,changes:Record<string,unknown>):Case=>({constraint,run:async f=>insert(f,{...await row(f),...changes})});
export const DISCOVERY_INTAKE_CONSTRAINT_CASES:readonly Case[]=[
 bad('sourcing_candidate_discovery_ori_workspace_id_candidate_id_fkey',{candidate_id:'00000000-0000-4000-8000-000000000126'}),
 bad('sourcing_discovery_origin_source_shape',{provider:'unapproved'}),
 bad('sourcing_discovery_origin_source_shape',{source:'{}'}),
 bad('sourcing_discovery_origin_source_shape',{release:''}),
 bad('sourcing_discovery_origin_source_shape',{record_id:''}),
 bad('sourcing_discovery_origin_source_shape',{source:JSON.stringify({provider:'overture_places',release:'fixture',recordId:'fixture',extra:'x'.repeat(8192)})}),
 bad('sourcing_discovery_origin_metadata_shape',{source_metadata:'{}'}),
 bad('sourcing_discovery_origin_metadata_shape',{source_metadata:'{"sourcesJson":[],"extra":true}'}),
 bad('sourcing_discovery_origin_metadata_shape',{source_metadata:JSON.stringify({sourcesJson:'x'.repeat(8192)})}),
 bad('sourcing_discovery_origin_license_shape',{licenses:'[]'}),
 bad('sourcing_discovery_origin_license_shape',{notices:'[]'}),
 bad('sourcing_discovery_origin_license_shape',{licenses:JSON.stringify(Array.from({length:17},()=> 'fixture'))}),
 {constraint:'sourcing_candidate_discovery_origins_pkey',run:async f=>{const value=await row(f);await insert(f,value);return insert(f,value);}},
];
