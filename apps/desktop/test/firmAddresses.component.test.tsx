// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import {
  FirmAddresses,
  type FirmAddressPorts,
} from '../src/renderer/firms/FirmAddresses.tsx';
afterEach(cleanup);
const ID = '11111111-1111-4111-8111-111111111111';
it('captures firm evidence for shared addresses without creating a fictional person', async () => {
  let captured = false;
  const ports: FirmAddressPorts = {
    firms: async () => [{ firmId: ID, name: 'Example Firm' }],
    read: async () => ({
      sources: captured
        ? [
            {
              workspaceId: ID,
              sourceId: ID,
              kind: 'selected_note',
              revision: 1,
              contentHash: 'a'.repeat(64),
              locator: 'selected_excerpt',
              speaker: null,
              occurredAt: '2026-09-10T15:00:00.000Z',
              observedAt: '2026-10-08T15:00:00.000Z',
              completeness: 'selected_excerpt',
              availability: 'available',
              excerpt: 'Use the shared office inbox.',
            },
          ]
        : [],
      nextAfterSourceId: null,
    }),
    add: async () => {
      captured = true;
    },
    remove: async () => {},
    restore: async () => {},
    recapture: async () => {},
  };
  const endpoints = {
    list: async () => ({ claims: [], nextAfterId: null }),
    match: async () => ({
      outcome: 'no_supported_match' as const,
      reason: 'no_supported_evidence' as const,
      personId: null,
      firmId: null,
      candidates: [],
    }),
  };
  render(<FirmAddresses enabled ports={ports} endpoints={endpoints} />);
  await userEvent.selectOptions(
    await screen.findByLabelText('Shared-address firm'),
    ID,
  );
  await userEvent.type(
    screen.getByLabelText('Firm note reference'),
    'office-inbox',
  );
  await userEvent.type(
    screen.getByLabelText('Firm selected note'),
    'Use the shared office inbox.',
  );
  fireEvent.change(screen.getByLabelText('Firm note original date'), {
    target: { value: '2026-09-10T11:00' },
  });
  await userEvent.click(
    screen.getByRole('button', { name: 'Save firm evidence' }),
  );
  expect(await screen.findByText('Use the shared office inbox.')).toBeTruthy();
  expect(screen.queryByText('Person name')).toBeNull();
});
