import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { meetingFollowThroughFixture, RECAP_AT } from './support/meetingFollowThroughFixture.ts';
import { meetingNoteItemSchema } from '@fss/contracts';

describe('recap drafts preserve the review window and exact content', () => {
  let f: Awaited<ReturnType<typeof meetingFollowThroughFixture>>;
  beforeEach(async () => { f = await meetingFollowThroughFixture(); });
  afterEach(async () => { await f.db.drop(); });
  it('renders sourced context into the approved template once with a thirty-minute window', async () => {
    const { prepareMeetingRecap } = await import('../../meetings/followThrough.ts');
    const p = await f.ready();
    const input = { meetingId: p.meetingId, expectedSourceHash: p.expectedSourceHash, at: RECAP_AT };
    const result = await withTransaction(f.db.session, () => prepareMeetingRecap(f.context, input));
    expect(result).toMatchObject({ ok: true, value: { currentDraft: { version: 1, notBefore: '2026-10-05T15:30:00.000Z', templateVersionId: p.templateId } } });
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.currentDraft?.body).toContain('After-hours calls interrupt the manager.');
    expect(result.value.currentDraft?.body).not.toContain('send the maintenance guide');
    const repeated = await withTransaction(f.db.session, () => prepareMeetingRecap(f.context, { ...input, at: '2026-10-05T15:05:00.000Z' }));
    expect(repeated).toMatchObject({ ok: true, value: { planId: result.value.planId, currentDraft: { version: 1, notBefore: '2026-10-05T15:30:00.000Z' } } });
  });
  it('durably holds editing, rejects stale saves, and starts a fresh window for changed content', async () => {
    const { prepareMeetingRecap, editMeetingRecap } = await import('../../meetings/followThrough.ts');
    const p = await f.ready();
    const prepared = await withTransaction(f.db.session, () => prepareMeetingRecap(f.context, { ...p, at: RECAP_AT }));
    if (!prepared.ok) throw new Error(prepared.reason);
    const first = prepared.value;
    const begin = await withTransaction(f.db.session, () => editMeetingRecap(f.context, { planId: first.planId!, expectedPlanVersion: first.version, expectedDraftVersion: 1, action: 'begin_edit' }, RECAP_AT));
    expect(begin).toMatchObject({ ok: true, value: { status: 'held', currentDraft: { state: 'editing' } } });
    if (!begin.ok) throw new Error(begin.reason);
    const editing = begin.value;
    const changed = { planId: first.planId!, expectedPlanVersion: editing.version, expectedDraftVersion: 1, action: 'save' as const, subject: 'Our next steps', body: 'Thanks for the conversation.\n\nSam Example\nCallie' };
    const saved = await withTransaction(f.db.session, () => editMeetingRecap(f.context, changed, '2026-10-05T16:00:00.000Z'));
    expect(saved).toMatchObject({ ok: true, value: { currentDraft: { version: 2, subject: changed.subject, body: changed.body, notBefore: '2026-10-05T16:30:00.000Z' } } });
    expect(await withTransaction(f.db.session, () => editMeetingRecap(f.context, changed, RECAP_AT))).toEqual({ ok: false, reason: 'draft_changed' });
    const rows = (await f.db.session.query('SELECT version,subject FROM meeting_follow_through_drafts ORDER BY version')).rows;
    expect(rows).toEqual([{ version: 1, subject: 'Our conversation' }, { version: 2, subject: 'Our next steps' }]);
    expect(await withTransaction(f.db.session, () => prepareMeetingRecap(f.context, { ...p, at: '2026-10-05T16:05:00.000Z' }))).toMatchObject({ ok: true, value: { currentDraft: { version: 2, subject: changed.subject, body: changed.body } } });
  });
  it('cancels the plan without adding a contact stop', async () => {
    const { prepareMeetingRecap, editMeetingRecap } = await import('../../meetings/followThrough.ts');
    const p = await f.ready();
    const prepared = await withTransaction(f.db.session, () => prepareMeetingRecap(f.context, { ...p, at: RECAP_AT }));
    if (!prepared.ok) throw new Error(prepared.reason);
    const result = await withTransaction(f.db.session, () => editMeetingRecap(f.context, { planId: prepared.value.planId!, expectedPlanVersion: prepared.value.version, expectedDraftVersion: 1, action: 'cancel' }, RECAP_AT));
    expect(result).toMatchObject({ ok: true, value: { status: 'cancelled', currentDraft: { state: 'cancelled' } } });
    expect((await f.db.session.query('SELECT 1 FROM suppression_events')).rows).toHaveLength(0);
  });
  it('holds conflicting facts, unapproved templates and unavailable promised material', async () => {
    const { buildMeetingRecapContent } = await import('../../meetings/recapDrafts.ts');
    const p = await f.ready();
    const { readMeetingOutcomes } = await import('../../meetings/outcomes.ts');
    const { readTemplateVersion } = await import('../../templates/templates.ts');
    const outcomes = (await readMeetingOutcomes(f.context, { meetingId: p.meetingId }))!;
    const template = (await readTemplateVersion(f.context, p.templateId))!;
    expect(buildMeetingRecapContent({ outcomes, template: { ...template, approvedAt: null }, variables: {} })).toMatchObject({ ok: false, reasons: ['template_unapproved'] });
    expect(buildMeetingRecapContent({ outcomes: { ...outcomes, holds: ['source_conflict'] }, template, variables: {} })).toMatchObject({ ok: false, reasons: expect.arrayContaining(['source_conflict']) });
    const item = meetingNoteItemSchema.parse({ ...outcomes.items[0], kind: 'material', text: 'Send the maintenance guide', owner: 'you' });
    expect(buildMeetingRecapContent({ outcomes: { ...outcomes, items: [item] }, template, variables: {} })).toMatchObject({ ok: false, reasons: expect.arrayContaining(['material_unavailable']) });
    const promise = { ...item, kind: 'commitment' as const, text: 'Offer a 50% discount' };
    expect(buildMeetingRecapContent({ outcomes: { ...outcomes, items: [promise] }, template, variables: {} })).toMatchObject({ ok: false, reasons: expect.arrayContaining(['unsupported_commitment']) });
  });
  it('refuses an outdated source and supersedes a changed source with a new window', async () => {
    const { prepareMeetingRecap } = await import('../../meetings/followThrough.ts');
    const p = await f.ready();
    await withTransaction(f.db.session, () => prepareMeetingRecap(f.context, { ...p, at: RECAP_AT }));
    await f.save(p.meetingId, 'After-hours calls interrupt the manager.', 1);
    expect(await withTransaction(f.db.session, () => prepareMeetingRecap(f.context, { ...p, at: RECAP_AT }))).toEqual({ ok: false, reason: 'source_changed' });
    const next = await f.publish(p.meetingId, [{ ...p.items[0]!, evidence: [{ kind: 'debrief', revision: 2, quote: 'After-hours calls interrupt the manager.', startOffset: 0, endOffset: 38 }] }]);
    expect(await withTransaction(f.db.session, () => prepareMeetingRecap(f.context, { ...next, at: '2026-10-05T16:00:00.000Z' }))).toMatchObject({ ok: true, value: { currentDraft: { version: 2, notBefore: '2026-10-05T16:30:00.000Z' } } });
  });
  it('can discard an editor after its meeting notes change, without releasing the old draft', async () => {
    const { prepareMeetingRecap, editMeetingRecap } = await import('../../meetings/followThrough.ts');
    const p = await f.ready();
    const prepared = await withTransaction(f.db.session, () => prepareMeetingRecap(f.context, { ...p, at: RECAP_AT }));
    if (!prepared.ok) throw new Error(prepared.reason);
    const begin = await withTransaction(f.db.session, () => editMeetingRecap(f.context, { planId: prepared.value.planId!, expectedPlanVersion: prepared.value.version, expectedDraftVersion: 1, action: 'begin_edit' }, RECAP_AT));
    if (!begin.ok) throw new Error(begin.reason);
    await f.save(p.meetingId, 'Corrected meeting notes.', 1);
    const discarded = await withTransaction(f.db.session, () => editMeetingRecap(f.context, { planId: begin.value.planId!, expectedPlanVersion: begin.value.version, expectedDraftVersion: 1, action: 'discard' }, RECAP_AT));
    expect(discarded).toMatchObject({ ok: true, value: { status: 'needs_review', currentDraft: { state: 'held' }, blockers: expect.arrayContaining(['source_changed']) } });
    expect((await f.db.session.query('SELECT editing FROM meeting_follow_through')).rows).toEqual([{ editing: false }]);
  });
  it('gives a discarded overdue draft a new window and refuses in-place content rewriting', async () => {
    const { prepareMeetingRecap, editMeetingRecap } = await import('../../meetings/followThrough.ts');
    const p = await f.ready();
    const prepared = await withTransaction(f.db.session, () => prepareMeetingRecap(f.context, { ...p, at: RECAP_AT }));
    if (!prepared.ok) throw new Error(prepared.reason);
    const begin = await withTransaction(f.db.session, () => editMeetingRecap(f.context, { planId: prepared.value.planId!, expectedPlanVersion: prepared.value.version, expectedDraftVersion: 1, action: 'begin_edit' }, RECAP_AT));
    if (!begin.ok) throw new Error(begin.reason);
    expect(await withTransaction(f.db.session, () => editMeetingRecap(f.context, { planId: begin.value.planId!, expectedPlanVersion: begin.value.version, expectedDraftVersion: 1, action: 'discard' }, '2026-10-05T16:00:00.000Z'))).toMatchObject({ ok: true, value: { currentDraft: { version: 2, notBefore: '2026-10-05T16:30:00.000Z', state: 'ready' } } });
    await expect(f.db.session.query("UPDATE meeting_follow_through_drafts SET body='Changed in place' WHERE version=1")).rejects.toMatchObject({ code: '23514' });
  });
  it('recovers a plan prepared before its sequence was configured', async () => {
    const { prepareMeetingRecap } = await import('../../meetings/followThrough.ts');
    const { updateSetting } = await import('../../settings/store.ts');
    const p = await f.ready();
    await f.db.session.query("DELETE FROM workspace_settings WHERE setting_key='meeting_follow_through'");
    const empty = await withTransaction(f.db.session, () => prepareMeetingRecap(f.context, { ...p, at: RECAP_AT }));
    expect(empty).toMatchObject({ ok: true, value: { status: 'needs_review', currentDraft: null } });
    await withTransaction(f.db.session, () => updateSetting(f.context, { settingKey: 'meeting_follow_through', value: { sequenceVersionId: p.sequenceVersionId } }));
    expect(await withTransaction(f.db.session, () => prepareMeetingRecap(f.context, { ...p, at: RECAP_AT }))).toMatchObject({ ok: true, value: { sequenceVersionId: p.sequenceVersionId, currentDraft: { version: 1 } } });
  });
  it('keeps an unresolved recipient as review work instead of guessing or crashing', async () => {
    const { prepareMeetingRecap } = await import('../../meetings/followThrough.ts');
    const p = await f.ready();
    await f.db.session.query('UPDATE meetings SET contact_id=NULL WHERE id=$1', [p.meetingId]);
    expect(await withTransaction(f.db.session, () => prepareMeetingRecap(f.context, { ...p, at: RECAP_AT }))).toMatchObject({ ok: true, value: { status: 'needs_review', contactId: null, blockers: expect.arrayContaining(['recipient_unresolved']) } });
  });
  it('starts a fresh revision and window when the configured email footer changes', async () => {
    const { prepareMeetingRecap } = await import('../../meetings/followThrough.ts');
    const { updateSetting } = await import('../../settings/store.ts');
    const p = await f.ready();
    await withTransaction(f.db.session, () => prepareMeetingRecap(f.context, { ...p, at: RECAP_AT }));
    await withTransaction(f.db.session, () => updateSetting(f.context, { settingKey: 'postal_address', value: { address: '123 Example Street, Providence RI 02912' } }));
    const result = await withTransaction(f.db.session, () => prepareMeetingRecap(f.context, { ...p, at: '2026-10-05T16:00:00.000Z' }));
    expect(result).toMatchObject({ ok: true, value: { currentDraft: { version: 2, body: expect.stringContaining('123 Example Street'), notBefore: '2026-10-05T16:30:00.000Z' } } });
  });
  it('returns an actionable refusal when a saved body cannot fit its footer', async () => {
    const { prepareMeetingRecap, editMeetingRecap } = await import('../../meetings/followThrough.ts');
    const p = await f.ready();
    const prepared = await withTransaction(f.db.session, () => prepareMeetingRecap(f.context, { ...p, at: RECAP_AT }));
    if (!prepared.ok) throw new Error(prepared.reason);
    const begun = await withTransaction(f.db.session, () => editMeetingRecap(f.context, { planId: prepared.value.planId!, expectedPlanVersion: prepared.value.version, expectedDraftVersion: 1, action: 'begin_edit' }, RECAP_AT));
    if (!begun.ok) throw new Error(begun.reason);
    expect(await withTransaction(f.db.session, () => editMeetingRecap(f.context, { planId: begun.value.planId!, expectedPlanVersion: begun.value.version, expectedDraftVersion: 1, action: 'save', subject: 'Recap', body: 'x'.repeat(4000) }, RECAP_AT))).toMatchObject({ ok: false, reason: expect.stringContaining('presentation_') });
  });
});
