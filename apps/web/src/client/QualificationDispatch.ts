import { z } from 'zod';
import { qualificationQueuedSchema, qualificationAdmittedSchema, prospectPhoneDiscoveryQueuedSchema, prospectPhoneDiscoveryReceiptSchema } from '@fss/contracts';
import {privateDraftCanonicalJson,privateDraftSHA256} from './PrivateDraftCustody.ts';
import {retainedIdentityDecisionResultSchema,retainedInterpretationResultSchema} from '@fss/contracts';
import type { BrowserClient } from './BrowserClient.ts';
import type { PendingQualification } from './QualificationPending.ts';

const refused = z.strictObject({ status: z.literal('refused'), replayed: z.boolean(), reason: z.string() });
const queued = z.union([refused, z.strictObject({ status: z.literal('accepted'), replayed: z.boolean(), result: qualificationQueuedSchema })]);
const admitted = z.union([refused, z.strictObject({ status: z.literal('accepted'), replayed: z.boolean(), result: qualificationAdmittedSchema })]);

/** Explicit dispatch or same-ID reconciliation only. Failed/malformed responses retain uncertainty. */
export async function dispatchQualification(client: BrowserClient, held: PendingQualification, current: () => boolean): Promise<string> {
  if (held.receipt !== undefined || !current()) throw new Error('Qualification dispatch unavailable');
  const beforeDispatch = (): void => {
    if (!current()) throw new Error('Qualification binding changed');
    const latest = client.qualification.read();
    if (latest === null || latest.receipt !== undefined || JSON.stringify(latest.command) !== JSON.stringify(held.command)) throw new Error('Qualification custody changed');
    client.qualification.retain(held);
  };
  const command = held.command;
  if(command.kind==='phone_discovery'){
    const answer=await client.request('/sourcing/candidates/phone-discovery/request',z.union([refused,z.strictObject({status:z.literal('accepted'),replayed:z.boolean(),result:prospectPhoneDiscoveryQueuedSchema})]),command.payload,beforeDispatch);
    if(!current())return '';
    client.qualification.retain({...held,receipt:answer.status==='accepted'?{kind:'phone_discovery',result:answer.result}:{kind:'refused'}});
    return answer.status==='accepted'?'Business phone discovery requested. Read the current result when ready.':`Phone discovery unavailable: ${answer.reason}`;
  }
  if(command.kind==='identity'){
    const answer=await client.request('/sourcing/qualification/recovery/identity',z.union([refused,z.strictObject({status:z.literal('accepted'),replayed:z.boolean(),result:retainedIdentityDecisionResultSchema})]),command.payload,beforeDispatch);
    if(!current())return '';
    client.qualification.retain({...held,receipt:answer.status==='accepted'?{kind:'identity',result:answer.result}:{kind:'refused'}});
    return answer.status==='accepted'?'Literal trade-name decision recorded. Not qualification. Explicitly reread current candidate and retained evidence.':`Identity decision refused: ${answer.reason}`;
  }
  if(command.kind==='retained_interpretation'){
    const answer=await client.request('/sourcing/qualification/recovery/interpret',z.union([refused,z.strictObject({status:z.literal('accepted'),replayed:z.boolean(),result:retainedInterpretationResultSchema})]),command.payload,beforeDispatch);
    if(!current())return '';
    client.qualification.retain({...held,receipt:answer.status==='accepted'?{kind:'retained_interpretation',result:answer.result}:{kind:'refused'}});
    return answer.status==='accepted'?`New retained interpretation recorded. Run ${answer.result.runId}. Read and review separately before admission.`:`Retained interpretation refused: ${answer.reason}`;
  }
  if (command.kind === 'request') {
    const answer = await client.request('/sourcing/qualification/request', queued, command.payload, beforeDispatch);
    if (!current()) return '';
    client.qualification.retain({ ...held, receipt: answer.status === 'accepted' ? { kind: 'request', result: answer.result } : { kind: 'refused' } });
    return answer.status === 'accepted' ? `Qualification request recorded. Run ${answer.result.runId}. Read explicitly for current evidence.` : `Qualification request refused: ${answer.reason}`;
  }
  const answer = await client.request('/sourcing/qualification/admit', admitted, command.payload, beforeDispatch);
  if (!current()) return '';
  client.qualification.retain({ ...held, receipt: answer.status === 'accepted' ? { kind: 'admit', result: answer.result } : { kind: 'refused' } });
  return answer.status === 'accepted' ? `Admission recorded for exact Firm ${answer.result.firmId}. No contact or sending authority is granted.` : `Qualification admission refused: ${answer.reason}`;
}

/** Receipt-only recovery: an uncertain capture is never dispatched again by this control. */
export async function reconcilePhoneDiscovery(client:BrowserClient,held:PendingQualification,current:()=>boolean):Promise<'unknown'|'accepted'|'refused'>{
 if(held.command.kind!=='phone_discovery'||held.receipt!==undefined||!current())throw Error('Phone discovery receipt unavailable');
 const {commandId,...payload}=held.command.payload;
 const payloadHash=await privateDraftSHA256(privateDraftCanonicalJson(payload));
 const check=()=>{if(!current()||JSON.stringify(client.qualification.read())!==JSON.stringify(held))throw Error('Phone discovery custody changed');};
 check();
 const answer=await client.request('/sourcing/candidates/phone-discovery/receipt',prospectPhoneDiscoveryReceiptSchema,{commandId,payloadHash},check);
 if(!current())throw Error('Phone discovery authority changed');
 if(answer.state==='accepted')client.qualification.retain({...held,receipt:{kind:'phone_discovery',result:answer.result}});
 if(answer.state==='refused')client.qualification.retain({...held,receipt:{kind:'refused'}});
 return answer.state;
}
