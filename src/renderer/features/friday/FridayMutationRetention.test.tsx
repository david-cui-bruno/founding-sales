// @vitest-environment jsdom
// Source-only candidate. Parent must observe behavioral RED before implementation.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mutationReceiptSchema } from '../../../shared/contracts/commonContract';
import type { MutationReceipt } from '../../../shared/contracts/commonContract';
import { fridayReportSchema } from '../../../shared/contracts/fridayContract';
import type { FridayReport, JobRequest } from '../../../shared/contracts/fridayContract';
import { PresentationRoot } from '../../app/PresentationRoot';
import { FridayRoute } from './FridayRoute';
import type { FridayApi } from './FridayRoute';

const receipt: MutationReceipt = {
  revision: 5, affectedPersonIds: [], affectedSalesCycleIds: [],
};
const job: JobRequest = {
  id: 'job-1', salesCycleId: null, requestedAt: '2026-08-31T13:00:00.000Z',
  status: 'requested', contractorAcceptedAt: null,
};
const report: FridayReport = {
  periodStartsAt: '2026-08-31T04:00:00.000Z',
  periodEndsAt: '2026-09-05T04:00:00.000Z', asOf: '2026-08-31T15:00:00.000Z',
  metrics: [], sourceRows: [], jobs: [job, { ...job, id: 'job-other' }], revision: 4,
};
const unknown = 'The change could not be confirmed. Your input is kept. Review the job before retrying.';
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function api(overrides: Partial<FridayApi> = {}): FridayApi {
  return {
    getCurrent: vi.fn(async () => report),
    getDrilldown: vi.fn(async () => ({ metricId: 'interviews' as const, label: 'Interviews', rows: [] })),
    createJob: vi.fn(async () => receipt), fillJob: vi.fn(async () => receipt),
    cancelJob: vi.fn(async () => receipt), ...overrides,
  };
}
async function mount(source: FridayApi) {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<PresentationRoot><FridayRoute api={source} onOpenLead={vi.fn()} /></PresentationRoot>); });
  return view;
}
const button = (name: string) => screen.getByRole('button', { name });
const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const change = (name: string, value: string) => fireEvent.change(field(name), { target: { value } });
async function click(name: string) { await act(async () => { fireEvent.click(button(name)); }); }
function enterCreate() {
  change('Requested date', '2026-08-31'); change('Requested time', '11:30');
  change('Won sales cycle (optional)', 'cycle-9');
}
async function beginFill() {
  await click('Fill job-1');
  change('Accepted date', '2026-08-31'); change('Accepted time', '16:00');
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Friday captured mutation continuity', () => {
  it('does not start fill without an accepted date or clear the editable time', async () => {
    const source = api(); await mount(source); await click('Fill job-1');
    change('Accepted time', '16:00'); await click('Confirm fill');
    expect(source.fillJob).not.toHaveBeenCalled();
    expect(field('Accepted time').value).toBe('16:00');
    expect(source.getCurrent).toHaveBeenCalledTimes(1);
  });

  it('freezes now and the generated ID for blank-date retry even after the clock moves', async () => {
    const flight = deferred<MutationReceipt>();
    const createJob = vi.fn<FridayApi['createJob']>().mockImplementationOnce(() => flight.promise).mockResolvedValue(receipt);
    const source = api({ createJob }); await mount(source);
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-31T15:00:00.000Z'));
    await click('Request job');
    expect(createJob).toHaveBeenCalledTimes(1);
    const captured = { ...createJob.mock.calls[0]![0] };
    expect(captured).toEqual({ jobId: expect.stringMatching(/^job-\S+$/), salesCycleId: null, requestedAt: '2026-08-31T15:00:00.000Z' });
    await act(async () => { flight.reject(new Error('uncertain')); });
    expect(screen.getByText(unknown)).toBeTruthy();
    vi.setSystemTime(new Date('2026-09-01T15:00:00.000Z'));
    await click('Retry');
    expect(createJob.mock.calls).toEqual([[captured], [captured]]);
  });

  it('does not treat inline fill Escape as modal dismissal under real PresentationRoot', async () => {
    await mount(api()); await beginFill();
    const cycle = field('Won sales cycle (optional)');
    change('Won sales cycle (optional)', 'cycle-draft');
    cycle.focus(); cycle.setSelectionRange(2, 7);
    fireEvent.keyDown(cycle, { key: 'Escape' });
    expect(field('Accepted date').value).toBe('2026-08-31');
    expect(field('Accepted time').value).toBe('16:00');
    expect(cycle.value).toBe('cycle-draft');
    expect(cycle.selectionStart).toBe(2); expect(cycle.selectionEnd).toBe(7);
  });

  it('uses strict fixtures with no invented job identity in a receipt', () => {
    expect(mutationReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(fridayReportSchema.parse(report)).toEqual(report);
  });

  it('admits one same-turn submit, keeps raw input and blocks competing controls', async () => {
    // Own every route/write timer before mount and before transport admission.
    vi.useFakeTimers();
    const flight = deferred<MutationReceipt>();
    const source = api({ createJob: vi.fn(() => flight.promise) });
    await mount(source); enterCreate();
    const date = field('Requested date');
    const form = button('Request job').closest('form')!;
    // Two actual submit events before React commits. Positive control is exactly one call.
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(source.createJob).toHaveBeenCalledTimes(1);
    expect(source.createJob).toHaveBeenCalledWith({
      jobId: expect.stringMatching(/^job-\S+$/), salesCycleId: 'cycle-9',
      requestedAt: new Date('2026-08-31T11:30').toISOString(),
    });
    expect(field('Requested date')).toBe(date);
    expect(date.value).toBe('2026-08-31');
    expect(field('Requested time').value).toBe('11:30');
    expect(field('Won sales cycle (optional)').value).toBe('cycle-9');
    for (const name of ['Request job', 'Fill job-1', 'Cancel job-1', 'Previous week']) {
      expect((button(name) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button(name));
    }
    expect(source.fillJob).not.toHaveBeenCalled();
    expect(source.cancelJob).not.toHaveBeenCalled();
    expect(source.getCurrent).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect((button('Request job') as HTMLButtonElement).disabled).toBe(true);
    expect(source.createJob).toHaveBeenCalledTimes(1);
  });

  it('shares same-act admission across fill, create and cancel without clearing the rejected create draft', async () => {
    const flight = deferred<MutationReceipt>();
    const source = api({ fillJob: vi.fn(() => flight.promise) });
    await mount(source); enterCreate(); await beginFill();
    const date = field('Requested date');
    const form = button('Request job').closest('form')!;
    const confirm = button('Confirm fill');
    const cancel = button('Cancel job-1');
    // Capture enabled controls first. All three dispatches occur before React commits.
    act(() => {
      fireEvent.click(confirm);
      fireEvent.submit(form);
      fireEvent.click(cancel);
    });
    // Positive control rules out an implementation that simply blocks every operation.
    expect(source.fillJob).toHaveBeenCalledTimes(1);
    expect(source.fillJob).toHaveBeenCalledWith({
      jobId: 'job-1', contractorAcceptedAt: new Date('2026-08-31T16:00').toISOString(),
    });
    expect(source.createJob).not.toHaveBeenCalled();
    expect(source.cancelJob).not.toHaveBeenCalled();
    expect(source.getCurrent).toHaveBeenCalledTimes(1);
    expect(field('Requested date')).toBe(date);
    expect(date.value).toBe('2026-08-31');
    expect(field('Requested time').value).toBe('11:30');
    expect(field('Won sales cycle (optional)').value).toBe('cycle-9');
    expect(field('Accepted date').value).toBe('2026-08-31');
    expect(field('Accepted time').value).toBe('16:00');
  });

  it('keeps rejected create fields without reread and retries the identical UUID and timestamp', async () => {
    const flight = deferred<MutationReceipt>();
    const createJob = vi.fn<FridayApi['createJob']>().mockImplementationOnce(() => flight.promise).mockResolvedValue(receipt);
    const source = api({ createJob }); await mount(source); enterCreate();
    await click('Request job');
    const captured = { ...createJob.mock.calls[0]![0] };
    await act(async () => { flight.reject(new Error('private /db/secret')); });
    expect(screen.getByText(unknown)).toBeTruthy();
    expect(document.body.textContent).not.toContain('/db/secret');
    expect(field('Requested date').value).toBe('2026-08-31');
    expect(field('Requested time').value).toBe('11:30');
    expect(field('Won sales cycle (optional)').value).toBe('cycle-9');
    for (const label of ['Requested date', 'Requested time', 'Won sales cycle (optional)']) {
      expect(field(label).disabled || field(label).readOnly).toBe(true);
    }
    expect(source.getCurrent).toHaveBeenCalledTimes(1);
    await click('Retry');
    expect(createJob).toHaveBeenCalledTimes(2);
    expect(createJob.mock.calls[1]![0]).toEqual(captured);
    expect(source.getCurrent).toHaveBeenLastCalledWith(undefined);
  });

  it('acknowledges receipt separately from report failure and never retries the write', async () => {
    const flight = deferred<MutationReceipt>();
    const reportFlight = deferred<FridayReport>();
    const getCurrent = vi.fn<FridayApi['getCurrent']>().mockResolvedValueOnce(report)
      .mockImplementationOnce(() => reportFlight.promise).mockResolvedValue(report);
    const source = api({ getCurrent, createJob: vi.fn(() => flight.promise) });
    await mount(source); await beginFill(); enterCreate(); const date = field('Requested date');
    await click('Request job');
    await act(async () => { flight.resolve(receipt); });
    // The follow-up report is still unresolved. Acknowledgement cannot wait for it.
    expect(getCurrent).toHaveBeenCalledTimes(2);
    expect(source.createJob).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/^Saved\b/)).toBeTruthy();
    expect(field('Requested date')).toBe(date);
    expect(date.value).toBe('');
    expect(field('Requested time').value).toBe('');
    expect(field('Won sales cycle (optional)').value).toBe('');
    expect(field('Accepted date').value).toBe('2026-08-31');
    expect(field('Accepted time').value).toBe('16:00');
    expect(screen.queryByText(unknown)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByText('Saved; scoreboard refresh failed')).toBeNull();
    await act(async () => { reportFlight.reject(new Error('private-read')); });
    expect(screen.getByText('Saved; scoreboard refresh failed')).toBeTruthy();
    expect(field('Requested date')).toBe(date);
    expect(date.value).toBe('');
    expect(field('Requested time').value).toBe('');
    expect(field('Won sales cycle (optional)').value).toBe('');
    expect(screen.queryByText(unknown)).toBeNull();
    expect(field('Accepted date').value).toBe('2026-08-31');
    expect(field('Accepted time').value).toBe('16:00');
    await click('Refresh jobs');
    expect(source.createJob).toHaveBeenCalledTimes(1);
    expect(getCurrent).toHaveBeenCalledTimes(3);
    expect(getCurrent).toHaveBeenLastCalledWith(undefined);
  });

  it('holds exact fill target and accepted fields across rejection and retry', async () => {
    const flight = deferred<MutationReceipt>();
    const fillJob = vi.fn<FridayApi['fillJob']>().mockImplementationOnce(() => flight.promise).mockResolvedValue(receipt);
    const source = api({ fillJob }); await mount(source); await beginFill();
    const date = field('Accepted date'); const confirm = button('Confirm fill');
    act(() => { fireEvent.click(confirm); fireEvent.click(confirm); });
    expect(fillJob).toHaveBeenCalledTimes(1);
    const captured = { jobId: 'job-1', contractorAcceptedAt: new Date('2026-08-31T16:00').toISOString() };
    expect(fillJob).toHaveBeenCalledWith(captured);
    for (const name of ['Keep requested', 'Fill job-other', 'Cancel job-other', 'Request job', 'Previous week']) {
      expect((button(name) as HTMLButtonElement).disabled).toBe(true);
    }
    await act(async () => { flight.reject(new Error('uncertain')); });
    expect(screen.getByText(unknown)).toBeTruthy();
    expect(field('Accepted date')).toBe(date); expect(date.value).toBe('2026-08-31');
    expect(field('Accepted time').value).toBe('16:00');
    expect((button('Keep requested') as HTMLButtonElement).disabled).toBe(true);
    expect(source.getCurrent).toHaveBeenCalledTimes(1);
    await click('Retry');
    expect(fillJob.mock.calls).toEqual([[captured], [captured]]);
    expect(source.getCurrent).toHaveBeenCalledTimes(2);
  });

  it('retains cancelled target uncertainty and retries only that exact ID', async () => {
    const flight = deferred<MutationReceipt>();
    const cancelJob = vi.fn<FridayApi['cancelJob']>().mockImplementationOnce(() => flight.promise).mockResolvedValue(receipt);
    const source = api({ cancelJob }); await mount(source);
    const cancel = button('Cancel job-1');
    act(() => { fireEvent.click(cancel); fireEvent.click(cancel); });
    expect(cancelJob.mock.calls).toEqual([[{ jobId: 'job-1' }]]);
    await act(async () => { flight.reject(new Error('uncertain')); });
    expect(screen.getByText(unknown)).toBeTruthy(); expect(screen.getByText('job-1')).toBeTruthy();
    expect(source.getCurrent).toHaveBeenCalledTimes(1);
    await click('Retry');
    expect(cancelJob.mock.calls).toEqual([[{ jobId: 'job-1' }], [{ jobId: 'job-1' }]]);
  });

  it.each(['create', 'fill', 'cancel'] as const)('reconciles %s only on exact job readback, never aggregate or wrong-ID evidence', async (kind) => {
    const flight = deferred<MutationReceipt>();
    const source = api({
      createJob: vi.fn(() => flight.promise), fillJob: vi.fn(() => flight.promise), cancelJob: vi.fn(() => flight.promise),
    });
    await mount(source);
    let expected: JobRequest;
    if (kind === 'create') {
      enterCreate(); await click('Request job');
      const input = vi.mocked(source.createJob).mock.calls[0]![0];
      expected = { id: input.jobId, salesCycleId: input.salesCycleId, requestedAt: input.requestedAt, status: 'requested', contractorAcceptedAt: null };
    } else if (kind === 'fill') {
      await beginFill(); await click('Confirm fill');
      expected = { ...job, status: 'filled', contractorAcceptedAt: new Date('2026-08-31T16:00').toISOString() };
    } else {
      await click('Cancel job-1'); expected = { ...job, status: 'cancelled' };
    }
    await act(async () => { flight.reject(new Error('uncertain')); });
    expect(screen.getByText(unknown)).toBeTruthy();
    const mismatch = kind === 'create' ? { ...expected, salesCycleId: 'cycle-wrong' }
      : kind === 'fill' ? { ...expected, contractorAcceptedAt: '2026-08-31T00:00:00.000Z' }
      : { ...expected, status: 'requested' as const };
    const extraMismatch = kind === 'create' ? [{ ...expected, requestedAt: '2026-08-30T00:00:00.000Z' }]
      : kind === 'fill' ? [{ ...expected, status: 'requested' as const }] : null;
    const reads = [[], [{ ...expected, id: 'wrong-id' }], [mismatch]];
    if (extraMismatch) reads.push(extraMismatch);
    for (const jobs of reads) {
      vi.mocked(source.getCurrent).mockResolvedValue({ ...report, revision: 99, jobs });
      await click('Refresh jobs'); expect(screen.getByText(unknown)).toBeTruthy();
    }
    vi.mocked(source.getCurrent).mockResolvedValue({ ...report, revision: 100, jobs: [expected] });
    await click('Refresh jobs');
    expect(screen.queryByText(unknown)).toBeNull();
    expect((button('Request job') as HTMLButtonElement).disabled).toBe(false);
    expect(source.createJob).toHaveBeenCalledTimes(kind === 'create' ? 1 : 0);
    expect(source.fillJob).toHaveBeenCalledTimes(kind === 'fill' ? 1 : 0);
    expect(source.cancelJob).toHaveBeenCalledTimes(kind === 'cancel' ? 1 : 0);
    expect(source.getCurrent).toHaveBeenCalledTimes(reads.length + 2);
    if (kind === 'create') expect(field('Requested date').value).toBe('');
    if (kind === 'fill') expect(screen.queryByLabelText('Accepted date')).toBeNull();
    if (kind === 'cancel') expect(screen.queryByRole('button', { name: 'Cancel job-1' })).toBeNull();
  });

  it.each(['resolve', 'reject'] as const)('ignores old mutation %s after real API replacement', async (outcome) => {
    const flight = deferred<MutationReceipt>();
    const nextFlight = deferred<MutationReceipt>();
    const old = api({ createJob: vi.fn(() => flight.promise) });
    const next = api({ createJob: vi.fn(() => nextFlight.promise) });
    const view = await mount(old); enterCreate(); await click('Request job');
    await act(async () => { view.rerender(<PresentationRoot><FridayRoute api={next} onOpenLead={vi.fn()} /></PresentationRoot>); });
    change('Won sales cycle (optional)', 'replacement-draft');
    await act(async () => {
      if (outcome === 'resolve') flight.resolve(receipt); else flight.reject(new Error('old-api'));
    });
    expect(old.getCurrent).toHaveBeenCalledTimes(1);
    expect(next.getCurrent).toHaveBeenCalledTimes(1);
    expect(next.createJob).not.toHaveBeenCalled();
    expect(field('Won sales cycle (optional)').value).toBe('replacement-draft');
    expect(screen.queryByText(unknown)).toBeNull();
    for (const label of ['Requested date', 'Requested time', 'Won sales cycle (optional)']) {
      expect(field(label).disabled).toBe(false);
      expect(field(label).readOnly).toBe(false);
    }
    expect((button('Request job') as HTMLButtonElement).disabled).toBe(false);
    change('Requested date', '2026-09-01');
    change('Requested time', '09:15');
    await click('Request job');
    expect(next.createJob).toHaveBeenCalledTimes(1);
    expect(next.createJob).toHaveBeenCalledWith({
      jobId: expect.stringMatching(/^job-\S+$/), salesCycleId: 'replacement-draft',
      requestedAt: new Date('2026-09-01T09:15').toISOString(),
    });
    expect(old.createJob).toHaveBeenCalledTimes(1);
    expect(old.getCurrent).toHaveBeenCalledTimes(1);
    // The new owner's transport remains pending, so no new report read is due yet.
    expect(next.getCurrent).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'reject'] as const)('does not revive the first A owner after A-B-A and old %s', async (outcome) => {
    const flight = deferred<MutationReceipt>();
    const freshFlight = deferred<MutationReceipt>();
    const createJob = vi.fn<FridayApi['createJob']>()
      .mockImplementationOnce(() => flight.promise).mockImplementation(() => freshFlight.promise);
    const a = api({ createJob }); const b = api();
    const view = await mount(a); enterCreate(); await click('Request job');
    await act(async () => { view.rerender(<PresentationRoot><FridayRoute api={b} onOpenLead={vi.fn()} /></PresentationRoot>); });
    await act(async () => { view.rerender(<PresentationRoot><FridayRoute api={a} onOpenLead={vi.fn()} /></PresentationRoot>); });
    enterCreate(); change('Won sales cycle (optional)', 'fresh-a');
    await act(async () => {
      if (outcome === 'resolve') flight.resolve(receipt); else flight.reject(new Error('departed-a'));
    });
    expect(a.getCurrent).toHaveBeenCalledTimes(2);
    expect(b.getCurrent).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(unknown)).toBeNull();
    expect(field('Won sales cycle (optional)').value).toBe('fresh-a');
    expect((button('Request job') as HTMLButtonElement).disabled).toBe(false);
    await click('Request job');
    expect(createJob).toHaveBeenCalledTimes(2);
    expect(createJob.mock.calls[1]![0]).toEqual({
      jobId: expect.stringMatching(/^job-\S+$/), salesCycleId: 'fresh-a',
      requestedAt: new Date('2026-08-31T11:30').toISOString(),
    });
  });

  it.each(['resolve', 'reject'] as const)('does not initiate post-unmount read after mutation %s', async (outcome) => {
    const flight = deferred<MutationReceipt>();
    const source = api({ cancelJob: vi.fn(() => flight.promise) });
    const view = await mount(source); await click('Cancel job-1'); view.unmount();
    await act(async () => {
      if (outcome === 'resolve') flight.resolve(receipt); else flight.reject(new Error('departed'));
    });
    expect(source.getCurrent).toHaveBeenCalledTimes(1);
    expect(source.cancelJob).toHaveBeenCalledTimes(1);
  });
});
