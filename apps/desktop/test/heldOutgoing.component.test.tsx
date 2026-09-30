// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { HeldOutgoingMessage } from '@fss/contracts';
import { HeldOutgoing } from '../src/renderer/firms/FirmPage.tsx';
import type { ResolveOutgoingRequest } from '../src/renderer/firmWorkspaceContract.ts';

/**
 * Your own e-mails waiting for a firm (send-path v2, S1 review P1-C).
 *
 * A direct Gmail send matched to more than one firm is held until a person names the
 * firm. Before this section the only way to name it was a reply card, which an outgoing
 * message never has. No real person or firm: `example.test` names are invented.
 */

afterEach(cleanup);

const MESSAGE: HeldOutgoingMessage = {
  messageId: '44444444-4444-4444-8444-444444444444',
  internalDate: '2026-09-29T14:00:00.000Z',
  candidates: [
    { opportunityId: '55555555-5555-4555-8555-555555555555', firmId: '11111111-1111-4111-8111-111111111111', firmName: 'Northwind Test Holdings' },
    { opportunityId: '66666666-6666-4666-8666-666666666666', firmId: '77777777-7777-4777-8777-777777777777', firmName: 'Southwind Test Partners' },
  ],
};

function draw(input: {
  readonly messages: readonly HeldOutgoingMessage[];
  readonly notice: string | null;
  readonly asked?: ResolveOutgoingRequest[];
}): void {
  render(
    <HeldOutgoing
      messages={input.messages}
      notice={input.notice}
      actionsEnabled
      busy={() => false}
      onResolve={request => input.asked?.push(request)}
    />,
  );
}

describe('the held outgoing messages on a firm page', () => {
  it('lists each held message with one action per candidate firm, which sends the resolve command', () => {
    const asked: ResolveOutgoingRequest[] = [];
    draw({ messages: [MESSAGE], notice: null, asked });
    expect(screen.getAllByTestId('held-outgoing-row')).toHaveLength(1);
    const choices = screen.getAllByTestId('held-outgoing-choose');
    expect(choices.map(choice => choice.textContent)).toEqual(['Northwind Test Holdings', 'Southwind Test Partners']);
    fireEvent.click(choices[1] as HTMLElement);
    expect(asked).toEqual([{ messageId: MESSAGE.messageId, opportunityId: MESSAGE.candidates[1]?.opportunityId }]);
  });

  it('says so when somebody already chose the firm, even after the list has emptied', () => {
    draw({ messages: [], notice: 'already_resolved' });
    expect(screen.getByTestId('held-outgoing-notice').textContent).toBe(
      'Somebody already chose the firm for that message.',
    );
  });

  it('shows another refusal in words, never as its code', () => {
    draw({ messages: [MESSAGE], notice: 'match_unknown' });
    const said = screen.getByTestId('held-outgoing-notice').textContent ?? '';
    expect(said).not.toContain('match_unknown');
    expect(said.length).toBeGreaterThan(0);
  });

  it('says exactly why a resolution was refused: already applied, or not this person’s firm', () => {
    draw({ messages: [MESSAGE], notice: 'already_applied' });
    expect(screen.getByTestId('held-outgoing-notice').textContent).toBe(
      'That e-mail was already recorded against another firm.',
    );
    cleanup();
    draw({ messages: [MESSAGE], notice: 'not_assigned' });
    expect(screen.getByTestId('held-outgoing-notice').textContent).toBe(
      'This firm is assigned to somebody else, so it cannot be changed here.',
    );
  });

  it('is absent when nothing is held and nothing was said about one', () => {
    draw({ messages: [], notice: 'saved' });
    expect(screen.queryByTestId('held-outgoing')).toBeNull();
  });
});
