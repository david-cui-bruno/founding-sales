import { z } from 'zod';
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { mailScopeFingerprint } from '../../../../src/main/outreach/providers/gmailThreadProvider';
import { mailCursorEnvelopeSchema } from '../../../../src/shared/contracts/mailThreadContract';
import { commandReceiptSchema, workerEventSchema } from '../../../../src/shared/contracts/delegationContract';
import { accountIdSchema } from '../../../../src/shared/contracts/accountContract';
import { DynamoStore, keyPart } from './dynamoStore';
import { mailCursorKey } from './threadIntakeRepository';

export const INTAKE_MAX_AGE_MS = 300000;
export const intakeRegistryKey = (accountId: string) => `DISPATCH_INTAKE#${keyPart(accountId)}`;
export const intakeRegistrySchema = z.strictObject({ accountId: accountIdSchema,
  adapters: z.array(z.strictObject({ id: accountIdSchema, kind: z.string().min(1), enabled: z.boolean(), relevant: z.boolean(), mailboxSubject: accountIdSchema.nullable() })).max(20),
  manualDependencies: z.array(z.strictObject({ commandId: accountIdSchema, actionId: accountIdSchema, channel: z.enum(['call', 'linkedin']), outcome: z.string().min(1) })).max(20),
});
export type IntakeSubject = { accountId: string; mailboxSubject: string; requiredRecipient?: string; requiredThreadId?: string };
export type IntakeResult = { status: 'blocked'; reason: 'intake_unavailable' | 'intake_incomplete' | 'intake_stale' | 'manual_outcome_pending' }
  | { status: 'ready'; checks: TransactWriteItem[]; revisions: { key: string; revision: number }[]; validUntil: number };
/** Reads the configured relevant adapter set, not just whichever adapter answered.
 * Returned CAS checks MUST join the final reservation transaction. */
export function createIntakeBarrier(store: DynamoStore) {
  return { async check(subject: IntakeSubject, signal: AbortSignal): Promise<IntakeResult> {
    try {
      if (signal.aborted) return { status: 'blocked', reason: 'intake_unavailable' };
      const key = intakeRegistryKey(subject.accountId); const row = await store.get<unknown>(key);
      if (!row) return { status: 'blocked', reason: 'intake_unavailable' };
      const registry = intakeRegistrySchema.parse(row.data);
      if (registry.accountId !== subject.accountId) return { status: 'blocked', reason: 'intake_unavailable' };
      const relevant = registry.adapters.filter(adapter => adapter.enabled && adapter.relevant);
      if (!relevant.some(adapter => adapter.kind === 'gmail' && adapter.mailboxSubject === subject.mailboxSubject)
        || relevant.some(adapter => adapter.kind !== 'gmail' || !adapter.mailboxSubject)) return { status: 'blocked', reason: 'intake_unavailable' };
      const checks = [store.check(key, row.rev)]; const revisions = [{ key, revision: row.rev }];
      let validUntil = Infinity;
      const seen = new Set<string>();
      for (const adapter of relevant) {
        const cursorKey = mailCursorKey(subject.accountId, adapter.mailboxSubject!);
        if (seen.has(cursorKey)) return { status: 'blocked', reason: 'intake_unavailable' };
        seen.add(cursorKey);
        const cursor = await store.get<unknown>(cursorKey);
        if (!cursor) return { status: 'blocked', reason: 'intake_incomplete' };
        const envelope = mailCursorEnvelopeSchema.parse(cursor.data);
        const { checkpoint, poll, scope } = envelope;
        if (!scope || scope.accountId !== subject.accountId || scope.mailboxSubject !== adapter.mailboxSubject
          || scope.approvedAt > store.now() || scope.since > store.now()) return { status: 'blocked', reason: 'intake_incomplete' };
        const scopeHash = mailScopeFingerprint(scope);
        if (adapter.mailboxSubject === subject.mailboxSubject && (subject.requiredRecipient && !scope.participantAddresses.includes(subject.requiredRecipient)
          || subject.requiredThreadId && !scope.knownThreadIds.includes(subject.requiredThreadId))) return { status: 'blocked', reason: 'intake_incomplete' };
        if (checkpoint?.scopeRevision !== scope.revision || checkpoint?.scopeFingerprint !== scopeHash || checkpoint?.since !== scope.since
          || poll?.scopeRevision !== scope.revision || poll?.scopeFingerprint !== scopeHash) return { status: 'blocked', reason: 'intake_incomplete' };
        if (!checkpoint || !poll || poll.status !== 'complete' || checkpoint.pageToken !== null || checkpoint.mode !== 'history'
          || checkpoint.accountId !== subject.accountId || checkpoint.mailboxSubject !== adapter.mailboxSubject
          || poll.accountId !== subject.accountId || poll.mailboxSubject !== adapter.mailboxSubject || !poll.completedAt) return { status: 'blocked', reason: 'intake_incomplete' };
        const now = Date.parse(store.now()); const started = Date.parse(poll.startedAt); const completed = Date.parse(poll.completedAt);
        // The observation began at startedAt. A long poll cannot make old coverage fresh.
        if (completed > now || started > now || now - started >= INTAKE_MAX_AGE_MS) return { status: 'blocked', reason: 'intake_stale' };
        validUntil = Math.min(validUntil, started + INTAKE_MAX_AGE_MS);
        checks.push(store.check(cursorKey, cursor.rev)); revisions.push({ key: cursorKey, revision: cursor.rev });
      }
      for (const dependency of registry.manualDependencies) {
        const commandKey = `COMMAND#${keyPart(dependency.commandId)}`;
        const command = await store.get<{ receipt: unknown; sequence: number }>(commandKey);
        if (!command) return { status: 'blocked', reason: 'manual_outcome_pending' };
        const receipt = commandReceiptSchema.parse(command.data.receipt);
        const eventKey = store.eventKey(command.data.sequence);
        const eventRow = await store.get<{ event: unknown }>(eventKey);
        const event = eventRow ? workerEventSchema.parse(eventRow.data.event) : null;
        if (receipt.commandId !== dependency.commandId || receipt.status !== 'applied' || !event || event.kind !== 'manual.outcome'
          || event.accountId !== subject.accountId || event.workspaceId !== store.options.workspaceId
          || event.receipt.commandId !== dependency.commandId || event.payload.actionId !== dependency.actionId
          || event.payload.channel !== dependency.channel || event.payload.outcome !== dependency.outcome
          || ['unknown', 'reply', 'opt_out'].includes(event.payload.outcome)) return { status: 'blocked', reason: 'manual_outcome_pending' };
        checks.push(store.check(commandKey, command.rev), store.check(eventKey, eventRow!.rev));
        revisions.push({ key: commandKey, revision: command.rev }, { key: eventKey, revision: eventRow!.rev });
      }
      if (signal.aborted || Date.parse(store.now()) >= validUntil) return { status: 'blocked', reason: 'intake_stale' };
      return { status: 'ready', checks, revisions, validUntil };
    } catch { return { status: 'blocked', reason: 'intake_unavailable' }; }
  } };
}
