// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { People, type PeoplePorts } from '../src/renderer/firms/People.tsx';
afterEach(cleanup);
const PERSON = '11111111-1111-4111-8111-111111111111';
it('captures a person with an unknown firm and reads their selected source with its original date', async () => {
  let created = false;
  const ports: PeoplePorts = {
    list: async () => ({
      people: created
        ? [
            {
              personId: PERSON,
              fullName: 'Alex Example',
              firm: null,
              revision: 1,
            },
          ]
        : [],
      nextAfterId: null,
    }),
    create: async () => {
      created = true;
      return { personId: PERSON };
    },
    read: async () => ({
      person: {
        personId: PERSON,
        fullName: 'Alex Example',
        firm: null,
        revision: 1,
      },
      nextAfterSourceId: null,
      sources: [],
    }),
    add: async () => ({ sourceId: '22222222-2222-4222-8222-222222222222' }),
    recapture: async () => {},
    remove: async () => {},
    restore: async () => {},
  };
  render(<People enabled ports={ports} />);
  await userEvent.type(
    await screen.findByLabelText('Person name'),
    'Alex Example',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Add person' }));
  expect(await screen.findByText('Firm unknown')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Alex Example' })).toBeTruthy();
});
it('shows selected evidence and removes its copied excerpt without recovering it on restore', async () => {
  let availability: 'available' | 'deleted' | 'awaiting_recapture' =
    'available';
  let revision = 1;
  const sourceId = '22222222-2222-4222-8222-222222222222';
  const ports: PeoplePorts = {
    list: async () => ({
      people: [
        { personId: PERSON, fullName: 'Alex Example', firm: null, revision: 1 },
      ],
      nextAfterId: null,
    }),
    create: async () => ({ personId: PERSON }),
    read: async () => ({
      person: {
        personId: PERSON,
        fullName: 'Alex Example',
        firm: null,
        revision: 1,
      },
      nextAfterSourceId: null,
      sources: [
        {
          workspaceId: PERSON,
          sourceId,
          kind: 'selected_note',
          revision,
          contentHash: availability === 'available' ? 'a'.repeat(64) : null,
          locator: availability === 'available' ? 'selected_excerpt' : null,
          speaker: null,
          occurredAt:
            availability === 'available' ? '2026-09-10T15:00:00.000Z' : null,
          observedAt: '2026-10-08T15:00:00.000Z',
          completeness:
            availability === 'available' ? 'selected_excerpt' : 'unavailable',
          availability,
          excerpt:
            availability === 'available'
              ? 'Please follow up next month.'
              : null,
        },
      ],
    }),
    add: async () => ({ sourceId }),
    recapture: async () => {},
    remove: async () => {
      availability = 'deleted';
      revision++;
    },
    restore: async () => {
      availability = 'awaiting_recapture';
      revision++;
    },
  };
  render(<People enabled ports={ports} />);
  await userEvent.click(
    await screen.findByRole('button', { name: 'Alex Example' }),
  );
  expect(await screen.findByText('Please follow up next month.')).toBeTruthy();
  expect(screen.getByText(/2026-09-10/)).toBeTruthy();
  await userEvent.click(
    screen.getByRole('button', { name: 'Delete copied note' }),
  );
  await screen.findByRole('button', { name: 'Restore for recapture' });
  expect(screen.queryByText('Please follow up next month.')).toBeNull();
  await userEvent.click(
    screen.getByRole('button', { name: 'Restore for recapture' }),
  );
  expect(
    await screen.findByText('Select the note again to recapture its content.'),
  ).toBeTruthy();
  expect(screen.queryByText('Please follow up next month.')).toBeNull();
});
it('submits only the selected note and original date, then shows the captured evidence', async () => {
  let selected: { excerpt: string; occurredAt: string } | null = null;
  const ports: PeoplePorts = {
    list: async () => ({
      people: [
        { personId: PERSON, fullName: 'Alex Example', firm: null, revision: 1 },
      ],
      nextAfterId: null,
    }),
    create: async () => ({ personId: PERSON }),
    read: async () => ({
      person: {
        personId: PERSON,
        fullName: 'Alex Example',
        firm: null,
        revision: 1,
      },
      nextAfterSourceId: null,
      sources:
        selected === null
          ? []
          : [
              {
                workspaceId: PERSON,
                sourceId: PERSON,
                kind: 'selected_note',
                revision: 1,
                contentHash: 'a'.repeat(64),
                locator: 'selected_excerpt',
                speaker: null,
                occurredAt: selected.occurredAt,
                observedAt: '2026-10-08T15:00:00.000Z',
                completeness: 'selected_excerpt',
                availability: 'available',
                excerpt: selected.excerpt,
              },
            ],
    }),
    add: async (input) => {
      selected = input;
      return { sourceId: PERSON };
    },
    recapture: async () => {},
    remove: async () => {},
    restore: async () => {},
  };
  render(<People enabled ports={ports} />);
  await userEvent.click(
    await screen.findByRole('button', { name: 'Alex Example' }),
  );
  await userEvent.type(
    screen.getByLabelText('Note reference'),
    'call-notes-2026-09-10',
  );
  await userEvent.type(
    screen.getByLabelText('Selected note'),
    'Our team needs scheduling help.',
  );
  const date = screen.getByLabelText('Original date and time');
  // A native datetime-local field accepts an explicit local wall-clock value.
  const { fireEvent } = await import('@testing-library/react');
  fireEvent.change(date, { target: { value: '2026-09-10T11:00' } });
  await userEvent.click(
    screen.getByRole('button', { name: 'Save selected note' }),
  );
  expect(
    await screen.findByText('Our team needs scheduling help.'),
  ).toBeTruthy();
});
it('clears displayed sensitive evidence when a later operation loses access', async () => {
  const ports: PeoplePorts = {
    list: async () => ({
      people: [
        { personId: PERSON, fullName: 'Alex Example', firm: null, revision: 1 },
      ],
      nextAfterId: null,
    }),
    create: async () => ({ personId: PERSON }),
    read: async () => ({
      person: {
        personId: PERSON,
        fullName: 'Alex Example',
        firm: null,
        revision: 1,
      },
      nextAfterSourceId: null,
      sources: [
        {
          workspaceId: PERSON,
          sourceId: PERSON,
          kind: 'selected_note',
          revision: 1,
          contentHash: 'a'.repeat(64),
          locator: 'selected_excerpt',
          speaker: null,
          occurredAt: '2026-09-10T15:00:00.000Z',
          observedAt: '2026-10-08T15:00:00.000Z',
          completeness: 'selected_excerpt',
          availability: 'available',
          excerpt: 'Private selected evidence.',
        },
      ],
    }),
    add: async () => ({ sourceId: PERSON }),
    recapture: async () => {},
    remove: async () => {
      throw new Error('person_access_denied');
    },
    restore: async () => {},
  };
  render(<People enabled ports={ports} />);
  await userEvent.click(
    await screen.findByRole('button', { name: 'Alex Example' }),
  );
  await screen.findByText('Private selected evidence.');
  await userEvent.click(
    screen.getByRole('button', { name: 'Delete copied note' }),
  );
  await screen.findByRole('alert');
  expect(screen.queryByText('Private selected evidence.')).toBeNull();
});
it('recaptures a restored note by its source identity after reopening, without the old reference', async () => {
  let state: 'awaiting_recapture' | 'available' = 'awaiting_recapture';
  let content = '';
  const ports: PeoplePorts = {
    list: async () => ({
      people: [
        { personId: PERSON, fullName: 'Alex Example', firm: null, revision: 1 },
      ],
      nextAfterId: null,
    }),
    create: async () => ({ personId: PERSON }),
    read: async () => ({
      person: {
        personId: PERSON,
        fullName: 'Alex Example',
        firm: null,
        revision: 1,
      },
      nextAfterSourceId: null,
      sources: [
        {
          workspaceId: PERSON,
          sourceId: PERSON,
          kind: 'selected_note',
          revision: 3,
          contentHash: state === 'available' ? 'a'.repeat(64) : null,
          locator: null,
          speaker: null,
          occurredAt: state === 'available' ? '2026-09-10T15:00:00.000Z' : null,
          observedAt: '2026-10-08T15:00:00.000Z',
          completeness:
            state === 'available' ? 'selected_excerpt' : 'unavailable',
          availability: state,
          excerpt: state === 'available' ? content : null,
        },
      ],
    }),
    add: async () => {
      throw new Error('must recapture existing source');
    },
    remove: async () => {},
    restore: async () => {},
    recapture: async (input) => {
      expect(input.sourceId).toBe(PERSON);
      expect(input.expectedRevision).toBe(3);
      state = 'available';
      content = input.excerpt;
    },
  };
  render(<People enabled ports={ports} />);
  await userEvent.click(
    await screen.findByRole('button', { name: 'Alex Example' }),
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Recapture this note' }),
  );
  await userEvent.type(
    screen.getByLabelText('Selected note'),
    'Recaptured selected evidence.',
  );
  const { fireEvent } = await import('@testing-library/react');
  fireEvent.change(screen.getByLabelText('Original date and time'), {
    target: { value: '2026-09-10T11:00' },
  });
  await userEvent.click(
    screen.getByRole('button', { name: 'Save recaptured note' }),
  );
  expect(await screen.findByText('Recaptured selected evidence.')).toBeTruthy();
});
it('does not retain an earlier page excerpt when continuing after that source was deleted', async () => {
  const ports: PeoplePorts = {
    list: async () => ({
      people: [
        { personId: PERSON, fullName: 'Alex Example', firm: null, revision: 1 },
      ],
      nextAfterId: null,
    }),
    create: async () => ({ personId: PERSON }),
    read: async (_id, after) => ({
      person: {
        personId: PERSON,
        fullName: 'Alex Example',
        firm: null,
        revision: 1,
      },
      nextAfterSourceId: after === undefined ? PERSON : null,
      sources:
        after === undefined
          ? [
              {
                workspaceId: PERSON,
                sourceId: PERSON,
                kind: 'selected_note',
                revision: 1,
                contentHash: 'a'.repeat(64),
                locator: 'selected_excerpt',
                speaker: null,
                occurredAt: '2026-09-10T15:00:00.000Z',
                observedAt: '2026-10-08T15:00:00.000Z',
                completeness: 'selected_excerpt',
                availability: 'available',
                excerpt: 'Deleted while moving between pages.',
              },
            ]
          : [],
    }),
    add: async () => ({ sourceId: PERSON }),
    remove: async () => {},
    restore: async () => {},
    recapture: async () => {},
  };
  render(<People enabled ports={ports} />);
  await userEvent.click(
    await screen.findByRole('button', { name: 'Alex Example' }),
  );
  await screen.findByText('Deleted while moving between pages.');
  await userEvent.click(screen.getByRole('button', { name: 'More notes' }));
  expect(screen.queryByText('Deleted while moving between pages.')).toBeNull();
});
