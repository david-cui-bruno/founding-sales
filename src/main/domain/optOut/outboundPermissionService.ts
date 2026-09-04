import type { AppDatabase } from '../../db/database';
import type { IdentityRepository } from '../identity/identityRepository';
import { FOUNDER_CHANNEL_POLICIES_V1, type ChannelPolicySnapshots } from '../cadence/cadenceScheduler';
import { JurisdictionRepository } from '../compliance/jurisdictionRepository';
import {
  evaluateOutboundAuthorization,
  type OutboundAuthorizationDecision,
} from '../compliance/outboundAuthorization';
import {
  DomainRepositoryDatabaseMismatchError,
  OutboundAuthorizationError,
  OutboundContactBlockedError,
  StaleDomainWriteError,
} from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import type { OptOutRepository } from './optOutRepository';
import {
  type OptOutHandleKind,
  type OutboundPermission,
  type TodaySelectedCallReceiptV1,
  todaySelectedCallReceiptV1Schema,
} from './optOutTypes';

export class OutboundPermissionService {
  private readonly database: AppDatabase;
  private readonly unitOfWork: DomainUnitOfWork;
  private readonly identities: IdentityRepository;
  private readonly optOuts: OptOutRepository;
  private readonly jurisdictions: JurisdictionRepository;
  private readonly windows: ChannelPolicySnapshots;

  constructor(input: {
    database: AppDatabase;
    unitOfWork: DomainUnitOfWork;
    identities: IdentityRepository;
    optOuts: OptOutRepository;
    jurisdictions?: JurisdictionRepository;
    windows?: ChannelPolicySnapshots;
  }) {
    if (input.database.raw !== input.unitOfWork.database.raw) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
    input.identities.assertBoundTo(input.database, input.unitOfWork);
    input.optOuts.assertBoundTo(input.database, input.unitOfWork);
    const jurisdictions = input.jurisdictions ?? new JurisdictionRepository({
      database: input.database, unitOfWork: input.unitOfWork,
    });
    jurisdictions.assertBoundTo(input.database, input.unitOfWork);
    this.database = input.database;
    this.unitOfWork = input.unitOfWork;
    this.identities = input.identities;
    this.optOuts = input.optOuts;
    this.jurisdictions = jurisdictions;
    this.windows = input.windows ?? FOUNDER_CHANNEL_POLICIES_V1;
  }

  assertBoundTo(database: AppDatabase, unitOfWork: DomainUnitOfWork): void {
    if (this.database.raw !== database.raw || this.unitOfWork !== unitOfWork) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
    this.identities.assertBoundTo(database, unitOfWork);
    this.optOuts.assertBoundTo(database, unitOfWork);
    this.jurisdictions.assertBoundTo(database, unitOfWork);
  }

  inspectPerson(personId: string): OutboundPermission {
    const person = this.identities.getPerson(personId);
    if (person === null) throw new Error('Outbound permission Person does not exist.');
    const tombstoneIds = new Set<string>();
    const matched = new Map<string, { kind: OptOutHandleKind; normalizedValue: string }>();
    const direct = this.optOuts.getForPerson(person.id);
    if (direct !== null) tombstoneIds.add(direct.id);
    for (const contact of this.identities.listContactMethodsForPerson(person.id)) {
      const blocks = this.optOuts.listBlocksForHandle(contact.kind, contact.normalizedValue);
      if (blocks.length === 0) continue;
      matched.set(`${contact.kind}:${contact.normalizedValue}`, {
        kind: contact.kind, normalizedValue: contact.normalizedValue,
      });
      blocks.forEach(({ id }) => tombstoneIds.add(id));
    }
    return permission(tombstoneIds, matched);
  }

  assertMayContactPerson(personId: string): void {
    assertAllowed(this.inspectPerson(personId));
  }

  assertMayContactHandle(kind: OptOutHandleKind, normalizedValue: string): void {
    const blocks = this.optOuts.listBlocksForHandle(kind, normalizedValue);
    if (blocks.length > 0) {
      throw new OutboundContactBlockedError(blocks.map(({ id }) => id));
    }
  }

  inspectOutbound(input: {
    personId: string;
    contactMethodId: string;
    channel: 'call' | 'text';
    now: string;
  }): OutboundAuthorizationDecision {
    this.unitOfWork.assertWriteScope();
    const contact = this.identities.getContactMethod(input.contactMethodId);
    if (contact === null || contact.personId !== input.personId) {
      throw new Error('Outbound contact method does not belong to the Person.');
    }
    const jurisdiction = this.jurisdictions.getPersonJurisdiction(input.personId);
    return evaluateOutboundAuthorization({
      channel: input.channel,
      now: input.now,
      personOrHandleOptedOut: this.identities.isPersonOrHandleOptedOut(input.personId, {
        kind: contact.kind, normalizedValue: contact.normalizedValue,
      }),
      contact: {
        kind: contact.kind,
        normalizedValue: contact.normalizedValue,
        validationState: contact.validationState,
        evidence: contact.complianceEvidence,
      },
      jurisdiction,
      clearance: jurisdiction === null
        ? null
        : this.jurisdictions.getClearance(jurisdiction.regionCode, input.channel),
      windows: this.windows,
    });
  }

  assertMayExecuteOutbound(input: {
    personId: string;
    contactMethodId: string;
    channel: 'call' | 'text';
    now: string;
  }): void {
    const decision = this.inspectOutbound(input);
    if (decision.kind === 'refused') throw new OutboundAuthorizationError(decision.reasonCode);
  }

  assertCurrentSelectedCallReceipt(input: {
    personId: string;
    receipt: TodaySelectedCallReceiptV1;
  }): void {
    this.unitOfWork.assertWriteScope();
    const receipt = todaySelectedCallReceiptV1Schema.parse(input.receipt);
    const row = this.database.raw.prepare(`
      SELECT action.id
      FROM sales_cycles AS cycle
      JOIN next_actions AS action ON action.id = cycle.current_next_action_id
      WHERE cycle.person_id = ?
        AND cycle.workflow_status = 'active'
        AND action.id = ?
        AND action.sales_cycle_id = cycle.id
        AND action.status = 'pending'
        AND action.action_type = 'call'
        AND action.channel = 'phone'
        AND action.work_intent = 'discretionary_prospecting'
    `).get(input.personId, receipt.currentActionId);
    if (row === undefined) throw new StaleDomainWriteError();
  }
}

function permission(
  tombstoneIds: Set<string>,
  matched: Map<string, { kind: OptOutHandleKind; normalizedValue: string }>,
): OutboundPermission {
  if (tombstoneIds.size === 0) return Object.freeze({ kind: 'allowed' });
  const matchedHandles = [...matched.values()].sort((left, right) => (
    left.kind.localeCompare(right.kind)
    || left.normalizedValue.localeCompare(right.normalizedValue)
  )).map((value) => Object.freeze({ ...value }));
  return Object.freeze({
    kind: 'blocked',
    tombstoneIds: Object.freeze([...tombstoneIds].sort()),
    matchedHandles: Object.freeze(matchedHandles),
  });
}

function assertAllowed(result: OutboundPermission): void {
  if (result.kind === 'blocked') {
    throw new OutboundContactBlockedError(result.tombstoneIds);
  }
}
