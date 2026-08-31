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
