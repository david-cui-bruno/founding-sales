import {
  DEFAULT_INTEGRATION_SETTING_VALUES,
  DEFAULT_VOICEMAIL_SCRIPT,
  calendarIntegrationSettingSchema,
  callTranscriptionSettingSchema,
  callingProviderSettingSchema,
  telephonyBudgetSettingSchema,
  voicemailScriptSettingSchema,
  type CallTranscriptionSetting,
  type TelephonyBudgetSetting,
} from '@fss/contracts';
import type { SessionQueryable } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readSetting } from './store.ts';

/**
 * The call-to-booking switches, as the routes ask them (migration 0028, slice W).
 *
 * Each reader fails to the OFF side: a stored value that does not parse is `tel`, `off`
 * or a zero ceiling, because a configuration bug in something that places paid calls or
 * moves a pipeline must behave as though the configuration said no.
 */

export type CallingProvider = 'tel' | 'twilio';
export type CalendarIntegration = 'off' | 'calcom';

export async function readCallingProvider(context: RepositoryContext): Promise<CallingProvider> {
  const parsed = callingProviderSettingSchema.safeParse((await readSetting(context, 'calling_provider')).value);
  return parsed.success ? parsed.data.provider : 'tel';
}

export async function readCalendarIntegration(context: RepositoryContext): Promise<CalendarIntegration> {
  const parsed = calendarIntegrationSettingSchema.safeParse((await readSetting(context, 'calendar_integration')).value);
  return parsed.success ? parsed.data.integration : 'off';
}

const DISABLED_BUDGET = telephonyBudgetSettingSchema.parse(DEFAULT_INTEGRATION_SETTING_VALUES.telephony_budget);

export async function readTelephonyBudget(context: RepositoryContext): Promise<TelephonyBudgetSetting> {
  const parsed = telephonyBudgetSettingSchema.safeParse((await readSetting(context, 'telephony_budget')).value);
  return parsed.success ? parsed.data : { ...DISABLED_BUDGET, dailyCeilingCents: 0 };
}

/**
 * The voicemail script's template (slice C1): `{contactFirstName}`, `{firmName}`,
 * `{callerName}` and `{callbackNumber}`, rendered by `renderVoicemailScript`.
 *
 * The stored `voicemail_script` setting (slice S1 made it editable; migration 0028 already
 * admits the key), or the default when none is stored or the stored value does not parse.
 */
export async function readVoicemailScript(context: RepositoryContext): Promise<string> {
  const parsed = voicemailScriptSettingSchema.safeParse((await readSetting(context, 'voicemail_script')).value);
  return parsed.success ? parsed.data.template : DEFAULT_VOICEMAIL_SCRIPT;
}

const TRANSCRIPTION_OFF = callTranscriptionSettingSchema.parse(DEFAULT_INTEGRATION_SETTING_VALUES.call_transcription);

/**
 * Call transcription (slice C2): on or off, the day's ceiling in cents, the price per
 * minute. A stored value that does not parse is off with a zero ceiling, like the budget.
 */
export async function readCallTranscription(context: RepositoryContext): Promise<CallTranscriptionSetting> {
  const parsed = callTranscriptionSettingSchema.safeParse((await readSetting(context, 'call_transcription')).value);
  return parsed.success ? parsed.data : { ...TRANSCRIPTION_OFF, enabled: false, dailyCeilingCents: 0 };
}

/**
 * The workspaces whose current setting turns one integration on, across the deployment.
 *
 * The provider webhooks carry no workspace, so the ingress asks this before anything
 * else: none means the route answers 404, exactly as it does with the flags at their
 * defaults. Unscoped by design — it reads one setting key, never a prospect row.
 */
export async function workspacesWithIntegration(
  db: SessionQueryable,
  integration: { readonly key: 'calling_provider'; readonly value: 'twilio' } | { readonly key: 'calendar_integration'; readonly value: 'calcom' },
): Promise<readonly string[]> {
  const field = integration.key === 'calling_provider' ? 'provider' : 'integration';
  const { rows } = await db.query<{ workspace_id: string }>(
    `SELECT workspace_id FROM workspace_settings
      WHERE setting_key = $1 AND superseded_at IS NULL AND value ->> $2 = $3
      ORDER BY workspace_id`,
    [integration.key, field, integration.value],
  );
  return rows.map(row => row.workspace_id);
}
