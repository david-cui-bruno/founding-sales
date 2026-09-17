import { describe, expect, it, vi } from 'vitest';

import {
  createSafeLogger,
  sanitizeErrorClass,
} from '../../../src/main/logging/safeLogger';

const NOW = '2026-09-04T12:34:56.000Z';
const POLL_ID = '257c539c-01bd-4006-989e-14678bab7e10';
const OBJECT_KEY = 'events/2026-09-04/mail-parse-01ARZ3NDEKTSV4RRFFQ69G5FAV.ndjson';
const ACCEPTED_SHAPE_PRIVATE_VALUES = [
  'ADA_LOVELACE',
  'ada-lovelace',
  'contact-AdaLovelace',
  'events/2026-09-04/mail-parse-01ADALOVELACEPRIVATEVALUE.ndjson',
  'AdaLovelace',
  'adalovelace',
  'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
];

function capture(
  level: 'debug' | 'info' | 'warn' | 'error',
  eventCode: string,
  fields?: Record<string, unknown>,
): { write: ReturnType<typeof vi.fn>; output: () => Record<string, unknown> } {
  const write = vi.fn();
  createSafeLogger({ now: () => NOW, write }).log(level, eventCode, fields as never);
  return { write, output: () => JSON.parse(write.mock.calls[0]![0]) };
}

describe('createSafeLogger', () => {
  it('retains only bounded research stage, reason, HTTP status and generated job identity', () => {
    const result = capture('warn', 'COMPANY_RESEARCH_PARKED', {
      component: 'company-research', requestId: POLL_ID, stage: 'model_request', reason: 'provider_rejected', httpStatus: 401,
      accountId: 'private-company', message: 'private response', url: 'https://private.example/', payload: { key: 'secret' },
    });
    expect(result.output()).toEqual({ timestamp: NOW, level: 'warn', eventCode: 'COMPANY_RESEARCH_PARKED',
      component: 'company-research', requestId: POLL_ID, stage: 'model_request', reason: 'provider_rejected', httpStatus: 401 });
    for (const value of ACCEPTED_SHAPE_PRIVATE_VALUES) {
      const rejected = capture('warn', 'COMPANY_RESEARCH_PARKED', { component: 'company-research', stage: value, reason: value, requestId: value, httpStatus: value });
      expect(rejected.output()).toEqual({ timestamp: NOW, level: 'warn', eventCode: 'COMPANY_RESEARCH_PARKED', component: 'company-research' });
    }
    for (const httpStatus of [-1, 99, 600, 401.5, NaN, Infinity]) {
      expect(capture('warn', 'COMPANY_RESEARCH_PARKED', { component: 'company-research', httpStatus }).output()).not.toHaveProperty('httpStatus');
    }
  });

  it('retains the intended fields for every actual production event policy', () => {
    const cases = [
      ['error', 'SOURCING_FILE_FAILED', {
        component: 'sourcing-poller', pollId: POLL_ID, objectKey: OBJECT_KEY,
        errorClass: 'TypeError',
      }],
      ['error', 'SOURCING_UPSTREAM_SYNC_FAILED', {
        component: 'sourcing-poller', pollId: POLL_ID, errorClass: 'Error',
      }],
      ['warn', 'SOURCING_LINE_QUARANTINED', {
        component: 'sourcing-poller', objectKey: OBJECT_KEY, lineNumber: 7,
      }],
      ['warn', 'SOURCING_IDEMPOTENCY_CONFLICT', {
        component: 'sourcing-poller', errorClass: 'Error',
      }],
      ['info', 'SOURCING_NEEDS_IDENTITY_SKIPPED', {
        component: 'sourcing-poller', status: 'no_usable_situs',
      }],
      ['info', 'SOURCING_SCORE_UPDATE_SKIPPED', {
        component: 'sourcing-poller', status: 'no_intake_receipt',
      }],
      ['error', 'SOURCING_POLL_FAILED', {
        component: 'sourcing-poller', pollId: POLL_ID, backlogCount: 4,
        status: 'POLL_FAILED', errorClass: 'RemoteOperationTimeoutError',
      }],
      ['info', 'SOURCING_CREDENTIALS_PROTECTED', {
        component: 'sourcing-credential-store', status: 'protected',
      }],
    ] as const;

    for (const [level, eventCode, fields] of cases) {
      const result = capture(level, eventCode, fields);
      expect(result.write).toHaveBeenCalledTimes(1);
      expect(result.output()).toEqual({ timestamp: NOW, level, eventCode, ...fields });
    }
  });

  it('retains one closed startup failure record and drops every open-ended field', () => {
    const accepted = capture('error', 'STARTUP_FAILED', {
      component: 'startup', stage: 'domain', errorClass: 'DomainStartupFatalError', code: 'catalog_conflict',
      message: 'private text', databasePath: '/Users/founder/private.sqlite3', reason: 'private',
    });
    expect(accepted.output()).toEqual({ timestamp: NOW, level: 'error', eventCode: 'STARTUP_FAILED',
      component: 'startup', stage: 'domain', errorClass: 'DomainStartupFatalError', code: 'catalog_conflict' });
    const sqlite = capture('error', 'STARTUP_FAILED', { component: 'startup', stage: 'open', errorClass: 'SqliteError', code: 'SQLITE_NOTADB' });
    expect(sqlite.output()).toEqual({ timestamp: NOW, level: 'error', eventCode: 'STARTUP_FAILED', component: 'startup', stage: 'open', errorClass: 'SqliteError', code: 'SQLITE_NOTADB' });
    for (const value of ACCEPTED_SHAPE_PRIVATE_VALUES) {
      const rejected = capture('error', 'STARTUP_FAILED', { component: 'startup', stage: value, errorClass: value, code: value });
      expect(rejected.output()).toEqual({ timestamp: NOW, level: 'error', eventCode: 'STARTUP_FAILED', component: 'startup' });
    }
    expect(capture('info', 'STARTUP_FAILED', { component: 'startup', stage: 'open', errorClass: 'Error' }).write).not.toHaveBeenCalled();
    expect(capture('error', 'STARTUP_FAILED', { component: 'sourcing-poller', stage: 'open', errorClass: 'Error' }).write).not.toHaveBeenCalled();
  });

  it('rejects unsupported event codes and wrong event levels', () => {
    expect(capture('info', 'SAFE_EVENT').write).not.toHaveBeenCalled();
    expect(capture('info', 'SOURCING_FILE_FAILED').write).not.toHaveBeenCalled();
    expect(capture('trace' as never, 'SOURCING_FILE_FAILED').write).not.toHaveBeenCalled();
  });

  it('omits accepted-shape PII and opaque secrets at every string field ingress', () => {
    const fields = [
      'component', 'requestId', 'pollId', 'objectKey', 'objectVersionId',
      'objectEtag', 'objectChecksumSha256', 'status', 'errorClass',
    ] as const;

    for (const value of ACCEPTED_SHAPE_PRIVATE_VALUES) {
      expect(capture('info', value).write).not.toHaveBeenCalled();
      for (const field of fields) {
        const eventCode = field === 'objectKey' ? 'SOURCING_FILE_FAILED' : 'SOURCING_POLL_FAILED';
        const level = eventCode === 'SOURCING_FILE_FAILED' ? 'error' : 'error';
        const result = capture(level, eventCode, {
          component: 'sourcing-poller',
          pollId: POLL_ID,
          status: 'POLL_FAILED',
          errorClass: 'Error',
          [field]: value,
        });
        if (result.write.mock.calls.length === 0) continue;
        const serialized = result.write.mock.calls[0]![0] as string;
        expect(serialized).not.toContain(value);
        expect(result.output()).not.toHaveProperty(field, value);
      }
    }
  });

  it('omits fields that are not admitted by a specific event policy', () => {
    const result = capture('info', 'SOURCING_CREDENTIALS_PROTECTED', {
      component: 'sourcing-credential-store', status: 'protected',
      requestId: POLL_ID, objectVersionId: 'opaque', objectEtag: 'abc',
      objectChecksumSha256: 'abc', count: 7, nested: { private: true },
    });

    expect(result.output()).toEqual({
      timestamp: NOW,
      level: 'info',
      eventCode: 'SOURCING_CREDENTIALS_PROTECTED',
      component: 'sourcing-credential-store',
      status: 'protected',
    });
  });

  it('maps only fixed error classes and never serializes hostile Error.name values', () => {
    expect(sanitizeErrorClass(new TypeError('private'))).toBe('TypeError');
    expect(sanitizeErrorClass('private')).toBe('UnknownError');
    for (const name of ACCEPTED_SHAPE_PRIVATE_VALUES) {
      const error = new Error('private');
      error.name = name;
      expect(sanitizeErrorClass(error)).toBe('Error');
    }
  });

  it('does not let a retained sink failure escape into live operations', () => {
    const logger = createSafeLogger({ write: () => { throw new Error('disk unavailable'); } });
    expect(() => logger.log('error', 'SOURCING_POLL_FAILED', {
      component: 'sourcing-poller', pollId: POLL_ID, status: 'POLL_FAILED',
      errorClass: 'Error',
    })).not.toThrow();
  });
});
