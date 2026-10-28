import {callingSetupAnswerSchema} from '@fss/contracts';
/** Only typed, receipted product refusals remain content. Collisions/auth stay closed. */
export function callingSetupBrowserResult(path:string,status:number,body:unknown):{status:number;body:unknown}|null{
 if(path!=='/calling/setup/provider'||status!==409)return null;
 const parsed=callingSetupAnswerSchema.safeParse(body);
 return parsed.success&&parsed.data.status==='refused'?{status:200,body:parsed.data}:null;
}
