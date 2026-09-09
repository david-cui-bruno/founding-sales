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
      expect((await service.prepare({ stepId: f.version.steps[0]!.id, expectedVersion: 1 })).body).toBe('Reviewed text');
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
      await expect(service.reportOutcome({ commandId: '00000000-0000-4000-8000-000000000001', draftId: draft.id, expectedRevision: 1, outcome: 'human_reported_sent', observedAt: f.now })).rejects.toThrow('stale_draft');
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
