import { AccountRepository } from './accountRepository';
import type { AppDatabase } from '../../db/database';
import type { Clock } from '../support/clock';
import type { IdGenerator } from '../support/idGenerator';
import type { LocalCompanyInput, LocalCompanyCreateRequest, LocalCompanyReview, LocalCompanyCreateResult, LocalCompanyCreateStatus } from '../../../shared/contracts/localCompanyIntakeContract';
/** Dedicated local-only intake policy, sharing the ordinary account receipt store. */
export class LocalCompanyIntake {
  private readonly accounts: AccountRepository;
  constructor(deps: { database: AppDatabase; clock: Clock; ids: IdGenerator }) { this.accounts = new AccountRepository(deps); }
  review(input: LocalCompanyInput): LocalCompanyReview { return this.accounts.reviewLocalCompany(input); }
  create(input: LocalCompanyCreateRequest): LocalCompanyCreateResult { return this.accounts.createLocalCompany(input); }
  status(input: LocalCompanyCreateRequest): LocalCompanyCreateStatus { return this.accounts.getLocalCompanyCreateStatus(input); }
}
