// @vitest-environment jsdom
import { cleanup, fireEvent, render as testingRender, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { discoveryBriefSchema, type DiscoveryApi, type DiscoveryBrief as Brief } from '../../../shared/contracts/discoveryContract';
import { DiscoveryBrief } from './DiscoveryBrief';
const brief = (): Brief => discoveryBriefSchema.parse({
  personId: 'owner', salesCycleId: 'cycle-owner', personName: 'Example Owner', stale: false, latestOverride: null, pilotNextStep: null,
  assessment: { id: '10000000-0000-4000-8000-000000000001', personId: 'owner', prospectId: 'prospect-owner', salesCycleId: 'cycle-owner', fingerprint: 'a'.repeat(64), policyVersion: 'discovery-v1', ruleVersionId: 'rules', modelVersion: null, evaluatedAt: '2026-09-06T12:00:00.000Z', expiresAt: '2026-09-07T12:00:00.000Z', localDate: '2026-09-06', overrideId: null, disposition: 'research', reasonCodes: ['unknown_owner'], axes: { fit: null, timing: { milliPoints: 0, band: 'cold', hasSupportedTrigger: false }, reachability: 'none' }, claims: [{ id: 'fact', label: 'Address', value: '<img src=x onerror=alert(1)>', certainty: 'fact', refs: [{ kind: 'source', sourceEventId: 'source-1', field: 'address', observedAt: '2026-09-05T12:00:00.000Z' }] }, { id: 'inference', label: 'Management', value: null, certainty: 'inference', refs: [] }], unknowns: ['Owner identity is not established'], questions: ['Who handles maintenance?'], identitySupported: false, needsResearch: true, ranking: { priority: null, earliestTriggerExpiresAt: null, dataConfidence: 0, lastContactAt: null, latestSourceObservedAt: null } },
});
const override = () => vi.fn<DiscoveryApi['override']>(async () => ({ revision: 2, affectedPersonIds: ['owner'], affectedSalesCycleIds: ['cycle-owner'] }));
import { PresentationRoot } from '../../app/PresentationRoot';
const render = (ui: Parameters<typeof testingRender>[0], options?: Parameters<typeof testingRender>[1]) => testingRender(ui, { wrapper: PresentationRoot, ...options });
Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });

afterEach(cleanup);
it('shows unknowns, dated literal evidence and questions without inferring zeros or rendering HTML', () => {
  const { container } = render(<DiscoveryBrief brief={brief()} onOverride={override()} />);
  expect(screen.getByText('Fit unknown')).toBeTruthy();
  expect(screen.getByText('No current trigger established')).toBeTruthy();
  expect(screen.getByText(/source-1/)).toBeTruthy(); expect(screen.getByText(/2026-09-05/)).toBeTruthy();
  expect(screen.getByText(/Owner identity is not established/)).toBeTruthy();
  expect(screen.getByText('Who handles maintenance?')).toBeTruthy();
  expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy(); expect(container.querySelector('img')).toBeNull();
});
it('distinguishes Not assessed, supported partial zero, and actual zero from absent facts', () => {
  const value = brief(); const view = render(<DiscoveryBrief brief={{ ...value, assessment: null }} onOverride={override()} />);
  expect(screen.getByText('Not assessed')).toBeTruthy();
  const assessed = value.assessment!; assessed.axes.fit = { points: 0, band: 'low', completeness: 'partial' };
  view.rerender(<DiscoveryBrief brief={value} onOverride={override()} />);
  expect(screen.getByText(/0 supported points/)).toBeTruthy();
});
it.each(['watch', 'exclude', 'reconsider'] as const)('requires a reason and explicitly sends one owner-bound %s override', async decision => {
  const onOverride = override(); render(<DiscoveryBrief brief={brief()} onOverride={onOverride} />);
  fireEvent.click(screen.getByRole('button', { name: 'Adjust discovery' }));
  const submit = screen.getByRole('button', { name: 'Save discovery decision' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  const select = screen.getByRole('combobox', { name: 'Discovery decision' }); select.focus();
  fireEvent.keyDown(select, { key: 'Enter' });
  const label = decision === 'watch' ? 'Watch' : decision === 'exclude' ? 'Exclude' : 'Reconsider';
  fireEvent.click(screen.getByRole('option', { name: label }));
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '  Existing relationship  ' } });
  fireEvent.click(submit); fireEvent.click(submit);
  await waitFor(() => expect(onOverride).toHaveBeenCalledTimes(1));
  expect(onOverride).toHaveBeenCalledWith({ commandId: expect.stringMatching(/^[a-f0-9-]{36}$/), personId: 'owner', assessmentId: '10000000-0000-4000-8000-000000000001', expectedFingerprint: 'a'.repeat(64), decision, reason: 'Existing relationship' });
});
it('keeps prior founder decision visible when evidence has changed and marks the brief stale', () => {
  const value = brief(); value.stale = true; value.latestOverride = { id: '20000000-0000-4000-8000-000000000002', assessmentId: value.assessment!.id, decision: 'watch', reason: 'Existing relationship', createdAt: '2026-09-06T12:00:00.000Z', evidenceChanged: true };
  render(<DiscoveryBrief brief={value} onOverride={override()} />);
  expect(screen.getByText(/Existing relationship/)).toBeTruthy(); expect(screen.getByText(/Revised evidence/)).toBeTruthy();
});

it('supports Enter and Space selection with focus in the override dialog in jsdom', async () => {
  const onOverride = override(); render(<DiscoveryBrief brief={brief()} onOverride={onOverride} />);
  fireEvent.click(screen.getByRole('button', { name: 'Adjust discovery' }));
  expect(document.activeElement).toBe(screen.getByLabelText('Reason'));
  const select = screen.getByRole('combobox', { name: 'Discovery decision' }); select.focus();
  fireEvent.keyDown(select, { key: 'Enter' }); fireEvent.keyDown(select, { key: 'ArrowDown' }); fireEvent.keyDown(select, { key: ' ' });
  expect(document.activeElement).toBe(select);
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Wrong owner context' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save discovery decision' }));
  await waitFor(() => expect(onOverride).toHaveBeenCalledWith(expect.objectContaining({ decision: 'exclude' })));
});

it('traps dialog Tab focus and restores the explicit trigger on Escape', async () => {
  render(<DiscoveryBrief brief={brief()} onOverride={override()} />);
  const trigger = screen.getByRole('button', { name: 'Adjust discovery' }); trigger.focus(); fireEvent.click(trigger);
  const last = screen.getByRole('button', { name: 'Close decision' }); last.focus();
  fireEvent.keyDown(last, { key: 'Tab' });
  expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Discovery decision' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull(); await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it.each(['First line\nSecond line', 'First part\tSecond part'])('explains an invalid reason without changing founder text and accepts a correction: %j', async invalidReason => {
  const onOverride = override(); render(<DiscoveryBrief brief={brief()} onOverride={onOverride} />);
  fireEvent.click(screen.getByRole('button', { name: 'Adjust discovery' }));
  const dialog = screen.getByRole('dialog'); const field = within(dialog).getByRole('textbox', { name: 'Reason' }) as HTMLTextAreaElement;
  const save = within(dialog).getByRole('button', { name: 'Save discovery decision' });
  fireEvent.change(field, { target: { value: invalidReason } });
  save.focus(); fireEvent.click(save);
  expect(onOverride).not.toHaveBeenCalled(); expect(field.value).toBe(invalidReason);
  const feedback = within(dialog).getByRole('alert');
  expect(feedback.textContent).toMatch(/one line.*without control characters/i);
  expect(field.getAttribute('aria-invalid')).toBe('true');
  expect(field.getAttribute('aria-describedby')).toBe(feedback.id); expect(feedback.id).not.toBe('');
  expect(document.activeElement).toBe(field);
  fireEvent.change(field, { target: { value: 'Existing relationship, check next month' } });
  expect(within(dialog).queryByRole('alert')).toBeNull(); expect(field.getAttribute('aria-invalid')).not.toBe('true');
  fireEvent.click(save);
  await screen.findByText(/Discovery decision saved/);
  expect(onOverride).toHaveBeenCalledTimes(1);
  expect(onOverride).toHaveBeenCalledWith(expect.objectContaining({ reason: 'Existing relationship, check next month' }));
  fireEvent.click(screen.getByRole('button', { name: 'Adjust discovery' }));
  expect(within(screen.getByRole('dialog')).queryByRole('alert')).toBeNull();
});

it('uses a native decision frame and ignores repeat and composition Escape', () => {
  render(<DiscoveryBrief brief={brief()} onOverride={override()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Adjust discovery' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.keyDown(dialog, { key: 'Escape', repeat: true });
  expect(screen.getByRole('dialog')).toBe(dialog);
  fireEvent.keyDown(dialog, { key: 'Escape', isComposing: true });
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(dialog.tagName).toBe('DIALOG');
});
