// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import type { PipelineView } from '../src/renderer/firmWorkspaceContract.ts';
import { PipelineBoard, emptyBoardMemory } from '../src/renderer/firms/PipelineBoard.tsx';
import { pipelineView } from './e2e/support/crmFixtures.ts';
afterEach(cleanup);
it('draws two independent deal cards at one firm and opens their explicit context', async () => {
  const old = pipelineView();
  const column = old.columns.find((entry) => entry.firms.length > 0)!;
  const firm = column.firms[0]!;
  const a = '11111111-1111-4111-8111-111111111111',
    b = '22222222-2222-4222-8222-222222222222';
  const opened: unknown[] = [];
  const detail: Omit<NonNullable<PipelineView['plural']>['cards'][string], 'opportunityId' | 'displayName'> = {
    firm,
    stageControlMode: 'human',
    mayChangeStage: true,
    value: null,
    meeting: null,
    evidence: null,
    pinned: true,
    nextAction: null,
    closeReason: null,
  };
  render(
    <PipelineBoard
      pipeline={{
        columns: [],
        opportunityIdByFirmId: {},
        plural: {
          version: 2,
          columns: [{ stage: column.stage, opportunityIds: [a, b] }],
          cards: {
            [a]: { ...detail, firm: { ...firm, opportunityStatus: 'open' }, opportunityId: a, displayName: 'Portfolio pilot' },
            [b]: { ...detail, firm: { ...firm, opportunityStatus: 'won' }, opportunityId: b, displayName: 'Second initiative' },
          },
          unplacedFirms: [],
          stages: old.columns.map((entry) => entry.stage),
        },
      }}
      actionsEnabled
      stageBusy={() => false}
      valueBusy={() => false}
      search=""
      memory={{ current: emptyBoardMemory() }}
      onSearch={() => {}}
      onShowLost={() => {}}
      onChangeStage={() => {}}
      onSetValue={() => {}}
      onOpenFirm={(firmId, opportunityId) => opened.push({ firmId, opportunityId })}
    />,
  );
  expect(screen.getByTestId('board-totals').textContent).toBe('Open opportunities: 1');
  expect(screen.getByText('Portfolio pilot')).toBeTruthy();
  expect(screen.getByText('Second initiative')).toBeTruthy();
  await userEvent.click(screen.getAllByTestId('pipeline-open-firm')[1]!);
  expect(opened).toEqual([{ firmId: firm.id, opportunityId: b }]);
  await userEvent.keyboard('j');
  expect(opened).toEqual([
    { firmId: firm.id, opportunityId: b },
    { firmId: firm.id, opportunityId: a },
  ]);
});
