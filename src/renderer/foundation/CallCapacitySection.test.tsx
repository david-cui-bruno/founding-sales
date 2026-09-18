// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallCapacitySection } from './CallCapacitySection';
import type { MeetingFirstAccountCallSettings, UpdateCallSettingsRequest } from '../../shared/contracts/localWorkspaceContract';
const initial: MeetingFirstAccountCallSettings = { newCallSlots: null, totalCallCapacity: null, revision: 0, updatedAt: '2026-09-11T12:00:00.000Z' };
const reply = (input: UpdateCallSettingsRequest) => ({ newCallSlots: input.newCallSlots, totalCallCapacity: input.totalCallCapacity, revision: input.expectedRevision + 1, updatedAt: initial.updatedAt });
function fixture() { return { getCallSettings: vi.fn(async () => initial), updateCallSettings: vi.fn(async (input: UpdateCallSettingsRequest) => reply(input)) }; }
function number(label: string, text: string) {
  fireEvent.change(screen.getByLabelText(`${label} configuration`), { target: { value: 'number' } });
  fireEvent.change(screen.getByLabelText(label), { target: { value: text } });
}
const save = () => screen.getByRole('button', { name: 'Save call capacity' });
async function ready() { await waitFor(() => expect((save() as HTMLButtonElement).disabled).toBe(false)); }
afterEach(cleanup);
describe('Call capacity editor', () => {
  it('reads only, distinguishes empty, zero and independently nullable values, then notifies once', async () => {
    const api = fixture(); const onSaved = vi.fn(); render(<CallCapacitySection api={api} onSaved={onSaved} />); await ready();
    expect(api.updateCallSettings).not.toHaveBeenCalled(); expect(onSaved).not.toHaveBeenCalled();
    number('New call slots', ''); fireEvent.click(save());
    expect(screen.getByRole('status').textContent).toContain('nonnegative safe whole number'); expect(api.updateCallSettings).not.toHaveBeenCalled();
    number('New call slots', '0'); fireEvent.click(save());
    await screen.findByText('Call capacity saved.');
    expect(api.updateCallSettings).toHaveBeenLastCalledWith({ expectedRevision: 0, newCallSlots: 0, totalCallCapacity: null }); expect(onSaved).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('New call slots configuration'), { target: { value: 'none' } }); number('Total call capacity', '0'); fireEvent.click(save());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    expect(api.updateCallSettings).toHaveBeenLastCalledWith({ expectedRevision: 1, newCallSlots: null, totalCallCapacity: 0 });
  });
  it('keeps a lost response unknown even when readback matches, retains edits and requires deliberate review', async () => {
    const api = fixture(); const onSaved = vi.fn();
    api.updateCallSettings.mockImplementationOnce(async input => { api.getCallSettings.mockResolvedValue(reply(input)); throw Error('private database path'); });
    render(<CallCapacitySection api={api} onSaved={onSaved} />); await ready(); number('New call slots', '4'); fireEvent.click(save());
    await screen.findByText(/Current stored settings \(revision 1\)/);
    expect(screen.getByRole('status').textContent).toContain('Save outcome unknown'); expect(screen.queryByText(/private database/)).toBeNull();
    expect((screen.getByLabelText('New call slots') as HTMLInputElement).value).toBe('4');
    fireEvent.click(save()); expect(api.updateCallSettings).toHaveBeenCalledTimes(1); expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'I reviewed current settings' })); expect(api.updateCallSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(save()); await screen.findByText('Call capacity saved.');
    expect(api.updateCallSettings).toHaveBeenLastCalledWith({ expectedRevision: 1, newCallSlots: 4, totalCallCapacity: null }); expect(onSaved).toHaveBeenCalledTimes(1);
  });
  it('fences duplicate submits and ignores an old completion after API replacement', async () => {
    const api = fixture(); const onSaved = vi.fn(); let finish!: (result: MeetingFirstAccountCallSettings) => void;
    api.updateCallSettings.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<CallCapacitySection api={api} onSaved={onSaved} />); await ready(); number('Total call capacity', '2');
    act(() => { fireEvent.submit(save().closest('form')!); fireEvent.submit(save().closest('form')!); });
    expect(api.updateCallSettings).toHaveBeenCalledTimes(1);
    const replacement = fixture(); view.rerender(<CallCapacitySection api={replacement} onSaved={onSaved} />); await ready();
    await act(async () => finish({ ...initial, totalCallCapacity: 2, revision: 1 }));
    expect(onSaved).not.toHaveBeenCalled(); expect(screen.queryByText('Call capacity saved.')).toBeNull();
  });
  it('does not reinterpret callback failure as a failed write', async () => {
    const api = fixture(); const onSaved = vi.fn(() => { throw Error('listener'); }); render(<CallCapacitySection api={api} onSaved={onSaved} />); await ready();
    fireEvent.click(save()); await screen.findByText('Call capacity saved.'); expect(onSaved).toHaveBeenCalledTimes(1); expect(api.getCallSettings).toHaveBeenCalledTimes(1);
  });
  it('refuses malformed replies and failed readback without claiming saved or retrying', async () => {
    const api = fixture(); const onSaved = vi.fn(); render(<CallCapacitySection api={api} onSaved={onSaved} />); await ready();
    api.updateCallSettings.mockResolvedValueOnce({ ...initial, revision: 7 }); api.getCallSettings.mockRejectedValueOnce(Error('private read'));
    fireEvent.click(save()); await waitFor(() => expect(api.getCallSettings).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('status').textContent).toContain('Save outcome unknown'); expect(onSaved).not.toHaveBeenCalled(); expect(api.updateCallSettings).toHaveBeenCalledTimes(1);
  });
  it('names the default of 30 new firms a day while unconfigured and the configured number once saved', async () => {
    const api = fixture(); render(<CallCapacitySection api={api} onSaved={vi.fn()} />); await ready();
    expect(screen.getByText(/Not configured means the default: 30 new firms a day\./)).toBeTruthy();
    expect(screen.getByTestId('effective-allocation').textContent).toBe('Today lists 30 new firms a day (default: 30 new firms a day). Set a number to change it.');
    number('New call slots', '1'); fireEvent.click(save());
    await screen.findByText('Call capacity saved.');
    expect(screen.getByTestId('effective-allocation').textContent).toBe('Today lists 1 new firm a day (configured).');
  });
  it('shows missing and malformed initial API data as unavailable', async () => {
    const view = render(<CallCapacitySection onSaved={vi.fn()} />); expect(screen.getByRole('status').textContent).toContain('unavailable');
    const api = fixture(); api.getCallSettings.mockResolvedValueOnce({ ...initial, updatedAt: 'yesterday' });
    view.rerender(<CallCapacitySection api={api} onSaved={vi.fn()} />); await screen.findByText('Call capacity is unavailable.'); expect((save() as HTMLButtonElement).disabled).toBe(true);
  });
});
