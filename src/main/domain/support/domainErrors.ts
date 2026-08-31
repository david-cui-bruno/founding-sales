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
