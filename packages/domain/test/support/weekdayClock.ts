import type { TestDatabase } from '../../db/testing/testDatabase.ts';

/** Test-only weekday anchor, scoped to one disposable clone and its worker's Date. */
export async function installWeekdayClock(database: TestDatabase): Promise<void> {
  const current = (await database.session.query<{ name: string }>('SELECT current_database() AS name')).rows[0]?.name;
  if (current !== database.name || !/^fss_test_[a-f0-9]{32}$/u.test(current)) throw new Error('Expected exact owned test database');
  // Shift JS and database-local clocks to Monday noon, retaining real elapsed
  // time, row ordering, lock waits and expiry. Trigger/default clocks must agree.
  const NativeDate = Date;
  const at = new NativeDate();
  at.setUTCDate(at.getUTCDate() + ((8 - at.getUTCDay()) % 7 || 7));
  at.setUTCHours(12, 0, 0, 0);
  const offset = at.getTime() - NativeDate.now();
  await database.session.query(`CREATE FUNCTION public.owner_risk_wall_clock() RETURNS timestamptz
    LANGUAGE internal VOLATILE PARALLEL SAFE AS 'clock_timestamp'`);
  for (const [name, clock, volatility] of [['clock_timestamp', 'public.owner_risk_wall_clock()', 'VOLATILE'],
    ['now', 'pg_catalog.transaction_timestamp()', 'STABLE']] as const) {
    await database.session.query(`CREATE OR REPLACE FUNCTION pg_catalog.${name}() RETURNS timestamptz
      LANGUAGE sql ${volatility} PARALLEL SAFE AS $$ SELECT ${clock} + interval '${offset} milliseconds' $$`);
  }
  // A Date-only proxy changes no timers. Explicit date arguments remain literal.
  globalThis.Date = new Proxy(NativeDate, {
    construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [NativeDate.now() + offset], newTarget),
    apply: () => new NativeDate(NativeDate.now() + offset).toString(),
    get: (target, key, receiver) => key === 'now' ? () => NativeDate.now() + offset : Reflect.get(target, key, receiver),
  });
  const drop = database.drop;
  database.drop = async () => { try { await drop(); } finally { globalThis.Date = NativeDate; } };
}
