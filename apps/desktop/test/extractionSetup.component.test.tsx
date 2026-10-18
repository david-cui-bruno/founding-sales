// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { CRM_EXTRACTION_ENDPOINT, CRM_EXTRACTION_MODELS, CRM_OWNER_SCOPE_VERSION } from '@fss/contracts';
import { ExtractionSetup } from '../src/renderer/settings/ExtractionSetup.tsx';
import { extractionSetupFields, type ExtractionPurpose, type ExtractionSetupPorts } from '../src/renderer/settings/extractionSetup.ts';

afterEach(cleanup);
const captureBinding={mailboxId:'11111111-1111-4111-8111-111111111111',mailboxEmail:'owner@example.test',ownerApprovalId:'22222222-2222-4222-8222-222222222222'};
const readCaptureBinding=async()=>captureBinding;
const configured: ExtractionPurpose = {
  scopeVersion:CRM_OWNER_SCOPE_VERSION,allowedSourceKinds:['mail'],mailCaptureOwnerApprovalId:captureBinding.ownerApprovalId,
  configured: true, enabled: false, revision: 7,
  endpointId: CRM_EXTRACTION_ENDPOINT, modelVersion: CRM_EXTRACTION_MODELS[0],
  accessGrantVersion: 'reviewed-access-v3', dataHandlingVersion: 'reviewed-handling-v4',
  dailyCeilingCents: 100, monthlyCeilingCents: 2000,
  inputTokenPriceMicros: '1.1', outputTokenPriceMicros: '5.5', unavailableReason: 'activation_not_available',
};
const unconfigured: ExtractionPurpose = {
  scopeVersion:CRM_OWNER_SCOPE_VERSION,
  configured: false, enabled: false, revision: 0, modelVersion: null, endpoint: null,
  dailyCeilingCents: 0, monthlyCeilingCents: 0, unavailableReason: 'purpose_not_configured',
};
const button = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Save disabled extraction configuration' });
const acknowledge = async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('checkbox'));
function mount(read: ExtractionPurpose = configured, save = vi.fn<ExtractionSetupPorts['save']>(async () => ({ revision: 8, enabled: false }))) {
  const onSaved = vi.fn();
  const ports = { readCaptureBinding, read: vi.fn(async () => read), save };
  const view = render(<ExtractionSetup available privacyKey="owner:1" ports={ports} onSaved={onSaved} />);
  return { ...view, ports, onSaved };
}

it('displays exact stored bindings, budgets and fractional prices and only saves disabled', async () => {
  const user = userEvent.setup();
  const { ports, onSaved } = mount({ ...configured, enabled: true });
  await screen.findByDisplayValue('reviewed-access-v3');
  expect(screen.getByText(/Current extraction: enabled; revision 7/)).toBeTruthy();
  for (const [key, label] of extractionSetupFields) expect(screen.getByLabelText<HTMLInputElement>(label).value).toBe(String(configured.configured && configured[key]));
  expect(screen.getByLabelText<HTMLSelectElement>('Endpoint').value).toBe(CRM_EXTRACTION_ENDPOINT);
  expect(screen.getByLabelText<HTMLSelectElement>('Model').value).toBe(CRM_EXTRACTION_MODELS[0]);
  expect(button().disabled).toBe(true);
  await acknowledge(user);
  await user.click(button());
  expect(ports.save).toHaveBeenCalledExactlyOnceWith({
    allowedSourceKinds:['mail'],mailCaptureOwnerApprovalId:captureBinding.ownerApprovalId,
    expectedRevision: 7, enabled: false, endpointId: CRM_EXTRACTION_ENDPOINT,
    modelVersion: CRM_EXTRACTION_MODELS[0], accessGrantVersion: 'reviewed-access-v3',
    dataHandlingVersion: 'reviewed-handling-v4', dailyCeilingCents: 100, monthlyCeilingCents: 2000,
    inputTokenPriceMicros: '1.1', outputTokenPriceMicros: '5.5',
  });
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(await screen.findByRole('status')).toHaveProperty('textContent', expect.stringContaining('No consent or activation was requested'));
  expect(screen.queryByRole('button', { name: /Activate|Enable/ })).toBeNull();
});

it('defaults to no configuration or permission and blocks blank or unsupported proposals', async () => {
  const user = userEvent.setup();
  const { ports } = mount(unconfigured);
  await screen.findByText(/Not configured. No model/);
  expect(screen.getByLabelText<HTMLInputElement>('Access grant version').value).toBe('');
  expect(screen.getByLabelText<HTMLSelectElement>('Model').value).toBe('');
  await acknowledge(user);
  expect(button().disabled).toBe(true);
  expect(ports.save).not.toHaveBeenCalled();
  expect(screen.getByText(/Connecting Gmail is not consent/)).toBeTruthy();
  expect(screen.getByText(/Explicit scoped deletion erases Callie copies/)).toBeTruthy();
  expect(screen.getByText(/Plain keyword and record search remain available/)).toBeTruthy();
});

it('refuses unsupported saved routes and requires renewed review after editing', async () => {
  const user = userEvent.setup();
  const { ports } = mount({ ...configured, endpointId: 'unreviewed-endpoint', modelVersion: 'unreviewed-model' });
  await screen.findByDisplayValue('reviewed-access-v3');
  await acknowledge(user);
  expect(button().disabled).toBe(true);
  await user.selectOptions(screen.getByLabelText('Endpoint'), CRM_EXTRACTION_ENDPOINT);
  await user.selectOptions(screen.getByLabelText('Model'), CRM_EXTRACTION_MODELS[0]);
  expect(screen.getByRole<HTMLInputElement>('checkbox').checked).toBe(false);
  await acknowledge(user);
  expect(button().disabled).toBe(false);
  await user.clear(screen.getByLabelText('Input price (microdollars per token)'));
  await user.type(screen.getByLabelText('Input price (microdollars per token)'), '0');
  await acknowledge(user);
  expect(button().disabled).toBe(true);
  expect(ports.save).not.toHaveBeenCalled();
});

it.each(['purpose_revision_conflict', 'purpose_access_denied', 'private diagnostic body'])('handles %s without retry, stale overwrite or exposing arbitrary errors', async reason => {
  const user = userEvent.setup();
  const { ports, onSaved } = mount(configured, vi.fn(async () => { throw new Error(reason); }));
  await screen.findByDisplayValue('reviewed-access-v3');
  await acknowledge(user);
  await user.click(button());
  await screen.findByRole('status');
  expect(screen.queryByText('private diagnostic body')).toBeNull();
  expect(screen.queryByLabelText('Access grant version')).toBeNull();
  expect(ports.save).toHaveBeenCalledTimes(1);
  expect(onSaved).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Reload extraction configuration' }));
  await screen.findByDisplayValue('reviewed-access-v3');
  expect(button().disabled).toBe(true);
});

it('does not read or save when unavailable', async () => {
  const ports = { readCaptureBinding, read: vi.fn(async () => configured), save: vi.fn<ExtractionSetupPorts['save']>() };
  render(<ExtractionSetup available={false} privacyKey="none" ports={ports} onSaved={vi.fn()} />);
  expect(ports.read).not.toHaveBeenCalled();
  expect(screen.queryByRole('checkbox')).toBeNull();
});

it('drops a pending private read on identity change', async () => {
  let resolve!: (value: ExtractionPurpose) => void;
  const first = new Promise<ExtractionPurpose>(done => { resolve = done; });
  const ports = { readCaptureBinding, read: vi.fn().mockReturnValueOnce(first).mockResolvedValue(unconfigured), save: vi.fn<ExtractionSetupPorts['save']>() };
  const { rerender } = render(<ExtractionSetup available privacyKey="first" ports={ports} onSaved={vi.fn()} />);
  rerender(<ExtractionSetup available privacyKey="second" ports={ports} onSaved={vi.fn()} />);
  await screen.findByText(/Not configured. No model/);
  await act(async () => { resolve(configured); await first; });
  expect(screen.queryByDisplayValue('reviewed-access-v3')).toBeNull();
});

it('drops a pending save after owner availability is lost', async () => {
  const user = userEvent.setup();
  let resolve!: (value: { revision: number; enabled: false }) => void;
  const pending = new Promise<{ revision: number; enabled: false }>(done => { resolve = done; });
  const ports = { readCaptureBinding, read: vi.fn(async () => configured), save: vi.fn(async () => pending) };
  const onSaved = vi.fn();
  const { rerender } = render(<ExtractionSetup available privacyKey="first" ports={ports} onSaved={onSaved} />);
  await screen.findByDisplayValue('reviewed-access-v3');
  await acknowledge(user);
  await user.click(button());
  await waitFor(() => expect(ports.save).toHaveBeenCalledTimes(1));
  rerender(<ExtractionSetup available={false} privacyKey="first" ports={ports} onSaved={onSaved} />);
  await act(async () => { resolve({ revision: 8, enabled: false }); await pending; });
  expect(onSaved).not.toHaveBeenCalled();
  expect(screen.queryByRole('status')).toBeNull();
});
