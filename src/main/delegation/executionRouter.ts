import { delegatedPhoneHandoffRequestSchema, type DelegatedPhoneHandoffRequest } from '../../shared/contracts/ownerCommandContract';
import { capabilitySchema, handoffResultSchema, type HandoffResult } from '../../shared/contracts/outboundContract';
import { accountFingerprint } from '../domain/accounts/accountEvidence';
import { authorizeDelegatedAccountPhoneRoute } from '../domain/accounts/accountOutreach';
import { CampaignRepository } from '../domain/campaign/campaignRepository';
import type { InboundReadiness } from '../communications/inboundReadiness';
import type { PhoneHandoffPort } from '../communications/outboundPorts';
import type { ExecutionClient } from './executionClient';
import type { Clock } from '../domain/support/clock';
import type { AppDatabase } from '../db/database';
import { z } from 'zod';
import { accountIdSchema } from '../../shared/contracts/accountContract';
import { workerEventSchema, type AuthorityState, type CommandReceipt, type DelegatedPhoneHandoffResult } from '../../shared/contracts/delegationContract';
import type { DelegationRepository } from './delegationRepository';
const routeRequestSchema = z.strictObject({ accountId: accountIdSchema, commandId: z.uuid(), draftId: accountIdSchema,
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
export type RouteSendRequest = Readonly<z.infer<typeof routeRequestSchema>>;
export type RouteSendResult = Readonly<{ status: 'held'; reason: 'authority_unavailable' | 'authority_inactive' | 'owner_unavailable' }> |
  Readonly<{ status: 'local_dispatched' }> | Readonly<{ status: 'worker_submitted'; receipt: CommandReceipt }>;
/** Main-only composition. Request carries exact references, never permission flags.
 * Local execution MUST call assertCurrent in its final SQL reservation transaction. */
export function createExecutionRouter(input: {
  repository: DelegationRepository;
  local: { send(request: RouteSendRequest, assertCurrent: () => void): Promise<RouteSendResult> };
  worker: { sendApproved(request: RouteSendRequest, owner: AuthorityState): Promise<RouteSendResult> };
}) {
  const { repository, local, worker } = input;
  return { async routeSend(value: RouteSendRequest): Promise<RouteSendResult> {
    const request = Object.freeze(routeRequestSchema.parse(value));
    const owner = repository.authority(request.accountId);
    if (!owner) return { status: 'held', reason: 'authority_unavailable' };
    if (repository.hasPendingStop(request.accountId) || ['delegating', 'paused', 'revoked'].includes(owner.state)) return { status: 'held', reason: 'authority_inactive' };
    if (owner.owner === 'worker' && owner.state === 'active') {
      try { return await worker.sendApproved(request, Object.freeze({ ...owner })); }
      catch { return { status: 'held', reason: 'owner_unavailable' }; }
    }
    if (owner.owner !== 'local' || owner.state !== 'local') return { status: 'held', reason: 'authority_unavailable' };
    return local.send(request, () => {
      const current = repository.authority(request.accountId);
      if (!current || current.owner !== 'local' || current.state !== 'local' || current.generation !== owner.generation) throw new Error('Local authority changed');
    });
  } };
}

/** Final historical-email fence. Existing unassociated local drafts retain their
 * legacy behavior. Any account association requires explicit paired local rights. */
export function assertLocalEmailAuthority(database: AppDatabase, input: {
  personId: string; recipient: string; expectedWorkspaceId?: string;
}): void {
  const raw = database.raw;
  if (!raw.inTransaction) throw new Error('email_authority_transaction_required');
  const accounts = raw.prepare(`SELECT DISTINCT account_id FROM pm_account_links WHERE person_id=?
    UNION SELECT DISTINCT account_id FROM pm_account_routes WHERE person_id=? OR (channel='email' AND lower(value)=lower(?))`)
    .all(input.personId, input.personId, input.recipient) as { account_id: string }[];
  for (const account of accounts) {
    const owner = raw.prepare('SELECT workspace_id,owner,state FROM delegated_authorities WHERE account_id=?').get(account.account_id) as
      { workspace_id: string; owner: string; state: string } | undefined;
    if (!input.expectedWorkspaceId || !owner || owner.workspace_id !== input.expectedWorkspaceId || owner.owner !== 'local' || owner.state !== 'local') {
      throw new Error('email_authority_unavailable');
    }
  }
}

export { delegatedPhoneHandoffRequestSchema };
export type { DelegatedPhoneHandoffRequest, DelegatedPhoneHandoffResult };

/** Explicit human begin only. Owner acknowledgment is not a call outcome, and a
 * consumed token is never retried even if the native reply or runtime is lost. */
export function createDelegatedPhoneHandoff(input: {
  database: AppDatabase; repository: DelegationRepository; client: ExecutionClient;
  phone: PhoneHandoffPort; readinessForHandoff: (handoffId: string) => Pick<InboundReadiness, 'checkSubject' | 'assertCurrent'>;
  clock: Clock; signal?: AbortSignal; expectedWorkspaceId: string;
}) {
  const { database, repository, client, phone, readinessForHandoff, clock, expectedWorkspaceId } = input;
  const lifetime = input.signal ?? new AbortController().signal;
  const flights = new Map<string, { fingerprint: string; promise: Promise<DelegatedPhoneHandoffResult> }>();
  const held = (reason: string): DelegatedPhoneHandoffResult => ({ status: 'held', reason });
  const uncertain: HandoffResult = { status: 'unknown', reasonCode: 'handoff_uncertain' };
  function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('operation_interrupted')); };
      signal.addEventListener('abort', abort, { once: true });
      promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
      if (signal.aborted) abort();
    });
  }
  async function run(request: DelegatedPhoneHandoffRequest, manual: boolean): Promise<DelegatedPhoneHandoffResult> {
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(15000)]);
    const command = request.command;
    let started: string | null = null;
    // The refusal the route authorization actually gave, so a territory hold keeps its state
    // ("state_clearance_missing:MA") instead of collapsing to account_route_unavailable.
    let refusal: string | null = null;
    try {
      signal.throwIfAborted();
      if (command.workspaceId !== expectedWorkspaceId) return held('workspace_mismatch');
      // D6 acceptance 2: a hand-dialed attempt is not a helper dial, so it does not ask the helper
      // whether it could dial. Every other check below is unchanged, and nothing here dials.
      if (!manual) {
        const capability = capabilitySchema.parse(await wait(phone.inspectCapability(), signal));
        if (capability.state !== 'available') return held(capability.reasonCode ?? 'phone_route_unverified');
      }
      signal.throwIfAborted();
      await wait(client.submit(command), signal);
      const sync = await wait(client.sync(signal), signal);
      signal.throwIfAborted();
      const receipt = repository.commandStatus(command.commandId);
      if (!receipt) return held('owner_acknowledgment_missing');
      if (receipt.status === 'pending') return { status: 'pending', receipt };
      if (receipt.status !== 'applied' || !sync.ownerFresh || sync.gaps !== 0) return held('owner_unavailable');
      const row = database.raw.prepare(`SELECT event_json FROM delegated_applied_events WHERE workspace_id=? AND account_id=?
        AND json_extract(event_json,'$.kind')='manual.handoff' AND json_extract(event_json,'$.receipt.commandId')=?`)
        .get(expectedWorkspaceId, command.accountId, command.commandId) as { event_json: string } | undefined;
      if (!row) return held('owner_acknowledgment_missing');
      const event = workerEventSchema.parse(JSON.parse(row.event_json));
      if (event.kind !== 'manual.handoff') return held('owner_acknowledgment_missing');
      const { handoffId, expiresAt, ...binding } = event.payload;
      if (accountFingerprint(binding) !== accountFingerprint(command.payload) || event.authorityGeneration !== command.expectedAuthorityGeneration) return held('owner_acknowledgment_mismatch');
      const saved = repository.getManualHandoff(handoffId);
      if (!saved) return held('owner_acknowledgment_missing');
      if (saved.consumedAt !== null) return { status: 'already_started', handoffId };
      const readiness = readinessForHandoff(handoffId);
      const ready = await wait(readiness.checkSubject({ kind: 'account', id: command.accountId }, signal), signal);
      signal.throwIfAborted();
      if (ready.kind !== 'ready' || ready.proof?.subject?.kind !== 'account' || ready.proof.subject.id !== command.accountId) return held('inbound_safety_unwired');
      const handoff = { ...binding, handoffId, expiresAt, accountId: command.accountId, authorityGeneration: event.authorityGeneration };
      let target = '';
      const consumed = repository.consumeManualHandoff(handoff, () => {
        signal.throwIfAborted();
        const campaigns = new CampaignRepository({ database, workspaceId: expectedWorkspaceId, clock });
        const enrollment = campaigns.getEnrollment(binding.campaign.enrollmentId);
        const version = campaigns.getVersion(enrollment.campaignVersionId);
        if (enrollment.accountId !== command.accountId || enrollment.state !== 'active' || enrollment.version !== binding.campaign.enrollmentRevision
          || enrollment.executionContextId !== binding.contextRevision || enrollment.selectedRouteId !== binding.routeId || enrollment.selectedRouteVersion !== binding.routeVersion
          || enrollment.currentStepId !== binding.campaign.stepId || version.campaignId !== binding.campaign.campaignId || version.version !== binding.campaign.campaignRevision
          || !version.approvedAt || version.approvedAt > clock.now() || !version.cohortAccountIds.includes(command.accountId)
          || !version.steps.some(step => step.id === binding.campaign.stepId && step.channel === 'call')) throw new Error('campaign_context_changed');
        const authorization = authorizeDelegatedAccountPhoneRoute({ database, clock, expectedWorkspaceId, handoff,
          request: { commandId: command.commandId, accountId: command.accountId, routeId: binding.routeId, expectedRouteVersion: binding.routeVersion,
            expectedEvidenceFingerprint: request.expectedEvidenceFingerprint, channel: 'call' } });
        if (authorization.kind !== 'allowed') {
          // A plain code or the `<code>:<STATE>` form the renderer's describeHandoffHold decodes.
          refusal = /^[a-z0-9_]{1,64}(:[A-Z]{2})?$/.test(authorization.reason) ? authorization.reason : 'account_route_unavailable';
          throw new Error('account_route_unavailable');
        }
        target = authorization.canonicalTarget;
        readiness.assertCurrent(ready.proof);
        signal.throwIfAborted();
      });
      if (consumed.status === 'already_started') return { status: 'already_started', handoffId };
      started = handoffId;
      // A hand-dialed attempt consumes the step's one handoff and stops there, so the outcome form
      // opens on real consumed evidence. The helper is never asked to dial, and `target` is never
      // handed to it: the founder dialled it himself from the number on the card.
      if (manual) return { status: 'handoff', handoffId, result: { status: 'unavailable', reasonCode: 'channel_unavailable' } };
      // No await, queued callback, or second authorization between SQL commit and dispatch.
      const pending = phone.dispatch(target);
      const result = handoffResultSchema.safeParse(await wait(pending, signal));
      return { status: 'handoff', handoffId, result: result.success ? result.data : uncertain };
    } catch {
      return started ? { status: 'handoff', handoffId: started, result: uncertain } : held(refusal ?? 'operation_interrupted');
    }
  }
  /** `manual` is the desktop-side flag for a hand-dialed attempt. It is part of the in-flight
   * identity, so the same command id can never be replayed as the other kind of handoff. */
  return { begin(value: DelegatedPhoneHandoffRequest, options?: { manual?: boolean }): Promise<DelegatedPhoneHandoffResult> {
    const request = delegatedPhoneHandoffRequestSchema.parse(value);
    const manual = options?.manual === true;
    const fingerprint = accountFingerprint({ request, manual }); const id = request.command.commandId; const prior = flights.get(id);
    if (prior) return prior.fingerprint === fingerprint ? prior.promise : Promise.resolve(held('command_conflict'));
    const promise = Promise.resolve().then(() => run(request, manual)).finally(() => flights.delete(id));
    flights.set(id, { fingerprint, promise }); return promise;
  } };
}
