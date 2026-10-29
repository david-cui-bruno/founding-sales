import {socialPublicThreadSnapshotSchema,socialPublicThreadViewSchema,type SocialPublicThreadRetainInput,
 type SocialPublicThreadList,type SocialPublicThreadMetadata,type SocialPublicThreadView} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {SocialResult} from './posts.ts';
import {validateRetainedPublicThread,publicThreadSHA256} from './publicThreadValidation.ts';
import {expireSocialPublicThreadRow,removeSocialPublicThreadRow,type PublicThreadRow} from './publicThreadRetention.ts';

/** Supplied by the existing retained-principal owner; no bearer or clock is wire data. */
export interface PublicThreadAuthority{authority:()=>Promise<boolean>;publicationNow:(databaseNow:number)=>number|null}
export class PublicThreadAuthorityChanged extends Error{}
const owner=(ctx:RepositoryContext)=>ctx.scope.actor.kind==='user'&&ctx.scope.actor.role==='admin'?ctx.scope.actor.userId:null;
async function membership(ctx:RepositoryContext):Promise<boolean>{
 const user=owner(ctx);return user!==null&&(await ctx.db.query("SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' AND role='admin' FOR SHARE",[ctx.scope.workspaceId,user])).rows.length===1;
}
async function requireAuthority(authority:PublicThreadAuthority):Promise<void>{if(!await authority.authority())throw new PublicThreadAuthorityChanged();}
async function finalNow(ctx:RepositoryContext,authority:PublicThreadAuthority):Promise<number>{
 await requireAuthority(authority);
 const clock=(await ctx.db.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]?.now;
 const now=clock?authority.publicationNow(clock.getTime()):null;if(now===null||!Number.isFinite(now))throw new PublicThreadAuthorityChanged();return now;
}
type MetadataRow=Pick<PublicThreadRow,'id'|'owner_user_id'|'revision'|'captured_at'|'expires_at'|'coverage'|'message_count'|'reason'>;
const fields='id,owner_user_id,revision,captured_at,expires_at,coverage,message_count,reason';
const base=(row:MetadataRow)=>({threadId:row.id,revision:row.revision,capturedAt:row.captured_at.toISOString(),expiresAt:row.expires_at.toISOString()});
function metadata(row:MetadataRow,now:number):SocialPublicThreadMetadata{
 if(row.reason!==null||row.expires_at.getTime()<=now)return {...base(row),availability:'unavailable',reason:row.reason??'expired'};
 if(row.coverage===null||row.message_count===null)return {...base(row),availability:'unavailable',reason:'removed'};
 return {...base(row),availability:'available',coverage:row.coverage,messageCount:row.message_count};
}
/** Internal retention fixture/future capture owner only. There is no HTTP writer. */
export async function retainSocialPublicThread(ctx:RepositoryContext,raw:SocialPublicThreadRetainInput,authority:PublicThreadAuthority):Promise<SocialResult<{threadId:string;revision:number}>>{
 if(!await membership(ctx))return {ok:false,reason:'owner_unavailable'};
 const now=await finalNow(ctx,authority),validated=validateRetainedPublicThread(raw,new Date(now).toISOString());if(!validated.ok)return validated;
 const input=validated.input;
 const inserted=(await ctx.db.query<PublicThreadRow>(`INSERT INTO social_public_threads(workspace_id,id,owner_user_id,captured_at,expires_at,source_url,payload,payload_sha256,coverage,message_count)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(workspace_id,id) DO NOTHING RETURNING *`,
 [ctx.scope.workspaceId,input.threadId,owner(ctx),input.capturedAt,validated.expiresAt,input.snapshot.url,JSON.stringify(input.snapshot),validated.payloadSHA256,input.snapshot.coverage,input.snapshot.messages.length])).rows[0];
 await requireAuthority(authority);
 if(!inserted)return {ok:false,reason:'identity_already_retained'};
 const current=await expireSocialPublicThreadRow(ctx,inserted),returnedAt=await finalNow(ctx,authority);
 if(current.reason!==null||current.expires_at.getTime()<=returnedAt)return {ok:false,reason:'expired'};
 return {ok:true,value:{threadId:current.id,revision:current.revision}};
}
export async function listSocialPublicThreads(ctx:RepositoryContext,afterId:string|undefined,authority:PublicThreadAuthority):Promise<SocialPublicThreadList>{
 if(!await membership(ctx)){await requireAuthority(authority);return {threads:[],nextAfterId:null};}
 const rows=(await ctx.db.query<MetadataRow>(`SELECT ${fields} FROM social_public_threads WHERE workspace_id=$1 AND owner_user_id=$2
  AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 21 FOR UPDATE`,[ctx.scope.workspaceId,owner(ctx),afterId??null])).rows;
 // Erase only expired bytes in the bounded selected page; never project source prose.
 const changed=(await ctx.db.query<MetadataRow>(`UPDATE social_public_threads SET source_url=NULL,payload=NULL,payload_sha256=NULL,coverage=NULL,message_count=NULL,
  reason='expired',revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND owner_user_id=$2 AND id=ANY($3::uuid[])
  AND reason IS NULL AND expires_at<=clock_timestamp() RETURNING ${fields}`,[ctx.scope.workspaceId,owner(ctx),rows.slice(0,20).map(row=>row.id)])).rows;
 const replacements=new Map(changed.map(row=>[row.id,row])),now=await finalNow(ctx,authority);
 const threads=rows.slice(0,20).map(row=>metadata(replacements.get(row.id)??row,now));
 return {threads,nextAfterId:rows.length>20?threads.at(-1)?.threadId??null:null};
}
export async function readSocialPublicThread(ctx:RepositoryContext,input:{threadId:string;expectedRevision:number},authority:PublicThreadAuthority):Promise<SocialPublicThreadView|null>{
 if(!await membership(ctx)){await requireAuthority(authority);return null;}
 let row=(await ctx.db.query<PublicThreadRow>('SELECT * FROM social_public_threads WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 FOR UPDATE',[ctx.scope.workspaceId,input.threadId,owner(ctx)])).rows[0];
 await requireAuthority(authority);if(!row)return null;
 if(row.revision!==input.expectedRevision){await finalNow(ctx,authority);return {...base(row),availability:'unavailable',reason:'revision_changed'};}
 row=await expireSocialPublicThreadRow(ctx,row);
 let snapshot:ReturnType<typeof socialPublicThreadSnapshotSchema.safeParse>|null=null;
 if(row.reason===null){
  try{snapshot=socialPublicThreadSnapshotSchema.safeParse(JSON.parse(row.payload??''));}catch{/* Corrupt retained bytes are never projected. */}
  if(!snapshot?.success||row.payload_sha256!==publicThreadSHA256(row.payload??'')||JSON.stringify(snapshot.data)!==row.payload
   ||snapshot.data.url!==row.source_url||snapshot.data.coverage!==row.coverage||snapshot.data.messages.length!==row.message_count
   ||snapshot.data.messages.some(message=>publicThreadSHA256(message.text)!==message.textSHA256
    ||(message.publishedAt.status==='known'&&Date.parse(message.publishedAt.at)>row!.captured_at.getTime()+300000))){
   row=await removeSocialPublicThreadRow(ctx,row);snapshot=null;
  }
 }
 const now=await finalNow(ctx,authority);
 if(row.reason!==null||row.expires_at.getTime()<=now)return {...base(row),availability:'unavailable',reason:row.reason??'expired'};
 if(!snapshot?.success)return {...base(row),availability:'unavailable',reason:'removed'};
 return socialPublicThreadViewSchema.parse({...base(row),availability:'available',snapshot:snapshot.data});
}
