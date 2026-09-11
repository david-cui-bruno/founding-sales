import { randomUUID } from 'node:crypto';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { describe, expect, it, vi } from 'vitest';
import { LinkedInService, reduceManualStatus, validateLinkedInTarget } from '../../src/main/linkedin/linkedInService';
import { createLinkedInFixture } from '../fixtures/linkedInWorkspace';

describe('manual LinkedIn safety', () => {
  it('open/copy are never send evidence', () => {
    expect(reduceManualStatus('prepared', 'copied')).toBe('prepared');
    expect(reduceManualStatus('prepared', 'opened')).toBe('prepared');
    expect(reduceManualStatus('prepared', 'reported_sent')).toBe('human_reported_sent');
    expect(reduceManualStatus('cancelled', 'reported_sent')).toBe('cancelled');
  });
  it.each(['http://linkedin.com/in/test', 'https://evil.invalid/in/test', 'https://linkedin.com.evil.invalid/in/test', 'https://user@linkedin.com/in/test', 'https://linkedin.com/in/test?redirect=https://evil.invalid', 'https://linkedin.com/redir/redirect', 'https://linkedin.com/in/%2e%2e/redirect', 'https://linkedin.com:443/in/test', 'https://linkedin.com/in/test#redirect', 'https://linkedin.com/in/test\\bad'])('rejects unsafe target %s', target => {
    expect(() => validateLinkedInTarget(target)).toThrow();
  });
  it('accepts only direct profile or messaging thread paths', () => {
    expect(validateLinkedInTarget('https://www.linkedin.com/in/fictional-person')).toBe('https://www.linkedin.com/in/fictional-person');
    expect(validateLinkedInTarget('https://linkedin.com/messaging/thread/fictional-thread/')).toBe('https://linkedin.com/messaging/thread/fictional-thread/');
  });
  it('uses pinned text/target and preserves draft during unavailable clipboard, with no send transition', async () => {
    const f = await createLinkedInFixture();
    try {
      const draft = f.drafts.create(f.drafts.requireStep(f.version.steps[0]!.id, 1), 'Reviewed text');
      const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined); const openExternal = vi.fn<(url: string) => Promise<void>>(async () => undefined);
      const service = new LinkedInService({ repository: f.drafts, clipboard: { writeText }, shell: { openExternal } });
      expect(await service.copy({ draftId: draft.id, expectedRevision: 1 })).toEqual({ draftId: draft.id, revision: 1, status: 'copied' });
      expect(await service.open({ draftId: draft.id, expectedRevision: 1 })).toEqual({ draftId: draft.id, revision: 1, status: 'opened' });
      expect(writeText).toHaveBeenCalledWith('Reviewed text'); expect(openExternal).toHaveBeenCalledWith('https://www.linkedin.com/in/fictional-person');
      writeText.mockRejectedValueOnce(new Error('unavailable'));
      await expect(service.copy({ draftId: draft.id, expectedRevision: 1 })).rejects.toThrow();
      expect(f.drafts.requireRevision(draft.id, 1).state).toBe('draft');
      expect((await service.prepare({ enrollmentId: f.enrollment.id, stepId: f.version.steps[0]!.id, expectedVersion: 1 })).body).toBe('Reviewed text');
    } finally { f.close(); }
  });
  it('blocks invalid saved target and stale reports before external boundaries', async () => {
    const f = await createLinkedInFixture('https://linkedin.com/in/fictional?redirect=bad');
    try {
      const draft = f.drafts.create(f.drafts.requireStep(f.version.steps[0]!.id, 1), 'Text');
      const openExternal = vi.fn(async () => undefined);
      const service = new LinkedInService({ repository: f.drafts, shell: { openExternal } });
      await expect(service.open({ draftId: draft.id, expectedRevision: 1 })).rejects.toThrow();
      expect(openExternal).not.toHaveBeenCalled();
      f.drafts.save({ draftId: draft.id, expectedRevision: 1, body: 'new' });
      await expect(service.reportOutcome({ commandId: '00000000-0000-4000-8000-000000000001', draftId: draft.id, expectedRevision: 1, outcome: 'human_reported_sent', observedAt: f.now })).rejects.toThrow('handoff_not_started');
    } finally { f.close(); }
  });
});
it('suppression blocks open/copy/generation without erasing drafts', async () => {
  const f = await createLinkedInFixture();
  try {
    const draft = f.drafts.create(f.drafts.requireStep(f.version.steps[0]!.id, 1), 'Preserve');
    const shell = { openExternal: vi.fn(async () => undefined) }; const clipboard = { writeText: vi.fn(async () => undefined) };
    const service = new LinkedInService({ repository: f.drafts, shell, clipboard });
    f.db.raw.prepare('INSERT INTO pm_account_suppression_tombstones VALUES(?,?,?,?,?,?)').run('fictional-optout', f.account.id, f.now, 'human', 'fictional-evidence', f.now);
    await expect(service.open({ draftId: draft.id, expectedRevision: 1 })).rejects.toThrow('linkedin_suppressed');
    await expect(service.copy({ draftId: draft.id, expectedRevision: 1 })).rejects.toThrow('linkedin_suppressed');
    expect((await service.get({ draftId: draft.id, expectedRevision: 1 })).body).toBe('Preserve');
    expect(shell.openExternal).not.toHaveBeenCalled(); expect(clipboard.writeText).not.toHaveBeenCalled();
  } finally { f.close(); }
});

it.each([true, false])('blocks retained linked-person suppression before external boundaries (saved draft: %s)', async saved => {
  const f = await createLinkedInFixture(undefined, true);
  try {
    const context = f.drafts.requireStep(f.version.steps[0]!.id, 1);
    const draft = saved ? f.drafts.create(context, 'Retained exact text') : null;
    const accounts = new AccountRepository({ database: f.db, clock: f.clock, ids: { next: randomUUID }, sourcePolicy: { attest: () => true } });
    const snapshot = accounts.snapshot(f.account.id, f.now);
    accounts.admitLinks({ commandId: randomUUID(), accountId: f.account.id, expectedVersion: snapshot.account.version,
      links: [{ id: randomUUID(), kind: 'person_role', personId: f.personId, role: 'Office contact', authority: 'unconfirmed', authorityEvidenceIds: [], relationship: 'Fictional office contact', evidenceIds: snapshot.routes[0]!.evidenceIds, validFrom: f.now, validTo: null }] });
    const activityId = randomUUID();
    f.db.raw.prepare("INSERT INTO activities(id,person_id,kind,direction,channel,occurred_at,metadata_json,created_at) VALUES(?,?,'opt_out','inbound','manual',?,'{}',?)").run(activityId, f.personId, f.now, f.now);
    f.db.raw.prepare('INSERT INTO opt_out_tombstones VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), f.personId, f.now, 'manual', activityId, 'fictional-retained-evidence', 'founder_opt_out_v1', f.now);
    const generate = vi.fn(async () => ({ body: 'Must not generate', evidenceIds: [] }));
    const shell = { openExternal: vi.fn(async () => undefined) }; const clipboard = { writeText: vi.fn(async () => undefined) };
    const service = new LinkedInService({ repository: f.drafts, provider: { generate }, shell, clipboard });
    await expect(service.prepare({ enrollmentId: f.enrollment.id, stepId: f.version.steps[0]!.id, expectedVersion: 1 })).rejects.toThrow('linkedin_suppressed');
    if (draft) {
      await expect(service.open({ draftId: draft.id, expectedRevision: 1 })).rejects.toThrow('linkedin_suppressed');
      await expect(service.copy({ draftId: draft.id, expectedRevision: 1 })).rejects.toThrow('linkedin_suppressed');
      expect((await service.get({ draftId: draft.id, expectedRevision: 1 })).body).toBe('Retained exact text');
    }
    expect(generate).not.toHaveBeenCalled(); expect(shell.openExternal).not.toHaveBeenCalled(); expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(context.personId).toBeNull();
  } finally { f.close(); }
});
