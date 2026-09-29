// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallBriefDto } from '@fss/contracts';
import { Brief } from '../src/renderer/research/Brief.tsx';
import { FirmResearch } from '../src/renderer/research/FirmResearch.tsx';
import { ResearchSettings } from '../src/renderer/settings/ResearchSettings.tsx';
import { createGeneration } from '../src/renderer/app/generation.ts';
import type { ResearchState } from '../src/renderer/researchContract.ts';
import type { OperationApi, OperationName } from '../src/shared/operations.ts';

/**
 * The Research surface as React components (lane R).
 *
 * Four things the end-to-end specs cannot state as plainly, because they are about the
 * shape of the page rather than about what a person sees:
 *
 *   * a quote carries its source and its date, and the two generated lines are the
 *     **only** things under "AI suggestion". The design record asks the brief to
 *     distinguish the firm's own words from an AI interpretation, and that is a claim
 *     about which text sits under which label;
 *   * a source is an ordinary `https:` anchor opened through the window-open handler
 *     that already exists, not a new channel: there is no `callie` bridge call behind
 *     it and no `tel:`, `file:` or `javascript:` anywhere in the markup;
 *   * a firm with no brief shows one grey line and the same action, rather than an
 *     empty section that looks like a failure;
 *   * the Research settings are **absent** for a salesperson rather than inert.
 *
 * No real firm, person or number appears; `example.test` is reserved by RFC 6761.
 */

const FIRM_ID = '11111111-1111-4111-8111-111111111111';
const AT = '2026-09-28T14:00:00.000Z';

const brief = (overrides: Partial<CallBriefDto> = {}): CallBriefDto => ({
  whyFit: [
    { quote: 'We manage residential property for owners.', sourceReference: 'https://northwind.example.test/', retrievedAt: AT },
  ],
  whatChanged: [
    { quote: 'We opened a second office.', sourceReference: 'https://northwind.example.test/about', retrievedAt: AT },
  ],
  likelyPerson: { contactId: FIRM_ID, name: 'Dana Example', title: 'Maintenance Coordinator' },
  questions: ['How do you take work orders today?', 'Who picks them up after hours?'],
  opening: 'I saw your maintenance page.',
  generated: true,
  judgments: { fit: 'yes', problemEvidence: 'yes', timing: 'unknown', reachability: 'yes' },
  judgedAt: AT,
  revision: 2,
  sources: [{ sourceReference: 'https://northwind.example.test/', retrievedAt: AT }],
  ...overrides,
});

const state = (overrides: Partial<ResearchState> = {}): ResearchState => ({
  firm: {
    firmId: FIRM_ID,
    brief: brief(),
    facts: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        key: 'target_fit',
        quote: 'We manage residential property for owners.',
        sourceReference: 'https://northwind.example.test/',
        retrievedAt: AT,
        confidence: null,
      },
    ],
    judgments: {
      fit: 'yes',
      problemEvidence: 'yes',
      timing: 'unknown',
      reachability: 'yes',
      reasons: { fit: 'the firm’s own site says it manages property for owners' },
      callFirst: true,
      likelyContactId: null,
      judgedAt: AT,
    },
    runs: [
      {
        revision: 2,
        trigger: 'sweep',
        startedAt: AT,
        completedAt: AT,
        outcome: 'completed',
        refusalCode: null,
        pagesFetched: 2,
        factsRecorded: 1,
        costCents: 2,
      },
    ],
    links: [],
  },
  settings: null,
  worstCaseRunCents: null,
  spend: { todayCents: 4, monthToDateCents: 37 },
  notice: null,
  mayMutate: true,
  role: 'salesperson',
  ...overrides,
});

const ADMIN_SETTINGS = {
  enabled: true,
  dailyFirmCeiling: 50,
  dailyCostCeilingCents: 50,
  monthlyCostCeilingCents: 1000,
  maxPagesPerFirm: 4,
  maxPageBytes: 1_000_000,
  modelName: 'claude-haiku-4-5',
  updatedByUserId: null,
  updatedAt: null,
} as const;

type Scripted = Readonly<Partial<Record<OperationName, (input: unknown) => Promise<ResearchState>>>>;

function install(scripted: Scripted, answer: ResearchState = state()): void {
  const answerOne = async (operation: OperationName, input: unknown): Promise<unknown> =>
    await (scripted[operation]?.(input) ?? Promise.resolve(answer));
  globalThis.callieApi = { read: answerOne, command: answerOne } as unknown as OperationApi;
}

const client = (): QueryClient =>
  new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });

afterEach(() => {
  cleanup();
  globalThis.callieApi = undefined;
});

describe('the call brief on the Today card', () => {
  const noop = (): void => undefined;

  it('quotes the firm with its source and date, and labels only the generated lines', () => {
    render(<Brief brief={brief()} enabled onResearchAgain={noop} researching={false} />);

    expect(screen.getAllByTestId('brief-quote').map(node => node.textContent)).toEqual([
      '“We manage residential property for owners.”',
      '“We opened a second office.”',
    ]);
    for (const source of screen.getAllByTestId('brief-source')) {
      expect(source.textContent).toBe('northwind.example.test · 28 Sep 2026');
    }
    // The two generated lines sit under "AI suggestion" and the quotes do not.
    const generated = screen.getByTestId('brief-generated');
    expect(generated.textContent).toContain('AI suggestion');
    expect(generated.textContent).toContain('How do you take work orders today?');
    expect(generated.textContent).toContain('I saw your maintenance page.');
    expect(generated.textContent).not.toContain('We manage residential property');
  });

  it('shows the four judgments as four small labels, with unknown as a dash', () => {
    render(<Brief brief={brief()} enabled onResearchAgain={noop} researching={false} />);
    expect(screen.getByTestId('judgment-fit').textContent).toContain('Fit yes');
    expect(screen.getByTestId('judgment-problem').textContent).toContain('Problem yes');
    // Silence is not a denial, and the label says so with a dash rather than "no".
    expect(screen.getByTestId('judgment-timing').textContent).toContain('Timing —');
    expect(screen.getByTestId('judgment-timing').textContent).not.toContain('no');
    expect(screen.getByTestId('judgment-reach').textContent).toContain('Reach yes');
  });

  it('opens a source through the window-open handler, and never through a bridge', () => {
    const { container } = render(<Brief brief={brief()} enabled onResearchAgain={noop} researching={false} />);
    const anchors = [...container.querySelectorAll('a')];
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) {
      expect(anchor.getAttribute('href')?.startsWith('https://')).toBe(true);
      expect(anchor.getAttribute('target')).toBe('_blank');
      expect(anchor.getAttribute('rel')).toBe('noreferrer');
    }
    // `app.ts`'s `setWindowOpenHandler` only passes `http(s)`; nothing here is a
    // scheme it would deny, and there is no other way out of the page.
    expect(container.innerHTML).not.toContain('tel:');
    expect(container.innerHTML).not.toContain('file:');
    expect(container.innerHTML).not.toContain('javascript:');
  });

  it('shows one grey line and the same action for a firm nobody has researched', async () => {
    const again = vi.fn();
    render(<Brief brief={null} enabled onResearchAgain={again} researching={false} />);
    expect(screen.getByTestId('brief-absent').textContent).toBe('Not researched yet.');
    expect(screen.queryByTestId('brief-generated')).toBeNull();
    await userEvent.click(screen.getByTestId('research-again'));
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('is a plain button and there is no form to submit', () => {
    const { container } = render(<Brief brief={brief()} enabled onResearchAgain={noop} researching={false} />);
    expect(container.querySelectorAll('form')).toHaveLength(0);
    expect(screen.getByTestId('research-again').getAttribute('type')).toBe('button');
  });

  it('waits for its own command and is read-only meanwhile', () => {
    render(<Brief brief={brief()} enabled onResearchAgain={noop} researching />);
    const button = screen.getByTestId('research-again');
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });
});

describe('the Firm page’s Research section', () => {
  const mount = (): void => {
    render(
      <QueryClientProvider client={client()}>
        <FirmResearch firmId={FIRM_ID} identity="person" generation={0} guard={createGeneration().guard} enabled />
      </QueryClientProvider>,
    );
  };

  it('reads the firm’s own route and shows the judgments, the facts and the runs', async () => {
    const open = vi.fn(async (_input: unknown) => await Promise.resolve(state()));
    install({ 'research.open': open });
    mount();

    await screen.findByTestId('research-fact');
    expect(open).toHaveBeenCalledWith({ firmId: FIRM_ID });
    expect(screen.getByTestId('research-judgment-fit').textContent).toContain('Fit yes');
    expect(screen.getAllByTestId('research-reason')[0]?.textContent).toContain('manages property for owners');
    expect(screen.getByTestId('research-fact').textContent).toContain('“We manage residential property for owners.”');
    expect(screen.getByTestId('research-fact-source').textContent).toBe('target_fit · northwind.example.test · 28 Sep 2026');
    expect(screen.getByTestId('research-run').textContent).toBe('28 Sep 2026 — 1 fact, $0.02');
  });

  it('sends Research now and Add a link as commands, and clears the field', async () => {
    const run = vi.fn(async (_input: unknown) => await Promise.resolve(state()));
    const addLink = vi.fn(async (_input: unknown) => await Promise.resolve(state()));
    install({ 'research.run': run, 'research.addLink': addLink });
    mount();
    await screen.findByTestId('research-fact');

    const user = userEvent.setup();
    await user.click(screen.getByTestId('research-now'));
    await waitFor(() => {
      expect(run).toHaveBeenCalledWith({ firmId: FIRM_ID });
    });

    const field = screen.getByTestId('research-link-input');
    await user.type(field, 'https://news.example.test/piece');
    await user.click(screen.getByTestId('research-add-link'));
    await waitFor(() => {
      expect(addLink).toHaveBeenCalledWith({ firmId: FIRM_ID, url: 'https://news.example.test/piece' });
    });
    expect((field as HTMLInputElement).value).toBe('');
  });

  it('turns a refusal code into a sentence and never shows the code', async () => {
    install({}, state({ notice: 'link_not_permitted' }));
    mount();
    expect((await screen.findByTestId('research-notice')).textContent).toBe(
      'Callie reads https pages, and never a directory, a social network or a job board.',
    );
    expect(document.body.textContent).not.toContain('link_not_permitted');
  });

  it('says so plainly for a firm Callie has not read yet', async () => {
    install({}, state({ firm: { firmId: FIRM_ID, brief: null, facts: [], judgments: null, runs: [], links: [] } }));
    mount();
    expect((await screen.findByTestId('research-empty')).textContent).toBe('Callie has not read this firm’s site yet.');
  });
});

describe('Settings › Research', () => {
  const mount = (): void => {
    render(
      <QueryClientProvider client={client()}>
        <ResearchSettings identity="person" generation={0} guard={createGeneration().guard} />
      </QueryClientProvider>,
    );
  };

  it('is absent for a salesperson rather than inert', async () => {
    install({}, state({ settings: null, role: 'salesperson' }));
    mount();
    await waitFor(() => {
      expect(globalThis.callieApi).toBeDefined();
    });
    expect(screen.queryByTestId('research-settings')).toBeNull();
  });

  it('shows the ceilings, the model and the month’s spend for an admin', async () => {
    install(
      {},
      state({ settings: ADMIN_SETTINGS, worstCaseRunCents: 2, role: 'admin', spend: { todayCents: 4, monthToDateCents: 37 } }),
    );
    mount();
    await screen.findByTestId('research-settings');
    expect((screen.getByTestId('research-dailyFirmCeiling') as HTMLInputElement).value).toBe('50');
    expect((screen.getByTestId('research-monthlyCostCeilingCents') as HTMLInputElement).value).toBe('1000');
    expect(screen.getByTestId('research-model').textContent).toBe('claude-haiku-4-5 · up to $0.02 a firm');
    expect(screen.getByTestId('research-spend').textContent).toBe('$0.04 today, $0.37 of $10.00 this month.');
  });

  it('sends what was typed and clamps nothing', async () => {
    const save = vi.fn(async (_input: unknown) => await Promise.resolve(state({ settings: ADMIN_SETTINGS, role: 'admin' })));
    install({ 'research.saveSettings': save }, state({ settings: ADMIN_SETTINGS, role: 'admin' }));
    mount();
    await screen.findByTestId('research-settings');
    save.mockClear();

    const user = userEvent.setup();
    const field = screen.getByTestId('research-maxPagesPerFirm');
    await user.clear(field);
    // Out of bounds on purpose: the server's refusal is what an admin should read.
    await user.type(field, '99');
    await user.click(screen.getByTestId('research-save'));
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });
    expect(save.mock.calls[0]?.[0]).toMatchObject({ maxPagesPerFirm: 99 });
  });
});
