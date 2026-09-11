import { configureOutreachSchema,draftRevisionSchema,emailDraftSchema,localEmailAuthorityReadSchema,openDraftSchema,outreachStatusSchema,
  saveDraftSchema,sendDraftSchema,type OutreachApi,type EmailDraft } from '../../shared/contracts/outreachContract';
import type { IpcClient } from '../ipcClient';
import type { z } from 'zod';
export function createOutreachApi(client:IpcClient):OutreachApi {
  const noInput=(name:string,...args:[])=>{
    if(args.length!==0)throw new Error('Outreach method accepts no arguments.');
    return client.requestNoInput(`outreach:${name}`,outreachStatusSchema);
  };
  const draftRequest=async <T extends {draftId:string}>(name:string,schema:z.ZodType<T>,args:[T]):Promise<EmailDraft>=>{
    if(args.length!==1)throw new Error('Outreach method requires one request.');
    const input=schema.parse(args[0]);
    const result=await client.request(`outreach:${name}`,schema,emailDraftSchema,input);
    if(result.id!==input.draftId)throw new Error('Email response does not match draft.');return result;
  };
  return {
    status:(...args:[])=>noInput('status',...args),
    connectGmail:(...args:[])=>noInput('connect-gmail',...args),
    disconnectGmail:(...args:[])=>noInput('disconnect-gmail',...args),
    configure:(...args)=>{
      if(args.length!==1)throw new Error('Outreach configure requires one request.');
      return client.request('outreach:configure',configureOutreachSchema,outreachStatusSchema,args[0]);
    },
    openDraft:async(...args)=>{
      if(args.length!==1)throw new Error('Open email requires one request.');
      const input=openDraftSchema.parse(args[0]);
      const draft=await client.request('outreach:open-draft',openDraftSchema,emailDraftSchema,input);
      if(draft.personId!==input.personId||draft.contactMethodId!==input.contactMethodId)throw new Error('Email response does not match person.');
      return draft;
    },
    inspectLocalAuthority:async(...args)=>{
      try {
        if(args.length!==1)throw new Error('EMAIL_AUTHORITY_READ_FAILED');
        const input=draftRevisionSchema.parse(args[0]);
        const result=await client.request('outreach:inspect-local-authority',draftRevisionSchema,localEmailAuthorityReadSchema,input);
        if(result.draftId!==input.draftId||result.expectedRevision!==input.expectedRevision)throw new Error('EMAIL_AUTHORITY_READ_FAILED');
        return result;
      } catch {throw new Error('EMAIL_AUTHORITY_READ_FAILED');}
    },
    saveDraft:(...args)=>draftRequest('save-draft',saveDraftSchema,args),
    generateDraft:(...args)=>draftRequest('generate-draft',draftRevisionSchema,args),
    sendDraft:(...args)=>draftRequest('send-draft',sendDraftSchema,args),
  };
}
