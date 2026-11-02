import { afterAll, beforeAll, expect, it } from 'vitest';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { fakePeople, preparedEmailWorld } from '../../../packages/domain/test/outreach/preparedEmailFixture.ts';
import { runOnce } from '../src/runner/jobRunner.ts';
import { runSchedulerPass } from '../src/scheduler/schedulerPass.ts';
import { personEnrichHandler, personEnrichSource } from '../src/handlers/personEnrich.ts';

// ADR0036 through the registered handler and the real runner. An `outbound_fence` handler runs outside any transaction, so each reservation can
// only commit before its paid call because the domain opens its own transaction for it.
let world: Awaited<ReturnType<typeof preparedEmailWorld>>;
beforeAll(async () => { world = await preparedEmailWorld(); }, 180_000);
afterAll(async () => { await world?.stop(); });
const schedule = (enabled = true) => runSchedulerPass(world.runtime, { sources: [personEnrichSource(enabled)], now: new Date().toISOString() });
const settle = async () => (await world.runtime.query('SELECT state FROM outreach_people_lookups WHERE workspace_id=$1', [world.ws])).rows;

it('schedules nothing without a composed provider or while the setting is off, and one job per workspace when on', async () => {
  expect((await schedule(false)).inserted).toBe(0);
  await world.setPeople({ enabled: false, dailyCredits: 30 });
  expect((await schedule()).inserted).toBe(0);
  await world.setPeople({ enabled: true, dailyCredits: 0 });
  expect((await schedule()).inserted).toBe(0);
  await world.setPeople({ enabled: true, dailyCredits: 30 });
  expect((await schedule()).inserted).toBe(1);
  expect((await schedule()).inserted).toBe(0);
});

it('enriches a prepared company when the scheduled job runs through the runner, commits the reservation before the call and completes the job', async () => {
  const company = await world.prepared('OH', () => 'Call our office.', 'Columbus', true);
  const people = fakePeople();
  const registry = new HandlerRegistry().register(personEnrichHandler({ provider: people.provider }));
  expect(await runOnce(world.runtime, { registry, owner: 'person-enrich-test', limit: 5 })).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
  expect(people.calls).toEqual([company.domain]);
  expect(await settle()).toEqual([{ state: 'found' }]);
  expect((await world.runtime.query('SELECT state FROM jobs WHERE workspace_id=$1 AND kind=$2', [world.ws, 'outreach.person_enrich'])).rows).toEqual([{ state: 'done' }]);
});
