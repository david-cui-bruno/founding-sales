import { z } from 'zod';
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { mailScopeFingerprint } from '../../../../src/main/outreach/providers/gmailThreadProvider';
import { mailCursorEnvelopeSchema } from '../../../../src/shared/contracts/mailThreadContract';
import { commandReceiptSchema, workerEventSchema } from '../../../../src/shared/contracts/delegationContract';
import { manualHandoffSchema, prepareManualCommandSchema } from '../../../../src/shared/contracts/ownerCommandContract';
import { accountIdSchema, accountInstantSchema } from '../../../../src/shared/contracts/accountContract';
import { DynamoStore, keyPart, fingerprint, integer } from './dynamoStore';
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
export type PendingHandoffIdentity = { handoffId: string; pairingId: string; generation: number };
export type PendingHandoffProof = { dependency: { commandId: string; actionId: string; channel: 'call' | 'linkedin'; outcome: 'pending' };
  checks: TransactWriteItem[]; revisions: { key: string; revision: number }[]; validUntil: number };
/** Internal owner composition only. A caller identity is never an exemption:
 * all immutable admission artifacts and the current registry must agree. */
export async function validatePendingHandoff(store: DynamoStore, accountId: string, identity: PendingHandoffIdentity): Promise<PendingHandoffProof | null> {
  try {
    const handoffKey = `MANUAL_HANDOFF#${keyPart(identity.handoffId)}`; const row = await store.get<unknown>(handoffKey);
    if (!row) return null;
    const saved = z.strictObject({ handoff: manualHandoffSchema, accountId: accountIdSchema, pairingId: accountIdSchema,
      generation: integer, issuedAt: accountInstantSchema, lastOutcome: z.null() }).parse(row.data);
    const { handoffId, expiresAt, ...binding } = saved.handoff;
    const now = Date.parse(store.now()); const expires = Date.parse(expiresAt);
    if (saved.accountId !== accountId || saved.pairingId !== identity.pairingId || saved.generation !== identity.generation
      || handoffId !== identity.handoffId || Date.parse(saved.issuedAt) > now || now >= expires) return null;
    const registryKey = intakeRegistryKey(accountId); const registryRow = await store.get<unknown>(registryKey);
    if (!registryRow) return null;
    const registry = intakeRegistrySchema.parse(registryRow.data);
    const matches = registry.manualDependencies.filter(item => item.actionId === binding.actionId && item.channel === binding.channel && item.outcome === 'pending');
    if (registry.accountId !== accountId || matches.length !== 1) return null;
    const dependency = { ...matches[0]!, outcome: 'pending' as const };
    const commandKey = `COMMAND#${keyPart(dependency.commandId)}`; const commandRow = await store.get<unknown>(commandKey);
    if (!commandRow) return null;
    const stored = z.strictObject({ fingerprint: z.string(), receipt: commandReceiptSchema, sequence: integer.positive(), command: prepareManualCommandSchema }).parse(commandRow.data);
    const command = stored.command; const receipt = stored.receipt;
    if (stored.fingerprint !== fingerprint(command) || command.commandId !== dependency.commandId || command.workspaceId !== store.options.workspaceId
      || command.accountId !== accountId || command.expectedAuthorityGeneration !== identity.generation || fingerprint(command.payload) !== fingerprint(binding)
      || handoffId !== `handoff-${fingerprint([command.workspaceId, command.commandId])}` || receipt.commandId !== command.commandId
      || receipt.status !== 'applied' || receipt.authorityGeneration !== identity.generation || receipt.aggregateVersion !== command.expectedVersion + 1) return null;
    const eventKey = store.eventKey(stored.sequence); const eventRow = await store.get<{ event: unknown }>(eventKey);
    const event = eventRow ? workerEventSchema.parse(eventRow.data.event) : null;
    if (!event || event.kind !== 'manual.handoff' || event.workspaceId !== command.workspaceId || event.accountId !== accountId
      || event.authorityGeneration !== identity.generation || event.aggregateVersion !== receipt.aggregateVersion
      || fingerprint(event.receipt) !== fingerprint(receipt) || fingerprint(event.payload) !== fingerprint(saved.handoff)) return null;
    const revisions = [{ key: registryKey, revision: registryRow.rev }, { key: handoffKey, revision: row.rev },
      { key: commandKey, revision: commandRow.rev }, { key: eventKey, revision: eventRow!.rev }];
    return { dependency, revisions, checks: revisions.map(row => store.check(row.key, row.revision)), validUntil: Math.min(expires, now + 5000) };
  } catch { return null; }
}
/** Reads the configured relevant adapter set, not just whichever adapter answered.
 * Returned CAS checks MUST join the final reservation transaction. */
export function createIntakeBarrier(store: DynamoStore) {
  async function check(subject: IntakeSubject, signal: AbortSignal, handoff?: PendingHandoffIdentity): Promise<IntakeResult> {
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
      const proof = handoff ? await validatePendingHandoff(store, subject.accountId, handoff) : null;
      if (handoff && (!proof || proof.revisions.find(item => item.key === key)?.revision !== row.rev)) return { status: 'blocked', reason: 'manual_outcome_pending' };
      if (proof) { checks.push(...proof.checks.filter(item => item.ConditionCheck?.Key?.sk?.S !== key)); revisions.push(...proof.revisions.filter(item => item.key !== key)); }
      let validUntil = proof?.validUntil ?? Infinity;
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
        if (proof && fingerprint(dependency) === fingerprint(proof.dependency)) continue;
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
  }
  return { check: (subject: IntakeSubject, signal: AbortSignal) => check(subject, signal),
    checkHandoff: (subject: IntakeSubject, identity: PendingHandoffIdentity, signal: AbortSignal) => check(subject, signal, identity) };
}
