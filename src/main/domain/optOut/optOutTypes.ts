import { z } from 'zod';

import type { Activity, AppendActivityInput } from '../events/eventTypes';
import type { SalesCycle } from '../lifecycle/lifecycleTypes';

export const optOutIdSchema = z.string().trim().min(1);
export const optOutUtcTimestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => {
    const timestamp = new Date(value);
    return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
  },
  'Timestamp must use canonical UTC ISO format.',
);
export const optOutObservedChannelSchema = z.enum([
  'manual', 'imessage', 'gmail', 'call', 'identity_propagation',
]);
export const optOutHandleKindSchema = z.enum(['phone', 'email']);

export type OptOutObservedChannel = z.infer<typeof optOutObservedChannelSchema>;
export type OptOutHandleKind = z.infer<typeof optOutHandleKindSchema>;

export type OptOutTombstone = Readonly<{
  id: string;
  personId: string;
  requestedAt: string;
  observedChannel: OptOutObservedChannel;
  sourceActivityId: string;
  evidenceRef: string | null;
  policyVersion: string;
  createdAt: string;
}>;

export type OptOutHandle = Readonly<{
  id: string;
  tombstoneId: string;
  kind: OptOutHandleKind;
  normalizedValue: string;
  createdAt: string;
}>;

export type InsertOptOutTombstoneInput = OptOutTombstone;
export type InsertOptOutHandleInput = OptOutHandle;

export type OptOutEvidence =
  | Readonly<{ kind: 'existing_activity'; activityId: string }>
  | Readonly<{
    kind: 'append_activity';
    activity: AppendActivityInput & { id: string; occurredAt: string };
  }>;

export type ApplyOptOutInput = Readonly<{
  personId: string;
  tombstoneId: string;
  requestedAt: string;
  policyVersion: 'founder_opt_out_v1';
  decision:
    | { kind: 'structured_written'; channel: 'imessage' | 'gmail' }
    | { kind: 'founder_confirmed'; channel: 'manual' | 'call' };
  evidence: OptOutEvidence;
  terminalStageEventId: string | null;
}>;

export type ApplyOptOutResult = Readonly<{
  tombstone: OptOutTombstone;
  handles: readonly OptOutHandle[];
  cycle: SalesCycle | null;
  alreadyApplied: boolean;
}>;

export type OptOutFaultPoint =
  | 'after_activity'
  | 'after_lifecycle_close'
  | 'after_tombstone'
  | 'after_handle'
  | 'after_postcondition';

export type OutboundPermission =
  | Readonly<{ kind: 'allowed' }>
  | Readonly<{
    kind: 'blocked';
    tombstoneIds: readonly string[];
    matchedHandles: ReadonlyArray<Readonly<{
      kind: OptOutHandleKind;
      normalizedValue: string;
    }>>;
  }>;

export type TodaySelectedCallReceiptV1 = Readonly<{
  version: 1;
  kind: 'discretionary_call';
  currentActionId: string;
  queueGeneratedAt: string;
  queueTimezone: string;
  queueLocalDate: string;
}>;

export const todaySelectedCallReceiptV1Schema = z.object({
  version: z.literal(1),
  kind: z.literal('discretionary_call'),
  currentActionId: optOutIdSchema,
  queueGeneratedAt: optOutUtcTimestampSchema,
  queueTimezone: z.string().trim().min(1).refine((timezone) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
      return true;
    } catch {
      return false;
    }
  }, 'Queue timezone must be a valid IANA timezone.'),
  queueLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year!, month! - 1, day!));
    return date.getUTCFullYear() === year
      && date.getUTCMonth() === month! - 1
      && date.getUTCDate() === day;
  }, 'Queue local date must be a real ISO calendar date.'),
}).strict().superRefine((value, context) => {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: value.queueTimezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(value.queueGeneratedAt));
  } catch {
    return;
  }
  const part = (type: Intl.DateTimeFormatPartTypes): string | undefined => (
    parts.find((candidate) => candidate.type === type)?.value
  );
  const actual = `${part('year')}-${part('month')}-${part('day')}`;
  if (actual !== value.queueLocalDate) {
    context.addIssue({
      code: z.ZodIssueCode.custom, path: ['queueLocalDate'],
      message: 'Queue local date must match the generated instant and timezone.',
    });
  }
});

export type RecordPastOffAppTouchInput = Readonly<{
  personId: string;
  reportedAt: string;
  activity: AppendActivityInput & {
    id: string;
    occurredAt: string;
    direction: 'outbound';
  };
}>;

export type PropagateOptOutInput = Readonly<{
  sourceTombstoneId: string;
  targetPersonId: string;
  targetTombstoneId: string;
  evidenceActivity: AppendActivityInput & { id: string; occurredAt: string };
  terminalStageEventId: string | null;
}>;

export type RecordPastOffAppTouchResult = Activity;
