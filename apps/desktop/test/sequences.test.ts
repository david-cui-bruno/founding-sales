import { describe, expect, it } from 'vitest';
import { SENDING_STOP_LINE } from '@fss/contracts';
import { OFFLINE_BANNER } from '../src/renderer/readError.ts';
import { createAuthedClient } from '../src/main/authedClient.ts';
import { createSequenceBridge } from '../src/main/sequenceBridge.ts';
import type { SequenceState, SequenceStep, TemplateVersion } from '../src/renderer/sequenceContract.ts';
import {
  EDITOR_CHANNELS,
  EMPTY_SEQUENCE_STATE,
  SEQUENCE_UNREAD,
  draftStepsOf,
  publishRefusalFor,
  sequenceScreen,
  stepsForWire,
} from '../src/renderer/sequenceView.ts';
import {
  FOOTER_SIGN_OFF,
  SEQUENCE_IDS,
  callStepAnswer,
  emailStepAnswer,
  enrollmentAnswer,
  removedLinkedInStepAnswer,
  sequenceSummaryAnswer,
  sequenceVersionAnswer,
  templateVersionAnswer,
} from './support/sequenceAnswers.ts';

/**
 * The sequence editor's rules, without Electron and without a database
 * (specification 11.1, 4.3, 14.2).
 *
 * The view model is pure, so every "can this be done" is a function call here; the
 * bridge takes its API as a port.
 *
 * The answers are the routes' shapes, from `./support/sequenceAnswers.ts`, which the
 * release suite holds to the real routes (lane g78). Until g78 this file built its own:
 * steps with no `sequenceVersionId` and enrollments missing four fields — the
 * desktop's wrong DTO, so the suite passed while every populated answer failed (T04).
 *
 * No real person, firm or profile appears. `example.test` is reserved by RFC 6761.
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
  const options = { isAdmin: true, mayMutate: true };

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

  it('refuses a salesperson and an unsupported version before it looks at the steps, and never offline', () => {
    const good = draftVersion([emailStep(template().id)]);
    expect(publishRefusalFor(good, [template()], { isAdmin: false, mayMutate: true })).toBe('admin_only');
    expect(publishRefusalFor(good, [template()], { isAdmin: true, mayMutate: false })).toBe('upgrade_required');
  });

  /**
   * Wave 2, S3: a published version is edited in place and the edit reaches the
   * enrollments already running in it. "Edit as a new draft" is gone, so the control a
   * published version offers is Edit, not Supersede — and a retired one offers neither.
   */
  it('edits a published version in place, and offers nothing on a retired one', () => {
    const state = (patch: Partial<SequenceState['versions'][number]>): SequenceState => ({
      ...EMPTY_SEQUENCE_STATE,
      online: true,
      mayMutate: true,
      isAdmin: true,
      versions: [{ ...draftVersion([emailStep(template().id)]), ...patch }],
      templates: [template()],
    });
    const live = sequenceScreen(state({ state: 'published', publishedAt: '2026-09-01T12:00:00.000Z' }));
    expect(live.versions[0]?.editable).toBe(true);
    expect(live.versions[0]?.canPublish).toBe(false);
    expect(live.versions[0]?.canRetire).toBe(true);

    const retired = sequenceScreen(state({ state: 'retired', publishedAt: '2026-09-01T12:00:00.000Z' }));
    expect(retired.versions[0]?.editable).toBe(false);
    expect(retired.versions[0]?.canPublish).toBe(false);
    expect(retired.versions[0]?.canRetire).toBe(false);
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

  it('refuses to offer approval for a body carrying an opt-out link, and offers it for the bare word', () => {
    const linked = sequenceScreen(
      state([
        template({
          approvedAt: null,
          body: `Unsubscribe here: https://mail.example.test/unsubscribe/1\n\n${FOOTER_SIGN_OFF}`,
        }),
      ]),
    );
    expect(linked.templates[0]?.optOutLinkMentioned).toBe(true);
    expect(linked.templates[0]?.canApprove).toBe(false);

    // David, 29 September 2026: the word is not the problem. "Reply unsubscribe" is the
    // sentence the old rule made unwritable, and it approves.
    const worded = sequenceScreen(
      state([
        template({
          approvedAt: null,
          body: `Just reply unsubscribe and I'll stop.\n\n${FOOTER_SIGN_OFF}`,
        }),
      ]),
    );
    expect(worded.templates[0]?.optOutLinkMentioned).toBe(false);
    expect(worded.templates[0]?.canApprove).toBe(true);
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

/**
 * Who is in flight (11.2; wave 2, S4.1).
 *
 * There is no hold review any more — an enrollment held a long time resumes on its own
 * — so the panel counts rather than asks. It counts per version of the sequence on
 * screen, and it names nobody: an enrollment's own fields are ids, and a raw UUID on
 * screen is a bug report a person cannot file.
 */
describe('the enrolled panel', () => {
  const version = sequenceVersionAnswer([emailStepAnswer(SEQUENCE_IDS.template)], { state: 'published' });
  const withEnrollments = (enrollments: readonly ReturnType<typeof enrollmentAnswer>[]) =>
    sequenceScreen({
      ...EMPTY_SEQUENCE_STATE,
      online: true,
      mayMutate: true,
      sequences: [sequenceSummaryAnswer()],
      selectedSequenceId: SEQUENCE_IDS.sequence,
      versions: [version],
      enrollments: [...enrollments],
    });

  it('counts the states of this sequence’s enrollments, per version', () => {
    const screen = withEnrollments([
      enrollmentAnswer(),
      enrollmentAnswer({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', state: 'completed' }),
      enrollmentAnswer({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', state: 'stopped' }),
    ]);
    expect(screen.enrollments?.summary).toBe('One person is working through this sequence.');
    expect(screen.enrollments?.rows).toEqual([
      { sequenceVersionId: SEQUENCE_IDS.version, line: 'Version 2 — 1 running, 1 finished, 1 stopped' },
    ]);
  });

  it('leaves out an enrollment in another sequence’s version', () => {
    const screen = withEnrollments([
      enrollmentAnswer({ sequenceVersionId: '77777777-7777-4777-8777-777777777777' }),
    ]);
    expect(screen.enrollments?.summary).toBe('Nobody is working through this sequence right now.');
    expect(screen.enrollments?.rows).toEqual([]);
  });

  it('is absent while no sequence is open', () => {
    expect(sequenceScreen({ ...EMPTY_SEQUENCE_STATE, online: true }).enrollments).toBeNull();
  });
});

describe('the bridge while offline (4.2)', () => {
  it('says offline when the read cannot reach the server (4.2)', async () => {
    const host = createSequenceBridge({
      api: {
        read: async () => await Promise.resolve({ ok: false, reason: 'offline', offline: true } as const),
        command: async () => await Promise.resolve({ ok: false, reason: 'offline', offline: true } as const),
      },
      session: {
        state: async () => await Promise.resolve({ online: false, mayMutate: true, device: { role: 'admin' as const } }),
      },
    });
    const state = await host.state();
    expect(state.online).toBe(false);
    expect(state.sequences).toEqual([]);
    expect(sequenceScreen(state).banner).toBe(OFFLINE_BANNER);
  });

  it('asks the server even when the session last found it away, so a returned connection is seen (wave 1)', async () => {
    const paths: string[] = [];
    const host = createSequenceBridge({
      api: {
        read: async (path: string) => {
          paths.push(path);
          return await Promise.resolve({ ok: false, reason: 'not_found', offline: false } as const);
        },
        command: async () => await Promise.resolve({ ok: false, reason: 'refused', offline: false } as const),
      },
      session: {
        state: async () => await Promise.resolve({ online: false, mayMutate: true, device: { role: 'admin' as const } }),
      },
    });
    const state = await host.state();
    expect(paths[0]).toBe('/sequences');
    expect(state.online).toBe(true);
    expect(sequenceScreen(state).banner).toBeNull();
  });
});

describe('the bridge reads what the routes answer (lane g78)', () => {
  /** The real transport, over a table of answers: the parse is the shipped one. */
  const bridgeOver = (answers: Readonly<Record<string, { status: number; body: unknown } | 'offline'>>) =>
    createSequenceBridge({
      api: createAuthedClient({
        baseUrl: 'https://api.example.test/',
        clientVersion: '1.0.5',
        accessToken: async () => await Promise.resolve({ token: 'token', generation: 0 }),
        send: async url => {
          const answer = answers[new URL(url).pathname];
          if (answer === 'offline') throw new Error('no route to host');
          return await Promise.resolve(answer ?? { status: 404, body: { error: 'not_found' } });
        },
      }),
      session: {
        state: async () => await Promise.resolve({ online: true, mayMutate: true, device: { role: 'admin' as const } }),
      },
    });

  const populated = {
    '/sequences': { status: 200, body: { sequences: [sequenceSummaryAnswer()] } },
    '/sequences/versions': {
      status: 200,
      body: { versions: [sequenceVersionAnswer([emailStepAnswer(SEQUENCE_IDS.template), callStepAnswer()])] },
    },
    '/templates': { status: 200, body: { templates: [templateVersionAnswer()] } },
    '/enrollments': {
      status: 200,
      body: {
        asOf: '2026-09-21T13:00:00.000Z',
        enrollments: [enrollmentAnswer(), enrollmentAnswer({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })],
      },
    },
  } as const;

  it('shows a populated version and its two enrollments, which 1.0.4 refused to parse (D01, D02)', async () => {
    const state = await bridgeOver(populated).state();
    expect(state.readErrors).toEqual({ sequences: null, versions: null, templates: null, enrollments: null });
    expect(state.versions).toHaveLength(1);
    expect(state.versions[0]?.steps.map(step => [step.ordinal, step.channel, step.sequenceVersionId])).toEqual([
      [1, 'email', SEQUENCE_IDS.version],
      [2, 'call_task', SEQUENCE_IDS.version],
    ]);
    expect(state.enrollments.map(entry => [entry.id, entry.opportunityId, entry.firmTimeZone])).toEqual([
      [SEQUENCE_IDS.enrollment, SEQUENCE_IDS.opportunity, 'America/New_York'],
      ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', SEQUENCE_IDS.opportunity, 'America/New_York'],
    ]);

    const screen = sequenceScreen(state);
    expect(screen.unread).toEqual([]);
    expect(screen.versions[0]?.steps.map(step => step.detail)).toEqual([
      'Template email',
      'Call task (move on if nobody answers)',
    ]);
    expect(screen.enrollments?.summary).toBe('2 people are working through this sequence.');
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
    expect(state.enrollments).toEqual([]);

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

/**
 * A LinkedIn step stored before 25 September 2026 (lane A2; wave 2, D6).
 *
 * Migration 0019 took the stored steps with the channel, and the API's own test says no
 * step goes out as `removed`. The wire contract keeps the variant for desktop 1.0.11, so
 * the type still admits one; the greyed row, its label, the publish refusal and the
 * "saving leaves this step out" hint went with 1.0.13, because nothing can produce one.
 * What is left is that such an answer is still read rather than refused, and that the
 * editor neither offers the channel nor sends it back.
 */
describe('a LinkedIn step stored before 25 September 2026 (lane A2)', () => {
  const bridgeOver = (answers: Readonly<Record<string, { status: number; body: unknown }>>) =>
    createSequenceBridge({
      api: createAuthedClient({
        baseUrl: 'https://api.example.test/',
        clientVersion: '1.0.5',
        accessToken: async () => await Promise.resolve({ token: 'token', generation: 0 }),
        send: async url => await Promise.resolve(answers[new URL(url).pathname] ?? { status: 404, body: { error: 'not_found' } }),
      }),
      session: {
        state: async () => await Promise.resolve({ online: true, mayMutate: true, device: { role: 'admin' as const } }),
      },
    });
  const published = sequenceVersionAnswer([callStepAnswer(1), removedLinkedInStepAnswer(2)], {
    state: 'published',
    publishedAt: '2026-09-01T12:00:00.000Z',
  });

  it('reads the versions answer instead of refusing it', async () => {
    const state = await bridgeOver({
      '/sequences': { status: 200, body: { sequences: [sequenceSummaryAnswer()] } },
      '/sequences/versions': { status: 200, body: { versions: [published] } },
      '/templates': { status: 200, body: { templates: [] } },
      '/enrollments': { status: 200, body: { asOf: '2026-09-25T13:00:00.000Z', enrollments: [] } },
    }).state();
    // Before lane A2 the whole answer failed to parse and the window said it could not read it.
    expect(state.readErrors.versions).toBeNull();
    expect(state.versions[0]?.steps.map(step => step.channel)).toEqual(['call_task', 'removed']);
    const [panel] = sequenceScreen(state).versions;
    expect(panel?.steps[1]?.detail).toBe('A step this version of Callie does not run');
  });

  it('keeps authoring closed: the editor neither holds, offers nor sends a LinkedIn step', () => {
    const draft = draftVersion([callStepAnswer(1), removedLinkedInStepAnswer(2)]);
    expect(EDITOR_CHANNELS).toEqual(['call_task', 'email']);
    const held = draftStepsOf(draft);
    expect(held.map(step => step.channel)).toEqual(['call_task']);
    expect(stepsForWire(held).map(step => step['channel'])).toEqual(['call_task']);
    // And no refusal of its own: the publish rules are the server's six, and this is not one.
    expect(publishRefusalFor(draft, [], { isAdmin: true, mayMutate: true })).toBeNull();
  });
});
