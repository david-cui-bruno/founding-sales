// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type JSX } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { PreparedBriefDto } from '@fss/contracts';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { PreparedBrief, type ClearBrief, type SetBrief } from '../src/renderer/research/PreparedBrief.tsx';

/**
 * Lane PB: the prepared brief on the firm page and the Today card — the label, the
 * https-only links, the fold — and its editor under the kept-state rules K1–K7.
 */

const FIRM = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const BRIEF: PreparedBriefDto = {
  brief: 'Who to ask for: Pat Placeholder, Owner (confirmed)\nSoftware: appfolio\nDoors: 300',
  sources: [
    { url: 'https://firm.example.test/contact', label: 'Phone source' },
    { url: 'http://legacy.example.test/', label: 'Old page' },
  ],
  observedOn: '2026-10-02',
  preparedBy: 'Callie research agent (web), verified phones',
  updatedAt: '2026-10-02T15:00:00.000Z',
};

afterEach(() => {
  cleanup();
});

/** A deferred answer the test settles by hand, for the late-answer cases. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

function Harness({
  brief,
  canEdit = true,
  setBrief,
  clearBrief,
  firmId = FIRM,
  shown = true,
}: {
  readonly brief: PreparedBriefDto | null | undefined;
  readonly canEdit?: boolean;
  readonly setBrief?: SetBrief;
  readonly clearBrief?: ClearBrief;
  readonly firmId?: string;
  readonly shown?: boolean;
}): JSX.Element {
  return shown ? (
    <PreparedBrief
      firmId={firmId}
      brief={brief}
      canEdit={canEdit}
      enabled
      onChanged={() => undefined}
      {...(setBrief === undefined ? {} : { setBrief })}
      {...(clearBrief === undefined ? {} : { clearBrief })}
    />
  ) : (
    <p>elsewhere</p>
  );
}

describe('the prepared brief, shown', () => {
  it('says it is prepared research Callie did not verify, and links https sources only', () => {
    render(
      <DraftsProvider>
        <Harness brief={BRIEF} canEdit={false} />
      </DraftsProvider>,
    );
    expect(screen.getByTestId('prepared-brief-provenance').textContent).toBe('Prepared research · observed 2 Oct 2026 · not verified by Callie');
    expect(screen.getByTestId('prepared-brief-text').textContent).toBe(BRIEF.brief);
    const links = screen.getAllByTestId('prepared-brief-source');
    expect(links.map(link => link.getAttribute('href'))).toEqual(['https://firm.example.test/contact']);
    expect(links[0]?.getAttribute('target')).toBe('_blank');
    expect(screen.getByTestId('prepared-brief-source-unlinked').textContent).toBe('Old page');
    // A salesperson reads it and is offered nothing to change.
    expect(screen.queryByTestId('prepared-brief-edit')).toBeNull();
    expect(screen.queryByTestId('prepared-brief-clear')).toBeNull();
  });

  it('folds a long brief behind Show more, and draws nothing for a firm with none or an older API', async () => {
    const user = userEvent.setup();
    const long = { ...BRIEF, brief: Array.from({ length: 9 }, (_, i) => `Line ${String(i + 1)}`).join('\n') };
    const { rerender } = render(
      <DraftsProvider>
        <Harness brief={long} />
      </DraftsProvider>,
    );
    expect(screen.getByTestId('prepared-brief-text').className).toContain('line-clamp-6');
    await user.click(screen.getByTestId('prepared-brief-more'));
    expect(screen.getByTestId('prepared-brief-text').className).not.toContain('line-clamp-6');
    expect(screen.getByTestId('prepared-brief-more').textContent).toBe('Show less');
    rerender(
      <DraftsProvider>
        <Harness brief={null} />
      </DraftsProvider>,
    );
    expect(screen.queryByTestId('prepared-brief')).toBeNull();
    rerender(
      <DraftsProvider>
        <Harness brief={undefined} />
      </DraftsProvider>,
    );
    expect(screen.queryByTestId('prepared-brief')).toBeNull();
  });
});

describe('the prepared brief editor, under K1–K7', () => {
  it('K1: keeps the draft and the open editor across a remount, keyed by firm, and a new session starts empty', async () => {
    const user = userEvent.setup();
    function Shell({ session, shown, firmId }: { readonly session: number; readonly shown: boolean; readonly firmId: string }): JSX.Element {
      return (
        <DraftsProvider key={session}>
          <Harness brief={BRIEF} shown={shown} firmId={firmId} />
        </DraftsProvider>
      );
    }
    const { rerender } = render(<Shell session={1} shown firmId={FIRM} />);
    await user.click(screen.getByTestId('prepared-brief-edit'));
    await user.clear(screen.getByTestId('prepared-brief-text-input'));
    await user.type(screen.getByTestId('prepared-brief-text-input'), 'My draft');
    rerender(<Shell session={1} shown={false} firmId={FIRM} />);
    rerender(<Shell session={1} shown firmId={FIRM} />);
    expect((screen.getByTestId('prepared-brief-text-input') as HTMLTextAreaElement).value).toBe('My draft');
    // Another firm has its own (no) draft.
    rerender(<Shell session={1} shown firmId={OTHER} />);
    expect(screen.queryByTestId('prepared-brief-editor')).toBeNull();
    // Signing out and in again is a new session: nothing kept.
    rerender(<Shell session={2} shown firmId={FIRM} />);
    expect(screen.queryByTestId('prepared-brief-editor')).toBeNull();
  });

  it('Escape and a second press of Edit close the editor and keep the draft', async () => {
    const user = userEvent.setup();
    render(
      <DraftsProvider>
        <Harness brief={BRIEF} />
      </DraftsProvider>,
    );
    await user.click(screen.getByTestId('prepared-brief-edit'));
    await user.type(screen.getByTestId('prepared-brief-text-input'), ' more');
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('prepared-brief-editor')).toBeNull();
    await user.click(screen.getByTestId('prepared-brief-edit'));
    expect((screen.getByTestId('prepared-brief-text-input') as HTMLTextAreaElement).value).toBe(`${BRIEF.brief} more`);
    await user.click(screen.getByTestId('prepared-brief-edit'));
    expect(screen.queryByTestId('prepared-brief-editor')).toBeNull();
  });

  it('K2: Save sends only the brief, and only when it changed', async () => {
    const user = userEvent.setup();
    const sent: unknown[] = [];
    const setBrief: SetBrief = async input => {
      sent.push(input);
      return await Promise.resolve({ saved: { firmId: FIRM, created: false, briefLength: 5, sourceCount: 2, updatedAt: BRIEF.updatedAt }, reason: null });
    };
    render(
      <DraftsProvider>
        <Harness brief={BRIEF} setBrief={setBrief} />
      </DraftsProvider>,
    );
    await user.click(screen.getByTestId('prepared-brief-edit'));
    // Untouched: nothing to send.
    expect((screen.getByTestId('prepared-brief-save') as HTMLButtonElement).disabled).toBe(true);
    await user.clear(screen.getByTestId('prepared-brief-text-input'));
    await user.type(screen.getByTestId('prepared-brief-text-input'), 'Edited');
    await user.click(screen.getByTestId('prepared-brief-save'));
    await waitFor(() => expect(screen.getByTestId('prepared-brief-feedback').textContent).toBe('Saved.'));
    expect(sent).toEqual([{ firmId: FIRM, brief: 'Edited' }]);
    // K5: closed on success, and the draft is gone.
    expect(screen.queryByTestId('prepared-brief-editor')).toBeNull();
  });

  it('K2: when the server text moved since the edit began, the edit is dropped and nothing is sent', async () => {
    const user = userEvent.setup();
    const sent: unknown[] = [];
    const setBrief: SetBrief = async input => {
      sent.push(input);
      return await Promise.resolve({ saved: null, reason: 'invalid_input' });
    };
    const { rerender } = render(
      <DraftsProvider>
        <Harness brief={BRIEF} setBrief={setBrief} />
      </DraftsProvider>,
    );
    await user.click(screen.getByTestId('prepared-brief-edit'));
    await user.type(screen.getByTestId('prepared-brief-text-input'), ' stale edit');
    rerender(
      <DraftsProvider>
        <Harness brief={{ ...BRIEF, brief: 'Somebody else changed it.' }} setBrief={setBrief} />
      </DraftsProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('prepared-brief-feedback').textContent).toContain('Changed elsewhere'));
    expect(screen.queryByTestId('prepared-brief-editor')).toBeNull();
    expect(screen.getByTestId('prepared-brief-text').textContent).toBe('Somebody else changed it.');
    // Reopening starts from the current text, not the stale draft.
    await user.click(screen.getByTestId('prepared-brief-edit'));
    expect((screen.getByTestId('prepared-brief-text-input') as HTMLTextAreaElement).value).toBe('Somebody else changed it.');
    expect(sent).toEqual([]);
  });

  it('K5: a refusal keeps the editor open with the draft and says why beside it', async () => {
    const user = userEvent.setup();
    const setBrief: SetBrief = async () => await Promise.resolve({ saved: null, reason: 'not_assigned' });
    render(
      <DraftsProvider>
        <Harness brief={BRIEF} setBrief={setBrief} />
      </DraftsProvider>,
    );
    await user.click(screen.getByTestId('prepared-brief-edit'));
    await user.clear(screen.getByTestId('prepared-brief-text-input'));
    await user.type(screen.getByTestId('prepared-brief-text-input'), 'Refused edit');
    await user.click(screen.getByTestId('prepared-brief-save'));
    await waitFor(() => expect(screen.getByTestId('prepared-brief-feedback').textContent).not.toBe(''));
    expect(screen.getByTestId('prepared-brief-feedback').textContent).not.toContain('not_assigned');
    expect((screen.getByTestId('prepared-brief-text-input') as HTMLTextAreaElement).value).toBe('Refused edit');
  });

  it('K3: a late answer updates the feedback only; it never reopens an editor David closed', async () => {
    const user = userEvent.setup();
    const answer = deferred<{ saved: null; reason: string }>();
    const setBrief: SetBrief = async () => await answer.promise;
    function Shell({ shown }: { readonly shown: boolean }): JSX.Element {
      return (
        <DraftsProvider>
          <Toggle shown={shown} setBrief={setBrief} />
        </DraftsProvider>
      );
    }
    function Toggle({ shown, setBrief: send }: { readonly shown: boolean; readonly setBrief: SetBrief }): JSX.Element {
      const [, force] = useState(0);
      return (
        <>
          <button type="button" onClick={() => force(n => n + 1)}>
            tick
          </button>
          <Harness brief={BRIEF} setBrief={send} shown={shown} />
        </>
      );
    }
    const { rerender } = render(<Shell shown />);
    await user.click(screen.getByTestId('prepared-brief-edit'));
    await user.type(screen.getByTestId('prepared-brief-text-input'), ' late');
    await user.click(screen.getByTestId('prepared-brief-save'));
    // David closes the editor and leaves while the save is in flight.
    await user.click(screen.getByTestId('prepared-brief-close'));
    rerender(<Shell shown={false} />);
    answer.resolve({ saved: null, reason: 'not_assigned' });
    await Promise.resolve();
    rerender(<Shell shown />);
    await waitFor(() => expect(screen.getByTestId('prepared-brief-feedback').textContent).not.toBe(''));
    expect(screen.queryByTestId('prepared-brief-editor')).toBeNull();
  });

  it('Clear asks once more, then clears', async () => {
    const user = userEvent.setup();
    const cleared: unknown[] = [];
    const clearBrief: ClearBrief = async input => {
      cleared.push(input);
      return await Promise.resolve({ cleared: true, reason: null });
    };
    render(
      <DraftsProvider>
        <Harness brief={BRIEF} clearBrief={clearBrief} />
      </DraftsProvider>,
    );
    await user.click(screen.getByTestId('prepared-brief-clear'));
    expect(cleared).toEqual([]);
    await user.click(screen.getByTestId('prepared-brief-clear-confirm'));
    await waitFor(() => expect(cleared).toEqual([{ firmId: FIRM }]));
  });
});
