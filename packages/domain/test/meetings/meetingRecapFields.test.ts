import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MeetingFollowThroughViewV2, MeetingOutcomesView } from '@fss/contracts';
import { withTransaction } from '../../db/queryable.ts';
import { templateContentHash } from '../../src/rules/templates.ts';
import { updateSetting } from '../../settings/store.ts';
import { meetingFollowThroughFixture, RECAP_AT } from './support/meetingFollowThroughFixture.ts';
import { prepareMeetingRecap, editMeetingRecap, readMeetingFollowThrough, readMeetingPlan, currentMeetingDraft } from '../../meetings/followThrough.ts';
import { hasUnresolvedMeetingFields, REVIEWED_RECAP_BODY, REVIEWED_RECAP_SUBJECT, RECAP_FIELDS_UNRESOLVED } from '../../meetings/recapFields.ts';
import { buildMeetingRecapContent } from '../../meetings/recapDrafts.ts';
import { readMeetingOutcomes } from '../../meetings/outcomes.ts';
import { readTemplateVersion } from '../../templates/templates.ts';
import { verifyMeetingPlanApproval } from '../../meetings/followThroughApproval.ts';
import { enrollMeetingFollowThrough, verifyMeetingFollowThrough } from '../../meetings/followThroughEligibility.ts';

/** All people, notes and database records in this fixture are synthetic. */
describe('reviewed recap partials remain editable but never send-authoritative', () => {
  let f: Awaited<ReturnType<typeof meetingFollowThroughFixture>>;
  beforeEach(async () => { f = await meetingFollowThroughFixture(); });
  afterEach(async () => { await f.db.drop(); });

  async function configured(body = '{meeting_recap}\n\nTalk soon,\nDavid') {
    const source = await f.ready();
    const templateId = randomUUID(), subject = 'Callie + {firm_name}';
    const versionId = (await f.db.session.query<{ id: string }>(`INSERT INTO template_versions(workspace_id,template_id,version,name,subject,body,content_hash,footer_sign_off,required_variables,approved_at,approved_by_user_id)
      VALUES($1,$2,1,'Reviewed recap wrapper',$3,$4,$5,E'Talk soon,\\nDavid',ARRAY['meeting_recap','firm_name'],now(),$6) RETURNING id`,
    [f.workspace, templateId, subject, body, templateContentHash({ templateId, version: 1, subject, body }), f.seeded.alpha.admin.userId])).rows[0]!.id;
    const sequenceVersionId = await f.sequence(versionId);
    await withTransaction(f.db.session, () => updateSetting(f.context, { settingKey: 'meeting_follow_through', value: { sequenceVersionId } }));
    return { ...source, templateId: versionId, sequenceVersionId };
  }

  async function prepare() {
    const source = await configured();
    const result = await withTransaction(f.db.session, () => prepareMeetingRecap(f.context, { ...source, at: RECAP_AT }));
    if (!result.ok) throw new Error(result.reason);
    if (result.value.currentDraft === null) throw new Error(`partial draft missing: ${result.value.blockers.join(',')}`);
    return { source, view: result.value };
  }

  async function edit(view: MeetingFollowThroughViewV2, action: 'begin_edit' | 'discard') {
    const result = await withTransaction(f.db.session, () => editMeetingRecap(f.context, { planId: view.planId!, expectedPlanVersion: view.version,
      expectedDraftVersion: view.currentDraft!.version, action }, RECAP_AT));
    if (!result.ok) throw new Error(result.reason);
    return result.value;
  }

  async function save(view: MeetingFollowThroughViewV2, subject: string, body: string) {
    const result = await withTransaction(f.db.session, () => editMeetingRecap(f.context, { planId: view.planId!, expectedPlanVersion: view.version,
      expectedDraftVersion: view.currentDraft!.version, action: 'save', subject, body }, RECAP_AT));
    if (!result.ok) throw new Error(result.reason);
    return result.value;
  }

  it('persists exact reviewed copy with all original unknowns and ignores CRM and analyzed notes', async () => {
    const { source, view } = await prepare();
    expect(view).toMatchObject({ status: 'needs_review', approvalRequired: true, sendingPaused: true,
      currentDraft: { state: 'held', version: 1, subject: REVIEWED_RECAP_SUBJECT, body: REVIEWED_RECAP_BODY } });
    expect(view.blockers).toContain(RECAP_FIELDS_UNRESOLVED);
    expect(view.currentDraft!.body).not.toContain('After-hours calls interrupt the manager.');
    expect(view.currentDraft!.body).not.toContain('Pat Example');
    expect(view.currentDraft!.body.split(/\s+/u).length).toBeLessThan(200);
    const repeat = await withTransaction(f.db.session, () => prepareMeetingRecap(f.context, { ...source, at: RECAP_AT }));
    expect(repeat).toMatchObject({ ok: true, value: { currentDraft: { state: 'held', version: 1, body: REVIEWED_RECAP_BODY } } });
    expect((await readMeetingFollowThrough(f.context, source))!.currentDraft).toEqual(view.currentDraft);
    expect((await f.db.session.query('SELECT id FROM sequence_enrollments')).rows).toHaveLength(0);
  });

  it('preserves source, item-review, material and unsupported-commitment holds before generating copy', async () => {
    const { source } = await prepare();
    const outcomes = (await readMeetingOutcomes(f.context, source))!;
    const template = (await readTemplateVersion(f.context, source.templateId))!;
    const item = outcomes.items[0]!;
    const cases: [MeetingOutcomesView, string][] = [
      [{ ...outcomes, holds: ['source_conflict'] }, 'source_conflict'],
      [{ ...outcomes, state: 'stale' as const }, 'notes_incomplete'],
      [{ ...outcomes, items: [{ ...item, reviewReasons: ['owner_unknown'] }] }, 'owner_unknown'],
      [{ ...outcomes, items: [{ ...item, kind: 'material' as const, text: 'Send the guide' }] }, 'material_unavailable'],
      [{ ...outcomes, items: [{ ...item, kind: 'commitment' as const, owner: 'you' as const, text: 'Offer a discount' }] }, 'unsupported_commitment'],
    ];
    for (const [changed, reason] of cases) {
      expect(buildMeetingRecapContent({ outcomes: changed, template, variables: {} })).toMatchObject({ ok: false, reasons: expect.arrayContaining([reason]) });
    }
  });

  it('holds mismatching configured copy rather than rewriting an approved template', async () => {
    const source = await configured('Different approved copy\n\n{meeting_recap}\n\nTalk soon,\nDavid');
    const result = await withTransaction(f.db.session, () => prepareMeetingRecap(f.context, { ...source, at: RECAP_AT }));
    expect(result).toMatchObject({ ok: true, value: { currentDraft: null, blockers: expect.arrayContaining(['recap_configuration_required']) } });
    expect((await f.db.session.query<{ body: string }>('SELECT body FROM template_versions WHERE id=$1', [source.templateId])).rows[0]!.body)
      .toBe('Different approved copy\n\n{meeting_recap}\n\nTalk soon,\nDavid');
  });

  it('keeps Save and Discard held while even one named field is unresolved', async () => {
    const { view } = await prepare();
    const editing = await edit(view, 'begin_edit');
    const partial = await save(editing, 'Callie + Example firm', REVIEWED_RECAP_BODY.replace('{Name}', 'Pat Example'));
    expect(partial.currentDraft).toMatchObject({ state: 'held', version: 2 });
    expect(partial.blockers).toContain(RECAP_FIELDS_UNRESOLVED);
    const discarded = await edit(await edit(partial, 'begin_edit'), 'discard');
    expect(discarded.currentDraft).toMatchObject({ state: 'held', version: 2 });
    expect(discarded.blockers).toContain(RECAP_FIELDS_UNRESOLVED);
  });

  it('refuses approval, enrollment and dispatch even if stored approval mode and draft state are stale', async () => {
    const { view } = await prepare();
    await f.db.session.query("UPDATE meeting_follow_through SET approval_mode='legacy_template',blockers='[]',status='draft' WHERE id=$1", [view.planId]);
    await f.db.session.query("UPDATE meeting_follow_through_drafts SET state='ready' WHERE id=$1", [view.currentDraft!.id]);
    const plan = (await readMeetingPlan(f.context, view.planId!))!;
    const draft = (await currentMeetingDraft(f.context, plan))!;
    expect(await verifyMeetingPlanApproval(f.context, plan, draft)).toBe(RECAP_FIELDS_UNRESOLVED);
    expect(await withTransaction(f.db.session, () => enrollMeetingFollowThrough(f.context, { planId: plan.id, expectedVersion: plan.version, at: RECAP_AT })))
      .toEqual({ ok: false, reason: RECAP_FIELDS_UNRESOLVED });
    expect(await verifyMeetingFollowThrough(f.context, { planId: plan.id, executionId: randomUUID(), draftVersion: draft.version, at: RECAP_AT }))
      .toEqual({ ok: false, reason: RECAP_FIELDS_UNRESOLVED });
    expect(await withTransaction(f.db.session, () => editMeetingRecap(f.context, { planId: plan.id, expectedPlanVersion: plan.version,
      expectedDraftVersion: draft.version, action: 'approve', expectedApprovalHash: 'a'.repeat(64) }, RECAP_AT)))
      .toEqual({ ok: false, reason: RECAP_FIELDS_UNRESOLVED });
    expect((await readMeetingFollowThrough(f.context, { meetingId: plan.meeting_id }))!.blockers).toContain(RECAP_FIELDS_UNRESOLVED);
  });

  it('human resolution clears only the named-field hold and still requires explicit approval', async () => {
    const { source, view } = await prepare();
    await f.db.session.query("UPDATE meeting_follow_through SET blockers=blockers || '[\"reply_received\"]'::jsonb WHERE id=$1", [view.planId]);
    const latest = (await readMeetingFollowThrough(f.context, source))!;
    const editing = await edit(latest, 'begin_edit');
    const body = REVIEWED_RECAP_BODY.replace('{Name}', 'Pat Example').replace('{their main headache, in their words}', '“The phone never stops!”')
      .replace('{day}', 'Wednesday').replace('{time}', '2pm Central');
    const resolved = await save(editing, 'Callie + Example firm', body);
    expect(resolved.currentDraft).toMatchObject({ state: 'ready', body });
    expect(resolved.blockers).not.toContain(RECAP_FIELDS_UNRESOLVED);
    expect(resolved.blockers).toContain('reply_received');
    expect(resolved.approvalRequired).toBe(true);
    expect(resolved.approvedAt).toBeNull();
    expect(resolved.sendingPaused).toBe(true);
    expect(resolved.status).toBe('needs_review');
    expect((await f.db.session.query('SELECT id FROM sequence_enrollments')).rows).toHaveLength(0);
  });

  it('does not reinsert unknowns after human resolution and repeated preparation', async () => {
    const { source, view } = await prepare();
    const body = REVIEWED_RECAP_BODY.replace('{Name}', 'Pat Example').replace('{their main headache, in their words}', 'Calls interrupt us')
      .replace('{day}', 'Wednesday').replace('{time}', '2pm Central');
    const resolved = await save(await edit(view, 'begin_edit'), 'Callie + Example firm', body);
    const repeated = await withTransaction(f.db.session, () => prepareMeetingRecap(f.context, { ...source, at: RECAP_AT }));
    expect(repeated).toMatchObject({ ok: true, value: { currentDraft: { version: resolved.currentDraft!.version, body, state: 'ready' }, approvalRequired: true } });
    if (repeated.ok) expect(repeated.value.blockers).not.toContain(RECAP_FIELDS_UNRESOLVED);
  });

  it.each(['{Name}', '{their question}', '{short honest answer}', '{partner}', '{day', 'time}', '{}', '{unknown}'])('holds original or malformed field %s', field => {
    expect(hasUnresolvedMeetingFields('Callie + Example', field)).toBe(true);
    expect(hasUnresolvedMeetingFields(field, 'Resolved body')).toBe(true);
    expect(hasUnresolvedMeetingFields('Callie + Example', 'Prospect said “The phone never stops!”')).toBe(false);
  });
});
