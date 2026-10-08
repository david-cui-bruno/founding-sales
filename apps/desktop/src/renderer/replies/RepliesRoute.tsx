import {ReplyComposer,type ReplyComposerPorts} from './ReplyComposer.tsx';
import {operations} from '../app/bridges.ts';
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
const composerPorts:ReplyComposerPorts={
 context:async input=>{const api=operations();return api?await api.read('replyComposer.context',input):{ok:false,reason:'unavailable'};},
 prepareSuggestion:async input=>{const api=operations();return api?await api.command('replyComposer.generate',input):{ok:false,reason:'unavailable'};},
 preview:async input=>{const api=operations();return api?await api.read('replyComposer.preview',input):{ok:false,reason:'unavailable'};},
 sendStatus:async input=>{const api=operations();return api?await api.read('replyComposer.sendStatus',input):{ok:false,reason:'unavailable'};},
 send:async input=>{const api=operations();return api?await api.command('replyComposer.send',input):{ok:false,reason:'unavailable'};},
};
export function RepliesRoute({ column: _column, messageId }: { readonly column: RefObject<HTMLElement | null>; readonly messageId?: string }): JSX.Element | null {
  const replies = useReplies(messageId);
  return <RepliesView replies={replies} composer={(id,enabled)=><ReplyComposer key={id} messageId={id} ports={composerPorts} enabled={enabled}/>}/>;
}
