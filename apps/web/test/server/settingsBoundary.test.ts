import { describe, expect, it } from 'vitest';
import { browserApiPathAllowed, BROWSER_COMMAND_PATHS, BROWSER_POST_READ_PATHS } from '../../src/shared/browserContract.ts';
import { bookingLinkApiRequest, bookingLinkBrowserResult, bookingLinkBrowserSchemas } from '../../src/server/settingsBoundary.ts';

const id = '00000000-0000-4000-8000-000000000001';
const READ = '/settings/booking-link/read';
const UPDATE = '/settings/booking-link/update';
const update = bookingLinkBrowserSchemas[UPDATE]!;
const read = bookingLinkBrowserSchemas[READ]!;

describe('the browser booking link boundary', () => {
  it('admits exactly the dedicated booking link read and update paths, by POST only', () => {
    expect(BROWSER_POST_READ_PATHS).toContain(READ);
    expect(BROWSER_COMMAND_PATHS).toContain(UPDATE);
    for (const path of [READ, UPDATE]) {
      expect(browserApiPathAllowed('POST', path)).toBe(true);
      expect(browserApiPathAllowed('GET', path)).toBe(false);
      expect(browserApiPathAllowed('POST', `${path}/`)).toBe(false);
      expect(browserApiPathAllowed('POST', `${path}/extra`)).toBe(false);
    }
    const settingsPaths = [...BROWSER_POST_READ_PATHS, ...BROWSER_COMMAND_PATHS].filter(path => path.startsWith('/settings'));
    expect(settingsPaths.sort()).toEqual([READ, UPDATE]);
    expect(Object.keys(bookingLinkBrowserSchemas).sort()).toEqual([READ, UPDATE]);
  });

  it('keeps every generic settings route closed to the browser', () => {
    for (const path of ['/settings', '/settings/history', '/settings/update', '/settings/integrations', '/settings/finishing', '/settings/update/', '/settings/booking-link', '/settings/booking-link/history']) {
      expect(browserApiPathAllowed('POST', path)).toBe(false);
      expect(browserApiPathAllowed('GET', path)).toBe(false);
    }
  });

  it('reaches no setting but booking_link, and only with a public https URL or null', () => {
    const command = { value: { url: 'https://cal.example.test/demo' }, commandId: id };
    expect(update.safeParse(command).success).toBe(true);
    expect(update.safeParse({ ...command, value: { url: null } }).success).toBe(true);
    for (const change of [
      { settingKey: 'booking_link' },
      { settingKey: 'sending_enabled', value: { enabled: true, releaseGateReference: 'x' } },
      { settingKey: 'postal_address', value: { address: '1 Example Way' } },
      { value: { url: 'http://cal.example.test/demo' } },
      { value: { url: 'https://user:pass@cal.example.test/demo' } },
      { value: { url: 'https://cal.example.test/demo', extra: true } },
      { commandId: undefined },
    ]) expect(update.safeParse({ ...command, ...change }).success).toBe(false);
    expect(read.safeParse({}).success).toBe(true);
    for (const body of [{ settingKey: 'booking_link' }, { settingKey: 'sending_enabled' }, { limit: 1 }, { limit: 50 }])
      expect(read.safeParse(body).success).toBe(false);
  });

  it('maps the dedicated paths onto the settings routes with the booking_link key pinned server-side', () => {
    expect(bookingLinkApiRequest(READ, {})).toEqual({ path: '/settings/history', body: { settingKey: 'booking_link', limit: 1 } });
    const command = { value: { url: null }, commandId: id, clientVersion: '1.4.0' };
    expect(bookingLinkApiRequest(UPDATE, command)).toEqual({ path: '/settings/update', body: { ...command, settingKey: 'booking_link' } });
    expect(bookingLinkApiRequest(UPDATE, { ...command, settingKey: 'sending_enabled' })).toEqual({ path: '/settings/update', body: { ...command, settingKey: 'booking_link' } });
    for (const [path, body] of [['/settings/history', {}], ['/settings/update', command], [UPDATE, null], [UPDATE, [command]], ['/calling/setup', {}]] as const)
      expect(bookingLinkApiRequest(path, body)).toBeNull();
  });

  it('presents a refused value as content, but never auth loss or an unknown refusal', () => {
    const body = { status: 'refused', replayed: false, reason: 'invalid_value' };
    expect(bookingLinkBrowserResult(UPDATE, 409, body)).toEqual({ status: 200, body });
    for (const [path, status, other] of [
      [UPDATE, 401, body], [UPDATE, 403, body], [UPDATE, 409, { error: 'x' }],
      [UPDATE, 409, { ...body, reason: 'release_record_unknown' }], [READ, 409, body], ['/settings/update', 409, body],
    ] as const) expect(bookingLinkBrowserResult(path, status, other)).toBeNull();
  });
});
