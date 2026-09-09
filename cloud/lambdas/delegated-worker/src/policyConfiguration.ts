import { TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { workerPolicyRequestSchema, workerPolicyReceiptSchema, type WorkerPolicyReceipt } from '../../../../src/shared/contracts/workerPolicyContract';
import { DynamoStore, fingerprint, keyPart, type DynamoAdapter } from './dynamoStore';
import { WorkerAuth } from './workerAuth';
import { RemoteGoogleAuthorization } from './remoteGoogleAuthorization';
import { googleGrantSchema, requireCapabilities } from './googleGrantCapabilities';
import { DynamoDispatchRepository } from './dispatchRepository';
import { DynamoMeetingRepository } from './meetingRepository';

/** Authenticated policy admission only. No account, AUTH, permission, cap usage,
 * work item or provider mutation is created. Existing setters own policy storage. */
export class WorkerPolicyConfiguration {
  constructor(readonly input: { auth: WorkerAuth; authorization: RemoteGoogleAuthorization }) {}
  async apply(raw: unknown, bearer: string): Promise<WorkerPolicyReceipt> {
    const request = workerPolicyRequestSchema.parse(raw);
    const principal = await this.input.auth.authenticate(bearer, ['commands:write']);
    this.input.auth.store.workspace(request.workspaceId);
    if (principal.kind !== 'device' || principal.pairingId !== request.pairingId) throw Error('policy_identity_conflict');
    const fenced = this.input.auth.fencedDynamo(principal);
    const store = new DynamoStore({ ...this.input.auth.options, dynamo: fenced });
    const receiptKey = `POLICY_CONFIGURATION_REQUEST#${keyPart(request.requestId)}`; const fp = fingerprint(request);
    const replay = async () => {
      const row = await store.get<{ fingerprint: string; receipt: unknown }>(receiptKey);
      if (!row) return null;
      const receipt = workerPolicyReceiptSchema.parse(row.data.receipt);
      if (row.data.fingerprint !== fp || receipt.fingerprint !== fp || receipt.requestId !== request.requestId || receipt.kind !== request.kind) throw Error('command_fingerprint_conflict');
      return receipt;
    };
    const previous = await replay(); if (previous) return previous;
    const grantKey = `GOOGLE_GRANT#${keyPart(principal.pairingId)}`;
    const row = await store.get<unknown>(grantKey);
    // Parse metadata only. Never open, return or log the encrypted token envelope.
    const metadata = z.object({ grant: googleGrantSchema, revoked: z.literal(false), revocationInFlight: z.literal(false).optional(), providerRevocation: z.enum(['confirmed', 'pending']).optional() }).parse(row?.data);
    const grant = metadata.grant;
    if (!row || grant.owner !== 'remote' || grant.subject !== request.mailboxSubject || metadata.providerRevocation) throw Error('policy_grant_unavailable');
    if (request.kind === 'sender-caps') {
      requireCapabilities(grant, ['send']);
      if (request.policy.sender !== grant.email) throw Error('policy_sender_mismatch');
    } else {
      requireCapabilities(grant, ['availability', 'event_write']);
      const calendars = grant.calendars;
      if (!calendars || request.rules.ownedCalendarId !== calendars.ownedCalendarId
        || fingerprint([...request.rules.conflictCalendarIds].sort()) !== fingerprint([...calendars.conflictCalendarIds].sort())) throw Error('policy_calendar_mismatch');
    }
    const receipt = workerPolicyReceiptSchema.parse({ requestId: request.requestId, kind: request.kind, status: 'applied', revision: (request.expectedRevision ?? 0) + 1, fingerprint: fp });
    let transactionCount = 0;
    const joined: DynamoAdapter = { send: async command => {
      if (!(command instanceof TransactWriteItemsCommand)) return fenced.send(command);
      if (++transactionCount !== 1 || command.input.TransactItems?.length !== 1 || !command.input.TransactItems[0]?.Put) throw Error('policy_setter_transaction_invalid');
      return fenced.send(new TransactWriteItemsCommand({ ...command.input, TransactItems: [...command.input.TransactItems, store.check(grantKey, row.rev), store.put(receiptKey, { fingerprint: fp, receipt }, null)] }));
    } };
    const options = { ...this.input.auth.options, dynamo: joined };
    try {
      if (request.kind === 'sender-caps') await new DynamoDispatchRepository(options, this.input.authorization).configureCaps(request.policy, request.expectedRevision);
      else await new DynamoMeetingRepository(options, this.input.authorization).saveRules({ rules: request.rules, expectedRevision: request.expectedRevision });
      if (transactionCount !== 1) throw Error('policy_setter_transaction_invalid');
      return receipt;
    } catch (error) { const committed = await replay(); if (committed) return committed; throw error; }
  }
}
