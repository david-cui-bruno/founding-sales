import {z} from 'zod';
import {answerBlockSchema,answerBlocksReadSchema,saveAnswerBlockCommandSchema,answerBlockApprovalCommandSchema,uuid} from '@fss/contracts';
export const socialFactsBrowserSchemas:Readonly<Record<string,z.ZodType>>={
 '/outreach/answer-blocks':answerBlocksReadSchema,
 '/outreach/answer-blocks/save':saveAnswerBlockCommandSchema,
 '/outreach/answer-blocks/approve':answerBlockApprovalCommandSchema,
 '/outreach/answer-blocks/retire':answerBlockApprovalCommandSchema,
};
export const isSocialFactsBrowserPath=(path:string):boolean=>Object.hasOwn(socialFactsBrowserSchemas,path);
const list=z.strictObject({blocks:z.array(answerBlockSchema).max(50)});
const accepted=z.strictObject({status:z.literal('accepted'),replayed:z.boolean(),result:z.strictObject({id:uuid,version:z.number().int().positive()})});
const refused=z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason:z.enum(['invalid_input','not_found','stale_version','block_retired'])});
const failure=(status:number)=>({status,body:{error:'browser_request_refused'}});
/** Existing wire contracts only. A finite business refusal may resolve custody,
 * never an auth/collision/unknown failure or an unvalidated success payload. */
export function socialFactsBrowserResult(path:string,status:number,body:unknown):{status:number;body:unknown}|null{
 if(!isSocialFactsBrowserPath(path))return null;
 if(status===200){const result=(path==='/outreach/answer-blocks'?list:accepted).safeParse(body);return result.success?{status,body:result.data}:failure(503);}
 if(status===409&&path!=='/outreach/answer-blocks'){const result=refused.safeParse(body);if(result.success)return {status:200,body:result.data};}
 return failure(status>=400?status:503);
}
