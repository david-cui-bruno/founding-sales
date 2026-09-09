import type { z } from 'zod';
import { linkedInBeginSchema, linkedInBeginResultSchema, linkedInPrepareSchema, linkedInRevisionSchema, linkedInSaveSchema, linkedInReportSchema, linkedInDraftSchema,
  linkedInActionSchema, linkedInReportResultSchema, type LinkedInApi } from '../../shared/contracts/linkedInContract';
import { registerValidatedIpc } from '../ipc/registerValidatedIpc';
/** Registration is inert until the serialized composition root explicitly calls it. */
export function registerLinkedInIpc(options: { provider: LinkedInApi; isTrustedRendererUrl?: (url: string) => boolean }): () => void {
  const removers: (() => void)[] = [];
  const add = <Q, R>(name: string, requestSchema: z.ZodType<Q>, responseSchema: z.ZodType<R>, handler: (request: Q) => Promise<R>) => {
    removers.push(registerValidatedIpc({ channel: `linkedin:${name}`, requestSchema, responseSchema, handler,
      safeErrorCode: 'LINKEDIN_REQUEST_FAILED', isTrustedRendererUrl: options.isTrustedRendererUrl }));
  };
  try {
    const p = options.provider;
    add('begin', linkedInBeginSchema, linkedInBeginResultSchema, input => p.begin(input));
    add('prepare', linkedInPrepareSchema, linkedInDraftSchema, input => p.prepare(input));
    add('save', linkedInSaveSchema, linkedInDraftSchema, input => p.save(input));
    add('get', linkedInRevisionSchema, linkedInDraftSchema, input => p.get(input));
    add('open', linkedInRevisionSchema, linkedInActionSchema, input => p.open(input));
    add('copy', linkedInRevisionSchema, linkedInActionSchema, input => p.copy(input));
    add('report-outcome', linkedInReportSchema, linkedInReportResultSchema, input => p.reportOutcome(input));
  } catch (error) { removers.reverse().forEach(remove => remove()); throw error; }
  let disposed = false;
  return () => { if (disposed) return; disposed = true; removers.reverse().forEach(remove => remove()); };
}
