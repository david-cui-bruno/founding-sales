import {callingSetupAnswerSchema,callingBudgetAnswerSchema} from '@fss/contracts';
/** Only typed, receipted product refusals remain content. Collisions/auth stay closed. */
export function callingSetupBrowserResult(path:string,status:number,body:unknown):{status:number;body:unknown}|null{
 if((path!=='/calling/setup/provider'&&path!=='/calling/setup/budget')||status!==409)return null;
 const parsed=(path==='/calling/setup/budget'?callingBudgetAnswerSchema:callingSetupAnswerSchema).safeParse(body);
 return parsed.success&&parsed.data.status==='refused'?{status:200,body:parsed.data}:null;
}
