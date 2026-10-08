import type { JSX, RefObject } from 'react';
import { RepliesView } from './RepliesView.tsx';
import { useReplies } from './useReplies.ts';

/**
 * The Replies route: the hook and the view, in one component so that leaving the route
 * unmounts both and the reply content goes with them.
 *
 * It takes the column and does nothing to it (1.0.13, P1-4). Until the review this view
 * made the whole column `inert` while any call was on the wire — so confirming one reply
 * froze every other card, Refresh and the sidebar, and leaving the route mid-call had to
 * be remembered to release the hold. What waits now is the card whose button was pressed:
 * `replies.busy(messageId)` in `RepliesView`, released by the same call that took it.
 */
export function RepliesRoute({ column: _column, messageId }: { readonly column: RefObject<HTMLElement | null>; readonly messageId?: string }): JSX.Element | null {
  const replies = useReplies(messageId);
  return <RepliesView replies={replies} />;
}
