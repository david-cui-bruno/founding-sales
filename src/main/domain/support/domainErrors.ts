export class NestedDomainTransactionError extends Error {
  constructor() {
    super('A domain transaction is already active.');
    this.name = 'NestedDomainTransactionError';
  }
}

export class AsyncDomainTransactionError extends Error {
  constructor() {
    super('Domain transactions must complete synchronously.');
    this.name = 'AsyncDomainTransactionError';
  }
}

export class DomainTransactionRequiredError extends Error {
  constructor() {
    super('Domain repository mutations require an active DomainUnitOfWork transaction.');
    this.name = 'DomainTransactionRequiredError';
  }
}

export class DomainRepositoryDatabaseMismatchError extends Error {
  constructor() {
    super('Domain repository database must match its DomainUnitOfWork database.');
    this.name = 'DomainRepositoryDatabaseMismatchError';
  }
}

export class IdempotencyOwnershipConflictError extends Error {
  readonly adapter: string;
  readonly providerIdempotencyKey: string;

  constructor(adapter: string, providerIdempotencyKey: string) {
    super('The provider event is already owned by a different domain identity.');
    this.name = 'IdempotencyOwnershipConflictError';
    this.adapter = adapter;
    this.providerIdempotencyKey = providerIdempotencyKey;
  }
}

export class ContextLinkConflictError extends Error {
  readonly contextKind: 'organization' | 'property';
  readonly prospectId: string;
  readonly contextId: string;

  constructor(
    contextKind: 'organization' | 'property',
    prospectId: string,
    contextId: string,
  ) {
    super('The prospect context link already exists with different relationship data.');
    this.name = 'ContextLinkConflictError';
    this.contextKind = contextKind;
    this.prospectId = prospectId;
    this.contextId = contextId;
  }
}

export class ActivityMediaConsentError extends Error {
  constructor() {
    super('Managed activity media requires applicable recording consent.');
    this.name = 'ActivityMediaConsentError';
  }
}

export class StaleDomainWriteError extends Error {
  constructor() {
    super('The domain projection changed before this command could commit.');
    this.name = 'StaleDomainWriteError';
  }
}

export class LifecycleConflictError extends Error {
  constructor(message = 'The lifecycle command conflicts with durable state.') {
    super(message);
    this.name = 'LifecycleConflictError';
  }
}

export class LifecycleEligibilityError extends Error {
  constructor(message = 'The lifecycle command is not eligible for this Person or Prospect.') {
    super(message);
    this.name = 'LifecycleEligibilityError';
  }
}

export class LifecycleEvidenceError extends Error {
  constructor(message = 'The lifecycle command lacks qualifying immutable evidence.') {
    super(message);
    this.name = 'LifecycleEvidenceError';
  }
}

export class LifecycleIdempotencyConflictError extends Error {
  constructor() {
    super('The lifecycle idempotency key already exists for a different command.');
    this.name = 'LifecycleIdempotencyConflictError';
  }
}

export class OperationalCycleExistsError extends Error {
  readonly personId: string;

  constructor(personId: string) {
    super('The Person already has an active or onboarding SalesCycle.');
    this.name = 'OperationalCycleExistsError';
    this.personId = personId;
  }
}

export class LifecycleInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LifecycleInvariantError';
  }
}

export class OptOutPersistenceConflictError extends Error {
  readonly recordKind: 'tombstone' | 'handle';
  readonly recordId: string;

  constructor(recordKind: 'tombstone' | 'handle', recordId: string) {
    super('The permanent opt-out record already exists with different immutable content.');
    this.name = 'OptOutPersistenceConflictError';
    this.recordKind = recordKind;
    this.recordId = recordId;
  }
}

export class OutboundContactBlockedError extends Error {
  readonly reasonCode = 'person_or_handle_opted_out' as const;
  readonly tombstoneIds: readonly string[];

  constructor(tombstoneIds: readonly string[]) {
    super('Outbound contact is blocked by permanent opt-out evidence.');
    this.name = 'OutboundContactBlockedError';
    this.tombstoneIds = Object.freeze([...tombstoneIds]);
  }
}
