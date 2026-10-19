import {z} from 'zod';
import {TREC_LIMITS} from '@fss/domain/sourcing/trecVerification.ts';
import {verifyTrecBrokerFile} from '../../sourcing/trecBrokerSource.ts';
import type {AdminInvocation, AdminOutcome} from './admin.ts';
const firmSchema = z.object({firmId:z.string().min(1).max(100), legalName:z.string().trim().min(1).max(64),
  mailingCountyCode:z.string().regex(/^\d{1,3}$/u), license:z.object({type:z.enum(['BLLC','BCRP']),number:z.string().min(1).max(10)}).strict().optional()}).strict();
const optionsSchema = z.object({
  '--file':z.string().min(1).max(4096), '--source-url':z.string().url().max(500),
  '--retrieved-at':z.string().max(30), '--source-updated-at':z.string().max(30).optional(),
  '--firms-json':z.string().max(256*1024), '--official-legacy-file':z.literal('true'),
}).strict();
/** Root registers this isolated local verification command. No session, DB, provider or CRM mutation.
 * The operator attests the file's origin. This is not authenticated or live registry verification.
 * Omit --source-updated-at when unknown, never substitute the retrieval timestamp. */
export async function trecVerifyCommand(input: Pick<AdminInvocation,'options'>): Promise<AdminOutcome> {
  const parsed = optionsSchema.safeParse(input.options);
  if (!parsed.success) return {ok:false,reason:'invalid_options',detail:'Supply official legacy file, source URL, retrieval timestamp and existing firms JSON.'};
  try {
    const options = parsed.data;
    const firms = z.array(firmSchema).max(TREC_LIMITS.firms).parse(JSON.parse(options['--firms-json']));
    // Explicit projection avoids an optional-property undefined under exactOptionalPropertyTypes.
    const existing = firms.map(f => ({firmId:f.firmId,legalName:f.legalName,mailingCountyCode:f.mailingCountyCode,...(f.license ? {license:f.license} : {})}));
    const value = await verifyTrecBrokerFile({path:options['--file'],metadata:{sourceUrl:options['--source-url'],
      retrievedAt:options['--retrieved-at'],sourceUpdatedAt:options['--source-updated-at']??null}, firms:existing,now:new Date()});
    return {ok:true,value};
  } catch {
    // Do not serialize parser/library/file errors, raw rows, paths or submitted JSON.
    return {ok:false,reason:'trec_verification_unavailable',detail:'Invalid or unavailable local source, metadata or firm identities. No verification was recorded.'};
  }
}
