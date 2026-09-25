import type { SettingHistoryResponse } from '@fss/contracts';

/**
 * `POST /settings/history` as the API answers it (lane g78, audit item D04).
 *
 * Every key the route sends, typed as `@fss/contracts`' response, `current` and each
 * version's `value` included. The desktop's own schema used to strip both, so History
 * showed when a slice changed and never to what. `test/release/settingsHistory.check.ts`
 * holds this to the real route's answer key for key and type for type.
 */
export function settingHistoryAnswer(overrides: Partial<SettingHistoryResponse> = {}): SettingHistoryResponse {
  return {
    settingKey: 'business_time_zone',
    current: { value: { timeZone: 'America/Chicago' }, version: 2 },
    versions: [
      {
        settingKey: 'business_time_zone',
        version: 2,
        value: { timeZone: 'America/Chicago' },
        changeNote: 'the office moved',
        changedByUserId: '11111111-1111-4111-8111-111111111111',
        changedAt: '2026-09-19T10:00:00.000Z',
        supersededAt: null,
      },
      {
        settingKey: 'business_time_zone',
        version: 1,
        value: { timeZone: 'America/Denver' },
        changeNote: 'first configuration',
        changedByUserId: '11111111-1111-4111-8111-111111111111',
        changedAt: '2026-09-18T10:00:00.000Z',
        supersededAt: '2026-09-19T10:00:00.000Z',
      },
    ],
    ...overrides,
  };
}
