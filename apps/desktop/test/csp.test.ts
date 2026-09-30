import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The renderer's Content-Security-Policy (slice C1). The Twilio Voice SDK runs in the
 * page, so `connect-src` and `media-src` carry exactly the entries Twilio documents for
 * it (https://twilio.github.io/twilio-voice.js/, "Content Security Policy") and nothing
 * wider; everything else stays as strict as it was.
 */

const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u.exec(html)?.[1] ?? '';
const directives = new Map(
  policy
    .split(';')
    .map(part => part.trim().split(/\s+/u))
    .filter(parts => parts[0] !== undefined && parts[0] !== '')
    .map(parts => [parts[0] ?? '', parts.slice(1)] as const),
);

describe('the renderer’s CSP', () => {
  it('keeps default-src none and the local-only script, style and image sources', () => {
    expect(directives.get('default-src')).toEqual(["'none'"]);
    expect(directives.get('script-src')).toEqual(["'self'"]);
    expect(directives.get('style-src')).toEqual(["'self'"]);
    expect(directives.get('img-src')).toEqual(["'self'"]);
    expect(directives.get('base-uri')).toEqual(["'none'"]);
    expect(directives.get('form-action')).toEqual(["'none'"]);
  });

  it('connects only to the Twilio Voice SDK hosts Twilio documents', () => {
    expect(directives.get('connect-src')).toEqual([
      'https://eventgw.twilio.com',
      'wss://voice-js.roaming.twilio.com',
      'https://media.twiliocdn.com',
      'https://sdk.twilio.com',
    ]);
    expect(directives.get('media-src')).toEqual(['mediastream:', 'https://media.twiliocdn.com', 'https://sdk.twilio.com']);
  });

  it('has no unsafe source, no wildcard, and nothing but these eight directives', () => {
    expect(policy).not.toMatch(/unsafe-/u);
    expect(policy).not.toContain('*');
    expect(policy).not.toMatch(/\b(data|blob|http):/u);
    expect([...directives.keys()].sort()).toEqual(
      ['base-uri', 'connect-src', 'default-src', 'form-action', 'img-src', 'media-src', 'script-src', 'style-src'].sort(),
    );
  });
});
