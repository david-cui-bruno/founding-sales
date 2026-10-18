import type { GmailClient, GmailAccessGrant } from './gmailClient.ts';
import { headerValue } from './gmailClient.ts';
import type { MailCaptureProvider,MailCaptureProof } from './crmSources.ts';
import {isForwardCaptureDateAllowed} from './crmForwardCaptureScope.ts';

/** Structural quotation labels are context, never original-authorship or Sent proof. */
function contextRanges(text:string|null){
 if(!text)return [];
 const marker=/^(?:[ \t]*On .+wrote:|[ \t]*>)[^\n]*|^[ \t]*-{2,}\s*(?:Forwarded message|Original Message)\s*-*/gimu;
 const match=marker.exec(text);if(!match)return [{start:0,end:text.length,kind:'unknown' as const}];
 const kind=/Forwarded message|Original Message/iu.test(match[0])?'forwarded' as const:'quoted' as const;
 return [...(match.index>0?[{start:0,end:match.index,kind:'unknown' as const}]:[]),{start:match.index,end:text.length,kind}];
}
function headerAddresses(value:string|null|undefined){return [...(value??'').matchAll(/([^<>\s,]+@[^<>\s,]+)/gu)].map(match=>match[1]!);}
interface ProvenMailAccess {
  mailboxId: string;
  providerAccountId: string;
  generation: number;
  access: GmailAccessGrant;
  mailboxEmail?:string;
}
/** The resolver must prove the token's actual account and captured generation.
 * A requested account ID or the current mailbox email is not that proof. */
export function createGmailMailCaptureProvider(deps: {
  gmail: GmailClient;
  authorizeRead?(proof:MailCaptureProof):Promise<boolean>;
  authorizeSelectedMetadata?(proof:MailCaptureProof,metadata:Awaited<ReturnType<GmailClient['getMetadata']>>):Promise<boolean>;
  resolveAccess(
    input: Parameters<MailCaptureProvider['read']>[0],
  ): Promise<ProvenMailAccess | null>;
}): MailCaptureProvider {
  return {
    async read(input) {
      const proof=input.expectedProof?structuredClone(input.expectedProof):null;
      async function authorize(){if(deps.authorizeRead&&(!proof||proof.workspaceId!==input.workspaceId||proof.mailboxId!==input.mailboxId||proof.providerAccountId!==input.providerAccountId||proof.generation!==input.generation||!await deps.authorizeRead(structuredClone(proof))))throw new Error('CRM mail capture authority unavailable');}

      const proven = await deps.resolveAccess(input);
      if (
        !proven ||
        proven.mailboxId !== input.mailboxId ||
        proven.providerAccountId !== input.providerAccountId ||
        proven.generation !== input.generation
      )
        throw new Error('CRM mail account proof unavailable');
      await authorize();
      const metadata = await deps.gmail.getMetadata(
        proven.access,
        input.providerMessageId,
        ['From', 'To', 'Cc', 'Subject', 'Date'],
      );
      if (!metadata || metadata.id !== input.providerMessageId)
        throw new Error('CRM mail metadata identity unavailable');
      if(!Number.isSafeInteger(metadata.internalDateEpochMilliseconds)||metadata.internalDateEpochMilliseconds<0
        ||metadata.internalDateEpochMilliseconds>Date.now()+86400000||metadata.labelIds.includes('DRAFT'))throw new Error('CRM mail metadata date unavailable');
      const selected=deps.authorizeSelectedMetadata;
      if(!proof || (selected ? !await selected(structuredClone(proof),metadata) : !proof.forwardScope||!isForwardCaptureDateAllowed(proof.forwardScope,metadata.internalDateEpochMilliseconds)))throw new Error('CRM mail forward scope unavailable');
      await authorize();
      const body = await deps.gmail.getBody(proven.access, metadata.id);
      if (body && body.messageId !== metadata.id)
        throw new Error('CRM mail body identity unavailable');
      if (body?.threadId !== undefined && body.threadId !== metadata.threadId)
        throw new Error('CRM mail body thread identity unavailable');
      if (body?.labelIds !== undefined && JSON.stringify([...body.labelIds].sort()) !== JSON.stringify([...metadata.labelIds].sort()))
        throw new Error('CRM mail body labels changed');
      const labels = body?.labelIds ?? metadata.labelIds;
      const origin = body?.threadId === undefined || body.labelIds === undefined ? 'unknown' : labels.includes('DRAFT') ? 'unknown' : labels.includes('SENT') ? 'sent' : labels.includes('INBOX') ? 'received' : proven.mailboxEmail && headerAddresses(headerValue(metadata.headers,'To')).some(value=>value.toLowerCase()===proven.mailboxEmail!.toLowerCase()) && !headerAddresses(headerValue(metadata.headers,'From')).some(value=>value.toLowerCase()===proven.mailboxEmail!.toLowerCase()) ? 'received' : 'unknown';
      const latest = await deps.resolveAccess(input);
      if (
        !latest ||
        latest.mailboxId !== proven.mailboxId ||
        latest.providerAccountId !== proven.providerAccountId ||
        latest.generation !== proven.generation
      )
        throw new Error('CRM mail account proof changed');
      const addresses = (header: string | null | undefined) =>
        [...(header ?? '').matchAll(/([^<>\s,]+@[^<>\s,]+)/gu)].map(
          (match) => match[1]!,
        );
      const fromHeader = headerValue(metadata.headers, 'From');
      const from = addresses(fromHeader);
      if (from.length !== 1) throw new Error('CRM mail sender unavailable');
      const displayName = fromHeader?.match(
        /^\s*(?:"([^"]+)"|([^<>]+))\s*<[^<>]+>\s*$/u,
      );
      const text = body?.text ?? null;
      // A complete retained representation still leaves every authored/quoted range unknown.
      return {
        providerAccountId: proven.providerAccountId,
        messageId: metadata.id,
        threadId: metadata.threadId,
        labels: [...labels],
        origin,
        providerAt: new Date(
          metadata.internalDateEpochMilliseconds,
        ).toISOString(),
        rawSenderDate:
          headerValue(metadata.headers, 'Date')?.slice(0, 200) ?? null,
        from: from[0]!,
        ...(displayName
          ? {
              fromDisplayName: (displayName[1] ?? displayName[2]!)
                .trim()
                .slice(0, 240),
            }
          : {}),
        to: addresses(headerValue(metadata.headers, 'To')),
        cc: addresses(headerValue(metadata.headers, 'Cc')),
        subject: (headerValue(metadata.headers, 'Subject') ?? '').slice(0, 998),
        body: text,
        parserVersion: body?.completeness ? 'gmail-bounded-mime-v3' : 'gmail-existing-decoded-part-v1',
        representation: body?.plainText ? 'plain_text' : 'html_flattened',
        completeness: text === null ? 'unavailable' : body?.completeness === 'complete' && !body.truncated && body.plainText ? 'complete' : 'partial',
        attachments: [...(body?.attachments ?? metadata.attachments)],
        representationDiagnostics: [...(body?.representationDiagnostics ?? (body ? [] : ['body_unavailable']))],
        ranges: contextRanges(body?.plainText ? text : null).length ? contextRanges(text) : text ? [{start:0,end:text.length,kind:'unknown'}] : [],
      };
    },
  };
}
