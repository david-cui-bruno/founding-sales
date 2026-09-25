import { describe, expect, it } from 'vitest';
import { SENDING_STOP_LINE } from '@fss/contracts';
import type { ApiOutcome } from '../src/main/apiClient.ts';
import { createAuthedClient, type AuthedClient } from '../src/main/authedClient.ts';
import { createSequenceBridge, isOpenableProfile } from '../src/main/sequenceBridge.ts';
import type { SequenceState, SequenceStep, TemplateVersion } from '../src/renderer/sequenceContract.ts';
import {
  EMPTY_SEQUENCE_STATE,
  SEQUENCE_UNREAD,
  publishRefusalFor,
  remainingUndoMilliseconds,
  sequenceScreen,
} from '../src/renderer/sequenceView.ts';
import {
  FOOTER_SIGN_OFF,
  SEQUENCE_IDS,
  emailStepAnswer,
  enrollmentAnswer,
  linkedInHandoffAnswer,
  linkedInStepAnswer,
  sequenceSummaryAnswer,
  sequenceVersionAnswer,
  templateVersionAnswer,
} from './support/sequenceAnswers.ts';

/**
 * The sequence editor's rules, without Electron and without a database
 * (specification 11.1, 11.3, 4.3, 14.2).
 *
 * The view model is pure, so every "can this be done" is a function call here; the
 * bridge takes its API and its two side effects as ports, so the LinkedIn handoff is
 * a recorded clipboard write and a recorded browser open.
 *
 * The answers are the routes' shapes, from `./support/sequenceAnswers.ts`, which the
 * release suite holds to the real routes (lane g78). Until g78 this file built its own:
 * steps with no `sequenceVersionId` and enrollments missing four fields — the
 * desktop's wrong DTO, so the suite passed while every populated answer failed (T04).
 *
 * No real person, firm or profile appears. `example.test` is reserved by RFC 6761,
 * and the one LinkedIn URL is an obviously fictional path.
 */

const HASH = 'a'.repeat(64);
/** Imported rather than typed, so the panel and the server's rule cannot disagree. */
const STOP_LINE = SENDING_STOP_LINE;

const template = (patch: Partial<TemplateVersion> = {}): TemplateVersion =>
  templateVersionAnswer({ personalizationStrategy: 'deterministic', ...patch });

const draftVersion = (steps: readonly SequenceStep[]) =>
  sequenceVersionAnswer(steps, { stopConditions: ['human_reply', 'stage_closed'] });

const emailStep = (templateVersionId: string | null, ordinal = 1): SequenceStep =>
  emailStepAnswer(templateVersionId, ordinal);

describe('what the editor will and will not let a person publish (11.1)', () => {
  const options = { isAdmin: true, online: true };

  it('refuses an empty draft, a gap in the ordinals, and an unapproved template', () => {
    expect(publishRefusalFor(draftVersion([]), [], options)).toBe('version_has_no_steps');
    expect(
      publishRefusalFor(draftVersion([emailStep(template().id, 2)]), [template()], options),
    ).toBe('ordinals_not_contiguous');
    expect(
      publishRefusalFor(draftVersion([emailStep(template().id)]), [template({ approvedAt: null })], options),
    ).toBe('email_step_needs_approved_template');
    expect(
      publishRefusalFor(
        draftVersion([emailStep(template().id)]),
        [template({ retiredAt: '2026-09-02T12:00:00.000Z' })],
        options,
      ),
    ).toBe('email_step_needs_approved_template');
  });

  it('accepts a contiguous draft whose email step is approved', () => {
    expect(publishRefusalFor(draftVersion([emailStep(template().id)]), [template()], options)).toBeNull();
  });

  it('refuses a salesperson and an offline window before it looks at the steps', () => {
    const good = draftVersion([emailStep(template().id)]);
    expect(publishRefusalFor(good, [template()], { isAdmin: false, online: true })).toBe('admin_only');
    expect(publishRefusalFor(good, [template()], { isAdmin: true, online: false })).toBe('offline');
  });

  it('never offers an edit on a published version, because the trigger refuses one', () => {
    const state: SequenceState = {
      ...EMPTY_SEQUENCE_STATE,
      online: true,
      mayMutate: true,
      isAdmin: true,
      versions: [{ ...draftVersion([emailStep(template().id)]), state: 'published', publishedAt: '2026-09-01T12:00:00.000Z' }],
      templates: [template()],
    };
    const screen = sequenceScreen(state);
    expect(screen.versions[0]?.editable).toBe(false);
    expect(screen.versions[0]?.canPublish).toBe(false);
    expect(screen.versions[0]?.canRetire).toBe(true);
  });
});

describe('the template panel shows the digest and names what is wrong (11.1, 12.6)', () => {
  const state = (templates: readonly TemplateVersion[]): SequenceState => ({
    ...EMPTY_SEQUENCE_STATE,
    online: true,
    mayMutate: true,
    isAdmin: true,
    templates: [...templates],
  });

  it('displays the content hash verbatim', () => {
    const screen = sequenceScreen(state([template()]));
    expect(screen.templates[0]?.contentHash).toBe(HASH);
  });

  it('refuses to offer approval for a body with no footer, and says so', () => {
    const screen = sequenceScreen(state([template({ approvedAt: null, body: 'Hello,\n\nNo footer.' })]));
    expect(screen.templates[0]?.footerPresent).toBe(false);
    expect(screen.templates[0]?.canApprove).toBe(false);
  });

  it('refuses to offer approval for a body mentioning an unsubscribe link', () => {
    const screen = sequenceScreen(
      state([
        template({
          approvedAt: null,
          body: `Unsubscribe here.\n\n${FOOTER_SIGN_OFF}\n${STOP_LINE}`,
        }),
      ]),
    );
    expect(screen.templates[0]?.unsubscribeMentioned).toBe(true);
    expect(screen.templates[0]?.canApprove).toBe(false);
  });

  it('offers approval, and no edit, for an approved body', () => {
    const approvable = sequenceScreen(state([template({ approvedAt: null })]));
    expect(approvable.templates[0]?.canApprove).toBe(true);
    expect(approvable.templates[0]?.editable).toBe(true);

    const approved = sequenceScreen(state([template()]));
    expect(approved.templates[0]?.canApprove).toBe(false);
    expect(approved.templates[0]?.editable).toBe(false);
  });
});

describe('the LinkedIn card measures its undo against the server (11.3, G 9)', () => {
  const card = {
    stepExecutionId: '66666666-6666-4666-8666-666666666666',
    enrollmentId: '77777777-7777-4777-8777-777777777777',
    contactName: 'Dana Example',
    linkedInUrl: 'https://www.linkedin.com/in/dana-example-000',
    message: 'A short note.',
    handedOff: true,
    undoUntil: '2026-09-21T13:10:00.000Z',
  };

  it('offers the undo at 9:59 of database time and not at 10:00', () => {
    expect(remainingUndoMilliseconds(card, '2026-09-21T13:09:00.000Z')).toBe(60_000);
    expect(remainingUndoMilliseconds(card, '2026-09-21T13:10:00.000Z')).toBe(0);
    expect(remainingUndoMilliseconds(card, '2026-09-21T13:11:00.000Z')).toBe(0);
  });

  it('never claims the message was sent, and keeps both result buttons alive', () => {
    const screen = sequenceScreen({
      ...EMPTY_SEQUENCE_STATE,
      online: true,
      mayMutate: true,
      asOf: '2026-09-21T13:09:00.000Z',
      linkedInCard: card,
    });
    expect(screen.linkedIn?.statusLabel).toContain('does not know whether it was sent');
    expect(screen.linkedIn?.statusLabel).not.toContain('Sent');
    expect(screen.linkedIn?.canUndo).toBe(true);
    expect(screen.linkedIn?.canOpenAndCopy).toBe(false);
    expect(screen.linkedIn?.canRecordResult).toBe(true);
  });
});

describe('the hold review screen (4.3, G 31)', () => {
  it('shows only enrollments awaiting review, with the union in days', () => {
    const screen = sequenceScreen({
      ...EMPTY_SEQUENCE_STATE,
      online: true,
      mayMutate: true,
      heldEnrollments: [
        enrollmentAnswer({ state: 'review_required', reviewUnionMilliseconds: 9 * 86_400_000 }),
        enrollmentAnswer({
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          contactId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        }),
      ],
    });
    expect(screen.holdReview).toHaveLength(1);
    expect(screen.holdReview[0]?.heldForDays).toBe(9);
    expect(screen.holdReview[0]?.explanation).toContain('fresh eligibility check');
  });
});

describe('the bridge copies and opens after the server has recorded the handoff', () => {
  const answers = new Map<string, ApiOutcome<unknown>>();
  const copied: string[] = [];
  const opened: string[] = [];
  const commands: { path: string; payload: unknown }[] = [];

  const api: AuthedClient = {
    read: async (path, parse) => {
      const answer = answers.get(path) ?? { ok: false, reason: 'not_found', offline: false };
      return answer.ok ? { ok: true, value: parse(answer.value) } : answer;
    },
    command: async (path, payload, parse) => {
      commands.push({ path, payload });
      const answer = answers.get(path) ?? { ok: false, reason: 'refused', offline: false };
      return answer.ok ? { ok: true, value: parse(answer.value) } : answer;
    },
  };

  const bridge = () =>
    createSequenceBridge({
      api,
      session: {
        state: async () =>
          await Promise.resolve({ online: true, mayMutate: true, device: { role: 'admin' as const } }),
      },
      copyToClipboard: text => copied.push(text),
      openExternally: async url => {
        opened.push(url);
        await Promise.resolve();
      },
    });

  it('copies the text and opens the profile only after a successful completion', async () => {
    answers.set('/sequences', { ok: true, value: { sequences: [] } });
    answers.set('/templates', { ok: true, value: { templates: [] } });
    answers.set('/enrollments', {
      ok: true,
      value: { asOf: '2026-09-21T13:00:00.000Z', enrollments: [] },
    });
    answers.set('/enrollments/linkedin/complete', { ok: true, value: linkedInHandoffAnswer() });

    const host = bridge();
    const state = await host.completeLinkedIn({
      stepExecutionId: '66666666-6666-4666-8666-666666666666',
    });
    expect(copied).toEqual(['A short note.']);
    expect(opened).toEqual(['https://www.linkedin.com/in/dana-example-000']);
    expect(state.linkedInCard?.handedOff).toBe(true);
    expect(state.asOf).toBe('2026-09-21T13:00:00.000Z');
    expect(state.notice).toContain('has not claimed it was sent');
  });

  it('copies nothing and opens nothing when the completion is refused', async () => {
    copied.length = 0;
    opened.length = 0;
    answers.set('/enrollments/linkedin/complete', {
      ok: false,
      reason: 'execution_not_pending',
      offline: false,
    });
    const state = await bridge().completeLinkedIn({
      stepExecutionId: '66666666-6666-4666-8666-666666666666',
    });
    expect(copied).toEqual([]);
    expect(opened).toEqual([]);
    expect(state.notice).toBe('execution_not_pending');
  });

  it('fails the undo visibly when the successor has begun dispatching (11.3)', async () => {
    answers.set('/enrollments/linkedin/undo', {
      ok: false,
      reason: 'successor_dispatching',
      offline: false,
    });
    const state = await bridge().undoLinkedIn({
      stepExecutionId: '66666666-6666-4666-8666-666666666666',
    });
    expect(state.notice).toContain('already begun sending');
  });

  it('opens only an https linkedin.com profile', () => {
    expect(isOpenableProfile('https://www.linkedin.com/in/dana-example-000')).toBe(true);
    expect(isOpenableProfile('https://linkedin.com/in/dana')).toBe(true);
    expect(isOpenableProfile('http://www.linkedin.com/in/dana')).toBe(false);
    expect(isOpenableProfile('https://linkedin.com.example.test/in/dana')).toBe(false);
    expect(isOpenableProfile('javascript:alert(1)')).toBe(false);
    expect(isOpenableProfile(null)).toBe(false);
  });

  it('shows nothing and refuses everything while offline (4.2)', async () => {
    const host = createSequenceBridge({
      api,
      session: {
        state: async () =>
          await Promise.resolve({ online: false, mayMutate: false, device: { role: 'admin' as const } }),
      },
      copyToClipboard: text => copied.push(text),
      openExternally: async url => {
        opened.push(url);
        await Promise.resolve();
      },
    });
    const state = await host.state();
    expect(state.online).toBe(false);
    expect(state.sequences).toEqual([]);
    expect(sequenceScreen(state).banner).toContain('Offline');
  });
});

describe('the bridge reads what the routes answer (lane g78)', () => {
  /** The real transport, over a table of answers: the parse is the shipped one. */
  const bridgeOver = (answers: Readonly<Record<string, { status: number; body: unknown } | 'offline'>>) =>
    createSequenceBridge({
      api: createAuthedClient({
        baseUrl: 'https://api.example.test/',
        clientVersion: '1.0.5',
        accessToken: async () => await Promise.resolve('token'),
        send: async url => {
          const answer = answers[new URL(url).pathname];
          if (answer === 'offline') throw new Error('no route to host');
          return await Promise.resolve(answer ?? { status: 404, body: { error: 'not_found' } });
        },
      }),
      session: {
        state: async () => await Promise.resolve({ online: true, mayMutate: true, device: { role: 'admin' as const } }),
      },
      copyToClipboard: () => undefined,
      openExternally: async () => {
        await Promise.resolve();
      },
    });

  const populated = {
    '/sequences': { status: 200, body: { sequences: [sequenceSummaryAnswer()] } },
    '/sequences/versions': {
      status: 200,
      body: { versions: [sequenceVersionAnswer([emailStepAnswer(SEQUENCE_IDS.template), linkedInStepAnswer()])] },
    },
    '/templates': { status: 200, body: { templates: [templateVersionAnswer()] } },
    '/enrollments': {
      status: 200,
      body: {
        asOf: '2026-09-21T13:00:00.000Z',
        enrollments: [enrollmentAnswer(), enrollmentAnswer({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', state: 'review_required', reviewUnionMilliseconds: 86_400_000 })],
      },
    },
  } as const;

  it('shows a populated version and the held enrollment, which 1.0.4 refused to parse (D01, D02)', async () => {
    const state = await bridgeOver(populated).state();
    expect(state.readErrors).toEqual({ sequences: null, versions: null, templates: null, enrollments: null });
    expect(state.versions).toHaveLength(1);
    expect(state.versions[0]?.steps.map(step => [step.ordinal, step.channel, step.sequenceVersionId])).toEqual([
      [1, 'email', SEQUENCE_IDS.version],
      [2, 'linkedin_task', SEQUENCE_IDS.version],
    ]);
    expect(state.heldEnrollments.map(entry => [entry.id, entry.opportunityId, entry.firmTimeZone])).toEqual([
      ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', SEQUENCE_IDS.opportunity, 'America/New_York'],
    ]);

    const screen = sequenceScreen(state);
    expect(screen.unread).toEqual([]);
    expect(screen.versions[0]?.steps.map(step => step.detail)).toEqual([
      'Template email',
      'LinkedIn task, opened and copied by hand',
    ]);
    expect(screen.holdReview).toHaveLength(1);
  });

  it('says which read failed and why, instead of drawing an empty list (D06)', async () => {
    const withoutVersionIds = sequenceVersionAnswer([emailStepAnswer(SEQUENCE_IDS.template)]);
    const { sequenceVersionId: _dropped, ...oldStep } = withoutVersionIds.steps[0] ?? emailStepAnswer(null);
    const state = await bridgeOver({
      ...populated,
      // The shape 1.0.4's own schema expected: a step without its version id.
      '/sequences/versions': { status: 200, body: { versions: [{ ...withoutVersionIds, steps: [oldStep] }] } },
      '/templates': { status: 503, body: { error: 'service_unavailable' } },
      '/enrollments': 'offline',
    }).state();

    expect(state.versions).toEqual([]);
    expect(state.readErrors).toEqual({
      sequences: null,
      versions: 'unreadable_answer',
      templates: 'service_unavailable',
      enrollments: 'offline',
    });
    // No enrollments, so no server clock: the undo is measured against nothing rather than this Mac.
    expect(state.asOf).toBeNull();

    const screen = sequenceScreen(state);
    expect(screen.unread).toEqual([
      {
        slice: 'versions',
        line: `${SEQUENCE_UNREAD.versions} The answer was not in the shape this version of Callie reads (unreadable_answer).`,
      },
      { slice: 'templates', line: `${SEQUENCE_UNREAD.templates} The server answered service_unavailable.` },
      { slice: 'enrollments', line: `${SEQUENCE_UNREAD.enrollments} The server did not answer (offline).` },
    ]);
  });

  it('reads an empty workspace as empty, with nothing unread', async () => {
    const state = await bridgeOver({
      '/sequences': { status: 200, body: { sequences: [] } },
      '/templates': { status: 200, body: { templates: [] } },
      '/enrollments': { status: 200, body: { asOf: '2026-09-21T13:00:00.000Z', enrollments: [] } },
    }).state();
    expect(state.sequences).toEqual([]);
    expect(sequenceScreen(state).unread).toEqual([]);
  });

  it('keeps reading a field the API adds later, rather than refusing the whole answer', async () => {
    const version = sequenceVersionAnswer([emailStepAnswer(SEQUENCE_IDS.template)]);
    const state = await bridgeOver({
      ...populated,
      '/sequences/versions': {
        status: 200,
        body: { versions: [{ ...version, laterField: 1, steps: version.steps.map(step => ({ ...step, laterField: 'x' })) }] },
      },
    }).state();
    expect(state.readErrors.versions).toBeNull();
    expect(state.versions[0]?.steps).toHaveLength(1);
    // Stripped, not carried: the window cannot show what the contract does not declare.
    expect(JSON.stringify(state.versions)).not.toContain('laterField');
  });
});
