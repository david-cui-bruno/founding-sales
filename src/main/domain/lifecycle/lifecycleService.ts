import type { AppDatabase } from '../../db/database';
import { DomainRepositoryDatabaseMismatchError } from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import {
  LifecycleTransactionWriter,
  type ApplyProspectingTriggerInput,
  type CompleteOnboardingInput,
  type CompleteCurrentActionInput,
  type CloseLostNurtureInput,
  type ConfirmInterviewedInput,
  type ConfirmOfferedInput,
  type ConfirmWonInput,
  type CreateUnreviewedCycleInput,
  type LifecycleCommands,
  type LifecycleWriterDependencies,
  type RecordContactInput,
  type ReactivateFromInboundInput,
  type ReactivateFromRuleInput,
  type ReactivationResult,
  type ReviewToReadyInput,
  type SetCloseReadinessInput,
  type SetDesignPartnerFitnessInput,
} from './lifecycleTransactionWriter';
import type { CloseReadiness, SalesCycle } from './lifecycleTypes';

export class LifecycleService implements LifecycleCommands {
  private readonly database: AppDatabase;
  private readonly unitOfWork: DomainUnitOfWork;
  private readonly writer: LifecycleTransactionWriter;

  constructor(input: LifecycleWriterDependencies) {
    if (input.database.raw !== input.unitOfWork.database.raw) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
    this.database = input.database;
    this.unitOfWork = input.unitOfWork;
    this.writer = new LifecycleTransactionWriter(input);
  }

  assertBoundTo(database: AppDatabase, unitOfWork: DomainUnitOfWork): void {
    if (this.database.raw !== database.raw || this.unitOfWork !== unitOfWork) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
  }

  scopedWriter(): LifecycleTransactionWriter {
    this.unitOfWork.assertWriteScope();
    return this.writer;
  }

  createUnreviewedCycle(input: CreateUnreviewedCycleInput): SalesCycle {
    return this.unitOfWork.immediate(() => this.writer.createUnreviewedCycle(input));
  }

  reviewToReady(input: ReviewToReadyInput): SalesCycle {
    return this.unitOfWork.immediate(() => this.writer.reviewToReady(input));
  }

  recordQualifyingContact(input: RecordContactInput): SalesCycle {
    return this.unitOfWork.immediate(() => this.writer.recordQualifyingContact(input));
  }
  confirmInterviewed(input: ConfirmInterviewedInput): SalesCycle {
    return this.unitOfWork.immediate(() => this.writer.confirmInterviewed(input));
  }
  confirmOffered(input: ConfirmOfferedInput): SalesCycle {
    return this.unitOfWork.immediate(() => this.writer.confirmOffered(input));
  }
  confirmWon(input: ConfirmWonInput): SalesCycle {
    return this.unitOfWork.immediate(() => this.writer.confirmWon(input));
  }
  completeCurrentAction(input: CompleteCurrentActionInput): SalesCycle {
    return this.unitOfWork.immediate(() => this.writer.completeCurrentAction(input));
  }
  closeLostNurture(input: CloseLostNurtureInput): SalesCycle {
    return this.unitOfWork.immediate(() => this.writer.closeLostNurture(input));
  }
  completeOnboarding(input: CompleteOnboardingInput): SalesCycle {
    return this.unitOfWork.immediate(() => this.writer.completeOnboarding(input));
  }
  reactivateFromRule(input: ReactivateFromRuleInput): ReactivationResult {
    return this.unitOfWork.immediate(() => this.writer.reactivateFromRule(input));
  }
  reactivateFromInboundResponse(input: ReactivateFromInboundInput): ReactivationResult {
    return this.unitOfWork.immediate(() => this.writer.reactivateFromInboundResponse(input));
  }
  setDesignPartnerFitness(input: SetDesignPartnerFitnessInput): SalesCycle {
    return this.unitOfWork.immediate(() => this.writer.setDesignPartnerFitness(input));
  }
  setCloseReadiness(input: SetCloseReadinessInput): CloseReadiness {
    return this.unitOfWork.immediate(() => this.writer.setCloseReadiness(input));
  }
  applyProspectingTrigger(input: ApplyProspectingTriggerInput): SalesCycle {
    return this.unitOfWork.immediate(() => this.writer.applyProspectingTrigger(input));
  }
}
