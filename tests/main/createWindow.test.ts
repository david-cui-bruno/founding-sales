import { describe, expect, it } from 'vitest';
import { secureWebPreferences } from '../../src/main/createWindow';

describe('secureWebPreferences', () => {
  it('locks renderer access to the supplied preload bridge', () => {
    expect(secureWebPreferences('/tmp/preload.js')).toMatchObject({
      preload: '/tmp/preload.js',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    });
  });
});
