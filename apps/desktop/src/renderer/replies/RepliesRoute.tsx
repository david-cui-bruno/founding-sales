import { useEffect, type JSX, type RefObject } from 'react';
import { holdInert } from '../busy.ts';
import { RepliesView } from './RepliesView.tsx';
import { useReplies } from './useReplies.ts';

/**
 * The Replies route: the hook and the view, in one component so that leaving the route
 * unmounts both and the reply content goes with them.
 */
export function RepliesRoute({ column }: { readonly column: RefObject<HTMLElement | null> }): JSX.Element | null {
  const replies = useReplies();
  const pending = replies.pending;

  useEffect(() => {
    // Read-only while a call is on the wire, so a second press of Confirm sends nothing.
    const element = column.current;
    if (element !== null) holdInert(element, 'reply-command', pending > 0);
  }, [column, pending]);

  return <RepliesView replies={replies} />;
}
