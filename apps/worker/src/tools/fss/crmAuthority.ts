import {crmReadAllocationSchema,crmReadAllocationFingerprint,provisionCrmReadAllocation} from '@fss/domain/mail/crmReadAllocation.ts';
import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {crmCapabilityAuthorityReceiptSchema} from '@fss/contracts';
import {crmCapabilityAuthorityFingerprint,provisionCrmCapabilityAuthority,revokeCrmCapabilityAuthority} from '@fss/domain/crm/capabilityAuthority.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import type {AdminInvocation,AdminOutcome} from './admin.ts';
const refuse=(reason:string):AdminOutcome=>({ok:false,reason,detail:'The independently reviewed CRM authority receipt was refused; no capability was enabled.'});
/** Trusted operations persist a reviewed body-free receipt; ordinary settings cannot mint one. */
export async function crmAuthorityProvisionCommand(invocation:AdminInvocation):Promise<AdminOutcome>{
 let text:string;
 try{
  const path=invocation.options['--json'],encoded=invocation.options['--json-base64'];
  if(path!==undefined)text=await readFile(path,'utf8');
  else if(encoded!==undefined&&encoded.length<=32768&&/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded))text=Buffer.from(encoded,'base64').toString('utf8');
  else return refuse('authority_unreadable');
  if(Buffer.byteLength(text)>16384)return refuse('authority_malformed');
 }catch{return refuse('authority_unreadable');}
 let input:unknown;try{input=JSON.parse(text);}catch{return refuse('authority_malformed');}
 const parsed=crmCapabilityAuthorityReceiptSchema.safeParse(input);if(!parsed.success)return refuse('authority_malformed');
 const hash=invocation.options['--sha256'];if(hash===undefined||!/^[a-f0-9]{64}$/u.test(hash)||crmCapabilityAuthorityFingerprint(parsed.data)!==hash)return refuse('authority_review_hash_mismatch');
 const outcome=await withTransaction(invocation.session,()=>provisionCrmCapabilityAuthority(invocation.session,parsed.data));
 return outcome.ok?{ok:true,value:{...outcome.value,authoritySha256:hash}}:refuse(outcome.reason);
}
export async function crmAuthorityRevokeCommand(invocation:AdminInvocation):Promise<AdminOutcome>{
 const parsed=z.strictObject({workspaceId:z.uuid(),authorityReceiptId:z.uuid(),reference:z.string().trim().min(1).max(200)}).safeParse({workspaceId:invocation.options['--workspace'],authorityReceiptId:invocation.options['--receipt'],reference:invocation.options['--reference']});
 if(!parsed.success)return refuse('authority_malformed');
 const outcome=await revokeCrmCapabilityAuthority(invocation.session,parsed.data);
 return outcome.ok?{ok:true,value:{...outcome.value,authorityReceiptId:parsed.data.authorityReceiptId}}:refuse(outcome.reason);
}

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
