// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CALL_ANNOUNCEMENT, reasonSentence, type CallSessionDto } from '@fss/contracts';
import { DialPanel } from '../src/renderer/today/Lanes.tsx';
import { useCall, type CallPorts } from '../src/renderer/calling/useCall.ts';
import type { CallingStatus } from '../src/renderer/calling/useCallingStatus.ts';
import type { VoiceCall, VoiceCallEvent, VoiceDeviceFactory } from '../src/renderer/calling/voiceDevice.ts';
import { MICROPHONE_DENIED_SENTENCE } from '../src/renderer/calling/callText.ts';
import { CallHistory } from '../src/renderer/calling/CallHistory.tsx';
import type { CallingView, CallStart } from '../src/shared/operations.ts';
import type { TodayState } from '../src/renderer/todayContract.ts';
import type { TodayActions } from '../src/renderer/today/useToday.ts';
import type { TodayScreenView } from '../src/renderer/todayView.ts';

/**
 * The call view with the Voice SDK mocked (slice C1): the Device connects with the
 * session id and nothing else; ringing, connected with a timer, mute and hang up; a
 * refusal and a refused microphone as sentences; the voicemail script on the attempts
 * that show it; the phone-app handoff untouched when calling is not twilio.
 * No real business, person or number (NANP 555-01XX).
 */

const FIRM_ID = '11111111-1111-4111-8111-111111111111';
const ROUTE_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '88888888-8888-4888-8888-888888888888';

const state = {
  expanded: { firmId: FIRM_ID },
  handoffNotice: 'Once a call is handed to the phone app, Callie cannot recall it.',
} as unknown as TodayState;
const view = {
  actionsEnabled: true,
  dialRoutes: [
    {
      route: { routeId: ROUTE_ID, contactId: null, e164: '+14015550187', version: 3, eligibility: 'usable' },
      enabled: true,
      advice: null,
      reasons: [],
    },
  ],
} as unknown as TodayScreenView;

const twilio = (nextAttempt: number | null = 1): CallingView => ({
  provider: 'twilio',
  cadence: { unansweredAttempts: 0, nextAttempt, limit: 4, parked: nextAttempt === null, refusal: null },
});

/** A Voice SDK call that the test drives by emitting its events. */
function fakeSdk() {
  const listeners = new Map<VoiceCallEvent, ((detail?: unknown) => void)[]>();
  const call: VoiceCall & { muted: boolean[]; disconnected: number } = {
    muted: [],
    disconnected: 0,
    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    mute: value => {
      call.muted.push(value);
    },
    disconnect: () => {
      call.disconnected += 1;
      emit('disconnect');
    },
  };
  const emit = (event: VoiceCallEvent, detail?: unknown): void => {
    for (const listener of listeners.get(event) ?? []) listener(detail);
  };
  const connects: unknown[] = [];
  const tokens: string[] = [];
  let failConnect: unknown = null;
  const device: VoiceDeviceFactory = async token => {
    tokens.push(token);
    return await Promise.resolve({
      connect: async params => {
        connects.push(params);
        if (failConnect !== null) throw failConnect;
        return await Promise.resolve(call);
      },
      destroy: () => undefined,
    });
  };
  return {
    call,
    emit,
    connects,
    tokens,
    device,
    failWith: (error: unknown) => {
      failConnect = error;
    },
  };
}

function Harness({
  ports,
  calling,
  actions,
  resume = async () => undefined,
  onResumed,
}: {
  readonly ports: CallPorts;
  readonly calling: CallingView | null;
  readonly actions?: TodayActions;
  readonly resume?: () => Promise<void>;
  readonly onResumed?: () => void;
}) {
  const call = useCall(ports);
  const status: CallingStatus = { view: calling, resuming: false, reload: () => undefined, resume };
  return (
    <DialPanel
      state={state}
      view={view}
      actions={actions ?? ({ busy: () => false, dial: () => undefined } as unknown as TodayActions)}
      calling={{ status, call, ...(onResumed === undefined ? {} : { onResumed }) }}
    />
  );
}

/** A promise the test settles. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

function portsWith(answer: CallStart, sdk = fakeSdk(), now = { value: 1_000_000 }) {
  const active: boolean[] = [];
  const start = vi.fn(async (_input: unknown) => await Promise.resolve(answer));
  const cancel = vi.fn(async () => await Promise.resolve({ cancelled: true }));
  const ports: CallPorts = {
    start,
    cancel,
    setActive: async value => {
      active.push(value);
      return await Promise.resolve({ active: value });
    },
    device: sdk.device,
    now: () => now.value,
  };
  return { ports, start, cancel, active, sdk, now };
}

const started = (overrides: Partial<Extract<CallStart, { ok: true }>> = {}): CallStart => ({
  ok: true,
  sessionId: SESSION_ID,
  token: 'twilio.voice.jwt',
  attempt: 2,
  voicemailScript: null,
  ...overrides,
});

afterEach(cleanup);

describe('the call view', () => {
  it('connects with only the session id, rings, connects with a timer, mutes and hangs up', async () => {
    const world = portsWith(started());
    render(<Harness ports={world.ports} calling={twilio(2)} />);

    // The announcement is still the first thing in the panel, and the attempt is shown.
    expect(screen.getByTestId('dial-panel').firstElementChild?.textContent).toContain(CALL_ANNOUNCEMENT);
    expect(screen.getByTestId('call-attempt').textContent).toBe('Attempt 2 of 4');
    expect(screen.queryByTestId('dial-limitation')).toBeNull();

    fireEvent.click(screen.getByTestId('dial'));
    await waitFor(() => {
      expect(screen.getByTestId('call-status').textContent).toBe('Ringing…');
    });
    expect(world.start).toHaveBeenCalledWith({ firmId: FIRM_ID, contactId: null, routeId: ROUTE_ID });
    expect(world.sdk.tokens).toEqual(['twilio.voice.jwt']);
    expect(world.sdk.connects).toEqual([{ sessionId: SESSION_ID }]);
    expect(world.active).toEqual([true]);
    expect(screen.getByTestId('dial')).toHaveProperty('disabled', true);

    act(() => {
      world.sdk.emit('accept');
    });
    expect(screen.getByTestId('call-status').textContent).toBe('Connected · 0:00');
    act(() => {
      world.now.value += 65_000;
    });
    fireEvent.click(screen.getByTestId('call-mute'));
    expect(world.sdk.call.muted).toEqual([true]);
    expect(screen.getByTestId('call-mute').textContent).toBe('Unmute');
    expect(screen.getByTestId('call-status').textContent).toBe('Connected · 1:05');
    fireEvent.click(screen.getByTestId('call-mute'));
    expect(world.sdk.call.muted).toEqual([true, false]);

    fireEvent.click(screen.getByTestId('call-hang-up'));
    expect(world.sdk.call.disconnected).toBe(1);
    expect(screen.getByTestId('call-status').textContent).toBe('Call ended · 1:05. Record what happened below.');
    expect(world.active).toEqual([true, false]);
    expect(screen.queryByTestId('call-view')).toBeNull();
  });

  it('shows the voicemail script on the attempts that carry one', async () => {
    const script = 'Hi Dana, this is Sam Example from Callie.';
    const world = portsWith(started({ attempt: 1, voicemailScript: script }));
    render(<Harness ports={world.ports} calling={twilio(1)} />);
    fireEvent.click(screen.getByTestId('dial'));
    await waitFor(() => {
      expect(screen.getByTestId('call-voicemail-text').textContent).toBe(script);
    });
  });

  it('says a refusal in its sentence and never connects', async () => {
    for (const [reason, sentence] of [
      ['outside_calling_window', reasonSentence('outside_calling_window')],
      ['firm_suppressed', reasonSentence('firm_suppressed')],
      ['telephony_budget_exhausted', 'Calling paused: today’s calling budget is used.'],
    ] as const) {
      const world = portsWith({ ok: false, reason });
      render(<Harness ports={world.ports} calling={twilio(1)} />);
      fireEvent.click(screen.getByTestId('dial'));
      await waitFor(() => {
        expect(screen.getByTestId('call-refused').textContent).toBe(sentence);
      });
      expect(world.sdk.connects).toEqual([]);
      expect(world.active).toEqual([]);
      cleanup();
    }
  });

  it('says how to allow the microphone when macOS refused it', async () => {
    const world = portsWith(started());
    world.sdk.failWith({ code: 31401, name: 'PermissionDeniedError' });
    render(<Harness ports={world.ports} calling={twilio(1)} />);
    fireEvent.click(screen.getByTestId('dial'));
    await waitFor(() => {
      expect(screen.getByTestId('call-refused').textContent).toBe(MICROPHONE_DENIED_SENTENCE);
    });
    expect(MICROPHONE_DENIED_SENTENCE).toContain('System Settings');
    expect(world.active).toEqual([true, false]);
  });

  it('offers Resume calling on a parked firm and no Call', () => {
    const world = portsWith(started());
    render(<Harness ports={world.ports} calling={twilio(null)} />);
    expect(screen.getByTestId('call-attempt').textContent).toBe('4 calls went unanswered. Calling is parked for review.');
    expect(screen.getByTestId('call-resume')).toBeTruthy();
    expect(screen.getByTestId('dial')).toHaveProperty('disabled', true);
  });

  it('waits, with Call disabled, while the calling status is unknown, and says so when it could not be read', () => {
    const dial = vi.fn();
    const world = portsWith(started());
    const actions = { busy: () => false, dial } as unknown as TodayActions;
    render(<Harness ports={world.ports} calling={null} actions={actions} />);
    expect(screen.getByTestId('calling-status').textContent).toBe('Checking how to place calls…');
    expect(screen.getByTestId('dial')).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByTestId('dial'));
    expect(dial).not.toHaveBeenCalled();
    cleanup();

    // A 503, no answer or a refusal from the status read: unavailable, never the phone app.
    render(<Harness ports={world.ports} calling={{ provider: 'unavailable', cadence: null }} actions={actions} />);
    expect(screen.getByTestId('calling-status').textContent).toBe('Calling is unavailable right now.');
    expect(screen.getByTestId('dial')).toHaveProperty('disabled', true);
    expect(screen.queryByTestId('dial-limitation')).toBeNull();
    fireEvent.click(screen.getByTestId('dial'));
    expect(dial).not.toHaveBeenCalled();
    expect(world.start).not.toHaveBeenCalled();
  });

  it('reads the card again after Resume calling, so its Call is enabled by fresh dial advice', async () => {
    const world = portsWith(started());
    const onResumed = vi.fn();
    const resume = vi.fn(async () => await Promise.resolve());
    render(<Harness ports={world.ports} calling={twilio(null)} resume={resume} onResumed={onResumed} />);
    fireEvent.click(screen.getByTestId('call-resume'));
    await waitFor(() => {
      expect(onResumed).toHaveBeenCalledTimes(1);
    });
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('cancels a call still being set up when the card closes: the Device made afterwards is destroyed, nothing dials', async () => {
    const world = portsWith(started());
    const start = deferred<CallStart>();
    world.ports.start = async () => await start.promise;
    const destroyed: number[] = [];
    const connects: unknown[] = [];
    world.ports.device = async () =>
      await Promise.resolve({
        connect: async params => {
          connects.push(params);
          return await Promise.resolve(world.sdk.call);
        },
        destroy: () => {
          destroyed.push(1);
        },
      });
    const { unmount } = render(<Harness ports={world.ports} calling={twilio(1)} />);
    fireEvent.click(screen.getByTestId('dial'));
    unmount();
    expect(world.cancel).toHaveBeenCalledTimes(1);
    start.resolve(started());
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(connects).toEqual([]);
    expect(world.active).not.toContain(true);
  });

  it('disconnects and destroys a Call that connects after the card closed', async () => {
    const world = portsWith(started());
    const connected = deferred<VoiceCall>();
    const destroyed: number[] = [];
    world.ports.device = async () =>
      await Promise.resolve({
        connect: async () => await connected.promise,
        destroy: () => {
          destroyed.push(1);
        },
      });
    const { unmount } = render(<Harness ports={world.ports} calling={twilio(1)} />);
    fireEvent.click(screen.getByTestId('dial'));
    await waitFor(() => {
      expect(screen.getByTestId('call-status').textContent).toBe('Ringing…');
    });
    unmount();
    connected.resolve(world.sdk.call);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(world.sdk.call.disconnected).toBe(1);
    expect(destroyed.length).toBeGreaterThanOrEqual(1);
    expect(world.active).toEqual([true, false]);
  });

  it('cancels on Hang up pressed while the call is starting: nothing dials, and the panel is back to Call', async () => {
    const world = portsWith(started());
    const start = deferred<CallStart>();
    world.ports.start = async () => await start.promise;
    render(<Harness ports={world.ports} calling={twilio(1)} />);
    fireEvent.click(screen.getByTestId('dial'));
    expect(screen.getByTestId('call-status').textContent).toBe('Starting the call…');
    fireEvent.click(screen.getByTestId('call-hang-up'));
    // The main process is told, so a late session or token binds nothing there either.
    expect(world.cancel).toHaveBeenCalledTimes(1);
    start.resolve(started());
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(world.sdk.connects).toEqual([]);
    expect(screen.queryByTestId('call-status')).toBeNull();
    expect(screen.getByTestId('dial')).toHaveProperty('disabled', false);
  });

  it('keeps the phone-app handoff exactly when the server says calling is off', () => {
    const dial = vi.fn();
    const world = portsWith(started());
    render(
      <Harness
        ports={world.ports}
        calling={{ provider: 'tel', cadence: null }}
        actions={{ busy: () => false, dial } as unknown as TodayActions}
      />,
    );
    expect(screen.getByTestId('dial-limitation').textContent).toBe(state.handoffNotice);
    expect(screen.queryByTestId('call-attempt')).toBeNull();
    fireEvent.click(screen.getByTestId('dial'));
    expect(dial).toHaveBeenCalledWith({ firmId: FIRM_ID, contactId: null, routeId: ROUTE_ID });
    expect(world.start).not.toHaveBeenCalled();
  });
});

describe('the firm’s call history', () => {
  const call = (overrides: Partial<CallSessionDto> = {}): CallSessionDto => ({
    sessionId: SESSION_ID,
    firmId: FIRM_ID,
    status: 'completed',
    startedAt: '2026-09-21T14:00:00.000Z',
    answeredAt: '2026-09-21T14:00:10.000Z',
    endedAt: '2026-09-21T14:01:45.000Z',
    durationSeconds: 95,
    hasRecording: true,
    callLogId: null,
    ...overrides,
  });

  it('lists calls with their duration and plays a recording through the proxy', async () => {
    const recording = vi.fn(async (_sessionId: string) =>
      await Promise.resolve({ recording: { audioBase64: 'AAAA', contentType: 'audio/mpeg' }, reason: null }),
    );
    const played: string[] = [];
    render(
      <CallHistory
        firmId={FIRM_ID}
        ports={{
          history: async () =>
            await Promise.resolve({
              calls: [call(), call({ sessionId: '99999999-9999-4999-8999-999999999999', hasRecording: false, durationSeconds: null })],
            }),
          recording,
          play: async (audio, type) => {
            played.push(`${type}:${audio}`);
            return await Promise.resolve({ stop: () => undefined, ended: new Promise<void>(() => undefined) });
          },
        }}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('call-history-row')).toHaveLength(2);
    });
    expect(screen.getAllByTestId('call-history-duration').map(node => node.textContent)).toEqual(['1:35', '—']);
    expect(screen.getAllByTestId('call-history-play')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('call-history-play'));
    await waitFor(() => {
      expect(played).toEqual(['audio/mpeg:AAAA']);
    });
    expect(recording).toHaveBeenCalledWith(SESSION_ID);
    expect(screen.getByTestId('call-history-play').textContent).toBe('Stop');
  });
});

describe('playing a recording', () => {
  it('plays a blob: URL of the bytes and revokes it when stopped', async () => {
    const created: Blob[] = [];
    const revoked: string[] = [];
    const listeners = new Map<string, () => void>();
    const audio = {
      play: vi.fn(async () => await Promise.resolve()),
      pause: vi.fn(),
      removeAttribute: vi.fn(),
      addEventListener: (event: string, listener: () => void) => {
        listeners.set(event, listener);
      },
    } as unknown as HTMLAudioElement;
    const { playRecording } = await import('../src/renderer/calling/playRecording.ts');
    const playback = await playRecording(btoa('ID3bytes'), 'audio/mpeg', {
      createObjectURL: blob => {
        created.push(blob);
        return 'blob:callie-app://bundle/1';
      },
      revokeObjectURL: url => {
        revoked.push(url);
      },
      audio: url => {
        expect(url).toBe('blob:callie-app://bundle/1');
        return audio;
      },
    });
    expect(created[0]?.type).toBe('audio/mpeg');
    expect(created[0]?.size).toBe(8);
    expect(revoked).toEqual([]);
    playback.stop();
    expect(revoked).toEqual(['blob:callie-app://bundle/1']);
    await playback.ended;
    // Ending as well does not revoke twice.
    listeners.get('ended')?.();
    expect(revoked).toHaveLength(1);
  });
});
