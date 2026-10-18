import {crmReadAllocationSchema,crmReadAllocationFingerprint,provisionCrmReadAllocation} from '@fss/domain/mail/crmReadAllocation.ts';
import {readFile} from 'node:fs/promises';
import type {AdminInvocation,AdminOutcome} from './admin.ts';
const refuse=(reason:string):AdminOutcome=>({ok:false,reason,detail:'The reviewed CRM read allocation was refused; no allowance or capability was enabled.'});

/** A bounded history-read allocation remains independent of owner consent. */
export async function crmReadAllocationPutCommand(invocation:AdminInvocation):Promise<AdminOutcome>{
 let raw:unknown;
 try{
  const path=invocation.options['--json'],encoded=invocation.options['--json-base64'];
  const text=path!==undefined?await readFile(path,'utf8'):encoded!==undefined&&encoded.length<=32768&&/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)?Buffer.from(encoded,'base64').toString('utf8'):null;
  if(text===null||Buffer.byteLength(text)>16384)return refuse('allocation_unreadable');raw=JSON.parse(text);
 }catch{return refuse('allocation_unreadable');}
 const parsed=crmReadAllocationSchema.safeParse(raw);if(!parsed.success)return refuse('allocation_malformed');
 if(crmReadAllocationFingerprint(parsed.data)!==invocation.options['--sha256'])return refuse('allocation_review_hash_mismatch');
 const outcome=await provisionCrmReadAllocation(invocation.session,parsed.data);
 return outcome.ok?{ok:true,value:{...outcome.value}}:refuse(outcome.reason);
}
