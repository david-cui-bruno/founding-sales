import { describe, expect, it } from 'vitest';
import { RemoteGoogleAuthorization } from '../../src/remoteGoogleAuthorization';
import { createSourceCoordinator } from '../../src/sourceCoordinator';
import { createProductionServices } from '../../src/handler';
import { v1Fixture } from './v1Fixture';

/**
 * The one edit S3 makes to the old five-minute tick (FSS target design section 9): the configuration switch that
 * takes email off it the day S3 deploys. `delegated_worker_legacy_email_enabled = false` becomes the environment
 * variable `DELEGATED_WORKER_LEGACY_EMAIL_ENABLED=false`, which makes the tick skip the mailbox poll, the per-firm
 * mail scope step and the sequence email walk. The research phases, the backfill sweep and the list build are
 * untouched, and the switch can only take work away: there is no value of it that makes the tick send more.
 */

const START = '2026-09-18T12:00:00.000Z';

describe('the legacy email switch on the old tick', () => {
  const tickOf = (f: ReturnType<typeof v1Fixture>, legacyEmailEnabled?: boolean) => {
    const fetch: typeof globalThis.fetch = async () => { throw new Error('unconfigured fictional HTTP'); };
    const authorization = new RemoteGoogleAuthorization({ auth: f.auth, fetch });
    return createSourceCoordinator({ auth: f.auth, authorization, fetch, ...(legacyEmailEnabled === undefined ? {} : { legacyEmailEnabled }) });
  };
  /** Five ticks so every phase of the round-robin cursor gets its turn. */
  const fiveTicks = async (source: ReturnType<typeof tickOf>) => {
    const reports = [];
    for (let turn = 0; turn < 5; turn++) reports.push(await source.tick(new AbortController().signal));
    return reports;
  };

  it('keeps every email step of the tick when the switch is absent or true', async () => {
    const f = v1Fixture(START);
    const reports = await fiveTicks(tickOf(f));
    // With no configured source or policy there is nothing to poll or walk, but the steps are reached: the walk
    // and the scope step both report, which is exactly what the switch removes below.
    expect(reports.some(report => report.sequenceEmails !== undefined)).toBe(true);
    expect(reports.some(report => report.mailScopes !== undefined)).toBe(true);

    const explicit = await fiveTicks(tickOf(v1Fixture(START), true));
    expect(explicit.some(report => report.sequenceEmails !== undefined)).toBe(true);
    expect(explicit.some(report => report.mailScopes !== undefined)).toBe(true);
  });

  it('takes the mail scopes and the sequence email walk off the tick when the switch is false', async () => {
    const f = v1Fixture(START);
    const reports = await fiveTicks(tickOf(f, false));
    expect(reports.some(report => report.sequenceEmails !== undefined)).toBe(false);
    expect(reports.some(report => report.mailScopes !== undefined)).toBe(false);
    expect(reports.every(report => report.mailPolls === 0)).toBe(true);
    expect(reports.every(report => report.dispatches === 0)).toBe(true);
    // The rest of the tick is untouched: the territory backfill phase still ran and still reported.
    expect(reports.some(report => report.territory !== undefined)).toBe(true);
    expect(reports.some(report => report.phases.territoryBackfill === 'completed')).toBe(true);
    expect(reports.some(report => report.phases.research !== undefined)).toBe(true);
  });

  it('reads the switch from the environment, and only the exact string false turns it off', async () => {
    const base = { DELEGATED_WORKER_ENABLED: 'true', DELEGATED_WORKER_TABLE: 'fictional-table', DELEGATED_WORKSPACE_ID: 'ws',
      DELEGATED_WORKER_HOST: 'worker.example.test', AWS_REGION: 'us-east-1' };
    const f = v1Fixture(START);
    for (const [value, expected] of [[undefined, true], ['true', true], ['false', false], ['TRUE', true], ['0', true]] as const) {
      const services = await createProductionServices({ ...base, ...(value === undefined ? {} : { DELEGATED_WORKER_LEGACY_EMAIL_ENABLED: value }) },
        { dynamo: f.store.options.dynamo, fetch: async () => { throw new Error('unconfigured fictional HTTP'); } });
      expect(services).not.toBeNull();
      const reports = await fiveTicks(services!.source);
      expect(reports.some(report => report.sequenceEmails !== undefined), `LEGACY_EMAIL_ENABLED=${String(value)}`).toBe(expected);
    }
  });
});
