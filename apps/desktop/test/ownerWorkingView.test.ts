import { describe, expect, it } from 'vitest';
import type { FirmIdentityDto } from '@fss/contracts';
import { isOwnerWorkingFirm, ownerPipeline, ownerReplies, ownerToday } from '../src/renderer/ownerWorkingView.ts';
import { todayStateSchema } from '../src/renderer/todayContract.ts';
import { replyStateSchema } from '../src/renderer/replyContract.ts';
import { pipelineViewSchema } from '../src/renderer/firmWorkspaceContract.ts';

const TEST = '11111111-1111-4111-8111-111111111111';
const REAL = '22222222-2222-4222-8222-222222222222';
const at = '2026-10-19T12:00:00.000Z';
const counts = { replies: 1, emailsDue: 0, callsDue: 0 };
const cards = [
  { firmId: TEST, firmName: 'Callie Internal Test', lane: 'reply', dueAt: at, counts },
  { firmId: REAL, firmName: 'Callie Internal Test Partners', lane: 'reply', dueAt: at, counts },
];

function firm(id: string, name: string): FirmIdentityDto {
  return { id, name, website: null, locality: null, regionCode: null, status: 'active', assignedUserId: null, stageKey: null, opportunityStatus: null, controlMode: null, openedAt: null, timeZone: null, timeZoneUnresolvedReason: null };
}

describe('owner-only working views, not stored data', () => {
  it('matches only the exact designated test name, never substrings or other test firms', () => {
    expect(isOwnerWorkingFirm('Callie Internal Test')).toBe(false);
    for (const name of ['Callie Internal Test Partners', 'Northwind Test Holdings', 'Callie', 'callie internal test', 'Callie Internal Test ']) expect(isOwnerWorkingFirm(name)).toBe(true);
    expect(isOwnerWorkingFirm(null)).toBe(true);
  });

  it('omits the test firm and stale selected dial advice without changing the Today snapshot', () => {
    const state = todayStateSchema.parse({ snapshotDate: '2026-10-19', businessTimeZone: 'America/New_York', cards,
      expanded: { firmId: TEST, firmName: 'Callie Internal Test', snapshotDate: '2026-10-19', lane: 'reply', counts, tasks: [], routes: [], callingIdentityId: null },
      online: true, stale: false, asOf: at, mayMutate: true, role: 'admin', notice: null, handoffNotice: '', dialAdvice: [], followUpTemplates: [] });
    const before = JSON.stringify(state);
    const visible = ownerToday(state);
    expect(visible.cards.map(card => card.firmId)).toEqual([REAL]);
    expect(visible.expanded).toBeNull();
    expect(visible.dialAdvice).toEqual([]);
    expect(visible.mayMutate).toBe(state.mayMutate);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('keeps real reply review and hides a restored test reply without resolving or deleting it', () => {
    const state = replyStateSchema.parse({ businessDate: '2026-10-19', businessTimeZone: 'America/New_York', cards: cards.map(card => ({ messageId: card.firmId, receivedAt: at, firmId: card.firmId, firmName: card.firmName, from: null, contactName: null, nextAction: 'confirm_disposition', deterministicClass: 'uncertain', confidence: null, proposedDisposition: null, confirmedDisposition: null })), open: null, online: true, mayMutate: true, classifier: null, notice: null });
    const before = JSON.stringify(state);
    expect(ownerReplies(state).cards.map(card => card.firmId)).toEqual([REAL]);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('filters both placed and unplaced firm rows, leaving direct firm/history reads outside this projection', () => {
    const test = firm(TEST, 'Callie Internal Test'), real = firm(REAL, 'Callie Internal Test Partners');
    const pipeline = pipelineViewSchema.parse({ columns: [{ stage: { id: REAL, key: 'new', displayName: 'New', position: 1, terminalKind: null, retired: false }, firms: [test, real] }], opportunityIdByFirmId: {}, unplacedFirms: [test, real] });
    const before = JSON.stringify(pipeline);
    const visible = ownerPipeline(pipeline);
    expect(visible.columns[0]?.firms).toEqual([real]);
    expect(visible.unplacedFirms).toEqual([real]);
    expect(JSON.stringify(pipeline)).toBe(before);
    expect(test.name).toBe('Callie Internal Test');
  });

  it('keeps every real opportunity and strips test opportunities from plural board columns and counts', () => {
    const stage = { id: REAL, key: 'new', displayName: 'New', position: 1, terminalKind: null, retired: false };
    const card = { value: null, meeting: null, evidence: null, pinned: false, displayName: null, stageControlMode: 'human', mayChangeStage: true };
    const pipeline = pipelineViewSchema.parse({ columns: [], opportunityIdByFirmId: {}, plural: {
      version: 2, columns: [{ stage, opportunityIds: [TEST, REAL] }], unplacedFirms: [], stages: [stage], cards: {
        [TEST]: { ...card, firm: firm(TEST, 'Callie Internal Test'), opportunityId: TEST },
        [REAL]: { ...card, firm: firm(REAL, 'Callie Internal Test Partners'), opportunityId: REAL },
      },
    } });
    const visible = ownerPipeline(pipeline);
    expect(visible.plural?.columns[0]?.opportunityIds).toEqual([REAL]);
    expect(Object.keys(visible.plural?.cards ?? {})).toEqual([REAL]);
    expect(Object.keys(pipeline.plural?.cards ?? {})).toEqual([TEST, REAL]);
  });
});
