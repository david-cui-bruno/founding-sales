// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutboundComposer } from './OutboundComposer';

afterEach(cleanup);
describe('OutboundComposer', () => {
  it.each(['text', 'email'] as const)('edits unsent %s in memory and discards on close', (channel) => {
    const close = vi.fn();
    const { unmount } = render(<OutboundComposer channel={channel} recipientLabel="Fixture recipient" onClose={close} />);
    expect(screen.getByText('Fixture recipient')).toBeTruthy();
    const body = screen.getByLabelText('Message') as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: 'Draft, not sent.' } });
    expect(body.value).toBe('Draft, not sent.');
    if (channel === 'email') {
      fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Local subject' } });
      expect((screen.getByLabelText('Subject') as HTMLInputElement).value).toBe('Local subject');
    }
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(channel === 'text' ? 'Messages sending not yet enabled.' : 'Gmail not connected.')).toBeTruthy();
    expect(window.localStorage.length).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Close draft' }));
    expect(close).toHaveBeenCalledTimes(1);
    unmount();
    render(<OutboundComposer channel={channel} recipientLabel="Fixture recipient" onClose={close} />);
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('');
  });
});
