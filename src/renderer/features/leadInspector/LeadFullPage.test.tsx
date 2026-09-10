// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PresentationRoot } from '../../app/PresentationRoot';
import { LeadFullPage } from './LeadFullPage';
import { LeadInspector } from './LeadInspector';
afterEach(cleanup);
describe('contact loading/error Close', () => {
  for (const Component of [LeadFullPage, LeadInspector]) {
    it(`${Component.name} keeps its frame and Close across pending and failed reads`, () => {
      const onClose = vi.fn();
      const props = { onClose, onRetry: vi.fn(), onOpenFullPage: vi.fn(), onBeginOutbound: vi.fn(), onConfirmTransition: vi.fn(), onDismissLead: vi.fn(), onOverrideCloudScore: vi.fn() };
      const view = render(<PresentationRoot><Component {...props} state={{ status: 'loading' }} /></PresentationRoot>);
      const close = screen.getByRole('button', { name: 'Close inspector' });
      const frame = close.closest('article, aside');
      expect(screen.getByText('Lead details')).toBeTruthy();
      view.rerender(<PresentationRoot><Component {...props} state={{ status: 'error' }} /></PresentationRoot>);
      expect(screen.getByRole('button', { name: 'Close inspector' })).toBe(close);
      expect(close.closest('article, aside')).toBe(frame);
      fireEvent.click(close);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  }
});
