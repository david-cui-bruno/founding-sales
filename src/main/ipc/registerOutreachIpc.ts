import type { z } from 'zod';
import { configureOutreachSchema,draftRevisionSchema,emailDraftSchema,openDraftSchema,outreachStatusSchema,
  saveDraftSchema,sendDraftSchema,type OutreachApi } from '../../shared/contracts/outreachContract';
import { registerValidatedIpc } from './registerValidatedIpc';

export function registerOutreachIpc(options:{provider:OutreachApi;isTrustedRendererUrl?:(url:string)=>boolean}):()=>void {
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
  }catch(error){removers.reverse().forEach(remove=>remove());throw error;}
  let disposed=false;
  return ()=>{if(disposed)return;disposed=true;removers.reverse().forEach(remove=>remove());};
}
