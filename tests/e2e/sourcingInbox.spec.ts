import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'playwright/test';

import { launchFounderWorkspace } from '../support/founderWorkspace';

test.describe.configure({ mode: 'serial' });

/** A person-bearing parcel event followed by its scored re-emission. */
const IDEMPOTENCY_KEY = 'e2e0'.repeat(16);

function parcelEvent(): Record<string, unknown> {
  return {
    contract_version: 1,
    id: 'se_01E2E000000000000000000001',
    idempotency_key: IDEMPOTENCY_KEY,
    channel: 'parcel',
    source_uri: 'pvd-taxroll:e2e-fixture',
    fetched_at: '2026-09-01T03:00:00.000Z',
    observed_at: '2026-08-30T00:00:00.000Z',
    entity: {
      cloud_entity_id: 'ce_01E2E000000000000000000001',
      person: {
        full_name: 'FIXTURE OWNER LLC',
        mailing_address: {
          line1: '77 Benefit St',
          locality: 'Providence',
          region: 'RI',
          postal_code: '02906',
          country_code: 'US',
        },
        phones: ['+14015550100'],
        emails: [],
        org_names: ['FIXTURE OWNER LLC'],
      },
      property: {
        situs_address: {
          line1: '9 Doyle Ave',
          locality: 'Providence',
          region: 'RI',
          postal_code: '02906',
          country_code: 'US',
        },
        parcel_id: 'PROV-E2E-1',
        unit_count: 3,
        year_built: 1918,
        use_code: '3F',
      },
      known_person: false,
    },
    payload: {
      assessor_class: '2',
      assessed_value_usd: 500000,
      tax_usd: 6000,
      absentee: true,
      owner_kind: 'llc',
      tax_year: 2025,
    },
    signal_flags: {
      self_managed: null,
      vacancy: null,
      pain_mentions: [],
      urgency: 0,
      portfolio_hint: null,
    },
    trigger: null,
    scores: null,
    provenance: { adapter: 'pvd-taxroll', adapter_version: '1.0.0', confidence: 0.95 },
  };
}

function scoredEvent(): Record<string, unknown> {
  return {
    ...parcelEvent(),
    id: 'se_01E2E000000000000000000002',
    scores: {
      fit: 62,
      timing: 41,
      reasons: [
        { signal: 'llc_owner_no_pm', contribution: 7 },
        { signal: 'pre_1940_stock', contribution: 8 },
      ],
    },
    scores_version: 1,
  };
}

test('fixture inbox events import a lead and render its cloud score chip', async () => {
  // Fixture inbox: one intake file, then the scored re-emission. Lexicographic
  // key order (aaa < bbb) mirrors real emission order.
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'callie-sourcing-fixture-'));
  await mkdir(join(fixtureDirectory, 'events', '2026-09-01'), { recursive: true });
  await writeFile(
    join(fixtureDirectory, 'events', '2026-09-01', 'aaa-intake.ndjson'),
    `${JSON.stringify(parcelEvent())}\n`,
  );
  await writeFile(
    join(fixtureDirectory, 'events', '2026-09-01', 'bbb-scored.ndjson'),
    `${JSON.stringify(scoredEvent())}\n`,
  );

  const workspace = await launchFounderWorkspace({
    env: { CALLIE_SOURCING_FIXTURE_DIR: fixtureDirectory },
  });

  try {
    const { page } = workspace;

    // Drive the poll through the real preload surface.
    const status = await page.evaluate(async () => {
      return window.callie.sourcing.pollNow();
    });
    expect(status.counters.imported).toBe(1);
    expect(status.counters.scoreUpdates).toBe(1);

    // The imported lead renders with its two separate cloud axes.
    await page.getByRole('link', { name: 'Leads' }).click();
    await page.getByRole('row', { name: /Fixture Owner Llc/i }).waitFor();
    await expect(page.getByText('Fit 62 · Timing 41')).toBeVisible();
  } finally {
    await workspace.stop();
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});
