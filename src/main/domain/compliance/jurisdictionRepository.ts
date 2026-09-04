import { z } from 'zod';

import type { AppDatabase } from '../../db/database';
import { DomainRepositoryDatabaseMismatchError } from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import type { OutboundChannel } from './outboundAuthorization';

const idSchema = z.string().trim().min(1);
const regionSchema = z.string().regex(/^[A-Z]{2}$/);
const timestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => new Date(value).toISOString() === value,
);
const jurisdictionRowSchema = z.object({
  region_code: regionSchema,
  timezone: z.string().trim().min(1),
  review_at: timestampSchema.nullable(),
}).strict();
const clearanceRowSchema = z.object({
  decision: z.enum(['unknown', 'allowed', 'blocked']),
  registration_confirmed: z.union([z.literal(0), z.literal(1)]).nullable(),
  state_dnc_subscription_confirmed: z.union([z.literal(0), z.literal(1)]).nullable(),
  consent_rule_confirmed: z.union([z.literal(0), z.literal(1)]).nullable(),
  effective_at: timestampSchema,
  expires_at: timestampSchema.nullable(),
}).strict();

export type PersonOutboundJurisdiction = Readonly<{
  regionCode: string;
  timezone: string;
  reviewAt: string | null;
}>;
export type OutboundJurisdictionClearance = Readonly<{
  decision: 'unknown' | 'allowed' | 'blocked';
  registrationConfirmed: boolean | null;
  stateDncSubscriptionConfirmed: boolean | null;
  consentRuleConfirmed: boolean | null;
  effectiveAt: string;
  expiresAt: string | null;
}>;

function boolean(value: 0 | 1 | null): boolean | null {
  return value === null ? null : value === 1;
}

export class JurisdictionRepository {
  private readonly database: AppDatabase;
  private readonly unitOfWork: DomainUnitOfWork;

  constructor(input: { database: AppDatabase; unitOfWork: DomainUnitOfWork }) {
    if (input.database.raw !== input.unitOfWork.database.raw) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
    this.database = input.database;
    this.unitOfWork = input.unitOfWork;
  }

  assertBoundTo(database: AppDatabase, unitOfWork: DomainUnitOfWork): void {
    if (database.raw !== unitOfWork.database.raw || unitOfWork !== this.unitOfWork) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
  }

  getPersonJurisdiction(personId: string): PersonOutboundJurisdiction | null {
    const row = this.database.raw.prepare(`SELECT region_code, timezone, review_at
      FROM person_outbound_jurisdictions WHERE person_id = ?`).get(idSchema.parse(personId));
    if (row === undefined) return null;
    const parsed = jurisdictionRowSchema.parse(row);
    return { regionCode: parsed.region_code, timezone: parsed.timezone, reviewAt: parsed.review_at };
  }

  getClearance(regionCode: string, channel: OutboundChannel): OutboundJurisdictionClearance | null {
    const row = this.database.raw.prepare(`SELECT decision, registration_confirmed,
      state_dnc_subscription_confirmed, consent_rule_confirmed, effective_at, expires_at
      FROM outbound_jurisdiction_clearances WHERE region_code = ? AND channel = ?`)
      .get(regionSchema.parse(regionCode), channel);
    if (row === undefined) return null;
    const parsed = clearanceRowSchema.parse(row);
    return {
      decision: parsed.decision,
      registrationConfirmed: boolean(parsed.registration_confirmed),
      stateDncSubscriptionConfirmed: boolean(parsed.state_dnc_subscription_confirmed),
      consentRuleConfirmed: boolean(parsed.consent_rule_confirmed),
      effectiveAt: parsed.effective_at,
      expiresAt: parsed.expires_at,
    };
  }
}
