import type { RepositoryContext } from '../db/workspaceScope.ts';
import { providerFunding, providerKind, CREDIT_FUNDED_PROVIDER_KINDS } from '../settings/funding.ts';
import { localDate } from '../src/rules/localClock.ts';
import { lockMonthlySpend, type Spend } from './ledger.ts';

/** Modeled credit-funded MODEL usage only, not AWS totals, Transcribe or credit balance. */
export const DAILY_CREDIT_MODEL_CAP_CENTS = 5000;

export type ModelBudgetRefusalCode = 'credit_model_daily_ceiling' | 'model_reservation_stale' | 'model_reservation_mismatch';

/** Admission refused before dispatch. Callers must not retry this as a provider failure. */
export class ModelBudgetRefusal extends Error {
  readonly retryable = false;
  readonly refusedBeforeGeneration = true;
  constructor(readonly code: ModelBudgetRefusalCode) {
    super(code);
    this.name = 'ModelBudgetRefusal';
  }
}

/** Transcribe shares credit funding but has independent transcription/call limits. */
export function isCreditModelProvider(providerKey: string): boolean {
  return providerFunding(providerKey) === 'credits' && providerKind(providerKey) !== 'aws_transcribe';
}

/** Settled/estimated costs live in the ledger, only open obligations are added. */
export async function readCreditModelSpend(
  context: RepositoryContext,
  input: { readonly at: string; readonly businessTimeZone: string },
): Promise<Spend> {
  const date = localDate(input.at, input.businessTimeZone);
  const { rows } = await context.db.query<{ today: string | null; month: string | null }>(
    `WITH spend AS (
       SELECT business_date, cost_cents AS cents FROM provider_ledger
        WHERE workspace_id = $1 AND split_part(provider_key, '.', 1) = ANY($4::text[])
       UNION ALL
       SELECT business_date, cents FROM provider_reservations
        WHERE workspace_id = $1 AND state IN ('reserved', 'calling')
          AND split_part(provider_key, '.', 1) = ANY($4::text[])
     )
     SELECT sum(cents) FILTER (WHERE business_date = $2::date) AS today,
            sum(cents) FILTER (WHERE business_date BETWEEN $3::date AND $2::date) AS month
       FROM spend`,
    [context.scope.workspaceId, date, `${date.slice(0, 7)}-01`, CREDIT_FUNDED_PROVIDER_KINDS.filter(kind => kind !== 'aws_transcribe')],
  );
  return { todayCents: Number(rows[0]?.today ?? 0), monthToDateCents: Number(rows[0]?.month ?? 0) };
}

/** Lane locks first, shared spend lock last, held through insert/mark and COMMIT. */
export async function clearCreditModelBudget(
  context: RepositoryContext,
  input: { readonly providerKey: string; readonly at: string; readonly businessTimeZone: string; readonly additionalCents: number },
): Promise<void> {
  if (!isCreditModelProvider(input.providerKey)) return;
  await lockMonthlySpend(context);
  const spend = await readCreditModelSpend(context, input);
  if (spend.todayCents + input.additionalCents > DAILY_CREDIT_MODEL_CAP_CENTS) {
    throw new ModelBudgetRefusal('credit_model_daily_ceiling');
  }
}
