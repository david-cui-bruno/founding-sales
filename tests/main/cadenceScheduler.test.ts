import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BUILTIN_CADENCES } from '../../src/main/domain/cadence/builtinCadences';
import {
  FOUNDER_CHANNEL_POLICIES_V1,
  scheduleComponent,
} from '../../src/main/domain/cadence/cadenceScheduler';

const [cadenceA, , cadenceC] = BUILTIN_CADENCES;

function schedule(input: Partial<Parameters<typeof scheduleComponent>[0]> = {}) {
  return scheduleComponent({
    step: cadenceA.steps[0]!,
    component: cadenceA.steps[0]!.components[0]!,
    anchorAt: '2026-10-30T14:30:00.000Z',
    evaluationAt: '2026-10-30T14:30:00.000Z',
    timezone: 'America/New_York',
    policies: FOUNDER_CHANNEL_POLICIES_V1,
    priorCallWindow: null,
    ...input,
  });
}

describe('cadence component scheduling', () => {
  let bundleDirectory: string;
  let scenarioBundle: string;

  beforeAll(() => {
    bundleDirectory = mkdtempSync(join(process.cwd(), '.native-test-'));
    scenarioBundle = join(bundleDirectory, 'cadence-timezone.cjs');
    const build = spawnSync(join(process.cwd(), 'node_modules/.bin/esbuild'), [
      join(process.cwd(), 'tests/support/cadenceTimezoneScenario.ts'),
      '--bundle', '--platform=node', '--format=cjs', '--packages=external',
      '--log-level=error', `--outfile=${scenarioBundle}`,
    ], { cwd: process.cwd(), encoding: 'utf8' });
    expect({ status: build.status, stderr: build.stderr }).toEqual({ status: 0, stderr: '' });
  });

  afterAll(() => rmSync(bundleDirectory, { recursive: true, force: true }));

  it('uses the fixed anchor local date instead of cumulatively sliding late steps', () => {
    const dayThree = cadenceA.steps[2]!;
    expect(schedule({
      step: dayThree,
      component: dayThree.components[0]!,
      anchorAt: '2026-10-30T14:30:00.000Z',
      evaluationAt: '2026-11-05T18:15:00.000Z',
    })).toMatchObject({
      dueAt: '2026-11-05T18:15:00.000Z',
      allowedWindow: 'founder_text_v1:mon-sat',
    });
  });

  it('preserves local wall-clock intent across the fall and spring DST boundaries', () => {
    const dayThree = cadenceA.steps[2]!;
    expect(schedule({
      step: dayThree,
      component: dayThree.components[0]!,
      anchorAt: '2026-10-31T14:30:00.000Z',
      evaluationAt: '2026-10-31T14:30:00.000Z',
    }).dueAt).toBe('2026-11-03T14:00:00.000Z');
    expect(schedule({
      step: dayThree,
      component: dayThree.components[0]!,
      anchorAt: '2027-03-13T15:30:00.000Z',
      evaluationAt: '2027-03-13T15:30:00.000Z',
    }).dueAt).toBe('2027-03-16T13:00:00.000Z');
  });

  it('uses half-open text and email policy boundaries including Sunday afternoon only', () => {
    const textStep = cadenceA.steps[0]!;
    const text = textStep.components[2]!;
    expect(schedule({ step: textStep, component: text, evaluationAt: '2026-11-01T16:59:59.999Z' }).dueAt)
      .toBe('2026-11-01T18:00:00.000Z');
    expect(schedule({ step: textStep, component: text, evaluationAt: '2026-11-01T18:00:00.000Z' }).dueAt)
      .toBe('2026-11-01T18:00:00.000Z');
    expect(schedule({ step: textStep, component: text, evaluationAt: '2026-11-01T22:00:00.000Z' }).dueAt)
      .toBe('2026-11-02T14:00:00.000Z');
    expect(schedule({ step: textStep, component: text, evaluationAt: '2026-11-02T01:00:00.000Z' }).dueAt)
      .toBe('2026-11-02T14:00:00.000Z');

    const email = cadenceA.steps[4]!.components[0]!;
    const immediateEmailStep = { ...cadenceA.steps[4]!, dayOffset: 0 };
    expect(schedule({ step: immediateEmailStep, component: email, evaluationAt: '2026-11-02T12:00:00.000Z' }).dueAt)
      .toBe('2026-11-02T13:00:00.000Z');
  });

  it('uses Morning/Afternoon/Evening call windows and a different window for the day-one call', () => {
    const dayOne = cadenceA.steps[1]!;
    const component = dayOne.components[0]!;
    expect(schedule({
      step: dayOne,
      component,
      anchorAt: '2026-10-30T18:30:00.000Z',
      evaluationAt: '2026-10-30T18:30:00.000Z',
      priorCallWindow: 'afternoon',
    })).toMatchObject({ dueAt: '2026-10-31T13:00:00.000Z', allowedWindow: 'morning' });
    expect(schedule({
      step: dayOne,
      component,
      anchorAt: '2026-10-31T14:00:00.000Z',
      evaluationAt: '2026-10-31T14:00:00.000Z',
      priorCallWindow: 'afternoon',
    })).toMatchObject({ dueAt: '2026-11-02T14:00:00.000Z', allowedWindow: 'morning' });
    expect(schedule({
      step: dayOne,
      component,
      priorCallWindow: 'morning',
    })).toMatchObject({ dueAt: '2026-10-31T17:00:00.000Z', allowedWindow: 'afternoon' });
  });

  it.each([
    ['2026-08-31T12:59:59.999Z', '2026-08-31T13:00:00.000Z', 'morning'],
    ['2026-08-31T13:00:00.000Z', '2026-08-31T13:00:00.000Z', 'morning'],
    ['2026-08-31T16:00:00.000Z', '2026-08-31T17:00:00.000Z', 'afternoon'],
    ['2026-08-31T20:59:59.999Z', '2026-08-31T20:59:59.999Z', 'afternoon'],
    ['2026-08-31T21:00:00.000Z', '2026-08-31T21:00:00.000Z', 'evening'],
    ['2026-09-01T00:00:00.000Z', '2026-09-01T13:00:00.000Z', 'morning'],
    ['2026-08-30T16:59:59.999Z', '2026-08-30T17:00:00.000Z', 'afternoon'],
    ['2026-08-30T17:00:00.000Z', '2026-08-30T17:00:00.000Z', 'afternoon'],
    ['2026-08-30T21:00:00.000Z', '2026-08-31T13:00:00.000Z', 'morning'],
  ] as const)('enforces half-open call boundary at %s', (at, dueAt, allowedWindow) => {
    expect(schedule({ anchorAt: at, evaluationAt: at })).toMatchObject({ dueAt, allowedWindow });
  });

  it('schedules the Warm day-one call and exposes its final day-two SLA window', () => {
    const step = cadenceC.steps[1]!;
    expect(schedule({
      step,
      component: step.components[0]!,
      anchorAt: '2026-10-30T14:30:00.000Z',
      evaluationAt: '2026-10-30T14:30:00.000Z',
    })).toMatchObject({
      dueAt: '2026-10-31T13:00:00.000Z',
      slaDueAt: '2026-11-01T22:00:00.000Z',
    });
  });

  it('fails closed for invalid timestamps, timezones, and policy snapshots', () => {
    expect(() => schedule({ evaluationAt: 'not-an-instant' })).toThrow();
    expect(() => schedule({ timezone: 'Mars/Olympus_Mons' })).toThrow();
    expect(() => schedule({
      policies: { ...FOUNDER_CHANNEL_POLICIES_V1, text: { ...FOUNDER_CHANNEL_POLICIES_V1.text, id: '' } },
    })).toThrow();
  });

  it('is byte-deterministic and independent of the process timezone', () => {
    const original = process.env.TZ;
    process.env.TZ = 'Pacific/Honolulu';
    const first = JSON.stringify(schedule());
    process.env.TZ = 'Europe/London';
    const second = JSON.stringify(schedule());
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
    expect(second).toBe(first);

    const run = (timezone: string) => spawnSync(process.execPath, [scenarioBundle], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, TZ: timezone },
    });
    const honolulu = run('Pacific/Honolulu');
    const london = run('Europe/London');
    expect(honolulu).toMatchObject({ status: 0, stderr: '' });
    expect(london).toMatchObject({ status: 0, stderr: '' });
    expect(london.stdout).toBe(honolulu.stdout);
  });
});
