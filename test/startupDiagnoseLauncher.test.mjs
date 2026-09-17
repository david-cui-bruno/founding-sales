import { userInfo } from 'node:os';
import { expect, it } from 'vitest';
import { scrubEnvironment, validateDiagnoseReport } from '../scripts/diagnoseStartup.mjs';

const ready = { kind: 'diagnose_startup', files: { database: 356249600, wal: 0, shm: 32768, journal: null }, copied: ['database', 'wal'],
  stages: [{ stage: 'open', ok: true, detail: {} }, { stage: 'readiness', ok: true, detail: { schemaVersion: 26 } },
    { stage: 'migrate', ok: true, detail: { fromVersion: 26, toVersion: 27, applied: 1 } }, { stage: 'domain', ok: true, detail: { status: 'ready', blockingViolationCount: 0 } }],
  verdict: 'database_ready' };
const failed = { ...ready, stages: [{ stage: 'open', ok: true, detail: {} }, { stage: 'readiness', ok: false,
  failure: { stage: 'open', errorClass: 'DomainStartupFatalError', code: 'manifest_mismatch' }, message: 'Domain schema manifest mismatch.' }], verdict: 'database_failed_readiness' };

it('accepts the two closed report shapes', () => {
  expect(validateDiagnoseReport(ready)).toBe(ready);
  expect(validateDiagnoseReport(failed)).toBe(failed);
});
it.each([
  ['kind', 'receipt'], ['verdict', 'database_failed_open'], ['copied', ['shm']], ['stages', []], ['files', { database: 1 }],
  ['stages', [{ stage: 'open', ok: true, detail: { path: '/Users/founder' } }]],
  ['stages', [{ stage: 'open', ok: false, failure: { stage: 'open', errorClass: 'Error' }, message: 'unable to open /Users/founder/callie.sqlite3' }]],
  ['stages', [{ stage: 'open', ok: false, failure: { stage: 'open', errorClass: 'Ada Lovelace' }, message: 'x' }]],
  ['extra', true],
])('rejects a malformed report field %s', (field, value) => {
  const report = { ...ready, [field]: value };
  if (field === 'stages' && Array.isArray(value) && value.length && value[0].ok === false) report.verdict = 'database_failed_open';
  expect(() => validateDiagnoseReport(report)).toThrow('STARTUP_DIAGNOSE_FAILED');
});
it('hands the host a fixed environment without the shell-carried NODE_ variables', () => {
  const env = { HOME: userInfo().homedir, PATH: '/usr/bin', NODE_REPL_TRUSTED_CODE_PATHS: '/x', ELECTRON_RUN_AS_NODE: '1', CALLIE_TEST: '1', TERM: 'xterm', SECRET_TOKEN: 'private' };
  expect(scrubEnvironment(env)).toEqual({ HOME: userInfo().homedir, PATH: '/usr/bin', TERM: 'xterm' });
  expect(() => scrubEnvironment({ HOME: '/Users/someone-else' })).toThrow('STARTUP_DIAGNOSE_FAILED');
});
