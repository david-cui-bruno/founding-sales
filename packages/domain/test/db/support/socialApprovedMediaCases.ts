import type {SessionQueryable} from '../../../db/queryable.ts';
import type {TwoWorkspaces} from './fixtures.ts';
interface Fixture {session:SessionQueryable;seeded:TwoWorkspaces}
interface ConstraintCase {constraint:string;run(f:Fixture):Promise<unknown>}
const assetId='00000000-0000-4000-8000-000000001640';
// Cases execute inside the catalog's rollback, so fixed opaque IDs remain isolated.
async function insertAsset(f:Fixture){
 await f.session.query('INSERT INTO social_assets(workspace_id,id,owner_user_id,origin) VALUES($1,$2,$3,$4::jsonb)',[f.seeded.alpha.workspaceId,assetId,f.seeded.alpha.admin.userId,JSON.stringify({kind:'upload',sourceUrl:null,usageNote:null})]);
}
const approvedColumns={approved_version:2,approved_sha256:'a'.repeat(64),approved_caption:'Synthetic release screenshot',approved_topic:'engineering',approved_alt_text:'A blue rectangle',approved_at:'2026-11-03T12:00:00Z'};
function invalidApproval(constraint:string,patch:Record<string,unknown>):ConstraintCase{
 return {constraint,run:async f=>{
  await insertAsset(f);
  const values={...approvedColumns,...patch},columns=Object.keys(values);
  return f.session.query(`UPDATE social_assets SET ${columns.map((column,index)=>`${column}=$${index+3}`).join(',')} WHERE workspace_id=$1 AND id=$2`,[f.seeded.alpha.workspaceId,assetId,...Object.values(values)]);
 }};
}
export const SOCIAL_APPROVED_MEDIA_CONSTRAINT_CASES:readonly ConstraintCase[]=[
 {constraint:'social_assets_approval_revision_check',run:async f=>{
  await insertAsset(f);
  return f.session.query('UPDATE social_assets SET approval_revision=-1 WHERE workspace_id=$1 AND id=$2',[f.seeded.alpha.workspaceId,assetId]);
 }},
 invalidApproval('social_assets_approved_caption_check',{approved_caption:'x'.repeat(1001)}),
 invalidApproval('social_assets_approved_topic_check',{approved_topic:'x'.repeat(201)}),
 invalidApproval('social_assets_approved_alt_text_check',{approved_alt_text:'x'.repeat(1001)}),
 invalidApproval('social_asset_approval_complete',{approved_alt_text:null}),
 {constraint:'social_asset_sanitized_derivative',run:async f=>{
  await insertAsset(f);
  return f.session.query("INSERT INTO social_asset_objects(workspace_id,asset_id,version,object_key,kind,state,sha256,bytes,mime,sanitized) VALUES($1,$2,1,'social-approved-media-constraint-original','original','ready',$3,100,'image/jpeg',true)",[f.seeded.alpha.workspaceId,assetId,'a'.repeat(64)]);
 }},
];
