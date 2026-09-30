import type { SessionQueryable } from '../../../db/queryable.ts';
import type { RepositoryContext } from '../../../db/workspaceScope.ts';
import { createDraftVersion, createSequence, publishVersion, type DraftStepInput } from '../../../sequences/definitions.ts';
import { createTemplateVersion } from '../../../templates/templates.ts';
import { firstStageId } from '../../db/support/crmFixtures.ts';
import type { SeededWorkspace } from '../../db/support/fixtures.ts';
import { FIXTURE_SIGN_OFF, fixtureBody } from './sequenceFixtures.ts';

/**
 * Plans, firms and templates made per case, for the send-path v2 (S2) files: edits
 * create new versions, and an enrollment moves to one only by migration. Every case
 * builds its own sequence, so no case depends on the order the others ran in.
 *
 * No real person, firm or address appears; the addresses are in `example.test`.
 */

export interface VersionFirm {
  readonly firmId: string;
  readonly contactId: string;
  readonly opportunityId: string;
}

let firms = 0;

/** One more firm with one reachable contact and an open opportunity. */
export async function newFirm(
  session: SessionQueryable,
  workspace: SeededWorkspace,
  assignedUserId: string = workspace.salesperson.userId,
): Promise<VersionFirm> {
  firms += 1;
  const label = `v2-${String(firms)}-${crypto.randomUUID().slice(0, 8)}`;
  const { rows: firm } = await session.query<{ id: string }>(
    `INSERT INTO firms (workspace_id, name, assigned_user_id, website, locality, region_code, postal_code,
                        time_zone, time_zone_confidence, time_zone_source, time_zone_rule_version)
     VALUES ($1, $2, $3, $4, 'Providence', 'RI', '02903', 'America/New_York', 'medium', 'state_default', 'firm-zone.1')
     RETURNING id`,
    [workspace.workspaceId, `Versioned ${label}`, assignedUserId, `https://${label}.example.test`],
  );
  const firmId = firm[0]?.id ?? '';
  const { rows: contact } = await session.query<{ id: string }>(
    `INSERT INTO contacts (workspace_id, firm_id, full_name, title, is_primary)
     VALUES ($1, $2, 'Robin Example', 'Owner', true) RETURNING id`,
    [workspace.workspaceId, firmId],
  );
  const contactId = contact[0]?.id ?? '';
  await session.query(
    `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                  association_confidence, technical_validation, eligibility, eligibility_policy_version)
     VALUES ($1, $2, $3, $4, 'research_provider', TIMESTAMPTZ '2026-09-01 12:00:00+00',
             0.950, 'passed', 'usable', 'route-policy.1')`,
    [workspace.workspaceId, firmId, contactId, `robin@${label}.example.test`],
  );
  const { rows: opportunity } = await session.query<{ id: string }>(
    `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
     VALUES ($1, $2, $3, TIMESTAMPTZ '2026-09-01 12:00:00+00') RETURNING id`,
    [workspace.workspaceId, firmId, await firstStageId(session, workspace.workspaceId)],
  );
  return { firmId, contactId, opportunityId: opportunity[0]?.id ?? '' };
}

export const templateText = (opening: string) => ({
  name: 'Versioned',
  subject: 'Hello {firm_name}',
  body: fixtureBody(opening),
  footer: { signOff: FIXTURE_SIGN_OFF },
  requiredVariables: ['firm_name'],
});

export async function approvedTemplate(admin: RepositoryContext, opening: string): Promise<string> {
  const created = await createTemplateVersion(admin, { ...templateText(opening), approve: true });
  if (!created.ok) throw new Error(`the template was refused: ${created.reason}`);
  return created.value.id;
}

export const emailStep = (templateVersionId: string, ordinal = 1, hours = 0): DraftStepInput => ({
  ordinal,
  channel: 'email',
  delay: { unit: 'elapsed', hours },
  templateVersionId,
});

export const callStep = (ordinal: number, days: number): DraftStepInput => ({
  ordinal,
  channel: 'call_task',
  delay: { unit: 'business_days', days },
  onNoAnswer: 'advance',
});

/** A new sequence with one published version of `steps`. */
export async function publishedPlan(
  admin: RepositoryContext,
  steps: readonly DraftStepInput[],
): Promise<{ readonly sequenceId: string; readonly versionId: string }> {
  const sequence = await createSequence(admin, { name: `Plan ${crypto.randomUUID()}` });
  if (!sequence.ok) throw new Error(`the sequence was refused: ${sequence.reason}`);
  const versionId = await publishedVersionOf(admin, sequence.value.id, steps);
  return { sequenceId: sequence.value.id, versionId };
}

/** The next published version of an existing sequence. */
export async function publishedVersionOf(
  admin: RepositoryContext,
  sequenceId: string,
  steps: readonly DraftStepInput[],
): Promise<string> {
  const draft = await createDraftVersion(admin, { sequenceId, steps });
  if (!draft.ok) throw new Error(`the draft was refused: ${draft.reason}`);
  const published = await publishVersion(admin, { sequenceVersionId: draft.value.sequenceVersionId });
  if (!published.ok) throw new Error(`the publication was refused: ${published.reason}`);
  return draft.value.sequenceVersionId;
}
