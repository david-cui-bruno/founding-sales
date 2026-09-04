import { describe, expect, it, vi } from 'vitest';

import {
  createSafeLogger,
  sanitizeErrorClass,
} from '../../../src/main/logging/safeLogger';

describe('createSafeLogger', () => {
  it('serializes only the exact operational allowlist', () => {
    const write = vi.fn();
    const logger = createSafeLogger({
      now: () => '2026-09-04T12:34:56.000Z',
      write,
    });

    logger.log('warn', 'SOURCING_OBJECT_REJECTED', {
      component: 'sourcing-poller',
      requestId: 'request-01',
      pollId: 'poll-01',
      objectKey: 'inbox/2026-09-04.ndjson',
      objectVersionId: null,
      objectEtag: 'etag-01',
      objectChecksumSha256: 'abc123',
      invalidLineNumbers: [2, 7],
      invalidLineCount: 2,
      lineNumber: 7,
      durationMs: 42,
      count: 3,
      backlogCount: 4,
      unprocessedCount: 5,
      status: 'quarantined',
      errorClass: 'SyntaxError',
    });

    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(write.mock.calls[0]![0])).toEqual({
      timestamp: '2026-09-04T12:34:56.000Z',
      level: 'warn',
      eventCode: 'SOURCING_OBJECT_REJECTED',
      component: 'sourcing-poller',
      requestId: 'request-01',
      pollId: 'poll-01',
      objectKey: 'inbox/2026-09-04.ndjson',
      objectVersionId: null,
      objectEtag: 'etag-01',
      objectChecksumSha256: 'abc123',
      invalidLineNumbers: [2, 7],
      invalidLineCount: 2,
      lineNumber: 7,
      durationMs: 42,
      count: 3,
      backlogCount: 4,
      unprocessedCount: 5,
      status: 'quarantined',
      errorClass: 'SyntaxError',
    });
  });

  it('omits names, phones, emails, addresses, subjects, provider payloads, recovery material, credentials, and nested objects', () => {
    const write = vi.fn();
    const logger = createSafeLogger({ now: () => '2026-09-04T00:00:00.000Z', write });
    const forbidden = [
      'Ada Lovelace', '+1-401-555-0199', 'ada@example.com', '12 Main Street',
      'Confidential subject', 'provider-secret-body', 'recovery phrase violet river',
      'AKIAIOSFODNN7EXAMPLE', 'contact-hmac-value', 'oauth-token-value',
    ];

    logger.log('error', 'SAFE_EVENT', {
      component: 'runtime',
      count: 1,
      personName: forbidden[0],
      phone: forbidden[1],
      email: forbidden[2],
      address: forbidden[3],
      subject: forbidden[4],
      providerPayload: { body: forbidden[5] },
      recoveryMaterial: forbidden[6],
      awsAccessKeyId: forbidden[7],
      contactHmac: forbidden[8],
      token: forbidden[9],
      nested: { arbitrary: 'nested-private-value' },
    } as never);

    const output = write.mock.calls[0]![0] as string;
    expect(JSON.parse(output)).toEqual({
      timestamp: '2026-09-04T00:00:00.000Z',
      level: 'error',
      eventCode: 'SAFE_EVENT',
      component: 'runtime',
      count: 1,
    });
    for (const value of [...forbidden, 'nested-private-value']) {
      expect(output).not.toContain(value);
    }
  });

  it('records only a sanitized class for hostile errors', () => {
    const hostile = new Error('ada@example.com AKIAIOSFODNN7EXAMPLE recovery phrase');
    hostile.name = 'TypeError\nada@example.com';

    expect(sanitizeErrorClass(hostile)).toBe('Error');
    expect(sanitizeErrorClass(new TypeError('private provider payload'))).toBe('TypeError');
    expect(sanitizeErrorClass('private recovery string')).toBe('UnknownError');
  });

  it('does not let a retained sink failure escape into live operations', () => {
    const logger = createSafeLogger({
      write: () => { throw new Error('disk unavailable'); },
    });

    expect(() => logger.log('error', 'SAFE_EVENT', { count: 1 })).not.toThrow();
  });
});
