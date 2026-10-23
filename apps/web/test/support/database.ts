import setup from '../../../../packages/domain/db/testing/globalSetup.ts';

/** Dedicated single-worker lane. Existing helper creates and removes the local cluster
 * and migrated template. No production/service cluster may be adopted by this suite. */
export async function reserveLocalBrowserDatabase(): Promise<() => Promise<void>> {
  if (process.env['FSS_TEST_POSTGRES_URL'] || process.env['FSS_TEST_CLUSTER_URL']) {
    throw new Error('Local browser acceptance refuses an inherited PostgreSQL cluster');
  }
  const release = await setup();
  console.log('LOCAL_BROWSER_PG_RESERVED: dedicated disposable cluster, one worker');
  return async () => {
    await release();
    console.log('LOCAL_BROWSER_PG_RELEASED: template dropped and cluster stopped');
  };
}
