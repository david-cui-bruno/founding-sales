// @vitest-environment jsdom

import axe from 'axe-core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MutationReceipt } from '../../src/shared/contracts/commonContract';
import {
  captureLearningRequestSchema,
  learningRowSchema,
  learningsListResponseSchema,
  type LearningRow,
  type LearningsListResponse,
} from '../../src/shared/contracts/learningsContract';
import {
  LearningsRoute,
  type LearningsApi,
} from '../../src/renderer/features/learnings/LearningsRoute';

afterEach(() => {
  cleanup();
});

const NOW = '2026-08-31T15:00:00.000Z';

const receipt: MutationReceipt = {
  revision: 7, affectedPersonIds: [], affectedSalesCycleIds: [],
};

const painRow: LearningRow = learningRowSchema.parse({
  learningId: 'learning-pain',
  category: 'pain',
  statement: 'Owners lose weekends to showings.',
  status: 'active',
  statusReason: null,
  confidence: 'medium',
  sampleSize: 3,
  firstObservedAt: '2026-08-28T10:00:00.000Z',
  latestObservedAt: '2026-08-30T10:00:00.000Z',
  evidence: [
    {
      id: 'evidence-1',
      personId: 'person-kevin',
      personName: 'Kevin Ortiz',
      activityId: null,
      quote: 'We keep losing weekends to showings.',
      notedAt: '2026-08-28T10:00:00.000Z',
    },
    {
      id: 'evidence-2',
      personId: null,
      personName: null,
      activityId: null,
      quote: 'Second owner said weekends are gone.',
      notedAt: '2026-08-29T10:00:00.000Z',
    },
    {
      id: 'evidence-3',
      personId: null,
      personName: null,
      activityId: null,
      quote: 'Third owner canceled a trip over a showing.',
      notedAt: '2026-08-30T10:00:00.000Z',
    },
  ],
  contradictionOf: null,
  createdAt: '2026-08-28T10:00:00.000Z',
  version: 2,
});

const contradictedRow: LearningRow = learningRowSchema.parse({
  learningId: 'learning-contradicted',
  category: 'pricing_reaction',
  statement: 'Owners will not pay above 8%.',
  status: 'contradicted',
  statusReason: 'Two founding customers signed above 8%.',
  confidence: 'low',
  sampleSize: 1,
  firstObservedAt: '2026-08-20T10:00:00.000Z',
  latestObservedAt: '2026-08-20T10:00:00.000Z',
  evidence: [{
    id: 'evidence-4',
    personId: null,
    personName: null,
    activityId: null,
    quote: 'He balked at anything above 8%.',
    notedAt: '2026-08-20T10:00:00.000Z',
  }],
  contradictionOf: null,
  createdAt: '2026-08-20T10:00:00.000Z',
  version: 3,
});

const retiredRow: LearningRow = learningRowSchema.parse({
  ...painRow,
  learningId: 'learning-retired',
  statement: 'Old seasonal claim.',
  status: 'retired',
  evidence: [painRow.evidence[1]!],
  sampleSize: 1,
  version: 5,
});

function makeResponse(rows: LearningRow[]): LearningsListResponse {
  return learningsListResponseSchema.parse({
    rows,
    totalActiveCount: rows.filter((row) => row.status === 'active').length,
    revision: 3,
  });
}

function makeApi(rows: LearningRow[] = [painRow, contradictedRow]): LearningsApi {
  return {
    list: vi.fn().mockResolvedValue(makeResponse(rows)),
    capture: vi.fn().mockResolvedValue(receipt),
    addEvidence: vi.fn().mockResolvedValue(receipt),
    updateStatus: vi.fn().mockResolvedValue(receipt),
  };
}

function renderRoute(overrides: {
  api?: LearningsApi;
  onOpenLead?: (personId: string) => void;
} = {}) {
  const api = overrides.api ?? makeApi();
  const onOpenLead = overrides.onOpenLead ?? vi.fn();
  render(<LearningsRoute api={api} onOpenLead={onOpenLead} now={() => NOW} />);
  return { api, onOpenLead };
}

describe('LearningsRoute list and filters', () => {
  it('loads with the full request and renders learning cards', async () => {
    const { api } = renderRoute();

    const statement = await screen.findByText('Owners lose weekends to showings.');
    const card = statement.closest('article')!;
    expect(api.list).toHaveBeenCalledWith({
      categories: [], statuses: [], query: '', limit: 200,
    });
    expect(within(card).getByText('Pain')).toBeTruthy();
    expect(within(card).getByText('Medium confidence')).toBeTruthy();
    expect(within(card).getByText('n = 3')).toBeTruthy();
  });

  it('refetches when a category chip toggles on and off', async () => {
    const { api } = renderRoute();
    await screen.findByText('Owners lose weekends to showings.');

    fireEvent.click(screen.getByRole('button', { name: 'Pain', pressed: false }));
    await waitFor(() => {
      expect(api.list).toHaveBeenLastCalledWith({
        categories: ['pain'], statuses: [], query: '', limit: 200,
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Pain', pressed: true }));
    await waitFor(() => {
      expect(api.list).toHaveBeenLastCalledWith({
        categories: [], statuses: [], query: '', limit: 200,
      });
    });
  });

  it('refetches on status filter and search input changes', async () => {
    const { api } = renderRoute();
    await screen.findByText('Owners lose weekends to showings.');

    fireEvent.click(screen.getByRole('combobox', { name: 'Status' }));
    fireEvent.click(screen.getByRole('option', { name: 'Retired' }));
    await waitFor(() => {
      expect(api.list).toHaveBeenLastCalledWith({
        categories: [], statuses: ['retired'], query: '', limit: 200,
      });
    });

    fireEvent.change(screen.getByLabelText('Search learnings'), {
      target: { value: 'weekend' },
    });
    await waitFor(() => {
      expect(api.list).toHaveBeenLastCalledWith({
        categories: [], statuses: ['retired'], query: 'weekend', limit: 200,
      });
    });
  });

  it('explains capture in the empty state without a duplicate CTA', async () => {
    renderRoute({ api: makeApi([]) });

    expect(await screen.findByText('No learnings yet')).toBeTruthy();
    expect(
      screen.getByText('Capture what you learn on calls so patterns surface.'),
    ).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Capture learning' })).toHaveLength(1);
  });

  it('marks selected category chips with the accent selected state', async () => {
    renderRoute();
    await screen.findByText('Owners lose weekends to showings.');

    const chip = screen.getByRole('button', { name: 'Pain', pressed: false });
    fireEvent.click(chip);

    await waitFor(() => {
      expect(chip.getAttribute('aria-pressed')).toBe('true');
    });
    expect(chip.className).toContain('learnings__chip');
  });

  it('is axe-clean at the page level', async () => {
    renderRoute();
    await screen.findByText('Owners lose weekends to showings.');

    const results = await axe.run(document.body, {
      rules: {
        'color-contrast': { enabled: false },
        region: { enabled: false },
      },
    });

    expect(results.violations).toEqual([]);
  });
});

describe('LearningCard evidence', () => {
  it('collapses quotes to 2 and expands on Show all', async () => {
    renderRoute();
    const card = (await screen.findByText('Owners lose weekends to showings.'))
      .closest('article')!;

    expect(within(card).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(within(card).getByRole('button', { name: 'Show all 3' }));
    expect(within(card).getAllByRole('listitem')).toHaveLength(3);
    expect(
      within(card).getByText('Third owner canceled a trip over a showing.'),
    ).toBeTruthy();
  });

  it('opens the linked person through onOpenLead', async () => {
    const { onOpenLead } = renderRoute();
    const card = (await screen.findByText('Owners lose weekends to showings.'))
      .closest('article')!;

    fireEvent.click(within(card).getByRole('button', { name: 'Kevin Ortiz' }));

    expect(onOpenLead).toHaveBeenCalledWith('person-kevin');
  });

  it('appends evidence with the current version through the inline form', async () => {
    const { api } = renderRoute();
    const card = (await screen.findByText('Owners lose weekends to showings.'))
      .closest('article')!;

    fireEvent.click(within(card).getByRole('button', { name: 'Add evidence' }));
    fireEvent.change(within(card).getByLabelText('New evidence quote'), {
      target: { value: 'Fourth owner said the same.' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Save evidence' }));

    await waitFor(() => {
      expect(api.addEvidence).toHaveBeenCalledWith({
        learningId: 'learning-pain',
        expectedVersion: 2,
        evidence: {
          personId: null,
          activityId: null,
          quote: 'Fourth owner said the same.',
          notedAt: NOW,
        },
      });
    });
  });
});

describe('LearningCard status controls', () => {
  it('retires an active learning with its expected version', async () => {
    const { api } = renderRoute();
    const card = (await screen.findByText('Owners lose weekends to showings.'))
      .closest('article')!;

    fireEvent.click(within(card).getByRole('button', { name: 'Retire' }));

    await waitFor(() => {
      expect(api.updateStatus).toHaveBeenCalledWith({
        learningId: 'learning-pain',
        expectedVersion: 2,
        status: 'retired',
        reason: null,
      });
    });
  });

  it('requires a reason before confirming a contradiction', async () => {
    const { api } = renderRoute();
    const card = (await screen.findByText('Owners lose weekends to showings.'))
      .closest('article')!;

    fireEvent.click(within(card).getByRole('button', { name: 'Contradict' }));
    const confirm = within(card).getByRole('button', { name: 'Confirm contradiction' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(card).getByLabelText('Contradiction reason'), {
      target: { value: 'Three owners since said the opposite.' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Confirm contradiction' }));

    await waitFor(() => {
      expect(api.updateStatus).toHaveBeenCalledWith({
        learningId: 'learning-pain',
        expectedVersion: 2,
        status: 'contradicted',
        reason: 'Three owners since said the opposite.',
      });
    });
  });

  it('renders contradicted cards struck through with the reason and reactivates', async () => {
    const { api } = renderRoute();
    const statement = await screen.findByText('Owners will not pay above 8%.');
    const card = statement.closest('article')!;

    expect(statement.closest('s')).toBeTruthy();
    expect(
      within(card).getByText('Two founding customers signed above 8%.'),
    ).toBeTruthy();

    fireEvent.click(within(card).getByRole('button', { name: 'Reactivate' }));
    await waitFor(() => {
      expect(api.updateStatus).toHaveBeenCalledWith({
        learningId: 'learning-contradicted',
        expectedVersion: 3,
        status: 'active',
        reason: null,
      });
    });
  });

  it('reactivates retired learnings', async () => {
    const { api } = renderRoute({ api: makeApi([retiredRow]) });
    const card = (await screen.findByText('Old seasonal claim.')).closest('article')!;

    fireEvent.click(within(card).getByRole('button', { name: 'Reactivate' }));

    await waitFor(() => {
      expect(api.updateStatus).toHaveBeenCalledWith({
        learningId: 'learning-retired',
        expectedVersion: 5,
        status: 'active',
        reason: null,
      });
    });
  });
});

describe('CaptureLearningDialog', () => {
  async function openDialog(api: LearningsApi) {
    renderRoute({ api });
    await screen.findByText('Owners lose weekends to showings.');
    fireEvent.click(screen.getByRole('button', { name: 'Capture learning' }));
    return screen.getByRole('dialog', { name: 'Capture learning' });
  }

  it('submits a strict capture payload with evidence rows', async () => {
    const api = makeApi();
    const dialog = await openDialog(api);

    fireEvent.change(within(dialog).getByLabelText('Category'), {
      target: { value: 'objection' },
    });
    fireEvent.change(within(dialog).getByLabelText('Statement'), {
      target: { value: 'Owners fear losing tenant relationships.' },
    });
    fireEvent.change(within(dialog).getByLabelText('Confidence'), {
      target: { value: 'high' },
    });
    fireEvent.change(within(dialog).getByLabelText('Evidence quote 1'), {
      target: { value: 'What if my tenants stop calling me?' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add another evidence row' }));
    fireEvent.change(within(dialog).getByLabelText('Evidence quote 2'), {
      target: { value: 'Second owner asked the same.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save learning' }));

    await waitFor(() => {
      expect(api.capture).toHaveBeenCalledTimes(1);
    });
    const payload = (api.capture as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(captureLearningRequestSchema.parse(payload)).toEqual({
      category: 'objection',
      statement: 'Owners fear losing tenant relationships.',
      confidence: 'high',
      evidence: [
        {
          personId: null, activityId: null,
          quote: 'What if my tenants stop calling me?', notedAt: NOW,
        },
        {
          personId: null, activityId: null,
          quote: 'Second owner asked the same.', notedAt: NOW,
        },
      ],
      contradictionOf: null,
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('does not submit without a statement and a quote', async () => {
    const api = makeApi();
    const dialog = await openDialog(api);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save learning' }));

    expect(api.capture).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Capture learning' })).toBeTruthy();
  });

  it('is axe-clean with labelled dialog controls', async () => {
    const api = makeApi();
    const dialog = await openDialog(api);

    const results = await axe.run(dialog, {
      rules: {
        'color-contrast': { enabled: false },
        region: { enabled: false },
      },
    });

    expect(results.violations).toEqual([]);
  });
});
