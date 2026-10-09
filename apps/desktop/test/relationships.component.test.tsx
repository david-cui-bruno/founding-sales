// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import {
  Relationships,
  type RelationshipPorts,
  type RelationshipEditingPorts,
} from '../src/renderer/firms/Relationships.tsx';
afterEach(cleanup);
const PERSON = '11111111-1111-4111-8111-111111111111';
const FIRST = '22222222-2222-4222-8222-222222222222';
const SECOND = '33333333-3333-4333-8333-333333333333';
it('shows overlapping firm relationships with unknown dates and source provenance rather than choosing one firm', async () => {
  const ports: RelationshipPorts = {
    read: async () => ({
      relationships: [
        {
          relationshipId: FIRST,
          personId: PERSON,
          firmId: FIRST,
          firmName: 'First Example Firm',
          status: 'historical',
          startDate: null,
          endDate: '2026-09-30',
          revision: 1,
          evidence: {
            sourceId: FIRST,
            sourceRevision: 2,
            contentHash: 'a'.repeat(64),
          },
          sourceState: 'available',
          contextReview: 'current',
        },
        {
          relationshipId: SECOND,
          personId: PERSON,
          firmId: SECOND,
          firmName: 'Second Example Firm',
          status: 'current',
          startDate: null,
          endDate: null,
          revision: 1,
          evidence: {
            sourceId: SECOND,
            sourceRevision: 1,
            contentHash: 'b'.repeat(64),
          },
          sourceState: 'unavailable',
          contextReview: 'required',
        },
      ],
      nextAfterId: null,
    }),
  };
  render(<Relationships personId={PERSON} ports={ports} />);
  expect(await screen.findByText('First Example Firm')).toBeTruthy();
  expect(screen.getByText('Second Example Firm')).toBeTruthy();
  expect(screen.getAllByText('Start date unknown')).toHaveLength(2);
  expect(screen.getByText('Source revision 2')).toBeTruthy();
  expect(screen.getByText('Source unavailable')).toBeTruthy();
  expect(screen.getByText('Conversation context needs review')).toBeTruthy();
});
it('adds a supported relationship with unknown dates and explicitly corrects its revision', async () => {
  const user = (await import('@testing-library/user-event')).default.setup();
  let firmId = FIRST;
  let revision = 1;
  let saved = false;
  const ports: RelationshipPorts = {
    read: async () => ({
      relationships: saved
        ? [
            {
              relationshipId: FIRST,
              personId: PERSON,
              firmId,
              firmName:
                firmId === FIRST ? 'First Example Firm' : 'Second Example Firm',
              status: 'current',
              startDate: null,
              endDate: null,
              revision,
              evidence: {
                sourceId: FIRST,
                sourceRevision: 2,
                contentHash: 'a'.repeat(64),
              },
              sourceState: 'available',
              contextReview: 'current',
            },
          ]
        : [],
      nextAfterId: null,
    }),
  };
  const editing: RelationshipEditingPorts = {
    firms: async () => [
      { firmId: FIRST, name: 'First Example Firm' },
      { firmId: SECOND, name: 'Second Example Firm' },
    ],
    save: async (input) => {
      expect(input.startDate).toBeNull();
      expect(input.endDate).toBeNull();
      expect(input.evidence.sourceRevision).toBe(2);
      saved = true;
      firmId = input.firmId;
    },
    correct: async (input) => {
      expect(input.expectedRevision).toBe(1);
      firmId = input.firmId;
      revision++;
    },
  };
  const sources = [
    {
      workspaceId: PERSON,
      sourceId: FIRST,
      kind: 'selected_note' as const,
      revision: 2,
      contentHash: 'a'.repeat(64),
      locator: 'selected_excerpt',
      speaker: null,
      occurredAt: '2026-09-10T15:00:00.000Z',
      observedAt: '2026-10-08T15:00:00.000Z',
      completeness: 'selected_excerpt' as const,
      availability: 'available' as const,
      excerpt: 'Supported association.',
    },
  ];
  render(
    <Relationships
      personId={PERSON}
      ports={ports}
      editing={editing}
      sources={sources}
      enabled
    />,
  );
  await screen.findByRole('option', { name: 'First Example Firm' });
  await user.selectOptions(screen.getByLabelText('Relationship firm'), FIRST);
  await user.selectOptions(screen.getByLabelText('Supporting note'), FIRST);
  await user.click(screen.getByRole('button', { name: 'Save relationship' }));
  await screen.findByRole('heading', { name: 'First Example Firm' });
  await user.click(
    screen.getByRole('button', { name: 'Correct relationship' }),
  );
  await user.selectOptions(screen.getByLabelText('Relationship firm'), SECOND);
  await user.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(
    await screen.findByRole('heading', { name: 'Second Example Firm' }),
  ).toBeTruthy();
});
it('shows a failed correction without presenting stale relationship evidence as current', async () => {
  const user = (await import('@testing-library/user-event')).default.setup();
  const ports: RelationshipPorts = {
    read: async () => ({
      relationships: [
        {
          relationshipId: FIRST,
          personId: PERSON,
          firmId: FIRST,
          firmName: 'First Example Firm',
          status: 'current',
          startDate: null,
          endDate: null,
          revision: 1,
          evidence: {
            sourceId: FIRST,
            sourceRevision: 2,
            contentHash: 'a'.repeat(64),
          },
          sourceState: 'available',
          contextReview: 'current',
        },
      ],
      nextAfterId: null,
    }),
  };
  const editing: RelationshipEditingPorts = {
    firms: async () => [{ firmId: FIRST, name: 'First Example Firm' }],
    save: async () => {},
    correct: async () => {
      throw new Error('relationship_revision_changed');
    },
  };
  const sources = [
    {
      workspaceId: PERSON,
      sourceId: FIRST,
      kind: 'selected_note' as const,
      revision: 2,
      contentHash: 'a'.repeat(64),
      locator: 'selected_excerpt',
      speaker: null,
      occurredAt: '2026-09-10T15:00:00.000Z',
      observedAt: '2026-10-08T15:00:00.000Z',
      completeness: 'selected_excerpt' as const,
      availability: 'available' as const,
      excerpt: 'Supported association.',
    },
  ];
  render(
    <Relationships
      personId={PERSON}
      ports={ports}
      editing={editing}
      sources={sources}
      enabled
    />,
  );
  await user.click(
    await screen.findByRole('button', { name: 'Correct relationship' }),
  );
  await user.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(
    screen.queryByRole('heading', { name: 'First Example Firm' }),
  ).toBeNull();
});
