import { QueryCommand } from '@aws-sdk/client-dynamodb';
import { ownerSourceKey, ownerSourceConfigurationSchema } from '../../../../src/shared/contracts/ownerCommandContract';
import { z } from 'zod';
import { workerEventSchema } from '../../../../src/shared/contracts/delegationContract';
import { meetingWorkSchema, meetingApprovalSchema, type MeetingWork, saveMeetingOfferSchema, meetingOfferSchema, type MeetingOffer, reserveMeetingSchema, saveSchedulingRulesSchema, schedulingRulesSchema, meetingReservationSchema, meetingOutcomeSchema, type ReserveMeetingInput, type MeetingReservation, type MeetingReservationResult, type MeetingOutcome } from '../../../../src/shared/contracts/meetingContract';
import { threadProjectionSchema } from '../../../../src/shared/contracts/mailThreadContract';
import { validateMeetingIntent, matchOfferedReply, offeredSlotText } from '../../../../src/shared/meetings/schedulingRules';
import { providerMeetingIdentity, requireExplicitCalendarId } from '../../../../src/main/meetings/calendarProvider';
import { DynamoStore, fingerprint, keyPart, type RepositoryOptions } from './dynamoStore';
import { executionAuthorityKey, executionAuthorityFields, authorityRecordSchema } from './executionRepository';
import { mailThreadKey, mailSuppressionKey } from './threadIntakeRepository';
import { RemoteGoogleAuthorization, type GoogleAccessEvidence } from './remoteGoogleAuthorization';
import { dispatchIntentKey, dispatchIntentSchema, sendEvidenceSchema } from './dispatchRepository';
import { createIntakeBarrier } from './intakeBarrier';
import { googleGrantSchema } from './googleGrantCapabilities';
export const meetingOfferKey = (account: string, thread: string) => `MEETING_OFFER#${keyPart(account)}#${keyPart(thread)}`;
export const meetingWorkKey = (account: string, command: string) => `MEETING_INTENT#${keyPart(account)}#${keyPart(command)}`;
const heldKey = (command: string) => `MEETING_HELD#${keyPart(command)}`;
const rulesKey = (id: string) => `MEETING_RULES#${keyPart(id)}`;
export const meetingCommandKey = (id: string) => `MEETING_COMMAND#${keyPart(id)}`;
const meetingKey = (id: string) => `MEETING#${keyPart(id)}`;
const calendarKey = (id: string) => `MEETING_CALENDAR#${keyPart(id)}`;
const approvalKey = (id: string) => `MEETING_APPROVAL#${keyPart(id)}`;
const occupiedSchema = z.strictObject({ meetingId: z.string(), start: z.number().finite(), end: z.number().finite() });
const calendarSchema = z.strictObject({ activeCommandId: z.string().nullable(), occupied: z.array(occupiedSchema).max(200) });
const meetingSchema = z.strictObject({ accountId: z.string(), calendarId: z.string(), commandId: z.string(), outcome: meetingOutcomeSchema.nullable(), history: z.array(meetingOutcomeSchema).max(200) });
/** Raw background store only. C2 supplies BOTH pairing/grant conditions; do not
 * wrap this in WorkerAuth.fencedDynamo (duplicate transaction targets). */
export class DynamoMeetingRepository {
  readonly store: DynamoStore;
  constructor(options: RepositoryOptions, readonly authorization: RemoteGoogleAuthorization) { this.store = new DynamoStore(options); }
  private async page(prefix: string, accountId: string, cursor: string | null, limit: number) {
    z.string().min(1).max(255).parse(accountId); z.number().int().min(1).max(25).parse(limit);
    let after: string | undefined;
    if (cursor !== null) {
      try {
        z.string().min(1).max(8192).regex(/^[A-Za-z0-9_-]+$/).parse(cursor);
        const decoded = z.strictObject({ prefix: z.string(), accountId: z.string(), limit: z.number(), after: z.string() }).parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
        if (decoded.prefix !== prefix || decoded.accountId !== accountId || decoded.limit !== limit || !decoded.after.startsWith(prefix)) throw new Error();
        after = decoded.after;
      } catch { throw new Error('meeting_cursor_invalid'); }
    }
    const response = await this.store.options.dynamo.send(new QueryCommand({ TableName: this.store.options.tableName, ConsistentRead: true, Limit: limit, ScanIndexForward: true,
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)', ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: { ':pk': this.store.key('').pk, ':prefix': { S: prefix } }, ...(after ? { ExclusiveStartKey: this.store.key(after) } : {}) }));
    if ((response.Items?.length ?? 0) > limit) throw new Error('meeting_page_capacity_exceeded');
    const rows = (response.Items ?? []).map(item => {
      const key = z.string().startsWith(prefix).parse(item.sk?.S);
      if (item.pk?.S !== this.store.key('').pk.S || after && key <= after) throw new Error('meeting_page_identity_conflict');
      return { key, data: JSON.parse(z.string().parse(item.data?.S)) as unknown };
    });
    const last = response.LastEvaluatedKey; let nextCursor: string | null = null;
    if (last && Object.keys(last).length) {
      const end = z.string().startsWith(prefix).parse(last.sk?.S);
      if (last.pk?.S !== this.store.key('').pk.S || after && end <= after || rows.at(-1)?.key !== end) throw new Error('meeting_cursor_invalid');
      nextCursor = Buffer.from(JSON.stringify({ prefix, accountId, limit, after: end })).toString('base64url');
    }
    return { rows, nextCursor };
  }
  async listAcceptedOffers(accountId: string, cursor: string | null = null, limit = 25): Promise<{ offers: MeetingOffer[]; nextCursor: string | null }> {
    const page = await this.page(`MEETING_OFFER#${keyPart(accountId)}#`, accountId, cursor, limit);
    const offers = page.rows.map(row => {
      const offer = meetingOfferSchema.parse(row.data);
      if (offer.accountId !== accountId || row.key !== meetingOfferKey(accountId, offer.threadId)) throw new Error('meeting_page_identity_conflict');
      return offer;
    }).filter(offer => Date.parse(offer.expiresAt) > Date.parse(this.store.now()));
    return { offers, nextCursor: page.nextCursor };
  }
  async listPreparedIntents(accountId: string, cursor: string | null = null, limit = 25): Promise<{ work: MeetingWork[]; nextCursor: string | null }> {
    const page = await this.page(`MEETING_INTENT#${keyPart(accountId)}#`, accountId, cursor, limit); const work: MeetingWork[] = [];
    for (const row of page.rows) {
      const item = meetingWorkSchema.parse(row.data); const intent = item.input.intent;
      if (intent.workspaceId !== this.store.options.workspaceId || intent.accountId !== accountId || row.key !== meetingWorkKey(accountId, intent.commandId)
        || item.fingerprint !== fingerprint(item.input)) throw new Error('meeting_page_identity_conflict');
      if (!await this.store.get(meetingCommandKey(intent.commandId)) && !await this.store.get(heldKey(intent.commandId))) work.push(item);
    }
    return { work, nextCursor: page.nextCursor };
  }
  async listReservations(accountId: string, cursor: string | null = null, limit = 25): Promise<{ records: MeetingReservation[]; nextCursor: string | null }> {
    const page = await this.page('MEETING_COMMAND#', accountId, cursor, limit);
    const records = page.rows.map(row => {
      const record = meetingReservationSchema.parse(row.data);
      if (record.intent.workspaceId !== this.store.options.workspaceId || row.key !== meetingCommandKey(record.intent.commandId)) throw new Error('meeting_page_identity_conflict');
      return record;
    }).filter(record => record.intent.accountId === accountId);
    return { records, nextCursor: page.nextCursor };
  }
  async prepareOfferedReply(target: { accountId: string; threadId: string }): Promise<MeetingWork | null> {
    const { accountId, threadId } = z.strictObject({ accountId: z.string().min(1).max(255), threadId: z.string().min(1).max(255) }).parse(target);
    const row = await this.store.get<unknown>(meetingOfferKey(accountId, threadId)); if (!row) return null;
    const offer = meetingOfferSchema.parse(row.data);
    if (!offer.meeting || offer.accountId !== accountId || offer.threadId !== threadId || Date.parse(offer.expiresAt) <= Date.parse(this.store.now())) return null;
    const sourceRow = await this.store.get<unknown>(ownerSourceKey(accountId)); const source = ownerSourceConfigurationSchema.safeParse(sourceRow?.data);
    if (!source.success || source.data.state !== 'active' || !source.data.calendarId || source.data.mailboxSubject !== offer.mailboxSubject) return null;
    const rules = await this.rules(source.data.calendarId);
    const authRow = await this.store.get<unknown>(executionAuthorityKey(accountId)); if (!authRow) return null; const auth = authorityRecordSchema.parse(authRow.data);
    const threadRow = await this.store.get<unknown>(mailThreadKey(accountId, threadId)); if (!threadRow) return null;
    const thread = threadProjectionSchema.parse(threadRow.data);
    const latest = thread.thread.messages.reduce((last, message) => message.date > last ? message.date : last, '');
    const messages = thread.thread.messages.filter(message => message.date === latest); if (messages.length !== 1) return null;
    const message = messages[0]!; const accepted = await this.acceptedOffer(offer);
    const quote = message.bodyParts.map(part => part.text).join('\n').trim();
    if (!quote || quote.length > 500 || message.bodyParts.some(part => part.truncated) || message.from.length !== 1 || message.from[0] !== accepted.recipient) return null;
    const matches = matchOfferedReply(quote, message.references, { ...offer, rfcMessageId: accepted.rfcMessageId });
    if (!matches.length) return null;
    // Delegated choice may authorize several exact offered slots. Stable offer order
    // chooses one, never an unoffered time or a second interpretation of the reply.
    const slot = offer.slots.find(candidate => matches.includes(candidate.id))!;
    const identity = fingerprint([this.store.options.workspaceId, accountId, offer.id, offer.revision, offer.sendCommandId]);
    const commandId = `offered-${fingerprint([identity, message.id])}`; const meetingId = `offered-${identity}`;
    if (await this.store.get(meetingCommandKey(commandId)) || await this.store.get(heldKey(commandId)) || await this.store.get(meetingKey(meetingId))) return null;
    const workKey = meetingWorkKey(accountId, commandId); const previous = await this.store.get<unknown>(workKey);
    if (previous) {
      const work = meetingWorkSchema.parse(previous.data);
      if (work.fingerprint !== fingerprint(work.input) || work.input.intent.commandId !== commandId || work.input.intent.accountId !== accountId) throw new Error('command_fingerprint_conflict');
      return work;
    }
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: slot.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).formatToParts(new Date(slot.start)).map(part => [part.type, part.value]));
    const input = reserveMeetingSchema.parse({ calendarId: source.data.calendarId, intent: { workspaceId: this.store.options.workspaceId, accountId, commandId, meetingId, operation: 'create',
      expectedAuthorityGeneration: auth.authority.generation, expectedVersion: auth.version, rulesRevision: rules.revision, threadId, threadRevision: thread.revision, contextRevision: thread.contextRevision,
      mailboxSubject: offer.mailboxSubject, pairingId: source.data.pairingId, start: slot.start, end: slot.end, timezone: slot.timezone,
      localStart: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`, offset: parts.timeZoneName?.replace('GMT', '') || '+00:00',
      agreementEvidenceId: message.id, agreement: { kind: 'offered_slot', offerId: offer.id, offerRevision: offer.revision, slotId: slot.id, quote },
      mixedReply: false, approvalId: null, attendeeEmails: [accepted.recipient], inviteAttendees: offer.meeting.inviteAttendees, summary: offer.meeting.summary, etag: null } });
    const evidence = await this.evidence(input); if (evidence.mixed) return null;
    const work = meetingWorkSchema.parse({ input, fingerprint: fingerprint(input), preparedAt: this.store.now() });
    if (Date.parse(this.store.now()) >= evidence.validUntil) throw new Error('intake_stale');
    await this.store.transact([...evidence.checks, this.store.absent(meetingCommandKey(commandId)), this.store.absent(heldKey(commandId)), this.store.absent(meetingKey(meetingId)), this.store.put(workKey, work, null)]);
    return work;
  }
  private async publishRecorded(sequences: (number | undefined)[]): Promise<void> {
    try { for (const sequence of sequences) if (sequence) await this.store.publish(sequence); }
    catch { /* Durable outbox remains pending for C6 retryPublications. Never downgrade provider evidence. */ }
  }
  async held(raw: ReserveMeetingInput): Promise<MeetingOutcome | null> {
    const input = reserveMeetingSchema.parse(raw); this.store.workspace(input.intent.workspaceId);
    const row = await this.store.get<{ fingerprint: string; outcome: unknown; sequence: number }>(heldKey(input.intent.commandId));
    if (!row) return null;
    if (row.data.fingerprint !== fingerprint(input)) throw new Error('command_fingerprint_conflict');
    await this.publishRecorded([row.data.sequence]); return meetingOutcomeSchema.parse(row.data.outcome);
  }
  async recordHeldIntent(raw: ReserveMeetingInput, reason: string): Promise<MeetingOutcome> {
    const input = reserveMeetingSchema.parse(raw); const previous = await this.held(input); if (previous) return previous;
    const { intent, calendarId } = input; const identity = providerMeetingIdentity(intent.workspaceId, intent.meetingId, calendarId);
    const outcome: MeetingOutcome = { ...identity, status: 'held', reason: z.string().regex(/^[a-z_]{3,80}$/).parse(reason), event: null };
    const key = executionAuthorityKey(intent.accountId); const auth = await this.store.get<unknown>(key);
    if (!auth) return outcome; const current = authorityRecordSchema.parse(auth.data);
    if (current.authority.accountId !== intent.accountId || current.authority.owner !== 'worker') return outcome;
    const next = { ...current, version: current.version + 1 }; const fp = fingerprint(input);
    const outbox = await this.store.eventItems(workerEventSchema.parse({ id: `meeting-held-${fp}`, workspaceId: intent.workspaceId, accountId: intent.accountId,
      authorityGeneration: current.authority.generation, aggregateVersion: next.version, kind: 'meeting.outcome', payload: { commandId: intent.commandId, outcome, observedAt: this.store.now() } }));
    await this.store.transact([this.store.absent(meetingCommandKey(intent.commandId)), this.store.put(heldKey(intent.commandId), { fingerprint: fp, outcome, sequence: outbox.sequence }, null),
      this.store.put(key, next, auth.rev, executionAuthorityFields(next), executionAuthorityFields(current)), ...outbox.items]);
    await this.publishRecorded([outbox.sequence]); return outcome;
  }
  private async acceptedOffer(offer: MeetingOffer) {
    const key = dispatchIntentKey(offer.sendCommandId); const row = await this.store.get<unknown>(key);
    if (!row) throw new Error('accepted_offer_missing'); const sent = dispatchIntentSchema.parse(row.data);
    if (sent.kind === 'phone_requested_followup') throw new Error('offer_content_conflict');
    if (sent.action.workspaceId !== this.store.options.workspaceId || sent.action.accountId !== offer.accountId || sent.mailboxSubject !== offer.mailboxSubject
      || sent.frozenMessage.threadId !== offer.threadId || sent.action.contentHash !== fingerprint(sent.frozenMessage)
      || offer.slots.some(slot => Date.parse(slot.end) <= Date.parse(slot.start))
      || sent.frozenMessage.body.trim() !== offer.slots.map(offeredSlotText).join('\n')) throw new Error('offer_content_conflict');
    const actionKey = `ACTION#${keyPart(offer.accountId)}#${keyPart(sent.action.actionId)}`;
    const action = await this.store.get<{ state: string }>(actionKey); if (action?.data.state !== 'provider_accepted') throw new Error('accepted_offer_missing');
    const rows = await this.store.list<unknown>(`DISPATCH_EVIDENCE#${keyPart(offer.sendCommandId)}#`);
    const accepted = rows.map(row => ({ ...row, evidence: sendEvidenceSchema.parse(row.stored.data) })).find(row => {
      const e = row.evidence;
      return e.state === 'provider_accepted' && e.commandId === offer.sendCommandId && e.reservation.workspaceId === sent.action.workspaceId && e.reservation.accountId === offer.accountId
        && e.reservation.actionId === sent.action.actionId && e.reservation.contentHash === sent.action.contentHash && e.reservation.targetHash === sent.action.targetHash
        && e.providerIdentity?.threadId === offer.threadId && e.rfcMessageId === `<${offer.sendCommandId}@callie.invalid>`;
    });
    if (!accepted) throw new Error('accepted_offer_missing');
    return { rfcMessageId: accepted.evidence.rfcMessageId, recipient: sent.frozenMessage.to,
      checks: [this.store.check(key, row.rev), this.store.check(actionKey, action.rev), this.store.check(accepted.key, accepted.stored.rev)] };
  }
  async saveOffer(input: z.infer<typeof saveMeetingOfferSchema>): Promise<void> {
    const { offer, expectedRevision } = saveMeetingOfferSchema.parse(input); const key = meetingOfferKey(offer.accountId, offer.threadId);
    const previous = await this.store.get<unknown>(key);
    if ((previous ? meetingOfferSchema.parse(previous.data).revision : null) !== expectedRevision || offer.revision !== (expectedRevision ?? 0) + 1
      || Date.parse(offer.expiresAt) <= Date.parse(this.store.now())) throw new Error('offer_revision_conflict');
    const accepted = await this.acceptedOffer(offer);
    await this.store.transact([...accepted.checks, this.store.absent(mailSuppressionKey(offer.accountId)), this.store.put(key, offer, previous?.rev ?? null)]);
  }
  async saveRules(input: z.infer<typeof saveSchedulingRulesSchema>): Promise<void> {
    const { rules, expectedRevision } = saveSchedulingRulesSchema.parse(input);
    [rules.ownedCalendarId, ...rules.conflictCalendarIds].forEach(requireExplicitCalendarId);
    const old = await this.store.get<unknown>(rulesKey(rules.ownedCalendarId));
    if ((old ? schedulingRulesSchema.parse(old.data).revision : null) !== expectedRevision || rules.revision !== (expectedRevision ?? 0) + 1 || !rules.confirmed) throw new Error('rules_revision_conflict');
    await this.store.transact([this.store.put(rulesKey(rules.ownedCalendarId), rules, old?.rev ?? null)]);
  }
  async rules(calendarId: string) {
    requireExplicitCalendarId(calendarId);
    const stored = await this.store.get<unknown>(rulesKey(calendarId)); if (!stored) throw new Error('rules_missing');
    const rules = schedulingRulesSchema.parse(stored.data); if (rules.ownedCalendarId !== calendarId) throw new Error('rules_identity_conflict');
    return rules;
  }
  async command(commandId: string): Promise<MeetingReservation | null> {
    const old = await this.store.get<unknown>(meetingCommandKey(commandId)); if (!old) return null;
    const record = meetingReservationSchema.parse(old.data); if (record.intent.commandId !== commandId) throw new Error('command_identity_conflict'); return record;
  }
  /** Selection is an independent final fence, never a replacement for AUTH or grants. */
  async sourceFence(raw: ReserveMeetingInput) {
    const { intent, calendarId } = reserveMeetingSchema.parse(raw); this.store.workspace(intent.workspaceId);
    const key = ownerSourceKey(intent.accountId); const row = await this.store.get<unknown>(key);
    const parsed = ownerSourceConfigurationSchema.safeParse(row?.data);
    if (!row || !parsed.success || parsed.data.state !== 'active' || parsed.data.workspaceId !== intent.workspaceId || parsed.data.accountId !== intent.accountId
      || parsed.data.pairingId !== intent.pairingId || parsed.data.mailboxSubject !== intent.mailboxSubject || parsed.data.calendarId !== calendarId) throw new Error('meeting_source_inactive');
    return this.store.check(key, row.rev);
  }
  private async evidence(input: ReserveMeetingInput) {
    const { intent, calendarId } = input; this.store.workspace(intent.workspaceId);
    requireExplicitCalendarId(calendarId);
    const storedRules = await this.store.get<unknown>(rulesKey(calendarId)); if (!storedRules) throw new Error('rules_missing');
    const rules = schedulingRulesSchema.parse(storedRules.data);
    [rules.ownedCalendarId, ...rules.conflictCalendarIds].forEach(requireExplicitCalendarId);
    if (rules.ownedCalendarId !== calendarId) throw new Error('rules_identity_conflict');
    const valid = validateMeetingIntent(intent, rules, this.store.now()); if (valid.allowed === false) throw new Error(valid.reason);
    const auth = await this.store.get<unknown>(executionAuthorityKey(intent.accountId)); if (!auth) throw new Error('authority_missing');
    const current = authorityRecordSchema.parse(auth.data);
    if (current.authority.accountId !== intent.accountId || current.authority.owner !== 'worker' || current.authority.state !== 'active'
      || current.authority.generation !== intent.expectedAuthorityGeneration || current.version !== intent.expectedVersion) throw new Error('stale_authority');
    const source = await this.sourceFence(input);
    const barrier = createIntakeBarrier(this.store);
    const subject = { accountId: intent.accountId, mailboxSubject: intent.mailboxSubject, requiredThreadId: intent.threadId };
    const intake = await barrier.check({ ...subject, requiredRecipient: intent.attendeeEmails[0] }, new AbortController().signal);
    if (intake.status !== 'ready') throw new Error(intake.reason);
    for (const recipient of intent.attendeeEmails.slice(1)) {
      const additional = await barrier.check({ ...subject, requiredRecipient: recipient }, new AbortController().signal);
      if (additional.status !== 'ready') throw new Error(additional.reason);
      // Every attendee must be covered by the SAME snapshot. Do not combine
      // differently revised scopes or duplicate Dynamo transaction targets.
      if (fingerprint(additional.checks) !== fingerprint(intake.checks)) throw new Error('intake_incomplete');
      intake.validUntil = Math.min(intake.validUntil, additional.validUntil);
    }
    const now = Date.parse(this.store.now());
    const threadKey = mailThreadKey(intent.accountId, intent.threadId); const thread = await this.store.get<unknown>(threadKey);
    if (!thread) throw new Error('thread_missing'); const projection = threadProjectionSchema.parse(thread.data);
    if (projection.thread.accountId !== intent.accountId || projection.thread.mailboxSubject !== intent.mailboxSubject || projection.thread.providerThreadId !== intent.threadId
      || projection.revision !== intent.threadRevision || projection.contextRevision !== intent.contextRevision) throw new Error('stale_thread');
    const message = projection.thread.messages.find(m => m.id === intent.agreementEvidenceId);
    if (!message || message.bodyParts.some(p => p.truncated) || !message.bodyParts.map(p => p.text).join('\n').includes(intent.agreement!.quote)
      || message.from.length !== 1 || !intent.attendeeEmails.includes(message.from[0]!)) throw new Error('agreement_evidence_missing');
    if (/\b(not|no|never|maybe|perhaps|unavailable|cannot|can't|don't|unsure)\b/i.test(message.bodyParts.map(p => p.text).join('\n'))) throw new Error('agreement_unclear');
    const relevant = projection.signals.filter(s => s.evidence.some(e => e.messageId === message.id));
    if (!relevant.length || relevant.some(s => ['rejection', 'opt_out', 'out_of_office', 'delivery_failure'].includes(s.kind))) throw new Error('agreement_unclear');
    let mixed = intent.mixedReply || relevant.some(s => ['mixed', 'substantive'].includes(s.kind)) || intent.agreement!.kind !== 'offered_slot';
    const checks = [source, this.store.check(rulesKey(calendarId), storedRules.rev), this.store.check(executionAuthorityKey(intent.accountId), auth.rev, executionAuthorityFields(current)),
      ...intake.checks, this.store.check(threadKey, thread.rev), this.store.absent(mailSuppressionKey(intent.accountId))];
    if (intent.agreement?.kind === 'offered_slot') {
      const agreement = intent.agreement; const key = meetingOfferKey(intent.accountId, intent.threadId); const row = await this.store.get<unknown>(key);
      if (!row) throw new Error('accepted_offer_missing'); const offer = meetingOfferSchema.parse(row.data);
      if (offer.id !== agreement.offerId || offer.revision !== agreement.offerRevision || offer.accountId !== intent.accountId || offer.threadId !== intent.threadId
        || offer.mailboxSubject !== intent.mailboxSubject || Date.parse(offer.expiresAt) <= now) throw new Error('stale_offer');
      const accepted = await this.acceptedOffer(offer);
      const slot = offer.slots.find(s => s.id === agreement.slotId);
      if (!slot || Date.parse(slot.start) !== Date.parse(intent.start) || Date.parse(slot.end) !== Date.parse(intent.end) || slot.timezone !== intent.timezone
        || intent.attendeeEmails.length !== 1 || intent.attendeeEmails[0] !== accepted.recipient) throw new Error('offered_slot_mismatch');
      const matched = matchOfferedReply(message.bodyParts.map(p => p.text).join('\n'), message.references, { ...offer, rfcMessageId: accepted.rfcMessageId });
      if (!matched.includes(slot.id)) mixed = true;
      if (projection.thread.messages.some(m => m.date > message.date)) mixed = true;
      checks.push(this.store.check(key, row.rev), ...accepted.checks);
    }
    if (await this.store.get(mailSuppressionKey(intent.accountId))) throw new Error('account_suppressed');
    return { rules, checks, mixed, validUntil: intake.validUntil, auth, current };
  }
  /** Only an explicitly approved trusted composition invokes this method. */
  async approveIntent(raw: ReserveMeetingInput): Promise<void> {
    const input = reserveMeetingSchema.parse(raw); if (!input.intent.approvalId) throw new Error('meeting_approval_missing');
    const { checks } = await this.evidence(input);
    const proof = meetingApprovalSchema.parse({ input, fingerprint: fingerprint(input) });
    const work = meetingWorkSchema.parse({ ...proof, preparedAt: this.store.now() });
    await this.store.transact([...checks, this.store.put(approvalKey(input.intent.approvalId), proof, null), this.store.put(meetingWorkKey(input.intent.accountId, input.intent.commandId), work, null)]);
  }
  async reserve(raw: ReserveMeetingInput, access: GoogleAccessEvidence): Promise<MeetingReservationResult> {
    const input = reserveMeetingSchema.parse(raw); const { intent, calendarId } = input; this.store.workspace(intent.workspaceId);
    const fp = fingerprint(input); if (await this.held(input)) throw new Error('meeting_previously_held'); const old = await this.command(intent.commandId);
    if (old) { if (old.fingerprint !== fp) throw new Error('command_fingerprint_conflict'); return { kind: 'existing', record: old }; }
    const { rules, checks, mixed, validUntil, auth, current } = await this.evidence(input);
    const grantRecord = await this.store.get<{ grant: unknown }>(`GOOGLE_GRANT#${keyPart(intent.pairingId)}`);
    const grant = googleGrantSchema.parse(grantRecord?.data.grant);
    if (grant.calendars) [grant.calendars.ownedCalendarId, ...grant.calendars.conflictCalendarIds].forEach(requireExplicitCalendarId);
    if (grant.subject !== intent.mailboxSubject || grant.owner !== 'remote' || grant.calendars?.ownedCalendarId !== calendarId
      || rules.conflictCalendarIds.some(id => !grant.calendars?.conflictCalendarIds.includes(id))) throw new Error('calendar_not_selected');
    if (mixed) {
      if (!intent.approvalId) throw new Error('meeting_approval_missing');
      const approved = await this.store.get<unknown>(approvalKey(intent.approvalId));
      const proof = meetingApprovalSchema.safeParse(approved?.data);
      if (!approved || !proof.success || proof.data.fingerprint !== fp || fingerprint(proof.data.input) !== fp) throw new Error('meeting_approval_missing'); checks.push(this.store.check(approvalKey(intent.approvalId), approved.rev));
    }
    const prior = await this.store.get<unknown>(meetingKey(intent.meetingId)); const meeting = prior ? meetingSchema.parse(prior.data) : null;
    if (meeting && (meeting.accountId !== intent.accountId || meeting.calendarId !== calendarId)) throw new Error('meeting_identity_conflict');
    if (meeting?.outcome?.status === 'cancelled') throw new Error('meeting_cancelled');
    if (intent.operation === 'create' ? !!meeting : !meeting?.outcome?.event || meeting.outcome.event.etag !== intent.etag) throw new Error('meeting_state_conflict');
    const head = await this.store.get<unknown>(calendarKey(calendarId)); const calendar = head ? calendarSchema.parse(head.data) : { activeCommandId: null, occupied: [] };
    if (calendar.activeCommandId) throw new Error('calendar_reserved');
    const occupied = { meetingId: intent.meetingId, start: Date.parse(intent.start) - rules.bufferBeforeMinutes * 60000, end: Date.parse(intent.end) + rules.bufferAfterMinutes * 60000 };
    if (intent.operation !== 'cancel' && calendar.occupied.some(o => o.meetingId !== intent.meetingId && o.start < occupied.end && o.end > occupied.start)) throw new Error('calendar_overlap');
    const intervals = intent.operation === 'cancel' ? calendar.occupied : [...calendar.occupied, occupied];
    if (intervals.length > 200) throw new Error('calendar_capacity_exceeded');
    const record: MeetingReservation = { intent, rules, identity: providerMeetingIdentity(intent.workspaceId, intent.meetingId, calendarId), fingerprint: fp, state: 'dispatching', outcome: null };
    if ((meeting?.history.length ?? 0) > 198) throw new Error('meeting_history_capacity_exceeded');
    const pending: MeetingOutcome = { ...record.identity, status: 'unknown', reason: 'reservation_pending', event: null };
    const nextAuthority = { ...current, version: current.version + 1 };
    const outbox = await this.store.eventItems(workerEventSchema.parse({ id: `meeting-reserve-${fp}`, workspaceId: intent.workspaceId, accountId: intent.accountId,
      authorityGeneration: intent.expectedAuthorityGeneration, aggregateVersion: nextAuthority.version, kind: 'meeting.outcome',
      payload: { commandId: intent.commandId, outcome: pending, observedAt: this.store.now() } }));
    record.reservationSequence = outbox.sequence;
    if (Date.parse(this.store.now()) >= validUntil) throw new Error('intake_stale');
    checks.push(...this.authorization.accessChecks(access, { pairingId: intent.pairingId, subject: intent.mailboxSubject, requiredCapabilities: ['availability', 'event_write'] }));
    await this.store.transact([...checks.filter(check => check.ConditionCheck?.Key?.sk?.S !== executionAuthorityKey(intent.accountId)),
      this.store.put(executionAuthorityKey(intent.accountId), nextAuthority, auth.rev, executionAuthorityFields(nextAuthority), executionAuthorityFields(current)), ...outbox.items, this.store.absent(heldKey(intent.commandId)), this.store.put(meetingCommandKey(intent.commandId), record, null),
      this.store.put(meetingKey(intent.meetingId), { accountId: intent.accountId, calendarId, commandId: intent.commandId, outcome: meeting?.outcome ?? null, history: [...(meeting?.history ?? []), pending] }, prior?.rev ?? null),
      this.store.put(calendarKey(calendarId), { activeCommandId: intent.commandId, occupied: intervals }, head?.rev ?? null)]);
    // Ambiguous commit is deliberately not converted into a dispatch permission.
    return { kind: 'reserved', record };
  }
  async recordOutcome(commandId: string, input: MeetingOutcome): Promise<MeetingOutcome> {
    let outcome = meetingOutcomeSchema.parse(input); const command = await this.store.get<unknown>(meetingCommandKey(commandId)); if (!command) throw new Error('command_missing');
    const record = meetingReservationSchema.parse(command.data); const identity = record.identity;
    if (outcome.meetingId !== identity.meetingId || outcome.calendarId !== identity.calendarId || outcome.providerEventId !== identity.providerEventId
      || outcome.event && (outcome.event.meetingId !== identity.meetingId || outcome.event.calendarId !== identity.calendarId || outcome.event.providerEventId !== identity.providerEventId)) throw new Error('provider_identity_conflict');
    if (outcome.status === 'cancelled' ? outcome.event?.status !== 'cancelled' : outcome.status === 'booked' && outcome.event?.status !== 'confirmed') throw new Error('provider_status_conflict');
    const prior = await this.store.get<unknown>(meetingKey(identity.meetingId)); if (!prior) throw new Error('meeting_missing');
    const meeting = meetingSchema.parse(prior.data);
    if (meeting.outcome?.status === 'cancelled') outcome = meeting.outcome;
    if (meeting.commandId !== commandId && outcome.status !== 'cancelled') throw new Error('stale_meeting_outcome');
    const head = await this.store.get<unknown>(calendarKey(identity.calendarId)); if (!head) throw new Error('calendar_missing'); const calendar = calendarSchema.parse(head.data);
    const active = outcome.status === 'cancelled' && calendar.activeCommandId && calendar.activeCommandId !== commandId
      ? await this.store.get<unknown>(meetingCommandKey(calendar.activeCommandId)) : null;
    const activeRecord = active ? meetingReservationSchema.parse(active.data) : null;
    const settleActive = activeRecord && activeRecord.intent.accountId === record.intent.accountId
      && fingerprint(activeRecord.identity) === fingerprint(identity);
    const cleanup = outcome.status === 'cancelled' && (calendar.activeCommandId === commandId || settleActive || calendar.occupied.some(o => o.meetingId === identity.meetingId));
    if (fingerprint(meeting.outcome) === fingerprint(outcome) && fingerprint(record.outcome) === fingerprint(outcome) && !cleanup) {
      await this.publishRecorded([record.reservationSequence, record.outcomeSequence]); return outcome;
    }
    if (meeting.history.length >= 200) throw new Error('meeting_history_capacity_exceeded');
    let occupied = calendar.occupied;
    if (outcome.status === 'cancelled') occupied = occupied.filter(o => o.meetingId !== identity.meetingId);
    // Unknown and held provider-backed states retain ALL old/new intervals.
    if (outcome.status === 'booked' && outcome.event?.start && outcome.event.end) {
      occupied = occupied.filter(o => o.meetingId !== identity.meetingId);
      occupied.push({ meetingId: identity.meetingId, start: Date.parse(outcome.event.start) - record.rules.bufferBeforeMinutes * 60000, end: Date.parse(outcome.event.end) + record.rules.bufferAfterMinutes * 60000 });
    }
    const authKey = executionAuthorityKey(record.intent.accountId); const auth = await this.store.get<unknown>(authKey);
    if (!auth) throw new Error('authority_missing'); const current = authorityRecordSchema.parse(auth.data);
    if (current.authority.accountId !== record.intent.accountId) throw new Error('authority_identity_conflict');
    const next = { ...current, version: current.version + 1 };
    const outbox = await this.store.eventItems(workerEventSchema.parse({ id: `meeting-${fingerprint([commandId, prior.rev, outcome])}`, workspaceId: record.intent.workspaceId,
      accountId: record.intent.accountId, authorityGeneration: record.intent.expectedAuthorityGeneration, aggregateVersion: next.version,
      kind: 'meeting.outcome', payload: { commandId, outcome, observedAt: this.store.now() } }));
    await this.store.transact([this.store.put(authKey, next, auth.rev, executionAuthorityFields(next), executionAuthorityFields(current)),
      ...outbox.items, ...(settleActive && active && activeRecord ? [this.store.put(meetingCommandKey(calendar.activeCommandId!), { ...activeRecord, state: 'recorded', outcome, outcomeSequence: outbox.sequence }, active.rev)] : []), this.store.put(meetingCommandKey(commandId), { ...record, state: 'recorded', outcome, outcomeSequence: outbox.sequence }, command.rev),
      this.store.put(meetingKey(identity.meetingId), { ...meeting, outcome, history: [...meeting.history, outcome] }, prior.rev),
      this.store.put(calendarKey(identity.calendarId), { occupied, activeCommandId: (calendar.activeCommandId === commandId || settleActive) && outcome.status !== 'unknown' ? null : calendar.activeCommandId }, head.rev)]);
    await this.publishRecorded([record.reservationSequence, outbox.sequence]);
    return outcome;
  }
}
