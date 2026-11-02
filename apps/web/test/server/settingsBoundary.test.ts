import { describe, expect, it } from 'vitest';
import { browserApiPathAllowed, BROWSER_COMMAND_PATHS, BROWSER_POST_READ_PATHS } from '../../src/shared/browserContract.ts';
import { bookingLinkBrowserResult, bookingLinkBrowserSchemas } from '../../src/server/settingsBoundary.ts';

const id = '00000000-0000-4000-8000-000000000001';
const update = bookingLinkBrowserSchemas['/settings/update']!;
const history = bookingLinkBrowserSchemas['/settings/history']!;

describe('the browser booking link boundary', () => {
  it('admits the settings history read and update command by exact POST path only', () => {
    expect(BROWSER_POST_READ_PATHS).toContain('/settings/history');
    expect(BROWSER_COMMAND_PATHS).toContain('/settings/update');
    for (const path of ['/settings/history', '/settings/update']) {
      expect(browserApiPathAllowed('POST', path)).toBe(true);
      expect(browserApiPathAllowed('GET', path)).toBe(false);
    }
    for (const path of ['/settings', '/settings/integrations', '/settings/finishing', '/settings/update/']) {
      expect(browserApiPathAllowed('POST', path)).toBe(false);
      expect(browserApiPathAllowed('GET', path)).toBe(false);
    }
  });

  it('reaches no setting but booking_link, and only with a public https URL or null', () => {
    const command = { settingKey: 'booking_link', value: { url: 'https://cal.example.test/demo' }, commandId: id };
    expect(update.safeParse(command).success).toBe(true);
    expect(update.safeParse({ ...command, value: { url: null } }).success).toBe(true);
    for (const change of [
      { settingKey: 'sending_enabled', value: { enabled: true, releaseGateReference: 'x' } },
      { settingKey: 'postal_address', value: { address: '1 Example Way' } },
      { value: { url: 'http://cal.example.test/demo' } },
      { value: { url: 'https://user:pass@cal.example.test/demo' } },
      { value: { url: 'https://cal.example.test/demo', extra: true } },
      { commandId: undefined },
    ]) expect(update.safeParse({ ...command, ...change }).success).toBe(false);
    expect(history.safeParse({ settingKey: 'booking_link', limit: 1 }).success).toBe(true);
    for (const body of [{ settingKey: 'sending_enabled' }, { settingKey: 'booking_link', limit: 50 }, {}])
      expect(history.safeParse(body).success).toBe(false);
  });

  it('presents a refused value as content, but never auth loss or an unknown refusal', () => {
    const body = { status: 'refused', replayed: false, reason: 'invalid_value' };
    expect(bookingLinkBrowserResult('/settings/update', 409, body)).toEqual({ status: 200, body });
    for (const [path, status, other] of [
      ['/settings/update', 401, body], ['/settings/update', 403, body], ['/settings/update', 409, { error: 'x' }],
      ['/settings/update', 409, { ...body, reason: 'release_record_unknown' }], ['/settings/history', 409, body],
    ] as const) expect(bookingLinkBrowserResult(path, status, other)).toBeNull();
  });
});
