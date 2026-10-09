// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { DealChoices, type DealChoice } from '../src/renderer/firms/DealChoices.tsx';
afterEach(cleanup);
it('asks for an explicit deal selection and creates only a named human initiative', async () => {
  const selected: string[] = [],
    created: string[] = [];
  const entries: DealChoice[] = [
    {
      opportunity: { id: '11111111-1111-4111-8111-111111111111', openedAt: '2026-10-09T10:00:00Z', status: 'open' },
      displayName: 'Portfolio pilot',
    },
    {
      opportunity: { id: '22222222-2222-4222-8222-222222222222', openedAt: '2026-10-09T11:00:00Z', status: 'open' },
      displayName: 'Second portfolio',
    },
  ];
  render(
    <DealChoices
      firmId="33333333-3333-4333-8333-333333333333"
      entries={entries}
      selectedId={null}
      enabled
      ports={{
        create: async (input) => {
          created.push(input.name ?? '');
          return { opportunityId: '44444444-4444-4444-8444-444444444444' };
        },
        reopen: async () => {
          throw new Error('unexpected reopen');
        },
      }}
      onSelect={(id) => {
        selected.push(id);
      }}
    />,
  );
  expect(selected).toEqual([]);
  await userEvent.selectOptions(screen.getByLabelText('Selected deal'), entries[1]!.opportunity.id);
  expect(selected).toEqual([entries[1]!.opportunity.id]);
  await userEvent.type(screen.getByLabelText('New deal name'), 'New building pilot');
  await userEvent.click(screen.getByRole('button', { name: 'Create independent deal' }));
  expect(created).toEqual(['New building pilot']);
  expect(selected).toContain('44444444-4444-4444-8444-444444444444');
});

it('does not select a former firm after a pending create resolves following navigation', async () => {
  let finish: (value: { opportunityId: string }) => void = () => {};
  const selected: string[] = [];
  const rendered = render(
    <DealChoices
      firmId="33333333-3333-4333-8333-333333333333"
      entries={[]}
      selectedId={null}
      enabled
      ports={{
        create: () =>
          new Promise((done) => {
            finish = done;
          }),
        reopen: async () => {
          throw Error('unexpected');
        },
      }}
      onSelect={(id) => selected.push(id)}
    />,
  );
  await userEvent.type(screen.getByLabelText('New deal name'), 'First firm deal');
  await userEvent.click(screen.getByRole('button', { name: 'Create independent deal' }));
  rendered.unmount();
  finish({ opportunityId: '44444444-4444-4444-8444-444444444444' });
  await Promise.resolve();
  expect(selected).toEqual([]);
});
