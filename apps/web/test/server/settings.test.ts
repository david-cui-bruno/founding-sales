import { describe, expect, it } from 'vitest';
import { readBrowserHostSettings } from '../../src/server/settings.ts';

const valid = { FSS_BROWSER_ORIGIN: 'https://browser.example.test', FSS_BROWSER_CLIENT_VERSION: '1.4.0', FSS_BROWSER_COOKIE_KEY_HEX: 'ab'.repeat(32) };

describe('explicit browser host settings', () => {
  it('returns the exact pinned origin and a fresh decoded 32-byte key', () => {
    const settings = readBrowserHostSettings(valid);
    expect(settings).toEqual({ origin: valid.FSS_BROWSER_ORIGIN, clientVersion: '1.4.0', cookieKey: Buffer.alloc(32, 0xab) });
    expect(readBrowserHostSettings(valid).cookieKey).not.toBe(settings.cookieKey);
    expect(readBrowserHostSettings({ ...valid, FSS_BROWSER_COOKIE_KEY_HEX: 'AB'.repeat(32) }).cookieKey).toEqual(settings.cookieKey);
  });

  it.each(Object.keys(valid))('refuses missing or empty %s without echoing configuration', name => {
    for (const value of [undefined, '']) {
      expect(() => readBrowserHostSettings({ ...valid, [name]: value })).toThrowError('Invalid browser host configuration');
    }
  });

  it.each(['http://browser.example.test', 'not-an-origin', 'https://browser.example.test/', 'https://browser.example.test/path', 'https://user:private@browser.example.test', 'https://browser.example.test?secret', 'https://browser.example.test#secret', 'https://browser.example.test?', 'https://browser.example.test#', ' https://browser.example.test', 'https://BROWSER.example.test', 'https://browser.example.test:443', 'https://browser.example.test/..'])('refuses noncanonical origin %s', origin => {
    expect(() => readBrowserHostSettings({ ...valid, FSS_BROWSER_ORIGIN: origin })).toThrowError(/^Invalid browser host configuration$/u);
  });

  it.each(['1', '1.2', '01.2.3', '1.2.3-private', ' 1.2.3', '1.2.3\n', 'private-version'])('reuses version validation for %s', clientVersion => {
    expect(() => readBrowserHostSettings({ ...valid, FSS_BROWSER_CLIENT_VERSION: clientVersion })).toThrowError(/^Invalid browser host configuration$/u);
  });

  it.each(['a'.repeat(63), 'a'.repeat(65), 'z'.repeat(64), `${'a'.repeat(64)}\n`, ` ${'a'.repeat(64)}`, 'private-key'])('refuses malformed key without leaking it', key => {
    expect(() => readBrowserHostSettings({ ...valid, FSS_BROWSER_COOKIE_KEY_HEX: key })).toThrowError(/^Invalid browser host configuration$/u);
  });
});
