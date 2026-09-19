import { TERRITORY_RULES_REVISION } from '../../../../../src/shared/contracts/territoryClearanceContract';
import type { ReplyTemplateId } from '../../../../../src/shared/contracts/replyTemplateContract';
import type { TerritoryCallPolicy } from '../../../../../src/shared/contracts/territoryCallPolicyContract';
import type { DynamoStore } from '../../src/dynamoStore';
import type { MailboxAccess, MailboxConnection } from '../../src/v1/mailbox';
import { approveTemplate, footerBlock, readTemplate, setSendingLimit } from '../../src/v1/templates';
import { enrollFirm, putFirm, putTerritoryPolicy, riFirm, type FirmInput } from './firmFixtures';
import { setPosture } from './firmFixtures';
import type { v1Fixture } from './v1Fixture';

/**
 * What the send fence, the scheduler and the mail poller need in the workspace before any of them may do anything:
 * David's posture for the state, the standing territory policy, a firm with a business email enrolled on its
 * template step, a postal address in the sending settings and one approved template with the footer.
 *
 * Every address, mailbox, number and message id here is fictional, and every Gmail call goes through the injected
 * fetch below: nothing in these fixtures can reach a real mailbox.
 */

export const MAILBOX = 'founder@usecallie.invalid';
export const POSTAL_ADDRESS = '12 Fictional Way, Suite 3, Providence, RI 02903';

/** A connected mailbox with a fictional token. `connected: false` is the mailbox David has not set up. */
export function mailboxAccess(connection: MailboxConnection = { connected: true, email: MAILBOX, subject: MAILBOX, accessToken: 'fictional-access-token' }): MailboxAccess {
  return { access: async () => connection };
}

export type GmailCall = { url: string; method: string; body: string | null };
export type GmailScript = {
  /** What `messages/send` answers, in order. `'accepted'` is a 200 with a fresh id; `'refused'` a 400; `'lost'` a thrown network error. */
  send?: ('accepted' | 'refused' | 'lost')[];
  /** Messages the Sent folder holds, keyed by the RFC Message-ID the fence wrote. */
  sent?: Map<string, { id: string; threadId: string; from: string; to: string; subject: string; body: string }>;
  /** Threads the history read returns, in the order `mail.poll` asks for them. */
  history?: unknown[];
};

/** One injected fetch that answers exactly the Gmail calls this slice makes and refuses every other URL. */
export function gmailFetch(script: GmailScript): { fetch: typeof globalThis.fetch; calls: GmailCall[] } {
  const calls: GmailCall[] = [];
  const sends = [...(script.send ?? [])];
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const fetch: typeof globalThis.fetch = async (resource, init) => {
    const url = String(resource);
    calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : null });
    if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages/send')) {
      const outcome = sends.shift() ?? 'accepted';
      if (outcome === 'lost') throw new Error('fictional network failure');
      if (outcome === 'refused') return json(400, { error: { code: 400 } });
      const id = `sent-${calls.length}`;
      return json(200, { id, threadId: `thread-${calls.length}` });
    }
    if (url.includes('/messages?') || url.endsWith('/messages')) {
      const parsed = new URL(url);
      const query = parsed.searchParams.get('q') ?? '';
      const match = /rfc822msgid:([^\s]+)/.exec(query);
      const found = match ? script.sent?.get(`<${match[1]}>`) : undefined;
      return json(200, found ? { messages: [{ id: found.id }] } : {});
    }
    const message = /\/messages\/([^/?]+)/.exec(url);
    if (message) {
      const found = [...(script.sent?.values() ?? [])].find(entry => entry.id === message[1]);
      if (!found) return json(404, {});
      const key = [...(script.sent?.entries() ?? [])].find(([, entry]) => entry.id === found.id)?.[0] ?? '';
      const data = Buffer.from(found.body.replace(/\r\n|\r|\n/g, '\r\n')).toString('base64url');
      return json(200, { id: found.id, threadId: found.threadId, labelIds: ['SENT'], internalDate: '1789000000000',
        payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: found.from }, { name: 'To', value: found.to },
          { name: 'Subject', value: found.subject }, { name: 'Message-ID', value: key }],
        body: { data, size: Buffer.byteLength(found.body.replace(/\r\n|\r|\n/g, '\r\n')) } } });
    }
    throw new Error(`unconfigured fictional HTTP: ${url}`);
  };
  return { fetch, calls };
}

/** The exact body the Sent folder would hold for one accepted send: the fence freezes CRLF-normalised text. */
export const sentBodyOf = (body: string): string => body.replace(/\r\n|\r|\n/g, '\r\n');

/** David's postal address in the sending settings; no template can be approved before this exists. */
export async function setPostalAddress(store: DynamoStore, postalAddress = POSTAL_ADDRESS): Promise<void> {
  const outcome = await setSendingLimit(store, { postalAddress });
  if (!outcome.applied) throw new Error(`fixture postal address refused: ${outcome.reason}`);
}

/** David's standing approval of one template, with the footer block appended to the seeded text. */
export async function approveWithFooter(store: DynamoStore, templateId: ReplyTemplateId, postalAddress = POSTAL_ADDRESS): Promise<string> {
  const held = await readTemplate(store, templateId);
  const footer = footerBlock(postalAddress);
  const body = held.record.body.endsWith(footer) ? held.record.body : `${held.record.body}\n${postalAddress}\n${footer.split('\n').at(-1)}`;
  const outcome = await approveTemplate(store, { templateId, expectedRevision: held.record.revision, subject: held.record.subject, body });
  if (!outcome.applied) throw new Error(`fixture approval refused: ${outcome.reason}`);
  return body;
}

export type EmailStepFirm = { firmId: string; stepId: string; email: string; policy: TerritoryCallPolicy; stepIds: string[] };

/**
 * One firm standing on the sequence's first email step (step index 2, template T4), with a business email and a
 * Rhode Island address. `startedAt` anchors the cadence, so the step's due instant is seven days later.
 */
export async function enrollOnEmailStep(store: DynamoStore, policy: TerritoryCallPolicy, input: { n: number; startedAt: string; extra?: Partial<FirmInput> }): Promise<EmailStepFirm> {
  const email = `contact${input.n}@firm${input.n}.invalid`;
  const firm = riFirm(input.n, { businessEmail: email, researchedAt: '2026-09-10T12:00:00.000Z', ...input.extra });
  await putFirm(store, firm);
  const routeId = `route-listed`;
  const enrolled = await enrollFirm(store, { firmId: firm.id, routeId, policy, startedAt: input.startedAt, stepIndex: 2 });
  const stepId = enrolled.version.steps[2]!.id;
  return { firmId: firm.id, stepId, email, policy, stepIds: enrolled.version.steps.map(step => step.id) };
}

/** The whole workspace one due send needs: posture, policy, settings, approval and one enrolled firm. */
export async function sendWorkspace(f: ReturnType<typeof v1Fixture>, bearer: string, options: { startedAt?: string; approve?: boolean } = {}): Promise<EmailStepFirm> {
  await setPosture(f, bearer, 'RI', 'calling');
  const policy = await putTerritoryPolicy(f.store, '2026-09-01T12:00:00.000Z');
  await setPostalAddress(f.store);
  if (options.approve !== false) await approveWithFooter(f.store, 'T4');
  return enrollOnEmailStep(f.store, policy, { n: 1, startedAt: options.startedAt ?? '2026-09-11T12:00:00.000Z' });
}

export const POSTURE_REVISION = TERRITORY_RULES_REVISION;
