import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mayMutate } from '@fss/contracts';
import { POSTURE_STATEMENTS } from '@fss/domain';
import { CONTAINER_CLIENT_VERSIONS } from '../../src/bootstrap/main.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from '../support/authFixture.ts';
import { issueSessionFor } from '../support/sessionFixture.ts';
import { createCrmBridge } from '../../../desktop/src/main/crmBridge.ts';
import { createAdminBridge } from '../../../desktop/src/main/settingsBridge.ts';
import { buildFirmWorkspaceView } from '../../../desktop/src/renderer/firmWorkspaceView.ts';
import { adminViewOf } from '../../../desktop/src/renderer/settingsView.ts';
import { DESKTOP_VERSION_UNDER_TEST, desktopClient } from '../support/wireThrough.ts';

/**
 * A founder adds, imports and permits from the Mac (release.md 8.0aq; lane g84, audit
 * items G02 and G04).
 *
 * Before g84 the only way a firm reached the workspace was a CSV sent to
 * `/import/commit` by something other than the Mac, and the only way a state posture was
 * recorded was a `POST /postures/record` nobody's screen could make. So a new workspace
 * had no firms and could call no state. This check drives the shipped desktop bridges —
 * the CRM window's and the Administration window's — through the real routes over a real
 * PostgreSQL, and asks the database what landed.
 *
 * ## The vacuous-pass traps, named
 *
 * **A refusal nobody sees.** Every refusal here is read back through the bridge, and the
 * field it names is asserted, not just the code: a row refused "somewhere" is the audit's
 * complaint, not its fix.
 *
 * **A preview that is the commit.** The import is previewed, then the workspace changes —
 * the same firm and contact are added by hand — and only then committed. The commit must
 * decide again rather than trust the preview: the contact's row is refused as already
 * here, and the second contact attaches to the firm that now exists.
 *
 * **A posture overlap that is a 500.** The second posture for a state meets the first in
 * the database's exclusion constraint; until g84 that aborted the transaction and the
 * route answered 500. It must come back as the sentence.
 */

describe('8.0aq: Add firm, Import and the postures form reach the real routes (lane g84)', () => {
  let fixture: AuthFixture;
  let adminToken = '';
  let salespersonToken = '';

  const session = (role: 'admin' | 'salesperson') => ({
    state: async () => await Promise.resolve({ online: true, mayMutate: true, device: { role } }),
  });
  const crmBridge = (token: string, role: 'admin' | 'salesperson') =>
    createCrmBridge({ api: desktopClient(fixture, token), clientVersion: CURRENT_CLIENT_VERSION, session: session(role) });

  const routesOf = async (firmId: string) =>
    (
      await fixture.db.query<{ eligibility: string; source: string }>(
        `SELECT eligibility, source FROM email_addresses WHERE workspace_id = $1 AND firm_id = $2
         UNION ALL SELECT eligibility, source FROM phone_routes WHERE workspace_id = $1 AND firm_id = $2`,
        [fixture.alpha.workspaceId, firmId],
      )
    ).rows;

  beforeAll(async () => {
    fixture = await createAuthFixture();
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    salespersonToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('adds a firm for the salesperson who typed it, opens its page, and names a duplicate', async () => {
    const crm = crmBridge(salespersonToken, 'salesperson');
    await crm.openAddFirm();
    const added = await crm.addFirm({
      name: 'Aspen Test Wealth',
      website: 'aspen.example.test',
      timeZone: 'America/Chicago',
      contactName: 'Kim Placeholder',
      contactTitle: 'Principal',
      contactEmail: 'kim@aspen.example.test',
      contactPhone: '401 555 0121',
    });
    expect(added.notice).toBe('firm_added');
    expect(added.screen).toBe('firm');
    const firmId = added.firm?.read.firm.id ?? '';
    expect(added.firm?.read.firm.name).toBe('Aspen Test Wealth');

    const firm = await fixture.db.query<{ assigned_user_id: string; website: string; time_zone: string }>(
      'SELECT assigned_user_id, website, time_zone FROM firms WHERE workspace_id = $1 AND id = $2',
      [fixture.alpha.workspaceId, firmId],
    );
    expect(firm.rows[0]).toEqual({
      assigned_user_id: fixture.alpha.salesperson.userId,
      website: 'https://aspen.example.test',
      time_zone: 'America/Chicago',
    });
    // Typed by a person is not verified by anything: both routes are candidates (7.4).
    expect(await routesOf(firmId)).toEqual([
      { eligibility: 'candidate', source: 'salesperson' },
      { eligibility: 'candidate', source: 'salesperson' },
    ]);

    // A firm with no stage yet is on the pipeline, under "Not in the pipeline yet".
    const pipeline = await crm.openPipeline();
    expect(pipeline.pipeline?.unplacedFirms?.map(entry => entry.id)).toContain(firmId);

    await crm.openAddFirm();
    const again = await crm.addFirm({
      name: 'Aspen Wealth (again)',
      website: 'https://www.aspen.example.test/about',
      timeZone: '',
      contactName: '',
      contactTitle: '',
      contactEmail: '',
      contactPhone: '',
    });
    expect(again.notice).toBe('duplicate_in_workspace');
    expect(again.screen).toBe('add_firm');
    expect(again.addFirm?.duplicateFirmId).toBe(firmId);
    expect(again.addFirm?.issues).toEqual([{ column: 'website', code: 'duplicate_in_workspace' }]);
    expect(again.addFirm?.draft.name).toBe('Aspen Wealth (again)');
    expect(buildFirmWorkspaceView(again).banners.map(banner => banner.text)).toContain(
      'That firm is already here. Open it, or change the website or the name.',
    );
  });

  it('previews an import, decides again at commit, and names the refused row and its column', async () => {
    const admin = crmBridge(adminToken, 'admin');
    await admin.openImport();
    const csv = [
      'firm_name,website,contact_name,contact_email,contact_phone,region_code',
      'Birch Test Advisors,birch.example.test,Lee Placeholder,lee@birch.example.test,401 555 0131,RI',
      'Birch Test Advisors,birch.example.test,Pat Placeholder,pat@birch.example.test,,RI',
      'Cedar Test Partners,cedar.example.test,Robin Placeholder,not-an-address,,MA',
    ].join('\n');
    const previewed = await admin.previewImport({ csv, fileName: 'prospects.csv' });
    expect(previewed.import?.preview?.counts).toMatchObject({ create: 1, attach: 1, duplicate: 0, invalid: 1 });
    const invalid = previewed.import?.preview?.rows.find(row => row.outcome === 'invalid');
    expect([invalid?.rowNumber, invalid?.issues]).toEqual([4, [{ column: 'contact_email', code: 'email_invalid' }]]);

    // Between the preview and the press, somebody adds Birch and Lee by hand.
    const salesperson = crmBridge(salespersonToken, 'salesperson');
    const byHand = await salesperson.addFirm({
      name: 'Birch Test Advisors',
      website: 'birch.example.test',
      timeZone: '',
      contactName: 'Lee Placeholder',
      contactTitle: '',
      contactEmail: 'lee@birch.example.test',
      contactPhone: '',
    });
    expect(byHand.notice).toBe('firm_added');
    const birchId = byHand.firm?.read.firm.id ?? '';

    const committed = await admin.commitImport();
    expect(committed.notice).toBe('imported_with_refusals');
    const results = committed.import?.results?.results ?? [];
    expect(results.map(result => [result.rowNumber, result.status, result.reason ?? null, result.column ?? null, result.outcome ?? null])).toEqual([
      [2, 'refused', 'duplicate_in_workspace', 'contact_email', null],
      [3, 'accepted', null, null, 'attached'],
    ]);
    expect(results[1]?.firmId).toBe(birchId);

    // The attached contact's address is a candidate from the import, beside the hand-typed one.
    expect((await routesOf(birchId)).map(route => route.source).sort()).toEqual(['import', 'salesperson']);
    expect((await routesOf(birchId)).every(route => route.eligibility === 'candidate')).toBe(true);
    const view = buildFirmWorkspaceView(committed);
    expect(view.banners.map(banner => banner.text)).toContain('Imported, except the rows listed below.');
  });

  it('records a posture from the form, refuses an overlap in words, and revokes it', async () => {
    const admin = createAdminBridge({ api: desktopClient(fixture, adminToken), session: session('admin') });
    const opened = await admin.state();
    expect(opened.postures?.reference?.statements.map(entry => entry.key)).toEqual(Object.keys(POSTURE_STATEMENTS));
    expect(opened.postures?.records).toEqual([]);

    const input = {
      state: 'ri',
      effectiveFromDate: '2026-09-01',
      reviewDate: '',
      confirmedStatements: Object.keys(POSTURE_STATEMENTS),
      note: 'Read the registration page.',
    };
    const recorded = await admin.recordPosture(input);
    expect(recorded.notice).toBe('posture_recorded');
    const posture = recorded.postures?.records?.[0];
    // Midnight on 1 September in the business zone (New York, EDT), and a year's review.
    expect([posture?.state, posture?.effectiveFrom, posture?.reviewAt]).toEqual([
      'RI',
      '2026-09-01T04:00:00.000Z',
      '2027-09-01T04:00:00.000Z',
    ]);

    const overlapping = await admin.recordPosture({ ...input, effectiveFromDate: '2026-10-01' });
    expect(overlapping.notice).toBe('posture_overlapping');
    expect(adminViewOf(overlapping).notice).toContain('already has a posture in force for part of that time');

    const revoked = await admin.revokePosture({ postureId: posture?.id ?? '' });
    expect(revoked.notice).toBe('posture_revoked');
    expect(revoked.postures?.records?.[0]?.revokedAt).not.toBeNull();
    expect((await admin.recordPosture({ ...input, effectiveFromDate: '2026-10-01' })).notice).toBe('posture_recorded');
  });

  it('is a build the deployed API accepts', () => {
    expect(mayMutate(CONTAINER_CLIENT_VERSIONS, DESKTOP_VERSION_UNDER_TEST)).toBe(true);
  });
});
