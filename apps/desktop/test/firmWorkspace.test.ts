import { describe, expect, it } from 'vitest';
import { CRM_REFUSAL_CODES, firmPageResponseSchema } from '@fss/contracts';
import type { CrmState, MergeView } from '../src/renderer/firmWorkspaceContract.ts';
import {
  CRM_NOTICES,
  FIRM_HEADING,
  GENERIC_NOTICE,
  MERGE_HEADING,
  PIPELINE_HEADING,
  buildFirmWorkspaceView,
  mergeSubmittable,
  noticeText,
  stageChangeSubmittable,
} from '../src/renderer/firmWorkspaceView.ts';

/**
 * The CRM windows' rules, without a DOM.
 *
 * Specification 14.2: "When offline or below the minimum client version,
 * cloud-dependent controls show a clear non-actionable state." Every one of those
 * decisions is a pure function here, so it is a unit test rather than a screenshot,
 * and the Playwright specs prove that the DOM obeys them.
 *
 * No name, address or number in this file belongs to anybody: `example.test` is
 * reserved by RFC 6761 and the UUIDs are fixed strings.
 */

const FIRM_ID = '11111111-1111-4111-8111-111111111111';

function identityPage(assigned: boolean): CrmState['firm'] {
  const firm = {
    id: FIRM_ID,
    name: 'Northwind Test Holdings',
    website: 'https://northwind.example.test',
    locality: 'Providence',
    regionCode: 'RI',
    status: 'active' as const,
    assignedUserId: '22222222-2222-4222-8222-222222222222',
    stageKey: 'new',
    opportunityStatus: 'open' as const,
    controlMode: 'automated' as const,
    openedAt: '2026-09-01T12:00:00.000Z',
    timeZone: 'America/New_York',
    timeZoneUnresolvedReason: null,
  };
  return assigned
    ? firmPageResponseSchema.parse({
        visibility: 'assigned_or_admin',
        read: {
          visibility: 'assigned_or_admin',
          firm: {
            ...firm,
            addressLine: '9 Sample Street',
            postalCode: '02903',
            countryCode: 'US',
            timeZoneConfidence: 'medium',
            timeZoneSource: 'state_default',
            contacts: [],
            phoneRoutes: [],
            emailRoutes: [],
            aliases: [],
          },
        },
        opportunity: null,
        stageHistory: [],
        holds: [],
      })
    : firmPageResponseSchema.parse({
        visibility: 'any_active_member',
        read: { visibility: 'any_active_member', firm },
      });
}

function state(overrides: Partial<CrmState> = {}): CrmState {
  return {
    screen: 'firm',
    role: 'salesperson',
    online: true,
    mayMutate: true,
    notice: null,
    firm: identityPage(true),
    pipeline: null,
    merge: null,
    ...overrides,
  };
}

describe('the CRM window view', () => {
  it('names each screen', () => {
    expect(buildFirmWorkspaceView(state()).heading).toBe(FIRM_HEADING);
    expect(buildFirmWorkspaceView(state({ screen: 'pipeline' })).heading).toBe(PIPELINE_HEADING);
    expect(buildFirmWorkspaceView(state({ screen: 'merge' })).heading).toBe(MERGE_HEADING);
  });

  it('disables every control when the cloud cannot be reached, and says why', () => {
    const view = buildFirmWorkspaceView(state({ online: false }));
    expect(view.actionsEnabled).toBe(false);
    expect(view.banners[0]).toEqual({ tone: 'warning', text: CRM_NOTICES['offline'] });
  });

  it('disables every control below the minimum client version, blockingly', () => {
    const view = buildFirmWorkspaceView(state({ mayMutate: false, notice: 'client_upgrade_required' }));
    expect(view.actionsEnabled).toBe(false);
    expect(view.banners.some(banner => banner.tone === 'blocking')).toBe(true);
  });

  it('says the firm is somebody else’s rather than showing empty sections', () => {
    const view = buildFirmWorkspaceView(state({ firm: identityPage(false) }));
    expect(view.showsDetail).toBe(false);
    expect(view.redactionNotice).toContain('assigned to somebody else');

    const mine = buildFirmWorkspaceView(state());
    expect(mine.showsDetail).toBe(true);
    expect(mine.redactionNotice).toBeNull();
  });

  it('has one fixed sentence for every CRM refusal code, and never shows a code', () => {
    // Every closed-set refusal a CRM command can answer with reaches this window.
    // A code with no sentence falls back to the generic one rather than being
    // printed, and a code that is *only* a fallback is a gap worth seeing here.
    for (const code of CRM_REFUSAL_CODES) {
      const text = noticeText(code);
      expect(text, code).not.toContain(code);
      expect(text.length, code).toBeGreaterThan(0);
    }
    expect(noticeText('a_code_from_the_future')).toBe(GENERIC_NOTICE);
  });
});

describe('the Lost reason (8.1)', () => {
  const terminalKindOf = (stageKey: string): 'won' | 'lost' | null =>
    stageKey === 'lost' ? 'lost' : stageKey === 'won' ? 'won' : null;

  it('will not send a Lost change without a reason, and will with one', () => {
    const base = { terminalKindOf, actionsEnabled: true };
    expect(stageChangeSubmittable({ ...base, toStageKey: 'lost', reason: '' })).toBe(false);
    expect(stageChangeSubmittable({ ...base, toStageKey: 'lost', reason: '   ' })).toBe(false);
    expect(stageChangeSubmittable({ ...base, toStageKey: 'lost', reason: 'Budget moved' })).toBe(true);
  });

  it('asks for no reason for any other stage, including Won', () => {
    const base = { terminalKindOf, actionsEnabled: true, reason: '' };
    expect(stageChangeSubmittable({ ...base, toStageKey: 'won' })).toBe(true);
    expect(stageChangeSubmittable({ ...base, toStageKey: 'engaged' })).toBe(true);
  });

  it('sends nothing at all when the window cannot act, reason or no reason', () => {
    expect(
      stageChangeSubmittable({ terminalKindOf, actionsEnabled: false, toStageKey: 'engaged', reason: 'x' }),
    ).toBe(false);
    expect(stageChangeSubmittable({ terminalKindOf, actionsEnabled: true, toStageKey: '', reason: 'x' })).toBe(false);
  });
});

describe('merge conflict resolution (7.2, Appendix G 37)', () => {
  const merge: MergeView = {
    sourceFirmId: FIRM_ID,
    sourceName: 'Northwind Test Holdings',
    targetFirmId: '33333333-3333-4333-8333-333333333333',
    targetName: 'Northwind Holdings Test',
    conflicts: [
      { field: 'website', source: 'https://a.example.test', target: 'https://b.example.test' },
      { field: 'locality', source: null, target: 'Providence' },
    ],
  };

  it('stays unsubmittable until every conflict has been decided', () => {
    expect(mergeSubmittable(merge, {}, true)).toBe(false);
    expect(mergeSubmittable(merge, { website: 'https://a.example.test' }, true)).toBe(false);
    expect(
      mergeSubmittable(merge, { website: 'https://a.example.test', locality: 'Providence' }, true),
    ).toBe(true);
  });

  it('refuses a value neither record ever held', () => {
    expect(
      mergeSubmittable(merge, { website: 'https://invented.example.test', locality: 'Providence' }, true),
    ).toBe(false);
  });

  it('is unsubmittable when the window cannot act, however complete the choices', () => {
    expect(
      mergeSubmittable(merge, { website: 'https://a.example.test', locality: 'Providence' }, false),
    ).toBe(false);
  });

  it('is submittable with no choices when there is nothing to choose', () => {
    expect(mergeSubmittable({ ...merge, conflicts: [] }, {}, true)).toBe(true);
  });
});
