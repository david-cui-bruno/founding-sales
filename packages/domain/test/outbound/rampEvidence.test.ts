import { afterAll, beforeAll, expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { claimForDispatch } from '../../outbound/fence.ts';
import { closeSendDay, recordDaySignal, rampAdvancementFailure, type RampHealthSignals } from '../../outbound/ramp.ts';
import { createOutboundWorld, type OutboundWorld } from './support/outboundWorld.ts';
import { prepareFor, seedFirm } from './support/dispatchFixtures.ts';

const signals: RampHealthSignals = {
  authenticationPasses: true, coverageHealthy: true, providerWarning: false,
  automatedSent: 4, bounces: 0, optOuts: 0, providerErrors: 0,
};
let world: OutboundWorld;
beforeAll(async () => {
  world = await createOutboundWorld();
  await world.database.session.query(
    'UPDATE mailbox_send_ramp SET healthy_sending_days=0,last_advanced_on=NULL WHERE mailbox_id=$1',
    [world.alpha.mailboxId],
  );
});
afterAll(async () => { await world?.stop(); });
const context = () => world.systemContext(world.alpha.workspace.workspaceId);

it('requires substantial stage exposure, including when an admin has lowered the cap', () => {
  expect(rampAdvancementFailure({ ...signals, automatedSent: 1 }, 5)).toBe('insufficient_volume');
  expect(rampAdvancementFailure(signals, 5)).toBeNull();
  expect(rampAdvancementFailure(signals, 10)).toBe('insufficient_volume');
  expect(rampAdvancementFailure({ ...signals, automatedSent: 8 }, 10)).toBeNull();
  expect(rampAdvancementFailure({ ...signals, automatedSent: 1, bounces: 1 }, 5)).toBe('bounce_rate');
  expect(rampAdvancementFailure({ ...signals, optOuts: 1 }, 5)).toBe('opt_out_rate');
  expect(rampAdvancementFailure({ ...signals, providerErrors: 1 }, 5)).toBe('provider_warning');
});

async function day(date: string, count: number) {
  await world.database.session.query(
    `INSERT INTO mailbox_send_days (workspace_id,mailbox_id,business_date,automated_sent,cap_granted)
     VALUES ($1,$2,$3::date,$4,5)`,
    [world.alpha.workspace.workspaceId, world.alpha.mailboxId, date, count],
  );
}
const close = (date: string, health = signals) => withTransaction(world.database.session, () => closeSendDay(context(), {
  mailboxId: world.alpha.mailboxId, businessDate: date, signals: health,
}));

it('does not graduate sparse days and never re-earns a closed failed verdict', async () => {
  await day('2026-09-01', 1);
  expect(await close('2026-09-01')).toMatchObject({ advanced: false, failure: 'insufficient_volume', healthySendingDays: 0 });
  await day('2026-09-02', 4);
  expect(await close('2026-09-02', { ...signals, providerWarning: true })).toMatchObject({ advanced: false, failure: 'provider_warning' });
  expect(await close('2026-09-02')).toMatchObject({ advanced: false, healthy: false, healthySendingDays: 0 });
  await day('2026-09-03', 4);
  expect(await close('2026-09-03')).toMatchObject({ advanced: true, healthySendingDays: 1 });
  expect(await close('2026-09-03')).toMatchObject({ advanced: false, healthy: true, healthySendingDays: 1 });
});

it('will not graduate a day with an unresolved provider attempt', async () => {
  const firm = await seedFirm(world, world.alpha, 'unsettled-exposure');
  const fence = await prepareFor(world, world.alpha, firm);
  const claim = await claimForDispatch(context(), { outboundMessageId: fence, businessDate: '2026-09-04' });
  expect(claim.ok).toBe(true);
  await day('2026-09-04', 4);
  expect(await close('2026-09-04')).toMatchObject({ advanced: false, failure: 'unsettled_sends', healthySendingDays: 1 });
});

it('revokes a graduated day for a late opt-out once, including on a repeated signal', async () => {
  await day('2026-09-05', 4);
  expect(await close('2026-09-05')).toMatchObject({ advanced: true, healthySendingDays: 2 });
  for (let i = 0; i < 2; i += 1) {
    await withTransaction(world.database.session, () => recordDaySignal(context(), {
      mailboxId: world.alpha.mailboxId, businessDate: '2026-09-05', signal: 'opt_out',
    }));
  }
  const ramp = await world.database.session.query('SELECT healthy_sending_days,last_health_failure FROM mailbox_send_ramp WHERE mailbox_id=$1', [world.alpha.mailboxId]);
  expect(ramp.rows).toEqual([{ healthy_sending_days: 1, last_health_failure: 'opt_out_rate' }]);
});

it('does not mark an out-of-order day as graduated or later revoke unearned progress', async () => {
  await day('2026-08-31', 4);
  expect(await close('2026-08-31')).toMatchObject({ advanced: false, failure: 'out_of_order_day', healthySendingDays: 1 });
  await withTransaction(world.database.session, () => recordDaySignal(context(), {
    mailboxId: world.alpha.mailboxId, businessDate: '2026-08-31', signal: 'opt_out',
  }));
  const ramp = await world.database.session.query('SELECT healthy_sending_days FROM mailbox_send_ramp WHERE mailbox_id=$1', [world.alpha.mailboxId]);
  expect(ramp.rows).toEqual([{ healthy_sending_days: 1 }]);
});

it('atomically counts a late provider signal and revokes graduation outside a caller transaction', async () => {
  await day('2026-09-06', 4);
  expect(await close('2026-09-06')).toMatchObject({ advanced: true, healthySendingDays: 2 });
  await world.database.session.query(`CREATE FUNCTION fail_ramp_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_ramp_failure'; END $$;
    CREATE TRIGGER fail_ramp_update BEFORE UPDATE ON mailbox_send_ramp FOR EACH ROW EXECUTE FUNCTION fail_ramp_update()`);
  try {
    await expect(recordDaySignal(context(), { mailboxId: world.alpha.mailboxId, businessDate: '2026-09-06', signal: 'provider_error' })).rejects.toThrow('fixture_ramp_failure');
    const row = await world.database.session.query('SELECT healthy,provider_errors FROM mailbox_send_days WHERE mailbox_id=$1 AND business_date=$2::date', [world.alpha.mailboxId, '2026-09-06']);
    expect(row.rows).toEqual([{ healthy: true, provider_errors: 0 }]);
  } finally {
    await world.database.session.query('DROP TRIGGER fail_ramp_update ON mailbox_send_ramp; DROP FUNCTION fail_ramp_update()');
  }
  await recordDaySignal(context(), { mailboxId: world.alpha.mailboxId, businessDate: '2026-09-06', signal: 'provider_error' });
  const ramp = await world.database.session.query('SELECT healthy_sending_days,last_health_failure FROM mailbox_send_ramp WHERE mailbox_id=$1', [world.alpha.mailboxId]);
  expect(ramp.rows).toEqual([{ healthy_sending_days: 1, last_health_failure: 'provider_warning' }]);
});
