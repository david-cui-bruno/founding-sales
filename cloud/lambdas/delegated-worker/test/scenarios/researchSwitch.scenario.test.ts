import { describe, expect, it } from 'vitest';
import { RemoteGoogleAuthorization } from '../../src/remoteGoogleAuthorization';
import { createSourceCoordinator } from '../../src/sourceCoordinator';
import { createProductionServices } from '../../src/handler';
import { dayKey } from '../../src/v1/dayBuild';
import { dayBuildOf, putFirm, putTerritoryPolicy, riFirm, setPosture } from './firmFixtures';
import { v1Fixture } from './v1Fixture';

/**
 * The one edit S4 makes to the old five-minute tick (FSS target design section 9), beside S3's email switch:
 * `delegated_worker_legacy_research_enabled = false` becomes `DELEGATED_WORKER_LEGACY_RESEARCH_ENABLED=false`,
 * which makes the tick skip its research, configurations and territory backfill phases. From the moment the
 * S3 and S4 deploy sets both switches false, research runs in exactly one place: the queue.
 *
 * The tick itself keeps running, and so does S1's list build, which is not a phase and is what David actually
 * reads every morning. The switch can only take work away: no value of it makes the tick research more.
 */

const START = '2026-09-18T12:00:00.000Z';
/** Before 05:00 Eastern the build is not due; 10:00 UTC is 06:00 Eastern on this date, which is. */
const AFTER_FIVE_EASTERN = '2026-09-18T10:00:00.000Z';

describe('the legacy research switch on the old tick', () => {
  const tickOf = (f: ReturnType<typeof v1Fixture>, legacyResearchEnabled?: boolean) => {
    const fetch: typeof globalThis.fetch = async () => { throw new Error('unconfigured fictional HTTP'); };
    const authorization = new RemoteGoogleAuthorization({ auth: f.auth, fetch });
    return createSourceCoordinator({ auth: f.auth, authorization, fetch, ...(legacyResearchEnabled === undefined ? {} : { legacyResearchEnabled }) });
  };
  /** Five ticks so every phase of the round-robin cursor gets its turn. */
  const fiveTicks = async (source: ReturnType<typeof tickOf>) => {
    const reports = [];
    for (let turn = 0; turn < 5; turn++) reports.push(await source.tick(new AbortController().signal));
    return reports;
  };

  it('keeps every research phase of the tick when the switch is absent or true', async () => {
    const reports = await fiveTicks(tickOf(v1Fixture(START)));
    expect(reports.some(report => report.phases.research === 'completed')).toBe(true);
    expect(reports.some(report => report.phases.configurations === 'completed')).toBe(true);
    expect(reports.some(report => report.phases.territoryBackfill === 'completed')).toBe(true);

    const explicit = await fiveTicks(tickOf(v1Fixture(START), true));
    expect(explicit.some(report => report.phases.research === 'completed')).toBe(true);
    expect(explicit.some(report => report.phases.territoryBackfill === 'completed')).toBe(true);
  });

  it('takes the research, configurations and territory backfill phases off the tick when the switch is false, and no longer builds the list', async () => {
    const f = v1Fixture(AFTER_FIVE_EASTERN);
    const { bearer } = await f.pairDevice();
    await setPosture(f, bearer, 'RI', 'calling');
    await putTerritoryPolicy(f.store, START);
    for (let n = 1; n <= 3; n++) await putFirm(f.store, riFirm(n));

    const reports = await fiveTicks(tickOf(f, false));
    // Every one of the three is skipped rather than run and reported as having done nothing.
    expect(reports.every(report => report.phases.research === 'skipped')).toBe(true);
    expect(reports.every(report => report.phases.configurations === 'skipped')).toBe(true);
    expect(reports.every(report => report.phases.territoryBackfill === 'skipped')).toBe(true);
    expect(reports.every(report => report.places === undefined)).toBe(true);
    expect(reports.every(report => report.territory === undefined)).toBe(true);
    expect(reports.every(report => report.researchPrepared === 0 && report.researchCompleted === 0)).toBe(true);
    // The two phases that are nobody's research still take their turn.
    expect(reports.some(report => report.phases.submittedCommands === 'completed')).toBe(true);
    expect(reports.some(report => report.phases.publications === 'completed')).toBe(true);
    // The morning list is not this tick's any more (S6 moved it to the runner's `day.build` job), so the tick
    // leaves it unbuilt whatever this switch says. The one builder is the one the scheduler enqueues.
    expect(f.db.inspect(dayKey('2026-09-18'))).toBeUndefined();
    expect((await dayBuildOf(f)()).outcome.outcome).toBe('built');
    expect(f.db.inspect(dayKey('2026-09-18'))).toBeDefined();
  });

  it('reads the switch from the environment, and only the exact string false turns it off', async () => {
    const base = { DELEGATED_WORKER_ENABLED: 'true', DELEGATED_WORKER_TABLE: 'fictional-table', DELEGATED_WORKSPACE_ID: 'ws',
      DELEGATED_WORKER_HOST: 'worker.example.test', AWS_REGION: 'us-east-1' };
    for (const [value, expected] of [[undefined, true], ['true', true], ['false', false], ['FALSE', true], ['0', true]] as const) {
      const f = v1Fixture(START);
      const services = await createProductionServices({ ...base, ...(value === undefined ? {} : { DELEGATED_WORKER_LEGACY_RESEARCH_ENABLED: value }) },
        { dynamo: f.store.options.dynamo, fetch: async () => { throw new Error('unconfigured fictional HTTP'); } });
      expect(services).not.toBeNull();
      const reports = await fiveTicks(services!.source);
      expect(reports.some(report => report.phases.research === 'completed'), `LEGACY_RESEARCH_ENABLED=${String(value)}`).toBe(expected);
    }
  });
});
