import { afterEach, describe, expect, it } from 'vitest';
import { readReplyCard } from '../../classification/cards.ts';
import { classifyReplyWithModel } from '../../classification/classify.ts';
import { confirmReplyDisposition } from '../../classification/confirmations.ts';
import { listClassifications } from '../../classification/store.ts';
import { readOpportunity } from '../../crm/pipeline.ts';
import { listApplicableHolds } from '../../policy/holds.ts';
import { isSuppressed } from '../../suppression/effective.ts';
import { REPLY_CORPUS } from '../corpus/replies/cases.ts';
import { createClassifierWorld, type ClassifierWorld } from './support/classifierWorld.ts';

/**
 * The authority boundary, as a test suite (specification 12.4, Appendix G 34 and 35).
 *
 * "The LLM may label and prioritize ordinary work but cannot by itself:
 *   - release a message as automated;
 *   - close an opportunity;
 *   - create a suppression from ambiguous language;
 *   - commit an extracted callback instant; or
 *   - resume automation."
 *
 * There is one `it` for each of those five, plus the two scenarios that name them.
 * Every one of them is written the same way: run the classifier over a message whose
 * recorded answer is the worst plausible one, then assert the *database* did not
 * move. Asserting the return value would only prove that this code path did not do
 * it; asserting the rows proves nothing else did either.
 */

let world: ClassifierWorld | null = null;

afterEach(async () => {
  await world?.stop();
  world = null;
});

const only = (...ids: readonly string[]) => REPLY_CORPUS.filter(c => ids.includes(c.id));

interface Counts {
  readonly holds: number;
  readonly suppressions: number;
  readonly manual: number;
  readonly callbacks: number;
  readonly confirmations: number;
  readonly openTodayItems: number;
}

async function countEverything(w: ClassifierWorld): Promise<Counts> {
  const workspaceId = w.mail.seeded.alpha.workspaceId;
  const one = async (sql: string): Promise<number> => {
    const { rows } = await w.mail.database.session.query<{ total: string }>(sql, [workspaceId]);
    return Number(rows[0]?.total ?? '0');
  };
  return {
    holds: await one('SELECT count(*)::text AS total FROM active_holds WHERE workspace_id = $1'),
    suppressions: await one('SELECT count(*)::text AS total FROM suppression_events WHERE workspace_id = $1'),
    manual: await one(
      "SELECT count(*)::text AS total FROM opportunities WHERE workspace_id = $1 AND control_mode = 'manual'",
    ),
    callbacks: await one('SELECT count(*)::text AS total FROM callbacks WHERE workspace_id = $1'),
    confirmations: await one('SELECT count(*)::text AS total FROM mail_reply_confirmations WHERE workspace_id = $1'),
    openTodayItems: await one(
      "SELECT count(*)::text AS total FROM today_items WHERE workspace_id = $1 AND status = 'open'",
    ),
  };
}

describe('what the model cannot do, whatever it answers (12.4)', () => {
  it('never releases a message as automated: Appendix G 34', async () => {
    world = await createClassifierWorld({ cases: only('false-automated') });
    const w = world;
    const messageId = w.messageIdOf('false-automated');
    const before = await countEverything(w);

    const report = await classifyReplyWithModel(w.systemContext(), w.deps, { messageId });
    expect(report.outcome).toBe('accepted');

    // The recorded answer is `automated` at 0.96. The row says `uncertain`.
    const rows = await listClassifications(w.systemContext(), messageId);
    const model = rows.find(row => row.layer === 'model');
    expect(model?.class).toBe('uncertain');
    expect(model?.confidence).toBeCloseTo(0.96, 3);
    // And the confident wrong label is still visible, as a signal and not an answer.
    expect(model?.signals.map(signal => signal.evidence)).toContain('automated@0.96');

    // The hold the reply opened when it arrived is still open, and nothing else moved.
    const after = await countEverything(w);
    expect(after).toEqual(before);
    const holds = await listApplicableHolds(w.systemContext(), {
      actionKind: 'email_send',
      opportunityId: w.mail.crm.alpha.opportunityId,
    });
    expect(holds.map(hold => hold.reasonCode)).toContain('uncertain_reply');
  });

  it('never creates a suppression from ambiguous language: Appendix G 35', async () => {
    world = await createClassifierWorld({ cases: only('ambiguous-opt-out', 'explicit-opt-out') });
    const w = world;
    const context = w.systemContext();

    // The explicit case suppressed on arrival, deterministically, before any model
    // ran: "explicit deterministic opt-out language suppresses immediately".
    const explicitCard = await readReplyCard(w.context(), { messageId: w.messageIdOf('explicit-opt-out') });
    expect(explicitCard?.deterministicClass).toBe('opt_out');
    expect(
      await isSuppressed(context, { scope: 'handle', canonicalKey: 'reception@northwind.example.test' }),
    ).not.toBeNull();

    const before = await countEverything(w);
    const report = await classifyReplyWithModel(context, w.deps, {
      messageId: w.messageIdOf('ambiguous-opt-out'),
    });
    expect(report.outcome).toBe('accepted');

    // The model called it an opt-out at 0.55 and nothing was suppressed by that.
    const card = await readReplyCard(w.context(), { messageId: w.messageIdOf('ambiguous-opt-out') });
    expect(card?.proposedDisposition).toBe('opt_out');
    expect(card?.deterministicClass).toBe('uncertain');
    expect(card?.requiresConfirmation).toBe(true);
    expect(card?.nextAction).toBe('confirm_disposition');
    expect(await countEverything(w)).toEqual(before);
  });

  it('never commits the callback instant it extracted', async () => {
    world = await createClassifierWorld({ cases: only('callback-proposal') });
    const w = world;
    const messageId = w.messageIdOf('callback-proposal');

    await classifyReplyWithModel(w.systemContext(), w.deps, { messageId });
    const card = await readReplyCard(w.context(), { messageId });
    // A proposal in the sender's own words, with no zone invented for it.
    expect(card?.callbackProposal).toEqual({
      localDateTime: 'after the 14th of January, mid afternoon',
      timeZone: null,
    });
    const { rows } = await w.mail.database.session.query<{ total: string }>(
      'SELECT count(*)::text AS total FROM callbacks WHERE workspace_id = $1',
      [w.mail.seeded.alpha.workspaceId],
    );
    expect(Number(rows[0]?.total)).toBe(0);

    // And a confirmation that does not carry an instant is refused rather than
    // quietly reading the proposal.
    const refused = await confirmReplyDisposition(w.context(), {
      messageId,
      disposition: 'follow_up_later',
      journal: w.mail.journal,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe('callback_required');
  });

  it('never closes an opportunity, and never sets one to manual by itself', async () => {
    world = await createClassifierWorld({ cases: only('terse-human-reply') });
    const w = world;
    await classifyReplyWithModel(w.systemContext(), w.deps, {
      messageId: w.messageIdOf('terse-human-reply'),
    });
    const opportunity = await readOpportunity(w.systemContext(), w.mail.crm.alpha.opportunityId);
    expect(opportunity?.control_mode).toBe('automated');
    expect(opportunity?.status).toBe('open');
  });

  it('never resumes automation: no hold is released by a classification', async () => {
    world = await createClassifierWorld({ cases: only('terse-human-reply') });
    const w = world;
    const context = w.systemContext();
    const holdsBefore = await listApplicableHolds(context, {
      actionKind: 'email_send',
      opportunityId: w.mail.crm.alpha.opportunityId,
    });
    expect(holdsBefore.length).toBeGreaterThan(0);

    await classifyReplyWithModel(context, w.deps, { messageId: w.messageIdOf('terse-human-reply') });

    const holdsAfter = await listApplicableHolds(context, {
      actionKind: 'email_send',
      opportunityId: w.mail.crm.alpha.opportunityId,
    });
    expect(holdsAfter.map(hold => hold.id)).toEqual(holdsBefore.map(hold => hold.id));
  });

  it('cannot be talked into any of it by the message itself', async () => {
    world = await createClassifierWorld({ cases: only('adversarial-instruction') });
    const w = world;
    const before = await countEverything(w);
    const report = await classifyReplyWithModel(w.systemContext(), w.deps, {
      messageId: w.messageIdOf('adversarial-instruction'),
    });
    expect(report.outcome).toBe('accepted');
    expect(await countEverything(w)).toEqual(before);
    const card = await readReplyCard(w.context(), { messageId: w.messageIdOf('adversarial-instruction') });
    expect(card?.deterministicClass).toBe('uncertain');
    expect(card?.proposedDisposition).toBeNull();
  });

  it('cannot write a model row that decides, even when the code is asked to', async () => {
    world = await createClassifierWorld({ cases: only('terse-human-reply') });
    const w = world;
    // The wall under the code: `mail_message_classifications_model_cannot_decide`.
    await expect(
      w.mail.database.session.query(
        `INSERT INTO mail_message_classifications (workspace_id, mail_message_id, layer, class,
                                                   requires_confirmation, rules_version, model_name, prompt_version)
         VALUES ($1, $2, 'model', 'human', false, 'reply.1', 'claude-opus-5', 'g7b.replies.1')`,
        [w.mail.seeded.alpha.workspaceId, w.messageIdOf('terse-human-reply')],
      ),
    ).rejects.toMatchObject({ constraint: 'mail_message_classifications_model_cannot_decide' });
  });

  it('cannot confirm a disposition as the worker', async () => {
    world = await createClassifierWorld({ cases: only('terse-human-reply') });
    const w = world;
    const outcome = await confirmReplyDisposition(w.systemContext(), {
      messageId: w.messageIdOf('terse-human-reply'),
      disposition: 'interested',
      journal: w.mail.journal,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('invalid_input');
  });
});

describe('Appendix G 34: malformed output becomes uncertain', () => {
  it.each([
    ['malformed-output', 'malformed'],
    ['schema-invalid-output', 'schema_invalid'],
    ['refused-answer', 'refusal'],
    ['fabricated-excerpt', 'excerpt_unverified'],
    ['provider-error', 'provider_error'],
  ])('records %s as %s and leaves the message exactly as it was', async (caseId, expected) => {
    world = await createClassifierWorld({ cases: only(caseId) });
    const w = world;
    const messageId = w.messageIdOf(caseId);
    const before = await countEverything(w);

    const report = await classifyReplyWithModel(w.systemContext(), w.deps, { messageId });
    expect(report.outcome).toBe(expected);
    expect(report.classification?.class).toBe('uncertain');
    expect(report.recorded).toBe(false);

    // No model row at all: a failed answer is not a second opinion.
    const rows = await listClassifications(w.systemContext(), messageId);
    expect(rows.some(row => row.layer === 'model')).toBe(false);

    // The attempt is recorded, so the dashboard can see the failure rate.
    const { rows: calls } = await w.mail.database.session.query<{ outcome: string; request_sent: boolean }>(
      'SELECT outcome, request_sent FROM mail_classification_calls WHERE workspace_id = $1 AND mail_message_id = $2',
      [w.mail.seeded.alpha.workspaceId, messageId],
    );
    expect(calls.map(call => call.outcome)).toEqual([expected]);
    expect(calls[0]?.request_sent).toBe(true);

    expect(await countEverything(w)).toEqual(before);
  });
});

describe('the classifier switched off (the brief: FSS_CLASSIFIER=off)', () => {
  it('sends no request and leaves every message uncertain, at the process level', async () => {
    world = await createClassifierWorld({ cases: only('terse-human-reply'), processEnabled: false });
    const w = world;
    const report = await classifyReplyWithModel(w.systemContext(), w.deps, {
      messageId: w.messageIdOf('terse-human-reply'),
    });
    expect(report.outcome).toBe('disabled');
    expect(report.classification?.class).toBe('uncertain');
    expect(w.transport.calls.length).toBe(0);

    const { rows } = await w.mail.database.session.query<{ request_sent: boolean; input_tokens: number }>(
      'SELECT request_sent, input_tokens FROM mail_classification_calls WHERE workspace_id = $1',
      [w.mail.seeded.alpha.workspaceId],
    );
    expect(rows[0]?.request_sent).toBe(false);
    expect(rows[0]?.input_tokens).toBe(0);
  });

  it('does the same when an admin turned it off for the workspace', async () => {
    world = await createClassifierWorld({ cases: only('terse-human-reply'), settings: { enabled: false } });
    const w = world;
    const report = await classifyReplyWithModel(w.systemContext(), w.deps, {
      messageId: w.messageIdOf('terse-human-reply'),
    });
    expect(report.outcome).toBe('disabled');
    expect(w.transport.calls.length).toBe(0);
  });

  it('stops at the daily cap rather than spending past it', async () => {
    world = await createClassifierWorld({ cases: only('terse-human-reply'), settings: { dailyCallCap: 0 } });
    const w = world;
    const report = await classifyReplyWithModel(w.systemContext(), w.deps, {
      messageId: w.messageIdOf('terse-human-reply'),
    });
    expect(report.outcome).toBe('capped');
    expect(w.transport.calls.length).toBe(0);
  });
});
