import {randomUUID} from 'node:crypto';
import type {SqlParameter} from '../../../db/queryable.ts';
import type {CallToBookingFixture} from './callToBookingCases.ts';
import {seedAskRequest} from './askAnswerCases.ts';
type Row=Record<string,SqlParameter>;
type Fixture=CallToBookingFixture;
const missing='00000000-0000-4000-8000-000000005580';
const row=(f:Fixture):Row=>({workspace_id:f.seeded.alpha.workspaceId,id:randomUUID(),owner_user_id:f.seeded.alpha.salesperson.userId,scope:JSON.stringify({kind:'business'}),version:1,state:'active',title:null,pinned:false});
async function insert(f:Fixture,table:string,value:Row){const columns=Object.keys(value);return f.session.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(value));}
const bad=(constraint:string,patch:Row)=>({constraint,run:async(f:Fixture)=>insert(f,'crm_ask_sessions',{...row(f),...patch})});
const turn=async(f:Fixture)=>{const session=row(f);await insert(f,'crm_ask_sessions',session);return {workspace_id:session['workspace_id']!,session_id:session['id']!,request_id:await seedAskRequest(f),ordinal:1};};
export const ASK_SESSION_CONSTRAINT_CASES=[
 bad('crm_ask_sessions_version_check',{version:0}),
 bad('crm_ask_sessions_title_check',{title:''}),
 bad('crm_ask_sessions_state_check',{state:'unexpected'}),
 bad('crm_ask_sessions_valid_shape',{state:'deleted',scope:JSON.stringify({kind:'business'})}),
 bad('crm_ask_sessions_workspace_id_fkey',{workspace_id:missing}),
 bad('crm_ask_sessions_workspace_id_owner_user_id_fkey',{owner_user_id:missing}),
 {constraint:'crm_ask_sessions_pkey',run:async(f:Fixture)=>{const value=row(f);await insert(f,'crm_ask_sessions',value);return insert(f,'crm_ask_sessions',value);}},
 {constraint:'crm_ask_session_turns_ordinal_check',run:async(f:Fixture)=>insert(f,'crm_ask_session_turns',{...await turn(f),ordinal:0})},
 {constraint:'crm_ask_session_turns_pkey',run:async(f:Fixture)=>{const value=await turn(f);await insert(f,'crm_ask_session_turns',value);return insert(f,'crm_ask_session_turns',{...value,request_id:await seedAskRequest(f)});}},
 {constraint:'crm_ask_session_turns_workspace_id_request_id_key',run:async(f:Fixture)=>{const value=await turn(f);await insert(f,'crm_ask_session_turns',value);return insert(f,'crm_ask_session_turns',{...value,ordinal:2});}},
 {constraint:'crm_ask_session_turns_workspace_id_session_id_fkey',run:async(f:Fixture)=>insert(f,'crm_ask_session_turns',{...await turn(f),session_id:missing})},
 {constraint:'crm_ask_session_turns_workspace_id_request_id_fkey',run:async(f:Fixture)=>insert(f,'crm_ask_session_turns',{...await turn(f),request_id:missing})},
];
