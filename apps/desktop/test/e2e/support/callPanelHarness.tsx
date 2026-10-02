import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import type { CallControl, CallPhase } from '../../../src/renderer/calling/useCall.ts';
import type { CallingStatus } from '../../../src/renderer/calling/useCallingStatus.ts';
import { DraftsProvider } from '../../../src/renderer/app/drafts.tsx';
import { CallPanel } from '../../../src/renderer/today/CallPanel.tsx';
import { callProgress } from '../../../src/renderer/today/callProgress.ts';
import { buildTodayView } from '../../../src/renderer/todayView.ts';
import type { TodayActions } from '../../../src/renderer/today/useToday.ts';
import { CALLABLE_ADVICE, FIRM_ID, ROUTE_ID, expandedFirm, todayState } from './homeFixtures.ts';

/**
 * The call panel alone, in each phase a real call passes through (slice S2), for the
 * component screenshots of `callPanel.spec.ts`. A live call needs Twilio's Voice SDK and a
 * microphone, which a headless browser has neither of, so the phases are given to the real
 * component as `useCall` would report them. `?phase=connected&voicemail=1`.
 */

const query = new URLSearchParams(location.search);
const phaseName = query.get('phase') ?? 'idle';
const sessionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const phases: Record<string, CallPhase> = {
  idle: { phase: 'idle' },
  ringing: { phase: 'ringing', firmId: FIRM_ID, routeId: ROUTE_ID, sessionId, attempt: 1, voicemailScript: null, answeredAt: null },
  connected: {
    phase: 'connected',
    firmId: FIRM_ID,
    routeId: ROUTE_ID,
    sessionId,
    attempt: 1,
    voicemailScript:
      query.get('voicemail') === '1'
        ? 'Hi Dana, this is David from Callie. I will try you again on Thursday; you can reach me on 617 555 0100.'
        : null,
    answeredAt: Date.now() - 134_000,
  },
  ended: { phase: 'ended', firmId: FIRM_ID, routeId: ROUTE_ID, sessionId, seconds: 252 },
};
const call: CallControl = {
  state: phases[phaseName] ?? { phase: 'idle' },
  muted: false,
  seconds: 134,
  place: () => undefined,
  toggleMute: () => undefined,
  hangUp: () => undefined,
  dismiss: () => undefined,
};
const status: CallingStatus = {
  view: { provider: 'twilio', cadence: { unansweredAttempts: 0, nextAttempt: 1, limit: 4, parked: false, refusal: null } },
  resuming: false,
  reload: () => undefined,
  resume: async () => undefined,
};
const state = todayState({ expanded: expandedFirm(), dialAdvice: [CALLABLE_ADVICE] });
const now = Date.now();
const ended = new Date(now - 60_000).toISOString();
const steps = query.get('steps') ?? 'pending';
const progress = callProgress(
  {
    sessionId,
    firmId: FIRM_ID,
    status: 'completed',
    startedAt: new Date(now - 320_000).toISOString(),
    answeredAt: new Date(now - 312_000).toISOString(),
    endedAt: steps === 'failed' ? new Date(now - 40 * 60_000).toISOString() : ended,
    durationSeconds: 252,
    hasRecording: true,
    callLogId: null,
    hasTranscript: steps === 'done',
    ...(steps === 'done'
      ? { summary: { summary: 'Spoke with Dana.', nextSteps: [], commitments: [], model: 'claude-haiku-4-5', createdAt: ended } }
      : {}),
  },
  now,
);
const actions = { busy: () => false, expand: () => undefined, dial: () => undefined } as unknown as TodayActions;

const container = document.querySelector('#app');
if (container instanceof HTMLElement) {
  container.className = 'callie-v2 flex h-screen';
  createRoot(container).render(
    <QueryClientProvider client={new QueryClient()}>
      <DraftsProvider>
        <div className="flex w-[320px] flex-col border-r border-border">
          <CallPanel
            state={state}
            view={buildTodayView(state)}
            actions={actions}
            call={call}
            status={status}
            firmId={FIRM_ID}
            blockers={[]}
            progress={progress}
            hasNext
            onFix={() => undefined}
            onNext={() => undefined}
            onOutcome={() => undefined}
          />
        </div>
      </DraftsProvider>
    </QueryClientProvider>,
  );
}
