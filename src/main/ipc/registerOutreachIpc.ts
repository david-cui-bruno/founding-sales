import {workerPolicyRequestSchema,workerPolicyReceiptSchema} from '../../shared/contracts/workerPolicyContract';
import type { DelegationRuntime } from '../delegation/delegationRuntime';
import type { PairingStore } from '../delegation/pairingStore';
import { delegatedPhoneHandoffRequestSchema,bootstrapSelectedAccountSchema,configureResearchSourceSchema,ownerResearchSourceSchema,configureLocalDelegationSchema,localDelegationStatusSchema,localDelegationConfigurationRecordSchema,redeemLocalPairingSchema,redeemedLocalPairingSchema,delegationSyncReportSchema } from '../../shared/contracts/ownerCommandContract';
import {delegatedPhoneHandoffResultSchema,publicDelegationCommandSchema,commandReceiptSchema} from '../../shared/contracts/delegationContract';
import type { z } from 'zod';
import { configureOutreachSchema,draftRevisionSchema,emailDraftSchema,openDraftSchema,outreachStatusSchema,
  saveDraftSchema,sendDraftSchema,type OutreachApi } from '../../shared/contracts/outreachContract';
import { registerValidatedIpc } from './registerValidatedIpc';

export function registerOutreachIpc(options:{provider:OutreachApi;delegation?:DelegationRuntime;pairingStore?:Pick<PairingStore,'redeem'>;isTrustedRendererUrl?:(url:string)=>boolean}):()=>void {
  const removers:(()=>void)[]=[];
  const add=<Request,Response>(name:string,requestSchema:z.ZodType<Request>|null,responseSchema:z.ZodType<Response>,handler:(request:Request)=>Promise<Response>)=>{
    removers.push(registerValidatedIpc({channel:`outreach:${name}`,requestSchema,responseSchema,handler,
      safeErrorCode:'OUTREACH_REQUEST_FAILED',isTrustedRendererUrl:options.isTrustedRendererUrl}));
  };
  try {
    const p=options.provider;
    add('status',null,outreachStatusSchema,()=>p.status());
    add('configure',configureOutreachSchema,outreachStatusSchema,input=>p.configure(input));
    add('connect-gmail',null,outreachStatusSchema,()=>p.connectGmail());
    add('disconnect-gmail',null,outreachStatusSchema,()=>p.disconnectGmail());
    add('open-draft',openDraftSchema,emailDraftSchema,input=>p.openDraft(input));
    add('save-draft',saveDraftSchema,emailDraftSchema,input=>p.saveDraft(input));
    add('generate-draft',draftRevisionSchema,emailDraftSchema,input=>p.generateDraft(input));
    add('send-draft',sendDraftSchema,emailDraftSchema,input=>p.sendDraft(input));
    if(options.delegation){
      const d=options.delegation;
      add('delegation-begin-phone',delegatedPhoneHandoffRequestSchema,delegatedPhoneHandoffResultSchema,input=>d.beginPhone(input));
      add('delegation-bootstrap',bootstrapSelectedAccountSchema,commandReceiptSchema,input=>d.bootstrap(input));
      add('delegation-policy',workerPolicyRequestSchema,workerPolicyReceiptSchema,input=>d.configurePolicy(input));
      add('delegation-research',configureResearchSourceSchema,ownerResearchSourceSchema,input=>d.configureResearch(input));
      add('delegation-status',null,localDelegationStatusSchema,()=>d.status());
      add('delegation-configure',configureLocalDelegationSchema,localDelegationConfigurationRecordSchema,input=>d.configure(input));
      add('delegation-submit',publicDelegationCommandSchema,commandReceiptSchema,input=>d.submit(input));
      add('delegation-sync',null,delegationSyncReportSchema,()=>d.sync());
    }
    if(options.pairingStore)add('delegation-pair',redeemLocalPairingSchema,redeemedLocalPairingSchema,input=>options.pairingStore!.redeem(input,AbortSignal.timeout(15000)));

  }catch(error){removers.reverse().forEach(remove=>remove());throw error;}
  let disposed=false;
  return ()=>{if(disposed)return;disposed=true;removers.reverse().forEach(remove=>remove());};
}
