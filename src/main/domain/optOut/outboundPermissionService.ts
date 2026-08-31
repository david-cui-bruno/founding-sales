import type { AppDatabase } from '../../db/database';
import type { IdentityRepository } from '../identity/identityRepository';
import {
  DomainRepositoryDatabaseMismatchError,
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

  constructor(input: {
    database: AppDatabase;
    unitOfWork: DomainUnitOfWork;
    identities: IdentityRepository;
    optOuts: OptOutRepository;
  }) {
    if (input.database.raw !== input.unitOfWork.database.raw) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
    input.identities.assertBoundTo(input.database, input.unitOfWork);
    input.optOuts.assertBoundTo(input.database, input.unitOfWork);
    this.database = input.database;
    this.unitOfWork = input.unitOfWork;
    this.identities = input.identities;
    this.optOuts = input.optOuts;
  }

  assertBoundTo(database: AppDatabase, unitOfWork: DomainUnitOfWork): void {
    if (this.database.raw !== database.raw || this.unitOfWork !== unitOfWork) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
    this.identities.assertBoundTo(database, unitOfWork);
    this.optOuts.assertBoundTo(database, unitOfWork);
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

  assertMayExecuteOutbound(input: {
    personId: string;
    target: { kind: OptOutHandleKind; normalizedValue: string };
  }): void {
    this.unitOfWork.assertWriteScope();
    const personPermission = this.inspectPerson(input.personId);
    const targetBlocks = this.optOuts.listBlocksForHandle(
      input.target.kind, input.target.normalizedValue,
    );
    const tombstoneIds = new Set(
      personPermission.kind === 'blocked' ? personPermission.tombstoneIds : [],
    );
    targetBlocks.forEach(({ id }) => tombstoneIds.add(id));
    if (tombstoneIds.size > 0) {
      throw new OutboundContactBlockedError([...tombstoneIds].sort());
    }
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
