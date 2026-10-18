import { crmForwardCaptureScopeSchema, type CrmForwardCaptureScope } from '@fss/contracts';
import { z } from 'zod';

/** approvedAt must be the exact DB-observed ISO timestamp used for the immutable
 * owner approval, not an application clock. Date.parse floors submilliseconds;
 * adding one millisecond equals date_trunc('milliseconds', approved_at) + 1ms.
 * Select approved_at as an ISO text value when re-deriving an existing epoch.
 */
export function forwardCaptureScopeForApproval(approvedAt: string): CrmForwardCaptureScope | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(approvedAt)
    || !z.iso.datetime().safeParse(approvedAt).success) return null;
  const instant = Date.parse(approvedAt);
  if (!Number.isSafeInteger(instant) || !Number.isSafeInteger(instant + 1)) return null;
  const parsed = crmForwardCaptureScopeSchema.safeParse({
    mode: 'forward_only', enabledAt: new Date(instant + 1).toISOString(),
  });
  return parsed.success ? parsed.data : null;
}

/** Each original's provider INTERNAL date, never a conversation's latest date.
 * Invalid/missing scope and dates fail closed. Existing future-date policy is
 * independently retained at metadata admission and fresh provider validation.
 */
export function isForwardCaptureDateAllowed(scope: CrmForwardCaptureScope, internalDateEpochMilliseconds: number): boolean {
  const parsed = crmForwardCaptureScopeSchema.safeParse(scope);
  return parsed.success && Number.isSafeInteger(internalDateEpochMilliseconds)
    && internalDateEpochMilliseconds >= Date.parse(parsed.data.enabledAt);
}

export function sameForwardCaptureScope(a: CrmForwardCaptureScope, b: CrmForwardCaptureScope): boolean {
  const left = crmForwardCaptureScopeSchema.safeParse(a);
  const right = crmForwardCaptureScopeSchema.safeParse(b);
  return left.success && right.success && left.data.enabledAt === right.data.enabledAt;
}
