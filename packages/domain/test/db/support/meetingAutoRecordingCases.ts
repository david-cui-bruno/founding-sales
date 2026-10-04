import {randomUUID} from 'node:crypto';
import {meeting,type CallToBookingFixture} from './callToBookingCases.ts';
type Row=Record<string,unknown>;
type Case={constraint:string;run:(f:CallToBookingFixture)=>Promise<unknown>};
const missing='00000000-0000-4000-8000-000000004599';
async function insert(f:CallToBookingFixture,row:Row){const keys=Object.keys(row);return await f.session.query(`INSERT INTO meeting_recording_setup (${keys.join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));}
async function base(f:CallToBookingFixture):Promise<Row>{return {workspace_id:f.seeded.alpha.workspaceId,id:randomUUID(),meeting_id:await meeting(f),target:'{}',target_hash:'a'.repeat(64)};}
const bad=(suffix:string,changes:Row):Case=>({constraint:`meeting_recording_setup_${suffix}`,run:async f=>await insert(f,{...await base(f),...changes})});
export const MEETING_AUTO_RECORDING_CONSTRAINT_CASES:readonly Case[]=[
  ...[['target','[]'],['target_hash','bad'],['version',0],['retry_generation',-1],['state','bad'],['reason','bad'],['attempts',5],['write_certainty','bad'],['previous_mode','bad']].map(([key,value])=>bad(`${String(key)}_check`,{[String(key)]:value})),
  bad('check',{first_attempt_at:'2026-10-04T00:00:00Z'}),
  bad('check1',{first_attempt_at:'2026-10-04T00:00:00Z',deadline_at:'2026-10-04T03:00:00Z'}),
  bad('check2',{write_intent_at:'2026-10-04T00:00:00Z'}),
  bad('check3',{write_certainty:'intent'}),
  bad('check4',{state:'ready'}),
  bad('workspace_id_fkey',{workspace_id:missing}),
  bad('workspace_id_meeting_id_fkey',{meeting_id:missing}),
  bad('workspace_id_write_job_id_fkey',{write_intent_at:'2026-10-04T00:00:00Z',write_owner_token:1,write_job_id:missing}),
  {constraint:'meeting_recording_setup_pkey',run:async f=>{const row=await base(f);await insert(f,row);return await insert(f,{...row,target_hash:'b'.repeat(64)});}},
  {constraint:'meeting_recording_setup_workspace_id_meeting_id_target_hash_key',run:async f=>{const row=await base(f);await insert(f,row);return await insert(f,{...row,id:randomUUID()});}},
];
