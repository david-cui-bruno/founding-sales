import { describe, expect, it } from 'vitest';
import { NodeClient, defaultStackParser, makeNodeTransport } from '@sentry/node';
import { createTransport, serializeEnvelope } from '@sentry/core';
import type { Envelope, ErrorEvent, EventEnvelope } from '@sentry/core';
import { codeFilename, dataCollection, errorOnlyTransport, errorOptions, isBoundary, isDsn, sanitizeEnvelope, sanitizeErrorEvent } from '../src/privacy.ts';
import { parseSourceManifest } from '../src/sourceManifest.ts';
const sourceFiles: Record<string, true | undefined> = {
  'apps/api/src/server.ts': true,
  'apps/api/src/health.ts': true,
};

describe('private image source manifest', () => {
  it('requires exact reviewed code filenames and refuses malformed manifests as a whole', () => {
    const approved = parseSourceManifest(JSON.stringify(['apps/api/src/server.ts']));
    expect(approved).toEqual({ 'apps/api/src/server.ts': true });
    expect(Object.isFrozen(approved)).toBe(true);
    expect(codeFilename('/app/apps/api/src/server.ts', approved)).toBe('app:///apps/api/src/server.ts');
    expect(codeFilename('/app/apps/api/src/health.ts', approved)).toBeUndefined();
    for (const value of [
      [], {}, ['apps/api/src/server.ts', '/Users/private/secret.ts'],
      ['apps/api/src/../secret.ts'], ['app:///apps/api/src/server.ts'],
      ['apps/api/src/server.test.ts'], ['packages/domain/test/secret.ts'], [42],
    ]) expect(parseSourceManifest(JSON.stringify(value))).toBeUndefined();
    expect(parseSourceManifest('not-json')).toBeUndefined();
  });
});

const configuration = { release: 'a'.repeat(40), service: 'api' as const, sourceFiles };
const sentinel = 'PRIVATE_EMAIL_PROMPT_TOKEN_cookie@example.invalid';
function event(line = 42) {
  return {
    type: undefined, event_id: 'b'.repeat(32), timestamp: 1_800_000_000, level: 'error',
    exception: { values: [{ type: sentinel, value: sentinel, stacktrace: { frames: [{
      filename: '/app/apps/api/src/server.ts', lineno: line, colno: 7,
      function: sentinel, module: sentinel, vars: { secret: sentinel },
      pre_context: [sentinel], context_line: sentinel, post_context: [sentinel],
    }] } }] },
    user: { id: sentinel, email: sentinel }, request: { url: sentinel },
    contexts: { private_context: { trace_id: sentinel } }, tags: { technical_boundary: 'api_request', arbitrary: sentinel },
    extra: { secret: sentinel }, breadcrumbs: [{ message: sentinel }], message: sentinel,
    fingerprint: [sentinel], transaction: sentinel, server_name: sentinel,
  } satisfies ErrorEvent;
}

describe('new-event technical allowlist', () => {
  it('removes runtime content without changing the input', () => {
    const original = event();
    const safe = sanitizeErrorEvent(original, configuration);
    expect(safe).toEqual({
      type: undefined,
      event_id: 'b'.repeat(32), timestamp: 1_800_000_000, level: 'error', platform: 'node',
      release: configuration.release, environment: 'production',
      tags: { service: 'api', technical_boundary: 'api_request' },
      exception: { values: [{ type: 'Error', value: 'Technical error', stacktrace: { frames: [{
        filename: 'app:///apps/api/src/server.ts', lineno: 42, colno: 7, in_app: true,
      }] } }] },
    });
    expect(JSON.stringify(safe)).not.toContain(sentinel);
    expect(original.exception.values[0]?.value).toBe(sentinel);
  });

  it('retains grouping locations from real SDK-parsed exceptions, not messages', async () => {
    const client = new NodeClient({
      ...errorOptions(configuration), stackParser: defaultStackParser, transport: makeNodeTransport,
      integrations: [],
    });
    const parse = async (message: string, line: number) => {
      const error = new TypeError(message);
      error.stack = `TypeError: ${message}\n    at ${sentinel} (/app/apps/api/src/server.ts:${line}:7)`;
      return sanitizeErrorEvent(await client.eventFromException(error), configuration);
    };
    const first = await parse(sentinel, 42);
    expect(first).not.toBeNull();
    expect(first).toEqual(await parse('Different private body', 42));
    expect(first).not.toEqual(await parse(sentinel, 43));
    expect(first?.exception?.values?.[0]?.type).toBe('TypeError');
  });

  it('refuses unknown source paths, locations and malformed release metadata', () => {
    for (const path of [
      '/Users/private/apps/api/src/server.ts', '/app/apps/api/src/notTrackedSecret.ts',
      '/app/apps/api/src/../secret.ts', '/app/apps/api/src/server.ts?token=secret',
      'https://private.invalid/customer/secret.js', 'node:internal/process/task_queues',
    ]) expect(codeFilename(path, sourceFiles)).toBeUndefined();
    expect(codeFilename('https://app.example/renderer.js')).toBe('app:///renderer.js');
    expect(sanitizeErrorEvent(event(), { ...configuration, release: 'latest' })).toBeNull();
    expect(sanitizeErrorEvent({ ...event(), exception: { values: [{ value: sentinel }] } }, configuration)).toBeNull();
    expect(sanitizeErrorEvent({ ...event(), type: 'transaction' }, configuration)).toBeNull();
    expect(sanitizeErrorEvent(event(Number.NaN), configuration)).toBeNull();
    expect(sanitizeErrorEvent(new Proxy({}, { get: () => { throw new Error(sentinel); } }), configuration)).toBeNull();
  });

  it('keeps only validated debug IDs for retained source locations', () => {
    const id = '12345678-1234-4567-89ab-123456789abc';
    const safe = sanitizeErrorEvent({ ...event(), debug_meta: { images: [
      { type: 'sourcemap', code_file: '/app/apps/api/src/server.ts', debug_id: id, private: sentinel },
      { type: 'sourcemap', code_file: '/app/apps/api/src/server.ts', debug_id: sentinel },
      { type: 'sourcemap', code_file: '/app/apps/api/src/health.ts', debug_id: id },
    ] } }, configuration);
    expect(safe?.debug_meta).toEqual({ images: [{ type: 'sourcemap', code_file: 'app:///apps/api/src/server.ts', debug_id: id }] });
    expect(JSON.stringify(safe)).not.toContain(sentinel);
  });

  it('closes collection categories and configuration vocabularies', () => {
    expect(dataCollection).toEqual({
      userInfo: false, cookies: false, httpHeaders: { request: false, response: false }, httpBodies: [],
      urlQueryParams: false, graphQL: { document: false, variables: false }, genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false }, databaseQueryData: false, queues: false,
      stackFrameVariables: false, frameContextLines: 0,
    });
    expect(isBoundary(sentinel)).toBe(false);
    expect(isBoundary('__proto__')).toBe(false);
    expect(isDsn(`https://${'a'.repeat(32)}@o1.ingest.us.sentry.io/123`)).toBe(true);
    for (const dsn of ['https://evil.invalid/1', `https://${'a'.repeat(32)}@o1.ingest.de.sentry.io/1`, `https://${'a'.repeat(32)}@o1.ingest.us.sentry.io/1?secret=1`]) expect(isDsn(dsn)).toBe(false);
  });
});

describe('last structured SDK envelope boundary', () => {
  it('serializes only safe errors through the maintained SDK transport and preserves provider response', async () => {
    const technicalHeaders = { event_id: 'b'.repeat(32), sent_at: '2026-11-03T00:00:00.000Z' };
    const envelope: EventEnvelope = [{
      ...technicalHeaders, trace: { transaction: sentinel, trace_id: sentinel, public_key: sentinel },
      sdk: { name: sentinel, version: sentinel }, custom: sentinel,
    }, [
      [{ type: 'event', custom: sentinel }, event()],
      [{ type: 'attachment', filename: sentinel, length: sentinel.length }, sentinel],
      [{ type: 'transaction' }, { type: 'transaction', transaction: sentinel }],
    ]];
    let body: string | Uint8Array | undefined;
    const providerResponse = { statusCode: 429, headers: { 'x-sentry-rate-limits': '60:error', 'retry-after': '60' } };
    const delegate = createTransport({ recordDroppedEvent: () => {} }, (request) => {
      body = request.body;
      return Promise.resolve(providerResponse);
    });
    const transport = errorOnlyTransport(delegate, configuration);
    expect(await transport.send(envelope)).toEqual(providerResponse);
    const encoded = typeof body === 'string' ? body : new TextDecoder().decode(body);
    expect(encoded).not.toContain(sentinel);
    expect(JSON.parse(encoded.split('\n')[0] ?? '')).toEqual(technicalHeaders);
    expect(encoded.split('\n')[1]).toBe('{"type":"event"}');
    expect(encoded).toContain('app:///apps/api/src/server.ts');
    const safe = sanitizeEnvelope(envelope, configuration);
    expect(safe).not.toBeNull();
    if (safe) expect(serializeEnvelope(safe)).toBe(encoded);
  });

  it('refuses valid SDK session, client-report and log envelope categories', () => {
    const sentAt = '2026-11-03T00:00:00.000Z';
    const prohibited: Envelope[] = [
      [{ sent_at: sentAt }, [[{ type: 'session' }, {
        init: true, sid: 'b'.repeat(32), did: sentinel, timestamp: sentAt,
        started: sentAt, status: 'ok', errors: 0,
      }]]],
      [{}, [[{ type: 'client_report' }, {
        timestamp: 1_800_000_000,
        discarded_events: [{ reason: 'before_send', category: 'error', quantity: 1 }],
      }]]],
      [{}, [[{ type: 'log', item_count: 1, content_type: 'application/vnd.sentry.items.log+json' }, { items: [{ timestamp: 1_800_000_000, level: 'error', body: sentinel }] }]]],
    ];
    for (const envelope of prohibited) expect(sanitizeEnvelope(envelope, configuration)).toBeNull();
  });

  it('refuses non-error envelopes rather than inventing a successful provider acknowledgement', async () => {
    const delegate = createTransport({ recordDroppedEvent: () => {} }, () => {
      throw new Error('Refused envelopes must never reach the network executor');
    });
    const transport = errorOnlyTransport(delegate, configuration);
    const headers = { event_id: 'b'.repeat(32), sent_at: '2026-11-03T00:00:00.000Z' };
    await expect(transport.send([headers, [[{ type: 'attachment', filename: sentinel, length: sentinel.length }, sentinel]]])).rejects.toThrow('Telemetry envelope refused');
    expect(sanitizeEnvelope([headers, [[{ type: 'event' }, { message: sentinel }]]], configuration)).toBeNull();
  });
});
