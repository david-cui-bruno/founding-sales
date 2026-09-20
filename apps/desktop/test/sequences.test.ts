import { describe, expect, it } from 'vitest';
import type { ApiOutcome } from '../src/main/apiClient.ts';
import type { AuthedClient } from '../src/main/authedClient.ts';
import { createSequenceBridge, isOpenableProfile } from '../src/main/sequenceBridge.ts';
import type { SequenceState, TemplateVersion } from '../src/renderer/sequenceContract.ts';
import {
  EMPTY_SEQUENCE_STATE,
  publishRefusalFor,
  remainingUndoMilliseconds,
  sequenceScreen,
} from '../src/renderer/sequenceView.ts';

/**
 * The sequence editor's rules, without Electron and without a database
 * (specification 11.1, 11.3, 4.3, 14.2).
 *
 * The view model is pure, so every "can this be done" is a function call here; the
 * bridge takes its API and its two side effects as ports, so the LinkedIn handoff is
 * a recorded clipboard write and a recorded browser open.
 *
 * No real person, firm or profile appears. `example.test` is reserved by RFC 6761,
 * and the one LinkedIn URL is an obviously fictional path.
 */

const HASH = 'a'.repeat(64);
const FOOTER_SIGN_OFF = 'Sam Example';
const FOOTER_POSTAL = '1 Example Way';
const STOP_LINE = 'Reply "stop" and I will not email you again.';

const template = (patch: Partial<TemplateVersion> = {}): TemplateVersion => ({
  id: '11111111-1111-4111-8111-111111111111',
  templateId: '22222222-2222-4222-8222-222222222222',
  version: 1,
  name: 'First touch',
  subject: 'A question',
  body: `Hello,\n\n${FOOTER_SIGN_OFF}\n${FOOTER_POSTAL}\n${STOP_LINE}`,
  contentHash: HASH,
  footerSignOff: FOOTER_SIGN_OFF,
  footerPostalAddress: FOOTER_POSTAL,
  requiredVariables: [],
  approvedAt: '2026-09-01T12:00:00.000Z',
  retiredAt: null,
  personalizationStrategy: 'deterministic',
  ...patch,
});

const draftVersion = (steps: SequenceState['versions'][number]['steps']) => ({
  id: '33333333-3333-4333-8333-333333333333',
  sequenceId: '44444444-4444-4444-8444-444444444444',
  version: 2,
  state: 'draft' as const,
  stopConditions: ['human_reply', 'stage_closed'],
  publishedAt: null,
  retiredAt: null,
  steps,
});

const emailStep = (templateVersionId: string | null, ordinal = 1) => ({
  id: `55555555-5555-4555-8555-55555555555${String(ordinal)}`,
  ordinal,
  channel: 'email' as const,
  delay: { unit: 'elapsed' as const, hours: 0 },
  onNoAnswer: null,
  templateVersionId,
  linkedInMessage: null,
});

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
          body: `Unsubscribe here.\n\n${FOOTER_SIGN_OFF}\n${FOOTER_POSTAL}\n${STOP_LINE}`,
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
        {
          id: '88888888-8888-4888-8888-888888888888',
          sequenceVersionId: '33333333-3333-4333-8333-333333333333',
          firmId: '99999999-9999-4999-8999-999999999999',
          contactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          state: 'review_required',
          startedAt: '2026-09-01T12:00:00.000Z',
          endedAt: null,
          endReason: null,
          reviewUnionMilliseconds: 9 * 86_400_000,
        },
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          sequenceVersionId: '33333333-3333-4333-8333-333333333333',
          firmId: '99999999-9999-4999-8999-999999999999',
          contactId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          state: 'active',
          startedAt: '2026-09-01T12:00:00.000Z',
          endedAt: null,
          endReason: null,
          reviewUnionMilliseconds: null,
        },
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
    answers.set('/enrollments/linkedin/complete', {
      ok: true,
      value: {
        stepExecutionId: '66666666-6666-4666-8666-666666666666',
        linkedInUrl: 'https://www.linkedin.com/in/dana-example-000',
        message: 'A short note.',
        undoUntil: '2026-09-21T13:10:00.000Z',
      },
    });

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
