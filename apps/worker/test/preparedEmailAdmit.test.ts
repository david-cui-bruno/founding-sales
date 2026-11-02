import { afterAll, beforeAll, expect, it } from 'vitest';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { repositoryContext } from '@fss/domain/db/workspaceScope.ts';
import { dnsEmailVerifier, emailVerificationKey } from '@fss/domain/outreach/emailVerification.ts';
import { runPreparedEmailAdmission } from '@fss/domain/outreach/preparedEmailAdmission.ts';
import { goodMx, preparedEmailWorld } from '../../../packages/domain/test/outreach/preparedEmailFixture.ts';
import { runOnce } from '../src/runner/jobRunner.ts';
import { runSchedulerPass } from '../src/scheduler/schedulerPass.ts';
import { preparedEmailAdmitHandler, preparedEmailAdmitSource } from '../src/handlers/preparedEmailAdmit.ts';

// ADR0035 through the registered handler and the real runner. An `outbound_fence` handler runs outside any transaction, so the
// admission's SAVEPOINT and transaction-level advisory locks only work because the domain opens each admission's own transaction.
let world: Awaited<ReturnType<typeof preparedEmailWorld>>;
beforeAll(async () => { world = await preparedEmailWorld(); }, 180_000);
afterAll(async () => { await world?.stop(); });

it('admits a prepared own-site company when the scheduled job runs through the runner, and commits the check on its own', async () => {
  const company = await world.prepared('OH', domain => `Email info@${domain}`, 'Columbus', true);
  const scheduled = await runSchedulerPass(world.runtime, { sources: [preparedEmailAdmitSource()], now: new Date().toISOString() });
  expect(scheduled.inserted).toBe(1);
  const registry = new HandlerRegistry().register(preparedEmailAdmitHandler({ verifier: dnsEmailVerifier(goodMx, 50) }));
  const ran = await runOnce(world.runtime, { registry, owner: 'prepared-email-test', limit: 5 });
  expect(ran).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
  expect(await world.admissions()).toEqual([{ address: `info@${company.domain}`, source_kind: 'prepared_capture', region: 'OH' }]);
  expect((await world.runtime.query('SELECT outcome FROM outreach_email_verifications WHERE workspace_id=$1', [world.ws])).rows).toEqual([{ outcome: 'ok' }]);
  expect((await world.runtime.query('SELECT state FROM jobs WHERE workspace_id=$1 AND kind=$2', [world.ws, 'outreach.email_admit'])).rows).toEqual([{ state: 'done' }]);
});

it('commits the address check on its own: a failed admission rolls back only itself', async () => {
  const company = await world.prepared('OH', domain => `Email hello@${domain}`, 'Columbus', true);
  const failing: SessionQueryable = { query: (sql, values) => /^\s*INSERT INTO outreach_email_campaign_admissions/u.test(sql) ? Promise.reject(new Error('injected admission failure')) : world.runtime.query(sql, values) };
  const failed = await runPreparedEmailAdmission(repositoryContext(world.ctx(true).scope, failing), { verifier: dnsEmailVerifier(goodMx, 50) });
  expect(failed).toEqual({ admitted: 0, checked: 1, failed: 1 });
  expect((await world.runtime.query('SELECT outcome FROM outreach_email_verifications WHERE workspace_id=$1 AND address_key=$2', [world.ws, emailVerificationKey(`hello@${company.domain}`)])).rows).toEqual([{ outcome: 'ok' }]);
  expect((await world.runtime.query('SELECT 1 FROM firms WHERE workspace_id=$1 AND website=$2', [world.ws, `https://${company.domain}/`])).rows).toEqual([]);
  expect(await runPreparedEmailAdmission(world.ctx(true), { verifier: { verify: async () => { throw new Error('must not ask again inside the window'); } } })).toEqual({ admitted: 1, checked: 0, failed: 0 });
});
