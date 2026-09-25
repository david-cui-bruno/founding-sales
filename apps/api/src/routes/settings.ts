import {
  settingHistoryRequestSchema,
  updateSettingCommandSchema,
} from '@fss/contracts';
import {
  SETTINGS_ELSEWHERE,
  effectiveSendingEnabled,
  readCurrentSettings,
  readSetting,
  readSettingHistory,
  updateSetting,
} from '@fss/domain/settings';
import { attestedReleaseBinding } from '@fss/domain/release';
import { currentHolidayCalendar } from '@fss/domain/sequences';
import { REFUSAL_STATUS, contextForPrincipal, policyRouteDeps, redactError, runPolicyCommand } from './dialSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The administrative configuration surface (specification 10.1, 13.3, 16.2).
 *
 * Three exact paths. Reading is open to any authenticated member — a salesperson
 * whose send was refused by a cap should be able to see what the cap is — and
 * writing is admin-only, refused by the domain command in the same transaction as
 * the write rather than by a check here.
 *
 * `POST /settings/update` returns the updated slice through a command receipt, which
 * is the acceptance criterion in this lane's brief: the receipt, the payload hash,
 * the device and the mutation commit together (5.3), so a replayed save returns the
 * original version rather than writing a second one.
 *
 * The snapshot also carries the workspace holiday calendar, which this lane does
 * not store: it is G8's `workspace_holiday_calendars`, read through G8's
 * `currentHolidayCalendar`. A page that could not show the current calendar could
 * not offer an edit of it, and the edit goes to G8's command.
 *
 * Enabling production sending is refused unless the attested reference is a stored,
 * passing release record whose API digest is this API's own (lane g71); the refusal
 * codes are the domain's, `release_record_unknown`, `release_record_not_passing`,
 * `release_record_identity_unknown` and `release_record_digest_mismatch`.
 *
 * `/settings/history` is a POST and a read. It carries no personal data, so
 * `docs/decisions/g3b-reads-are-posts.md`'s argument about query strings does not
 * apply to it; it is a POST because it takes a body and because a family of
 * endpoints that is two thirds POST is one somebody gets wrong on the fourth.
 */
export const SETTINGS_PATHS: readonly string[] = ['/settings', '/settings/update', '/settings/history'];

export async function routeSettings(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!SETTINGS_PATHS.includes(request.path)) return null;
  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;

  if (request.path === '/settings') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
    }
    const scoped = contextForPrincipal(deps.auth, deps.principal);
    if (!scoped.ok) return scoped.result;

    const settings = await readCurrentSettings(scoped.context);
    const sendingSetting = settings.find(entry => entry.settingKey === 'sending_enabled')?.value;
    return {
      status: 200,
      body: {
        settings,
        elsewhere: SETTINGS_ELSEWHERE,
        // G8's table, read through G8's function and never copied into
        // `workspace_settings`. The settings page has to show the calendar to let
        // anybody edit it, and the edit itself goes to `POST /sequences/holidays`.
        // See docs/decisions/g9-two-slices-that-belong-to-other-lanes.md.
        holidayCalendar: await currentHolidayCalendar(scoped.context),
        // 16.2 is two switches ANDed. Both are shown, because an admin who has
        // enabled sending and still cannot send needs to see which half is off.
        deploymentSendingEnabled: options.sendingEnabled,
        // And, since lane g71, only when the attested release record binds to this
        // API's own image: after a deploy of digests nobody rehearsed, the page says
        // sending is off, which is what the worker's gate is about to say too.
        effectiveSendingEnabled:
          effectiveSendingEnabled(options.sendingEnabled, sendingSetting) &&
          (await attestedReleaseBinding(scoped.context, sendingSetting, 'api', options.imageDigest))?.ok === true,
      },
    };
  }

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  if (request.path === '/settings/history') {
    const parsed = settingHistoryRequestSchema.safeParse(request.body);
    if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
    const scoped = contextForPrincipal(deps.auth, deps.principal);
    if (!scoped.ok) return scoped.result;
    const versions = await readSettingHistory(scoped.context, parsed.data.settingKey, {
      ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
    });
    const current = await readSetting(scoped.context, parsed.data.settingKey);
    return { status: 200, body: { settingKey: parsed.data.settingKey, current, versions } };
  }

  return await runPolicyCommand(deps, updateSettingCommandSchema, 'update_setting', async (repository, body) => {
    const outcome = await updateSetting(repository, {
      settingKey: body.settingKey,
      value: body.value,
      changeNote: body.changeNote,
      commandId: body.commandId,
      // 16.2, lane g71: an enable names a release record whose API digest is this
      // process's own. The domain refuses in the same transaction; the route only
      // says which image it is.
      runningApiDigest: options.imageDigest,
    });
    // The receipt carries the updated slice, not the whole configuration: a receipt
    // is a record of what this command did.
    return outcome.ok ? { ok: true, value: outcome.value } : { ok: false, reason: outcome.reason };
  });
}
