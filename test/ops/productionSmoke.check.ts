import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { repositoryPath } from './support/repository.ts';

/**
 * The production smoke compares sending with the state the operator expects (lane g80,
 * audit item O12).
 *
 * Until g80 the sixth check passed only on `sendingEnabled === false`. That is right
 * before section 6 of `docs/greenfield/release.md` and wrong for ever after it: every
 * ordinary deployment once sending is on would fail its smoke for being exactly what it
 * should be, and the only way through would be to stop believing the smoke. The state
 * is now an input, `--expect-sending disabled|enabled`, off by default.
 *
 * ## The vacuous-pass trap, named
 *
 * A check that took the expectation and passed either way would be green in both states
 * and would never notice a deployment that flipped sending by accident, which is the one
 * thing it is for. So each expectation is run against both answers and must fail the
 * one it does not expect, and a truthy string is neither state.
 */

interface SmokeResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

interface SmokeOptions {
  readonly origin: string;
  readonly json: boolean;
  readonly timeoutMilliseconds: number;
  readonly canaryAgeSeconds: string | null;
  readonly expectSending?: string | null;
}

interface Smoke {
  SMOKE_CHECKS: readonly string[];
  SENDING_EXPECTATIONS: readonly string[];
  parseArguments(argv: readonly string[]): SmokeOptions;
  runSmoke(
    options: SmokeOptions,
    dependencies: {
      readonly fetch: (url: string) => Promise<{ status: number; text: () => Promise<string> }>;
      readonly ranges: { api: { minimum: number; maximum: number }; worker: { minimum: number; maximum: number } };
    },
  ): Promise<SmokeResult[]>;
}

// A computed specifier: plain ESM with no declarations.
const SMOKE_PATH = repositoryPath('scripts/productionSmoke.mjs');
const smoke = (await import(SMOKE_PATH)) as Smoke;

const RANGES = { api: { minimum: 16, maximum: 16 }, worker: { minimum: 16, maximum: 16 } };

/** A healthy deployment whose `/health` says `sendingEnabled` is `sending`. */
function deployment(sending: unknown) {
  const bodies: Record<string, unknown> = {
    '/healthz': { status: 'live' },
    '/readyz': { ready: true, schema: { declaredRange: { minimum: 16, maximum: 16 }, accepted: true, databaseVersion: 16 } },
    '/health': { sendingEnabled: sending },
  };
  return (url: string) => {
    const path = new URL(url).pathname;
    return Promise.resolve({ status: 200, text: () => Promise.resolve(JSON.stringify(bodies[path] ?? {})) });
  };
}

async function sixth(sending: unknown, argv: readonly string[]): Promise<SmokeResult> {
  const options = smoke.parseArguments(['--origin', 'https://api.example.test', '--canary-age-seconds', '3', ...argv]);
  const results = await smoke.runSmoke(options, { fetch: deployment(sending), ranges: RANGES });
  expect(results.map(result => result.name).slice(0, 5)).toEqual(smoke.SMOKE_CHECKS.slice(0, 5));
  // The first five pass against this deployment, so the sixth is the only variable.
  expect(results.slice(0, 5).every(result => result.passed), JSON.stringify(results)).toBe(true);
  const last = results.at(-1);
  if (last === undefined) throw new Error('the smoke returned no results');
  return last;
}

describe('g80: the smoke holds sending to the expected state, off by default', () => {
  it('expects sending off unless told otherwise, and fails when it is on', async () => {
    expect(smoke.parseArguments(['--origin', 'https://api.example.test']).expectSending).toBe('disabled');
    expect(await sixth(false, [])).toEqual({
      name: 'sending_disabled',
      passed: true,
      detail: 'sendingEnabled=false expected=disabled',
    });
    expect(await sixth(true, [])).toMatchObject({ name: 'sending_disabled', passed: false });
    expect(await sixth(true, ['--expect-sending', 'disabled'])).toMatchObject({ passed: false });
  });

  it('passes an enabled deployment when enabled is expected, and fails a disabled one', async () => {
    expect(await sixth(true, ['--expect-sending', 'enabled'])).toEqual({
      name: 'sending_enabled',
      passed: true,
      detail: 'sendingEnabled=true expected=enabled',
    });
    expect(await sixth(false, ['--expect-sending', 'enabled'])).toMatchObject({ name: 'sending_enabled', passed: false });
  });

  it('is neither state for anything but a boolean, and fails when the field is missing', async () => {
    expect(await sixth('true', ['--expect-sending', 'enabled'])).toMatchObject({ passed: false });
    expect(await sixth(0, [])).toMatchObject({ passed: false });
    expect(await sixth(undefined, [])).toMatchObject({ passed: false, detail: 'SMOKE_FIELD_MISSING:sendingEnabled' });
  });

  it('refuses to run on an expectation it does not know, rather than guessing', async () => {
    expect(smoke.SENDING_EXPECTATIONS).toEqual(['disabled', 'enabled']);
    expect(() => smoke.parseArguments(['--origin', 'https://api.example.test', '--expect-sending', 'on'])).toThrow(
      'SMOKE_BAD_EXPECT_SENDING:on',
    );
    expect(() => smoke.parseArguments(['--origin', 'https://api.example.test', '--expect-sending'])).toThrow(
      'SMOKE_BAD_EXPECT_SENDING',
    );
    await expect(
      smoke.runSmoke(
        { origin: 'https://api.example.test', json: false, timeoutMilliseconds: 1000, canaryAgeSeconds: '3', expectSending: 'Enabled' },
        { fetch: deployment(true), ranges: RANGES },
      ),
    ).rejects.toThrow('SMOKE_BAD_EXPECT_SENDING:Enabled');
    // From the command line that is exit 2, "could not run", before any request.
    const cli = spawnSync(process.execPath, [SMOKE_PATH, '--origin', 'https://api.example.test', '--expect-sending', 'yes'], {
      encoding: 'utf8',
    });
    expect(cli.status).toBe(2);
    expect(cli.stderr).toContain('SMOKE_BAD_EXPECT_SENDING:yes');
  });
});
