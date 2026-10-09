import type { GmailClient, GmailAccessGrant } from './gmailClient.ts';
import { headerValue } from './gmailClient.ts';
import type { MailCaptureProvider } from './crmSources.ts';

interface ProvenMailAccess {
  mailboxId: string;
  providerAccountId: string;
  generation: number;
  access: GmailAccessGrant;
}
/** The resolver must prove the token's actual account and captured generation.
 * A requested account ID or the current mailbox email is not that proof. */
export function createGmailMailCaptureProvider(deps: {
  gmail: GmailClient;
  resolveAccess(
    input: Parameters<MailCaptureProvider['read']>[0],
  ): Promise<ProvenMailAccess | null>;
}): MailCaptureProvider {
  return {
    async read(input) {
      const proven = await deps.resolveAccess(input);
      if (
        !proven ||
        proven.mailboxId !== input.mailboxId ||
        proven.providerAccountId !== input.providerAccountId ||
        proven.generation !== input.generation
      )
        throw new Error('CRM mail account proof unavailable');
      const metadata = await deps.gmail.getMetadata(
        proven.access,
        input.providerMessageId,
        ['From', 'To', 'Cc', 'Subject', 'Date'],
      );
      if (!metadata || metadata.id !== input.providerMessageId)
        throw new Error('CRM mail metadata identity unavailable');
      const body = await deps.gmail.getBody(proven.access, metadata.id);
      if (body && body.messageId !== metadata.id)
        throw new Error('CRM mail body identity unavailable');
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
      // The existing client decodes a MIME part or flattens HTML. It does not
      // prove complete MIME or authored/quoted segmentation; retain that limit.
      return {
        providerAccountId: proven.providerAccountId,
        messageId: metadata.id,
        threadId: metadata.threadId,
        labels: [...metadata.labelIds],
        origin: 'unknown',
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
        parserVersion: 'gmail-existing-decoded-part-v1',
        representation: body?.plainText ? 'plain_text' : 'html_flattened',
        completeness: text === null ? 'unavailable' : 'partial',
        ranges: text ? [{ start: 0, end: text.length, kind: 'unknown' }] : [],
      };
    },
  };
}
