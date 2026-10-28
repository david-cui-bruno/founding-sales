import {randomUUID} from 'node:crypto';
import type {SessionQueryable} from '../../../db/queryable.ts';
type Fixture={session:SessionQueryable;seeded:{alpha:{workspaceId:string}}};
async function row(f:Fixture){const id=randomUUID();await f.session.query('INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload) VALUES($1,$2,$3,$4::jsonb)',[f.seeded.alpha.workspaceId,id,id.replaceAll('-','').padEnd(64,'0'),'{}']);return {workspace_id:f.seeded.alpha.workspaceId,candidate_id:id,candidate_revision:1,state:'kept'};}
async function insert(f:Fixture,value:Record<string,unknown>){const keys=Object.keys(value);return f.session.query(`INSERT INTO sourcing_manual_prospect_states(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(value));}
const bad=(constraint:string,patch:Record<string,unknown>)=>({constraint,run:async(f:Fixture)=>insert(f,{...await row(f),...patch})});
export const MANUAL_PROSPECT_CONSTRAINT_CASES=[
 bad('sourcing_manual_prospect_revision',{candidate_revision:0}),
 bad('sourcing_manual_prospect_state',{state:'admitted'}),
 bad('sourcing_manual_prospect_candidate_fk',{candidate_id:'00000000-0000-4000-8000-000000000134'}),
 {constraint:'sourcing_manual_prospect_states_pkey',run:async(f:Fixture)=>{const r=await row(f);await insert(f,r);return insert(f,r);}},
];
/** Schema143 only: keep historical migration134's constraint inventory intact. */
export const MANUAL_PHONE_CHOICE_CONSTRAINT_CASES=[
 bad('manual_prospect_phone_choice_shape',{manual_phone_choice:'{}'}),
];
