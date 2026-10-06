import {z} from 'zod';
import type {ApprovedPost} from '../adapters.ts';
import {linkedInDomScript,type LinkedInDomAction} from './linkedinDom.ts';
const viewSchema=z.strictObject({zone:z.string().max(100),kind:z.enum(['composer','schedule','unknown']),postingName:z.string().max(200).nullable(),text:z.string().max(10000).nullable(),date:z.string().max(30).nullable(),time:z.string().max(30).nullable(),identities:z.array(z.strictObject({name:z.string().max(200),selected:z.boolean()})).max(30),scheduleLabel:z.string().max(150).nullable()});
interface StagePorts {
 current():boolean;now():number;wait():Promise<void>;
 contents:{getURL():string;insertText(text:string):Promise<void>;executeJavaScriptInIsolatedWorld(world:number,scripts:{code:string}[],gesture?:boolean):Promise<unknown>};
}
/** Text-only native staging. Images remain refused until upload/readback is verified. */
export async function stageLinkedInText(post:ApprovedPost,port:StagePorts):Promise<{ready:boolean;reason?:string}>{
 const refuse=(reason:string)=>({ready:false,reason});
 const current=()=>port.current()&&port.contents.getURL()==='https://www.linkedin.com/sharing/compose';
 async function action(input:LinkedInDomAction){if(!current())throw new Error('session_changed');const answer=await port.contents.executeJavaScriptInIsolatedWorld(1001,[{code:linkedInDomScript(input)}],false);if(!current())throw new Error('session_changed');return answer;}
 async function read(){const a=z.object({ok:z.literal(true),view:viewSchema}).parse(await action({action:'read'}));return a.view;}
 async function act(input:LinkedInDomAction){z.object({ok:z.literal(true)}).parse(await action(input));}
 // Retry only explicit no-action responses, never thrown/lost results.
 async function selectTime(time:string){
  const unavailable=z.strictObject({ok:z.literal(false),reason:z.literal('time_menu_unavailable')});
  for(let i=0;i<12;i++){
   const opened=await action({action:'openTime'});
   if(unavailable.safeParse(opened).success){await port.wait();continue;}
   z.strictObject({ok:z.literal(true)}).parse(opened);await port.wait();
   const selected=await action({action:'selectTime',time});
   if(unavailable.safeParse(selected).success){await port.wait();continue;}
   z.strictObject({ok:z.literal(true)}).parse(selected);return;
  }
  throw new Error('time_menu_unavailable');
 }
 async function waitFor(kind:'composer'|'schedule'){for(let i=0;i<12;i++){const answer=await action({action:'read'});if(!z.strictObject({ok:z.literal(false),reason:z.literal('layout_changed')}).safeParse(answer).success){const {view}=z.object({ok:z.literal(true),view:viewSchema}).parse(answer);if(view.kind===kind)return view;}await port.wait();}throw new Error('layout_changed');}
 try{
  if(post.account.platform!=='linkedin'||post.images.length)return refuse('format_not_verified');
  if(!Number.isFinite(Date.parse(post.publishAt))||Date.parse(post.publishAt)<=port.now())return refuse('schedule_missed');
  if(!post.text||[...post.text].length>3000)return refuse('content_needs_edit');
  let view=await waitFor('composer');if(view.text?.trim())return refuse('existing_draft');if(view.postingName!==post.account.displayName)return refuse('account_identity_changed');
  await act({action:'openIdentity',name:post.account.displayName});view=await read();
  const matching=view.identities.filter(x=>x.name===post.account.displayName);
  if(matching.length!==1||!matching[0]!.selected)return refuse('account_identity_changed');
  await act({action:'openIdentity',name:post.account.displayName});
  await act({action:'focusText'});if(!current())return refuse('session_changed');await port.contents.insertText(post.text);
  view=await read();if(view.text!==post.text||view.postingName!==post.account.displayName)return refuse('content_mismatch');
  await act({action:'openSchedule'});view=await waitFor('schedule');
  const zone=view.zone,at=new Date(post.publishAt);
  const fields=(instant:Date)=>Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'numeric',minute:'2-digit',hour12:true}).formatToParts(instant).map(p=>[p.type,p.value]));
  const f=fields(at),date=`${f['month']}/${f['day']}/${f['year']}`,time=`${f['hour']}:${f['minute']} ${f['dayPeriod']}`;
  // A repeated wall-clock time cannot be disambiguated by LinkedIn's visible fields.
  for(const delta of [-3600_000,3600_000])if(JSON.stringify(fields(new Date(at.getTime()+delta)))===JSON.stringify(f))return refuse('ambiguous_platform_time');
  if(at.getUTCSeconds()||at.getUTCMilliseconds())return refuse('unsupported_time_precision');
  await act({action:'fillSchedule',date,time});await port.wait();view=await read();
  if(view.date!==date||view.time!==time||view.zone!==zone)return refuse('schedule_mismatch');
  await selectTime(time);await port.wait();view=await read();
  if(view.date!==date||view.time!==time||view.zone!==zone)return refuse('schedule_mismatch');
  await act({action:'confirmSchedule',date,time});view=await waitFor('composer');
  const labelParts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:zone,weekday:'short',month:'short',day:'numeric'}).formatToParts(at).map(p=>[p.type,p.value]));
  const expected=`Posting at ${labelParts['weekday']}, ${labelParts['month']} ${labelParts['day']}, ${time}`;
  if(view.text!==post.text||view.postingName!==post.account.displayName||view.scheduleLabel!==expected||view.zone!==zone)return refuse('staged_content_changed');
  return current()&&at.getTime()>port.now()?{ready:true}:refuse('session_changed');
 }catch{return refuse('staging_unavailable');}
}
