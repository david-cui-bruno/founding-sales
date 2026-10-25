import {randomUUID} from 'node:crypto';
import type {SessionQueryable} from '../../../db/queryable.ts';
type Fixture={session:SessionQueryable;seeded:{alpha:{workspaceId:string;admin:{userId:string}}}};
export const privateDraftRow=(f:Fixture)=>({workspace_id:f.seeded.alpha.workspaceId,id:randomUUID(),owner_user_id:f.seeded.alpha.admin.userId,kind:'post',origin_kind:'manual',text:'Neutral private fixture',origin:'{"kind":"manual"}',created_at:'2026-10-25T00:00:00Z',expires_at:'2027-01-23T00:00:00Z'});
export async function insertPrivateDraft(f:Fixture,row:Record<string,unknown>){const keys=Object.keys(row);return f.session.query(`INSERT INTO social_private_drafts(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));}
const bad=(constraint:string,patch:Record<string,unknown>)=>({constraint,run:async(f:Fixture)=>insertPrivateDraft(f,{...privateDraftRow(f),...patch})});
export const SOCIAL_PRIVATE_CONSTRAINT_CASES=[
 bad('social_private_drafts_workspace_id_fkey',{workspace_id:'00000000-0000-4000-8000-000000000135'}),
 bad('social_private_owner_fk',{owner_user_id:'00000000-0000-4000-8000-000000000135'}),
 bad('social_private_revision',{revision:0}),bad('social_private_kind',{kind:'published'}),bad('social_private_origin_kind',{origin_kind:'account',reason:'removed',text:null,origin:null}),
 bad('social_private_text',{text:' '.repeat(3)}),bad('social_private_origin',{origin:'[]'}),bad('social_private_source',{origin_kind:'suggestion',origin:'{"kind":"suggestion"}',source_selection:'[]',source_hash:'a'.repeat(64)}),
 bad('social_private_hash',{source_hash:'invalid'}),bad('social_private_dependencies',{dependencies:'[]'}),bad('social_private_reason',{reason:'approved',text:null,origin:null}),
 bad('social_private_lifetime',{expires_at:'2027-01-24T00:00:00Z'}),bad('social_private_live_shape',{reason:'removed'}),
 {constraint:'social_private_drafts_pkey',run:async(f:Fixture)=>{const row=privateDraftRow(f);await insertPrivateDraft(f,row);return insertPrivateDraft(f,row);}},
];
