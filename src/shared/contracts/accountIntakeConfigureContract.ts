import { z } from 'zod';
import { accountIdSchema as id, accountInstantSchema as instant } from './accountContract';
import { commandReceiptSchema } from './commandReceiptContract';
import { configureOwnerCommandSchema, ownerSourceConfigurationSchema } from './ownerCommandContract';
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** One explicit intake change for one company. Every value travels exactly as the founder read it
 * (revision, mailbox, calendar) or as the connected grant reports it (mailbox subject, owned calendar);
 * nothing here is typed. The runtime binds workspace, pairing, authority generation, execution version,
 * the preserved research configuration and the scope's envelope revision from the device pairing and a
 * fresh owner read. Configuration is not readiness, and a configured mailbox is not permission to send. */
export const configureAccountIntakeSchema = z.strictObject({ accountId: id, expectedConfigurationRevision: revision, state: z.enum(['paused', 'active']),
  mailboxSubject: id.nullable(), calendarId: id.nullable(),
  /** Start of the read window. Non-null only when relevant mail is switched on for the first time. */
  mailSince: instant.nullable() });
export type ConfigureAccountIntake = z.infer<typeof configureAccountIntakeSchema>;
/** Worker admission rules mirrored before anything is queued (the worker's codes verbatim), plus runtime holds. */
export const accountIntakeHoldReasonSchema = z.enum(['stale_source_configuration', 'source_grant_unavailable', 'selected_scope_incomplete', 'no_mail_configuration_conflict', 'inactive_scope_change',
  'intake_owner_inactive', 'intake_owner_stale', 'intake_command_pending', 'intake_configuration_conflict', 'intake_mailbox_mismatch', 'intake_calendar_unavailable']);
export type AccountIntakeHoldReason = z.infer<typeof accountIntakeHoldReasonSchema>;
export const intakeMailScopeSchema = configureOwnerCommandSchema.shape.payload.shape.mailScope;
const held = z.strictObject({ status: z.literal('held'), accountId: id, expectedConfigurationRevision: revision, reason: accountIntakeHoldReasonSchema });
const queued = z.strictObject({ status: z.literal('queued'), accountId: id, commandId: z.uuid(), expectedConfigurationRevision: revision,
  configuration: ownerSourceConfigurationSchema, mailScope: intakeMailScopeSchema, receipt: commandReceiptSchema })
  .refine(status => status.configuration.accountId === status.accountId && status.configuration.revision === status.expectedConfigurationRevision + 1
    && status.receipt.commandId === status.commandId && (status.mailScope === null || status.configuration.state === 'active' && status.configuration.mailboxSubject !== null), 'intake_status_binding');
/** Local projection of one intake change: an honest hold (nothing queued) or the queued configure-owner
 * command with its current receipt. A receipt, even applied, admits the configuration; it is never readiness. */
export const accountIntakeConfigureStatusSchema = z.discriminatedUnion('status', [held, queued]);
export type AccountIntakeConfigureStatus = z.infer<typeof accountIntakeConfigureStatusSchema>;
export type QueuedAccountIntakeConfigure = Extract<AccountIntakeConfigureStatus, { status: 'queued' }>;
/** The exact request that produced a queued status. Retrying it reuses the stored command; nothing is guessed. */
export function accountIntakeRetry(status: QueuedAccountIntakeConfigure): ConfigureAccountIntake {
  return configureAccountIntakeSchema.parse({ accountId: status.accountId, expectedConfigurationRevision: status.expectedConfigurationRevision, state: status.configuration.state,
    mailboxSubject: status.configuration.mailboxSubject, calendarId: status.configuration.calendarId, mailSince: status.mailScope?.since ?? null });
}
export function boundAccountIntakeConfigureStatus(request: ConfigureAccountIntake) {
  return accountIntakeConfigureStatusSchema.refine(status => status.accountId === request.accountId && status.expectedConfigurationRevision === request.expectedConfigurationRevision
    && (status.status === 'held' || status.configuration.state === request.state && status.configuration.mailboxSubject === request.mailboxSubject
      && status.configuration.calendarId === request.calendarId && (status.mailScope?.since ?? null) === request.mailSince), 'intake_status_response_mismatch');
}
