import {randomUUID} from 'node:crypto';
import type {SessionQueryable} from '../../../db/queryable.ts';
type Fixture={session:SessionQueryable;seeded:{alpha:{workspaceId:string}}};
export const manualActivityContent=()=>({performedByUser:true,channel:'manual_phone',occurrence:{kind:'unknown'},result:'unknown',note:'Synthetic private business note',callback:null});
export async function manualActivityRow(f:Fixture){const candidate=randomUUID();await f.session.query('INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload) VALUES($1,$2,$3,$4::jsonb)',[f.seeded.alpha.workspaceId,candidate,candidate.replaceAll('-','').padEnd(64,'0'),'{}']);return {workspace_id:f.seeded.alpha.workspaceId,candidate_id:candidate,id:randomUUID(),candidate_revision:1,revision:1,content:JSON.stringify(manualActivityContent())};}
export async function insertManualActivity(f:Fixture,value:Record<string,unknown>){const keys=Object.keys(value);return f.session.query(`INSERT INTO sourcing_manual_prospect_attempts(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(value));}
const invalid=(constraint:string,patch:Record<string,unknown>)=>({constraint,run:async(f:Fixture)=>insertManualActivity(f,{...await manualActivityRow(f),...patch})});
export const MANUAL_ACTIVITY_CONSTRAINT_CASES=[
 invalid('manual_activity_candidate_fk',{candidate_id:'00000000-0000-4000-8000-000000000137'}),
 invalid('manual_activity_candidate_revision',{candidate_revision:0}),
 invalid('manual_activity_revision',{revision:0}),
 invalid('manual_activity_clock',{recorded_at:'2026-01-02T00:00:00Z',updated_at:'2026-01-01T00:00:00Z'}),
 invalid('manual_activity_content',{content:'{}'}),
 {constraint:'sourcing_manual_prospect_attempts_pkey',run:async(f:Fixture)=>{const r=await manualActivityRow(f);await insertManualActivity(f,r);return insertManualActivity(f,r);}},
];
