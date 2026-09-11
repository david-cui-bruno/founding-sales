import type { z } from 'zod';
import { linkedInRecoverySchema, linkedInBeginSchema, linkedInBeginResultSchema, linkedInPrepareSchema, linkedInRevisionSchema, linkedInSaveSchema, linkedInReportSchema, linkedInDraftSchema,
  linkedInActionSchema, linkedInReportResultSchema, type LinkedInApi } from '../../shared/contracts/linkedInContract';
import type { IpcClient } from '../ipcClient';
export function createLinkedInApi(client: IpcClient): LinkedInApi {
  const request = async <Q, R>(name: string, schema: z.ZodType<Q>, result: z.ZodType<R>, args: [Q]): Promise<R> => {
    if (args.length !== 1) throw new Error('LinkedIn request requires one argument');
    return client.request(`linkedin:${name}`, schema, result, schema.parse(args[0]));
  };
  const draft = async <Q extends { draftId: string; expectedRevision: number }>(name: 'get' | 'save', schema: z.ZodType<Q>, args: [Q]) => {
    const value = await request(name, schema, linkedInDraftSchema, args);
    if (value.id !== args[0].draftId || value.revision !== args[0].expectedRevision + (name === 'save' ? 1 : 0)) throw new Error('LinkedIn draft mismatch');
    return value;
  };
  const action = async (name: 'copy' | 'open', args: [z.infer<typeof linkedInRevisionSchema>]) => {
    const value = await request(name, linkedInRevisionSchema, linkedInActionSchema, args);
    if (value.draftId !== args[0].draftId || value.revision !== args[0].expectedRevision || value.status !== (name === 'copy' ? 'copied' : 'opened')) throw new Error('LinkedIn action mismatch');
    return value;
  };
  return {
    recover: async (...args) => {
      const value = await request('recover', linkedInRevisionSchema, linkedInRecoverySchema, args);
      if (value.draftId !== args[0].draftId || value.revision !== args[0].expectedRevision) throw new Error('LinkedIn recovery mismatch');
      return value;
    },
    begin: async (...args) => {
      const value = await request('begin', linkedInBeginSchema, linkedInBeginResultSchema, args);
      if (value.draftId !== args[0].draftId || value.revision !== args[0].expectedRevision || value.receipt.commandId !== args[0].commandId) throw new Error('LinkedIn begin mismatch');
      return value;
    },
    prepare: async (...args) => { const value = await request('prepare', linkedInPrepareSchema, linkedInDraftSchema, args);
      if (value.stepId !== args[0].stepId || value.enrollmentId !== args[0].enrollmentId) throw new Error('LinkedIn step mismatch'); return value; },
    save: (...args) => draft('save', linkedInSaveSchema, args),
    get: (...args) => draft('get', linkedInRevisionSchema, args),
    open: (...args) => action('open', args), copy: (...args) => action('copy', args),
    reportOutcome: async (...args) => {
      const value = await request('report-outcome', linkedInReportSchema, linkedInReportResultSchema, args);
      if (value.draftId !== args[0].draftId || value.revision !== args[0].expectedRevision || value.receipt.commandId !== args[0].commandId) throw new Error('LinkedIn report mismatch');
      return value;
    },
  };
}
