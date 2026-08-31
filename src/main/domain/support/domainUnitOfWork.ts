import { AsyncLocalStorage } from 'node:async_hooks';

import type { AppDatabase } from '../../db/database';
import {
  AsyncDomainTransactionError,
  DomainTransactionRequiredError,
  NestedDomainTransactionError,
} from './domainErrors';

type DomainScope = {
  owner: DomainUnitOfWork;
  active: boolean;
};

type RejectPromiseLike<T> = 'then' extends keyof T
  ? T extends { then: (...arguments_: never[]) => unknown }
    ? never
    : unknown
  : unknown;

const domainScopeStorage = new AsyncLocalStorage<DomainScope>();

export class DomainUnitOfWork {
  constructor(readonly database: AppDatabase) {}

  immediate<T>(operation: () => T & RejectPromiseLike<T>): T {
    const inheritedScope = domainScopeStorage.getStore();
    if (this.database.raw.inTransaction || inheritedScope?.active === true) {
      throw new NestedDomainTransactionError();
    }
    if (inheritedScope !== undefined) {
      throw new AsyncDomainTransactionError();
    }

    const scope: DomainScope = { owner: this, active: true };
    const transaction = this.database.raw.transaction(() => domainScopeStorage.run(scope, () => {
      const result = operation();
      if (isPromiseLike(result)) {
        throw new AsyncDomainTransactionError();
      }
      return result as T;
    }));

    try {
      return transaction.immediate();
    } finally {
      scope.active = false;
    }
  }

  assertWriteScope(): void {
    const scope = domainScopeStorage.getStore();
    if (
      scope?.owner !== this
      || scope.active !== true
      || !this.database.raw.inTransaction
    ) {
      throw new DomainTransactionRequiredError();
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' && value !== null)
    || typeof value === 'function'
  ) && typeof (value as { then?: unknown }).then === 'function';
}
