// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  firmMeetingsResponseSchema,
  meetingMatchedSchema,
  pipelineBoardResponseSchema,
  unmatchedMeetingsResponseSchema,
} from '@fss/contracts';
import type { HttpAnswer } from '../src/main/apiClient.ts';
import { createAuthedClient, type AuthedClient } from '../src/main/authedClient.ts';
import { createCrmBridge } from '../src/main/crmBridge.ts';
import { answerOperation, operationHandlers, type OperationHostDeps } from '../src/main/operationHost.ts';
import { FirmMeetings } from '../src/renderer/meetings/FirmMeetings.tsx';
import { meetingStateWord } from '../src/renderer/meetings/meetingText.ts';
import { meetingLabel } from '../src/renderer/pipeline/cardText.ts';

/**
 * Lane M1, B0: the desktop reads a meeting state it does not know without failing.
 *
 * Migration 0039 adds the state `ended`, and the desktop installed when the server first
 * answers with it is this one. Before B0, every meeting answer was parsed with
 * `z.enum(MEETING_STATES)`, so one card whose latest meeting was `ended` failed the whole
 * board read (`crmBridge.ts` `/pipeline/board`) and the firm's meetings
 * (`operationHost.ts` `meetings.forFirm`). Now `ended` reads "Ended", any other unknown state
 * reads "Meeting" in the neutral tone, and a state that is not a state's shape is still
 * refused. No real business or person: `example.test` is reserved by RFC 6761.
 */

const FIRM = '11111111-1111-4111-8111-111111111111';
const OTHER_FIRM = '22222222-2222-4222-8222-222222222222';
const OPP = '99999999-9999-4999-8999-999999999999';
const MEETING = '44444444-4444-4444-8444-444444444444';
const OTHER_MEETING = '55555555-5555-4555-8555-555555555555';
const FUTURE_STATE = 'attended_by_recording';
const STAGE = { id: '00000000-0000-4000-8000-000000000001', key: 'new', displayName: 'New', position: 1, terminalKind: null, retired: false };

afterEach(() => {
  cleanup();
});

const card = (state: string) => ({
  value: null,
  meeting: { meetingId: MEETING, state, startsAt: '2026-10-06T15:00:00.000Z' },
  evidence: null,
  pinned: false,
  closeReason: null,
});

const board = (states: readonly [string, string]): Record<string, unknown> => ({
  columns: [{ stage: STAGE, firms: [] }],
  opportunityIdByFirmId: { [FIRM]: OPP },
  unplacedFirms: [],
  cards: { [FIRM]: card(states[0]), [OTHER_FIRM]: card(states[1]) },
  stages: [STAGE],
});

const firmMeetings = (states: readonly string[]): Record<string, unknown> => ({
  meetings: states.map((state, index) => ({
    meetingId: index === 0 ? MEETING : OTHER_MEETING,
    state,
    startsAt: '2026-10-06T15:00:00.000Z',
    endsAt: '2026-10-06T15:30:00.000Z',
  })),
});

describe('the meeting answers accept a state this build does not know', () => {
  it('parses ended and a future state in every meeting answer the Mac reads', () => {
    expect(pipelineBoardResponseSchema.safeParse(board(['ended', FUTURE_STATE])).success).toBe(true);
    expect(firmMeetingsResponseSchema.safeParse(firmMeetings(['ended', FUTURE_STATE])).success).toBe(true);
    expect(
      unmatchedMeetingsResponseSchema.safeParse({
        meetings: [
          { meetingId: MEETING, state: 'ended', startsAt: '2026-10-06T15:00:00.000Z', endsAt: '2026-10-06T15:30:00.000Z', attendeeEmail: null, reason: null },
          { meetingId: OTHER_MEETING, state: FUTURE_STATE, startsAt: '2026-10-06T15:00:00.000Z', endsAt: '2026-10-06T15:30:00.000Z', attendeeEmail: null, reason: null },
        ],
      }).success,
    ).toBe(true);
    expect(meetingMatchedSchema.safeParse({ meetingId: MEETING, firmId: FIRM, contactId: null, state: 'ended', stage: 'none' }).success).toBe(true);
  });

  it('still refuses a state that is not a state s shape, so the field cannot carry text', () => {
    for (const state of ['', 'Held', 'held by a partner', 'no-show', 'ended!', 'x'.repeat(40), '_held']) {
      expect(firmMeetingsResponseSchema.safeParse(firmMeetings([state])).success, state).toBe(false);
      expect(pipelineBoardResponseSchema.safeParse(board([state, 'booked'])).success, state).toBe(false);
    }
  });
});

describe('the board read through the CRM bridge', () => {
  function scripted(answer: Record<string, unknown>) {
    const api = createAuthedClient({
      baseUrl: 'https://api.example.test/',
      clientVersion: '1.0.36',
      accessToken: async () => await Promise.resolve({ token: 'token-value', generation: 0 }),
      send: async url => {
        const path = new URL(url).pathname;
        if (path === '/pipeline/board') return await Promise.resolve<HttpAnswer>({ status: 200, body: answer });
        return await Promise.resolve<HttpAnswer>({ status: 404, body: { error: 'not_found' } });
      },
    });
    return createCrmBridge({
      api,
      clientVersion: '1.0.36',
      session: { state: async () => await Promise.resolve({ online: true, mayMutate: true, device: { role: 'admin' as const } }) },
    });
  }

  it('shows the whole board when a card s latest meeting is ended or a state from a newer server', async () => {
    const state = await scripted(board(['ended', FUTURE_STATE])).openPipeline();
    expect(state.pipeline).not.toBeNull();
    expect(state.pipeline?.cards?.[FIRM]?.meeting?.state).toBe('ended');
    expect(state.pipeline?.cards?.[OTHER_FIRM]?.meeting?.state).toBe(FUTURE_STATE);
    expect(state.pipeline?.opportunityIdByFirmId[FIRM]).toBe(OPP);
  });
});

describe('the firm s meetings through the operation host', () => {
  it('answers the meetings, not null, when one is ended and one is from a newer server', async () => {
    // The real parse the host hands the client, run on the server's raw answer.
    const api = {
      read: async (_path: string, parse: (value: unknown) => unknown) =>
        await Promise.resolve({ ok: true as const, value: parse(firmMeetings(['ended', FUTURE_STATE])) }),
      command: async () => await Promise.resolve({ ok: false as const, reason: 'unused' }),
    } as unknown as AuthedClient;
    const handlers = operationHandlers({ api } as unknown as OperationHostDeps);
    const answer = (await answerOperation(handlers, 'read', 'meetings.forFirm', { firmId: FIRM })) as {
      readonly meetings: readonly { readonly state: string }[] | null;
    };
    expect(answer.meetings?.map(meeting => meeting.state)).toEqual(['ended', FUTURE_STATE]);
  });
});

describe('the words for a state', () => {
  it('says Ended for ended, and Meeting, never the code, for a state it does not know', () => {
    expect(meetingStateWord('ended')).toBe('Ended');
    expect(meetingStateWord(FUTURE_STATE)).toBe('Meeting');
    // A key every object has is not a state either.
    expect(meetingStateWord('constructor')).toBe('Meeting');
    expect(meetingLabel({ meetingId: MEETING, state: FUTURE_STATE, startsAt: '2026-10-06T15:00:00.000Z' })).toMatch(/^Meeting · /u);
    expect(meetingLabel({ meetingId: MEETING, state: 'ended', startsAt: '2026-10-06T15:00:00.000Z' })).toMatch(/^Ended · /u);
  });

  it('renders the firm page rows neutrally for an unknown state', async () => {
    render(
      <FirmMeetings
        firmId={FIRM}
        ports={{
          forFirm: async () =>
            await Promise.resolve({
              meetings: [
                { meetingId: MEETING, state: 'ended', startsAt: '2026-10-06T15:00:00.000Z', endsAt: '2026-10-06T15:30:00.000Z' },
                { meetingId: OTHER_MEETING, state: FUTURE_STATE, startsAt: '2026-10-01T15:00:00.000Z', endsAt: '2026-10-01T15:30:00.000Z' },
              ],
            }),
        }}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('firm-meeting-row')).toHaveLength(2);
    });
    const tags = screen.getAllByTestId('firm-meeting-state');
    expect(tags.map(node => node.textContent)).toEqual(['Ended', 'Meeting']);
    for (const tag of tags) expect(tag.className).toContain('bg-muted');
  });
});
