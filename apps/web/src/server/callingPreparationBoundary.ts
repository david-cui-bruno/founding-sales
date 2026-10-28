import {CALLING_PREPARATION_PATHS,callingPreparationAnswerSchema,callingPreparationReadSchema} from '@fss/contracts';
/** Product refusals only; collisions, auth and malformed bodies remain closed. */
export function callingPreparationBrowserResult(path:string,status:number,body:unknown,now=Date.now()):{status:number;body:unknown}|null{
 if(path===CALLING_PREPARATION_PATHS.read&&status===200){
  const parsed=callingPreparationReadSchema.safeParse(body);
  if(!parsed.success||parsed.data.state==='available'&&Date.parse(parsed.data.phone.expiresAt)<=now)return {status:409,body:{error:'browser_request_refused'}};
  return {status:200,body:parsed.data};
 }
 if(path!==CALLING_PREPARATION_PATHS.confirm||status!==409)return null;
 const parsed=callingPreparationAnswerSchema.safeParse(body);
 return parsed.success&&parsed.data.status==='refused'?{status:200,body:parsed.data}:null;
}
