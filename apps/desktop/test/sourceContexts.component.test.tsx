// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import {
  SourceContexts,
  type ContextPorts,
} from '../src/renderer/firms/SourceContexts.tsx';
afterEach(cleanup);
const ID = '11111111-1111-4111-8111-111111111111';
const OLD = '22222222-2222-4222-8222-222222222222';
it('keeps the original conversation firm visible after a relationship correction requires review', async () => {
  const ports: ContextPorts = {
    read: async () => ({
      contexts: [
        {
          contextId: ID,
          sourceId: ID,
          relationshipId: ID,
          relationshipRevision: 1,
          firmId: OLD,
          review: 'required',
        },
      ],
      nextAfterId: null,
    }),
    save: async () => {},
  };
  render(
    <SourceContexts
      personId={ID}
      ports={ports}
      relationships={[]}
      sources={[]}
      firms={[{ firmId: OLD, name: 'Original Example Firm' }]}
      enabled
    />,
  );
  expect(
    await screen.findByText('Recorded context: Original Example Firm'),
  ).toBeTruthy();
  expect(
    screen.getByText(
      'Context needs review; the original firm remains recorded.',
    ),
  ).toBeTruthy();
});
it('explicitly attaches a selected note to an exact relationship revision', async () => {
  const user = userEvent.setup();
  let saved = false;
  const ports: ContextPorts = {
    read: async () => ({ contexts: [], nextAfterId: null }),
    save: async (input) => {
      expect(input.relationshipId).toBe(ID);
      expect(input.relationshipRevision).toBe(2);
      expect(input.evidence.sourceRevision).toBe(3);
      saved = true;
    },
  };
  const sources = [
    {
      workspaceId: ID,
      sourceId: ID,
      kind: 'selected_note' as const,
      revision: 3,
      contentHash: 'a'.repeat(64),
      locator: 'selected_excerpt',
      speaker: null,
      occurredAt: '2026-09-10T15:00:00.000Z',
      observedAt: '2026-10-08T15:00:00.000Z',
      completeness: 'selected_excerpt' as const,
      availability: 'available' as const,
      excerpt: 'This conversation concerns the firm.',
    },
  ];
  const relationships = [
    {
      relationshipId: ID,
      personId: ID,
      firmId: OLD,
      firmName: 'Original Example Firm',
      status: 'current' as const,
      startDate: null,
      endDate: null,
      revision: 2,
      evidence: {
        sourceId: ID,
        sourceRevision: 3,
        contentHash: 'a'.repeat(64),
      },
      sourceState: 'available' as const,
      contextReview: 'current' as const,
    },
  ];
  render(
    <SourceContexts
      personId={ID}
      ports={ports}
      relationships={relationships}
      sources={sources}
      firms={[{ firmId: OLD, name: 'Original Example Firm' }]}
      enabled
    />,
  );
  await user.selectOptions(
    screen.getByLabelText('Conversation supporting note'),
    ID,
  );
  await user.selectOptions(
    screen.getByLabelText('Conversation relationship'),
    ID,
  );
  await user.click(
    screen.getByRole('button', { name: 'Record conversation context' }),
  );
  expect(saved).toBe(true);
});
