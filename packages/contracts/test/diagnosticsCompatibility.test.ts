import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RESTORE_DIAGNOSTIC_NOT_APPLICABLE, diagnosticsResponseSchema } from '../src/index.ts';

/**
 * `GET /diagnostics` against the desktop that is installed (lane W3-S8).
 *
 * The system-generation pin is gone, and the API now answers `restore` with
 * `RESTORE_DIAGNOSTIC_NOT_APPLICABLE`. Desktop 1.0.11 parses the whole response with the
 * `diagnosticsResponseSchema` it was built with (`apps/desktop/src/main/settingsBridge.ts`)
 * and renders `restore` in Settings → Diagnostics (`settingsView.ts`, "Restore
 * generation"). Its `restore` parser is frozen below exactly as it shipped; the rest of
 * the response is parsed with today's schema, which no lane has changed for the fields
 * 1.0.11 reads. If this fails, 1.0.11's Diagnostics page stops loading.
 */

/** 1.0.11's parser for `restore`, as `packages/contracts/src/settings.ts` had it at ad420c25. */
const restoreAsParsedBy1011 = z.object({
  systemGeneration: z.number().nullable(),
  expectedSystemGeneration: z.number().nullable(),
  mismatch: z.boolean(),
});

const diagnosticsAsParsedBy1011 = diagnosticsResponseSchema.extend({ restore: restoreAsParsedBy1011 });

const response = (restore: unknown): Record<string, unknown> => ({
  restore,
  schema: { appliedVersion: 19, declaredRange: { minimum: 19, maximum: 19 }, accepted: true },
  clientVersions: { minimum: '1.0.0', maximum: '1.999.999' },
  sending: { deploymentEnabled: true, adminEnabled: true, effective: true },
  jobs: {
    runnable: 0,
    running: 0,
    retryable: 0,
    dead: 0,
    oldestRunnableAgeSeconds: null,
    oldestDeadAgeSeconds: null,
  },
  heartbeats: [],
  canaryCompletionAgeSeconds: 3,
  alerts: [],
  mailboxes: [],
  mailboxVisibility: 'all',
});

describe('the restore diagnostic desktop 1.0.11 reads', () => {
  it('is neutral: no generation, nothing pinned, no mismatch', () => {
    expect(RESTORE_DIAGNOSTIC_NOT_APPLICABLE).toEqual({
      systemGeneration: null,
      expectedSystemGeneration: null,
      mismatch: false,
    });
  });

  it('parses under 1.0.11’s parser, inside a whole diagnostics response', () => {
    const parsed = diagnosticsAsParsedBy1011.safeParse(response(RESTORE_DIAGNOSTIC_NOT_APPLICABLE));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    if (parsed.success) expect(parsed.data.restore.mismatch).toBe(false);
  });

  it('parses under today’s schema too, which still describes the same shape', () => {
    expect(diagnosticsResponseSchema.safeParse(response(RESTORE_DIAGNOSTIC_NOT_APPLICABLE)).success).toBe(true);
  });

  it('cannot simply be dropped yet: 1.0.11 refuses a response without it', () => {
    const { restore: _restore, ...without } = response(RESTORE_DIAGNOSTIC_NOT_APPLICABLE);
    expect(diagnosticsAsParsedBy1011.safeParse(without).success).toBe(false);
  });
});
