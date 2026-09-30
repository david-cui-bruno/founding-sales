// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FirmIdentityDto } from '@fss/contracts';
import type { CrmState, PipelineView } from '../src/renderer/firmWorkspaceContract.ts';
import { FIRMS_HEADING, PIPELINE_HEADING } from '../src/renderer/firmWorkspaceView.ts';
import { FirmsList, NOT_IN_PIPELINE, firmsOf, stageNameOf } from '../src/renderer/firms/FirmsList.tsx';
import { emptyBoardMemory, PipelineBoard } from '../src/renderer/firms/PipelineBoard.tsx';
import { routeOfState } from '../src/renderer/firms/useCrm.ts';

/**
 * Pipeline and Firms are two routes (1.0.14; David, 29 September 2026).
 *
 * They were one row called Firms, which answered two questions on one screen: what am I
 * working, and who is on file. The board is the first and carries the per-stage counts;
 * the list is the second and carries every firm, the ones nobody has spoken to included.
 *
 * What is pinned here is the division itself. A firm with no open opportunity has no
 * column to be in, so it must not be on the board; a firm in a stage must still be in the
 * list, because the list is *every* firm and a person looking somebody up should not have
 * to know which of the two screens they are on. Both halves of that went wrong in the
 * screen this replaced — the board grew a "Not in the pipeline yet" section above it
 * precisely because the two questions were on one page.
 *
 * No real firm appears: `example.test` is reserved by RFC 6761.
 */

const stage = (key: string, displayName: string, position: number) => ({
  id: `00000000-0000-4000-8000-00000000000${String(position)}`,
  key,
  displayName,
  position,
  terminalKind: null,
  retired: false,
});

const firm = (id: string, name: string, stageKey: string | null): FirmIdentityDto => ({
  id,
  name,
  website: null,
  locality: 'Providence',
  regionCode: 'RI',
  status: 'active',
  assignedUserId: null,
  stageKey,
  opportunityStatus: stageKey === null ? null : 'open',
  controlMode: null,
  openedAt: null,
  timeZone: null,
  timeZoneUnresolvedReason: null,
});

/**
 * Five firms, three of them with an open opportunity and two with none. The two are the
 * ones the old screen listed above the board; they belong to Firms now.
 */
const ASPEN = firm('11111111-1111-4111-8111-111111111111', 'Aspen Test Wealth', 'new');
const BRIDGE = firm('22222222-2222-4222-8222-222222222222', 'Bridgewater Test Advisors', 'contacting');
const CEDAR = firm('33333333-3333-4333-8333-333333333333', 'Cedar Test Partners', 'contacting');
const DELTA = firm('44444444-4444-4444-8444-444444444444', 'Delta Test Family Office', null);
const ELM = firm('55555555-5555-4555-8555-555555555555', 'Elm Test Capital', null);

const PIPELINE: PipelineView = {
  columns: [
    { stage: stage('new', 'New', 1), firms: [ASPEN] },
    { stage: stage('contacting', 'Contacting', 2), firms: [BRIDGE, CEDAR] },
  ],
  opportunityIdByFirmId: {},
  unplacedFirms: [ELM, DELTA],
};

const noop = (): void => undefined;

afterEach(cleanup);

describe('Pipeline', () => {
  it('shows only the firms that have an open opportunity, with its count on each column', () => {
    render(
      <PipelineBoard
        pipeline={PIPELINE}
        actionsEnabled={false}
        stageBusy={() => false}
        valueBusy={() => false}
        search=""
        memory={{ current: emptyBoardMemory() }}
        onSearch={noop}
        onShowLost={noop}
        onChangeStage={noop}
        onSetValue={noop}
        onOpenFirm={noop}
      />,
    );

    const names = screen.getAllByTestId('pipeline-open-firm').map(node => node.textContent);
    expect(names).toEqual(['Aspen Test Wealth', 'Bridgewater Test Advisors', 'Cedar Test Partners']);
    // The two firms the fixture has with no open opportunity are not on the board.
    expect(names).not.toContain('Delta Test Family Office');
    expect(names).not.toContain('Elm Test Capital');
    // The per-stage counts stay here: they are the column headings.
    const columns = screen.getAllByTestId('pipeline-column').map(node => node.textContent ?? '');
    expect(columns[0]).toContain('New1');
    expect(columns[1]).toContain('Contacting2');
    // And the section the old screen needed above the board is gone from it.
    expect(screen.queryByTestId('unplaced-firms')).toBeNull();
  });
});

describe('Firms', () => {
  it('lists every firm by name, cold ones included, and names the stage of each', () => {
    render(<FirmsList pipeline={PIPELINE} onOpenFirm={noop} />);

    expect(screen.getAllByTestId('firms-open-firm').map(node => node.textContent)).toEqual([
      'Aspen Test Wealth',
      'Bridgewater Test Advisors',
      'Cedar Test Partners',
      'Delta Test Family Office',
      'Elm Test Capital',
    ]);
    expect(screen.getAllByTestId('firms-row-stage').map(node => node.textContent)).toEqual([
      'New',
      'Contacting',
      'Contacting',
      NOT_IN_PIPELINE,
      NOT_IN_PIPELINE,
    ]);
    expect(screen.getByTestId('firms-list').textContent).toContain('Every firm5');
    // No board on this route, and no stage control on it either.
    expect(screen.queryByTestId('pipeline-board')).toBeNull();
    expect(screen.queryByTestId('stage-change')).toBeNull();
  });

  it('is every firm the one board read carried, in name order', () => {
    expect(firmsOf(PIPELINE).map(entry => entry.name)).toEqual([
      'Aspen Test Wealth',
      'Bridgewater Test Advisors',
      'Cedar Test Partners',
      'Delta Test Family Office',
      'Elm Test Capital',
    ]);
    expect(stageNameOf(PIPELINE, BRIDGE)).toBe('Contacting');
    expect(stageNameOf(PIPELINE, DELTA)).toBeNull();
    // A stage this client has never heard of is shown as its key rather than dropped.
    expect(stageNameOf(PIPELINE, firm(ASPEN.id, ASPEN.name, 'renamed_elsewhere'))).toBe('renamed_elsewhere');
  });

  it('shows the headings the two rows have, which are not the same heading', () => {
    expect(PIPELINE_HEADING).toBe('Pipeline');
    expect(FIRMS_HEADING).toBe('Firms');
  });
});

describe('the way back from a firm’s page', () => {
  const boardState = { screen: 'pipeline', firm: null } as unknown as CrmState;
  const firmState = {
    screen: 'firm',
    firm: { read: { firm: { id: ASPEN.id } } },
  } as unknown as CrmState;

  it('returns to the row the person came from, and Firms for a firm opened from neither', () => {
    // The board answer is the same answer on both rows, so the row is what the route says.
    expect(routeOfState(boardState, 'pipeline')).toEqual({ name: 'pipeline' });
    expect(routeOfState(boardState, 'firms')).toEqual({ name: 'firms' });
    // A firm's page is its own route either way, and lights Firms up.
    expect(routeOfState(firmState, 'pipeline')).toEqual({ name: 'firm', firmId: ASPEN.id });
    expect(routeOfState(firmState, 'firms')).toEqual({ name: 'firm', firmId: ASPEN.id });
  });

  it('puts Add firm and Import under Firms, because they put a firm on file', () => {
    const capture = { screen: 'add_firm', firm: null } as unknown as CrmState;
    expect(routeOfState(capture, 'pipeline')).toEqual({ name: 'firms' });
    expect(routeOfState({ ...capture, screen: 'import' }, 'pipeline')).toEqual({ name: 'firms' });
    expect(routeOfState({ ...capture, screen: 'merge' }, 'pipeline')).toEqual({ name: 'firms' });
  });
});
