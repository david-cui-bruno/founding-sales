import type { JSX } from 'react';
import { Button } from '../ui/button.tsx';
import { callTimer } from './callText.ts';
import type { CallControl } from './useCall.ts';

/**
 * The call in progress, under the announcement in the dial panel (slice C1): ringing,
 * connected with a timer, mute and hang up; the voicemail script on attempts 1 and 4;
 * a refusal as its sentence. Grey text and dividers, like the rest of the card.
 */
export function CallView({ call }: { readonly call: CallControl }): JSX.Element | null {
  const state = call.state;
  if (state.phase === 'idle') return null;
  if (state.phase === 'refused') {
    return (
      <p data-testid="call-refused" role="alert" className="text-xs text-muted-foreground">
        {state.sentence}
      </p>
    );
  }
  if (state.phase === 'starting') {
    return (
      <div className="flex items-center gap-2">
        <p data-testid="call-status" className="flex-1 text-xs text-muted-foreground">
          Starting the call…
        </p>
        <Button
          variant="outline"
          size="sm"
          data-testid="call-hang-up"
          onClick={() => {
            call.hangUp();
          }}
        >
          Hang up
        </Button>
      </div>
    );
  }
  if (state.phase === 'ended') {
    return (
      <p data-testid="call-status" className="text-xs text-muted-foreground">
        {`Call ended${state.seconds > 0 ? ` · ${callTimer(state.seconds)}` : ''}. Record what happened below.`}
      </p>
    );
  }
  return (
    <div data-testid="call-view" className="flex flex-col gap-2 border-y border-border py-2">
      <div className="flex items-center gap-2">
        <span data-testid="call-status" className="flex-1 text-sm">
          {state.phase === 'ringing' ? 'Ringing…' : `Connected · ${callTimer(call.seconds)}`}
        </span>
        <Button
          variant="outline"
          size="sm"
          data-testid="call-mute"
          aria-pressed={call.muted}
          onClick={() => {
            call.toggleMute();
          }}
        >
          {call.muted ? 'Unmute' : 'Mute'}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          data-testid="call-hang-up"
          onClick={() => {
            call.hangUp();
          }}
        >
          Hang up
        </Button>
      </div>
      {state.voicemailScript === null ? null : (
        <div data-testid="call-voicemail">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">If you reach voicemail</p>
          <p data-testid="call-voicemail-text" className="text-sm text-muted-foreground">
            {state.voicemailScript}
          </p>
        </div>
      )}
    </div>
  );
}
