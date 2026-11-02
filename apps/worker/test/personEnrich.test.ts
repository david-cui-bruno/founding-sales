import { afterAll, beforeAll, expect, it } from 'vitest';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { fakePeople, preparedEmailWorld } from '../../../packages/domain/test/outreach/preparedEmailFixture.ts';
import { runOnce } from '../src/runner/jobRunner.ts';
import { runSchedulerPass } from '../src/scheduler/schedulerPass.ts';
import { personEnrichHandler, personEnrichSource } from '../src/handlers/personEnrich.ts';
import { ownSitePeople } from '@fss/domain/outreach/ownSitePeople.ts';

// ADR0036 through the registered handler and the real runner. An `outbound_fence` handler runs outside any transaction, so each reservation can
// only commit before its paid call because the domain opens its own transaction for it.
let world: Awaited<ReturnType<typeof preparedEmailWorld>>;
beforeAll(async () => { world = await preparedEmailWorld(); }, 180_000);
afterAll(async () => { await world?.stop(); });
const schedule = (enabled = true, laterHours = 0) => runSchedulerPass(world.runtime, { sources: [personEnrichSource(enabled)], now: new Date(Date.now() + laterHours * 3_600_000).toISOString() });
const settle = async () => (await world.runtime.query('SELECT state FROM outreach_people_lookups WHERE workspace_id=$1', [world.ws])).rows;

it('schedules nothing without a composed source or while the setting is off, and one job per workspace when on, whatever the daily credit cap (a free source has none)', async () => {
  expect((await schedule(false)).inserted).toBe(0);
  await world.setPeople({ enabled: false, dailyCredits: 30 });
  expect((await schedule()).inserted).toBe(0);
  await world.setPeople({ enabled: true, dailyCredits: 0 });
  expect((await schedule()).inserted).toBe(1);
  expect((await schedule()).inserted).toBe(0);
});

it('enriches a prepared company when the scheduled job runs through the runner, commits the reservation before the call and completes the job', async () => {
  await world.setPeople({ enabled: true, dailyCredits: 30 });
  const company = await world.prepared('OH', () => 'Call our office.', 'Columbus', true);
  const people = fakePeople();
  const registry = new HandlerRegistry().register(personEnrichHandler({ provider: people.provider }));
  expect(await runOnce(world.runtime, { registry, owner: 'person-enrich-test', limit: 5 })).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
  expect(people.calls).toEqual([company.domain]);
  expect(await settle()).toEqual([{ state: 'found' }]);
  expect((await world.runtime.query('SELECT state FROM jobs WHERE workspace_id=$1 AND kind=$2', [world.ws, 'outreach.person_enrich'])).rows).toEqual([{ state: 'done' }]);
});

it('runs the own-site source through the same handler and runner with no key and at a zero credit cap, recording a found person and completing the job', async () => {
  await world.setPeople({ enabled: true, dailyCredits: 0 });
  const company = await world.prepared('OH', domain => `Tyler Bradford, President tyler@${domain}`, 'Columbus', true);
  expect((await schedule(true, 3)).inserted).toBe(1);
  const registry = new HandlerRegistry().register(personEnrichHandler({ provider: ownSitePeople() }));
  expect(await runOnce(world.runtime, { registry, owner: 'person-enrich-own-site', limit: 5 })).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
  expect((await world.runtime.query('SELECT l.provider,l.state,l.credits,c.email,c.email_status FROM outreach_people_lookups l JOIN outreach_people_contacts c ON c.lookup_id=l.id WHERE l.workspace_id=$1 AND l.candidate_id=$2', [world.ws, company.candidateId])).rows).toEqual([{ provider: 'own_site', state: 'found', credits: 0, email: `tyler@${company.domain}`, email_status: 'published' }]);
});
