import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ENROLLMENT_ORIGIN_KINDS,
  FOLLOW_UP_PERMISSION_KINDS,
  FOLLOW_UP_PERMISSION_SCOPES,
  FOLLOW_UP_PERMISSION_WINDOW_DAYS,
  MANUAL_MODE_ORIGINS_FOR_TESTS,
} from './support/followUpVocabulary.ts';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { seedCrm } from './support/crmFixtures.ts';
import { seedTwoWorkspaces } from './support/fixtures.ts';

/**
 * One vocabulary, two places (migration 0025).
 *
 * `@fss/contracts` declares the kinds, the scopes and the origins because the desktop
 * may not import `@fss/domain` (14.2); `0025_follow_up_permissions.sql` repeats each as
 * a CHECK, as every closed vocabulary in this schema does. A value the contract has and
 * the CHECK refuses is a form the Mac can submit and the database will reject; a value
 * the CHECK admits and the contract does not is a row nothing can read. Both directions
 * are asserted by inserting every declared value and by counting the alternatives the
 * catalogue holds.
 */
describe('the follow-up vocabularies in the database', () => {
  let database: TestDatabase;
  let workspaceId: string;
  let firmId: string;
  let contactId: string;
  let userId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    const seeded = await seedTwoWorkspaces(database.session);
    const crm = await seedCrm(database.session, seeded);
    workspaceId = seeded.alpha.workspaceId;
    userId = seeded.alpha.admin.userId;
    firmId = crm.alpha.firmId;
    contactId = crm.alpha.contactId;
  });

  afterAll(async () => {
    await database.drop();
  });

  /** A published version, for the scope that must name one. */
  async function publishedVersion(): Promise<string> {
    const { rows: sequence } = await database.session.query<{ id: string }>(
      'INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, $2, $3) RETURNING id',
      [workspaceId, `Vocabulary version ${String(Date.now())}`, userId],
    );
    const { rows } = await database.session.query<{ id: string }>(
      `INSERT INTO sequence_versions (workspace_id, sequence_id, version, state, published_at, published_by_user_id)
       VALUES ($1, $2, 1, 'published', now(), $3) RETURNING id`,
      [workspaceId, sequence[0]?.id ?? '', userId],
    );
    return rows[0]?.id ?? '';
  }

  /** An approved template version, for the scope that must name one. */
  async function approvedTemplate(): Promise<string> {
    const { rows } = await database.session.query<{ id: string }>(
      `INSERT INTO template_versions
         (workspace_id, template_id, version, name, subject, body, content_hash,
          footer_sign_off, approved_at, approved_by_user_id)
       VALUES ($1, gen_random_uuid(), 1, 'Vocabulary', 'A question', 'Hello,', repeat('d', 64),
               'Sam Example', now(), $2)
       RETURNING id`,
      [workspaceId, userId],
    );
    return rows[0]?.id ?? '';
  }

  it('accepts every kind the contract declares', async () => {
    // Every kind against the one scope that needs no other table, so this case is about
    // the kind vocabulary and nothing else.
    for (const kind of FOLLOW_UP_PERMISSION_KINDS) {
      await database.session.query(
        `INSERT INTO follow_up_permissions
           (workspace_id, firm_id, contact_id, kind, scope, booking_reference, expires_at, granted_by_user_id)
         VALUES ($1, $2, $3, $4, 'booking_communications', $5, now() + interval '14 days', $6)`,
        [workspaceId, firmId, contactId, kind, `cal-${kind}`, userId],
      );
    }
    const { rows } = await database.session.query<{ count: string }>(
      'SELECT count(DISTINCT kind)::text AS count FROM follow_up_permissions WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(Number(rows[0]?.count)).toBe(FOLLOW_UP_PERMISSION_KINDS.length);
  });

  it('accepts every scope the contract declares, and every one has a window rule', async () => {
    for (const scope of FOLLOW_UP_PERMISSION_SCOPES) {
      // Each scope with the binding its own CHECK requires: a template for the one
      // e-mail, an immutable version for the agreed sequence, a step limit for
      // everything but the reserved booking scope.
      const versionId = scope === 'agreed_sequence' ? await publishedVersion() : null;
      const templateId = scope === 'single_email' ? await approvedTemplate() : null;
      await database.session.query(
        `INSERT INTO follow_up_permissions
           (workspace_id, firm_id, contact_id, kind, scope, booking_reference, template_version_id,
            sequence_version_id, max_steps, expires_at, granted_by_rule)
         VALUES ($1, $2, $3, 'request', $4, $5, $6, $7, $8, now() + interval '14 days', 'reply_confirmation')`,
        [
          workspaceId,
          firmId,
          contactId,
          scope,
          `cal-scope-${scope}`,
          templateId,
          versionId,
          scope === 'booking_communications' ? null : 1,
        ],
      );
      // Every scope has an answer to "how long?", and exactly one of them is not a
      // constant: `agreed_sequence` lasts as long as its own sequence.
      expect(Object.hasOwn(FOLLOW_UP_PERMISSION_WINDOW_DAYS, scope), scope).toBe(true);
    }
    expect(Object.values(FOLLOW_UP_PERMISSION_WINDOW_DAYS).filter(days => days === null)).toEqual([null]);
  });

  it('refuses a kind and a scope the contract does not declare', async () => {
    for (const [column, value] of [
      ['kind', 'hunch'],
      ['scope', 'whatever_they_asked_for'],
    ] as const) {
      let thrown: unknown = null;
      try {
        await database.session.query(
          `INSERT INTO follow_up_permissions
             (workspace_id, firm_id, contact_id, kind, scope, booking_reference, expires_at, granted_by_user_id)
           VALUES ($1, $2, $3, ${column === 'kind' ? '$4' : "'booking'"},
                   ${column === 'scope' ? '$4' : "'booking_communications'"}, 'cal-refused',
                   now() + interval '14 days', $5)`,
          [workspaceId, firmId, contactId, value, userId],
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `${column} accepted ${value}`).not.toBeNull();
    }
  });

  it('accepts every origin kind the contract declares, and defaults to the excluded one', async () => {
    const { rows: sequence } = await database.session.query<{ id: string }>(
      'INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, $2, $3) RETURNING id',
      [workspaceId, 'Vocabulary origins', userId],
    );
    const { rows: version } = await database.session.query<{ id: string }>(
      `INSERT INTO sequence_versions (workspace_id, sequence_id, version, state, published_at, published_by_user_id)
       VALUES ($1, $2, 1, 'published', now(), $3) RETURNING id`,
      [workspaceId, sequence[0]?.id ?? '', userId],
    );
    // The seeded firm already has its one open opportunity
    // (`opportunities_one_open_per_firm`), and an enrollment needs one at *its* firm.
    const { rows: opportunity } = await database.session.query<{ id: string }>(
      "SELECT id FROM opportunities WHERE workspace_id = $1 AND firm_id = $2 AND status = 'open'",
      [workspaceId, firmId],
    );
    const { rows: permission } = await database.session.query<{ id: string }>(
      `INSERT INTO follow_up_permissions
         (workspace_id, firm_id, contact_id, kind, scope, booking_reference, expires_at, granted_by_user_id)
       VALUES ($1, $2, $3, 'booking', 'booking_communications', 'cal-origins',
               now() + interval '14 days', $4)
       RETURNING id`,
      [workspaceId, firmId, contactId, userId],
    );

    const seen: string[] = [];
    for (const origin of ENROLLMENT_ORIGIN_KINDS) {
      const { rows: person } = await database.session.query<{ id: string }>(
        'INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, $3) RETURNING id',
        [workspaceId, firmId, `Origin ${origin}`],
      );
      const { rows: stored } = await database.session.query<{ origin_kind: string }>(
        `INSERT INTO sequence_enrollments
           (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
            firm_time_zone, holiday_calendar_version, origin_kind, permission_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'America/New_York', 'none.1', $7, $8)
         RETURNING origin_kind`,
        [
          workspaceId,
          version[0]?.id ?? '',
          opportunity[0]?.id ?? '',
          firmId,
          person[0]?.id ?? '',
          userId,
          origin,
          origin === 'follow_up' ? permission[0]?.id ?? '' : null,
        ],
      );
      seen.push(stored[0]?.origin_kind ?? '');
    }
    expect(seen).toEqual([...ENROLLMENT_ORIGIN_KINDS]);

    // The DEFAULT is the backfill, and it is the excluded value.
    const { rows: person } = await database.session.query<{ id: string }>(
      'INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, $3) RETURNING id',
      [workspaceId, firmId, 'Origin by default'],
    );
    const { rows: defaulted } = await database.session.query<{ origin_kind: string }>(
      `INSERT INTO sequence_enrollments
         (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
          firm_time_zone, holiday_calendar_version)
       VALUES ($1, $2, $3, $4, $5, $6, 'America/New_York', 'none.1')
       RETURNING origin_kind`,
      [
        workspaceId,
        version[0]?.id ?? '',
        opportunity[0]?.id ?? '',
        firmId,
        person[0]?.id ?? '',
        userId,
      ],
    );
    expect(defaulted[0]?.origin_kind).toBe('cold_legacy');
  });

  it('accepts exactly the manual-mode origins the domain declares', async () => {
    const { rows: stage } = await database.session.query<{ id: string }>(
      'SELECT id FROM pipeline_stages WHERE workspace_id = $1 ORDER BY position OFFSET 1 LIMIT 1',
      [workspaceId],
    );
    const { rows: firm } = await database.session.query<{ id: string }>(
      'INSERT INTO firms (workspace_id, name, assigned_user_id) VALUES ($1, $2, $3) RETURNING id',
      [workspaceId, 'Origins Holdings', userId],
    );
    const { rows: opportunity } = await database.session.query<{ id: string }>(
      `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
       VALUES ($1, $2, $3, now()) RETURNING id`,
      [workspaceId, firm[0]?.id ?? '', stage[0]?.id ?? ''],
    );
    for (const origin of MANUAL_MODE_ORIGINS_FOR_TESTS) {
      await database.session.query(
        'UPDATE opportunities SET control_mode_origin = $3 WHERE workspace_id = $1 AND id = $2',
        [workspaceId, opportunity[0]?.id ?? '', origin],
      );
    }
    let thrown: unknown = null;
    try {
      await database.session.query(
        "UPDATE opportunities SET control_mode_origin = 'a_hunch' WHERE workspace_id = $1 AND id = $2",
        [workspaceId, opportunity[0]?.id ?? ''],
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeNull();
  });
});
