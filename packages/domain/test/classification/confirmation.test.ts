import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyReplyWithModel,
  confirmReplyDisposition,
  listReplyCards,
  readReplyCard,
} from '../../classification/index.ts';
import { readOpportunity } from '../../crm/index.ts';
import { listApplicableHolds } from '../../policy/holds.ts';
import { isSuppressed } from '../../suppression/index.ts';
import { businessDateOf } from '../../today/index.ts';
import { REPLY_CORPUS } from '../corpus/replies/cases.ts';
import { createClassifierWorld, type ClassifierWorld } from './support/classifierWorld.ts';

/**
 * A person confirming or correcting the card (specification 8.3, 7.3, 12.4,
 * Appendix A "Confirm disposition").
 *
 * The suite in `authority.test.ts` says what the model may not do. This one says
 * what a person may, which is the other half of the same rule: the consequences
 * 8.3 lists happen here, once, audited, and only the ones the disposition permits.
 */

let world: ClassifierWorld | null = null;

afterEach(async () => {
  await world?.stop();
  world = null;
});

const only = (...ids: readonly string[]) => REPLY_CORPUS.filter(c => ids.includes(c.id));

async function classified(caseId: string): Promise<ClassifierWorld> {
  const w = await createClassifierWorld({ cases: only(caseId) });
  await classifyReplyWithModel(w.systemContext(), w.deps, { messageId: w.messageIdOf(caseId) });
  return w;
}

describe('confirming the preselected disposition', () => {
  it('sets the firm manual, releases this message’s holds, and finishes the today item', async () => {
    world = await classified('terse-human-reply');
    const w = world;
    const messageId = w.messageIdOf('terse-human-reply');

    const before = await readReplyCard(w.context(), { messageId });
    expect(before?.proposedDisposition).toBe('interested');
    expect(before?.proposedBy).toBe('model');
    expect(before?.nextAction).toBe('confirm_disposition');
    expect(before?.impact.holds.map(hold => hold.reasonCode)).toContain('uncertain_reply');

    const outcome = await confirmReplyDisposition(w.context(), {
      messageId,
      disposition: 'interested',
      journal: w.mail.journal,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.confirmation.corrected).toBe(false);
    expect(outcome.value.confirmation.suggestedBy).toBe('model');
    expect([...outcome.value.confirmation.consequences].sort()).toEqual([
      'holds_released',
      'opportunity_manual',
      'today_item_completed',
    ]);
    expect(outcome.value.suggestsLost).toBe(false);

    // 7.3: a confirmed human reply sets manual, and automation never reverses it.
    const opportunity = await readOpportunity(w.systemContext(), w.mail.crm.alpha.opportunityId);
    expect(opportunity?.control_mode).toBe('manual');

    const holds = await listApplicableHolds(w.systemContext(), {
      actionKind: 'email_send',
      opportunityId: w.mail.crm.alpha.opportunityId,
    });
    expect(holds.map(hold => hold.reasonCode)).not.toContain('uncertain_reply');

    const after = await readReplyCard(w.context(), { messageId });
    expect(after?.nextAction).toBe('nothing_to_do');
    expect(after?.requiresConfirmation).toBe(false);
    expect(after?.confirmation?.disposition).toBe('interested');

    // The card leaves the day's list, because the task is done.
    const businessDate = await businessDateOf(w.context(), before?.receivedAt ?? '');
    const cards = await listReplyCards(w.context(), { businessDate });
    expect(cards.map(card => card.messageId)).not.toContain(messageId);
  });

  it('is refused a second time rather than quietly replacing the first', async () => {
    world = await classified('terse-human-reply');
    const w = world;
    const messageId = w.messageIdOf('terse-human-reply');
    const first = await confirmReplyDisposition(w.context(), {
      messageId,
      disposition: 'interested',
      journal: w.mail.journal,
    });
    expect(first.ok).toBe(true);
    const second = await confirmReplyDisposition(w.context(), {
      messageId,
      disposition: 'not_interested',
      journal: w.mail.journal,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('already_confirmed');
  });

  it('records a correction as a correction, and audits it as one (12.4)', async () => {
    world = await classified('terse-human-reply');
    const w = world;
    const messageId = w.messageIdOf('terse-human-reply');
    const outcome = await confirmReplyDisposition(w.context(), {
      messageId,
      disposition: 'referral_or_wrong_person',
      note: 'They meant their colleague.',
      journal: w.mail.journal,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.confirmation.corrected).toBe(true);
    expect(outcome.value.confirmation.suggestedDisposition).toBe('interested');

    const { rows } = await w.mail.database.session.query<{ action: string; detail: Record<string, unknown> }>(
      `SELECT action, detail FROM audit_events
        WHERE workspace_id = $1 AND subject_kind = 'mail_message' AND subject_id = $2`,
      [w.mail.seeded.alpha.workspaceId, messageId],
    );
    expect(rows.map(row => row.action)).toContain('reply.disposition_corrected');
    const detail = rows.find(row => row.action === 'reply.disposition_corrected')?.detail;
    expect(detail?.['suggestedBy']).toBe('model');
    expect(detail?.['modelName']).toBe('claude-opus-5');
    expect(detail?.['confidence']).toBeCloseTo(0.88, 3);
  });

  it('suggests Lost and never closes the opportunity (9.1)', async () => {
    world = await classified('terse-human-reply');
    const w = world;
    const outcome = await confirmReplyDisposition(w.context(), {
      messageId: w.messageIdOf('terse-human-reply'),
      disposition: 'not_interested',
      journal: w.mail.journal,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.suggestsLost).toBe(true);
    const opportunity = await readOpportunity(w.systemContext(), w.mail.crm.alpha.opportunityId);
    expect(opportunity?.status).toBe('open');
    expect(opportunity?.control_mode).toBe('manual');
  });
});

describe('Appendix G 35: ambiguous opt-out wording holds for review', () => {
  it('suppresses only when the person confirms it, and only as widely as they said', async () => {
    world = await classified('ambiguous-opt-out');
    const w = world;
    const context = w.systemContext();
    const messageId = w.messageIdOf('ambiguous-opt-out');

    // Nothing yet: the model called it an opt-out and the model does not decide.
    expect(
      await isSuppressed(context, { scope: 'handle', canonicalKey: 'reception@northwind.example.test' }),
    ).toBeNull();

    const outcome = await confirmReplyDisposition(w.context(), {
      messageId,
      disposition: 'opt_out',
      journal: w.mail.journal,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.confirmation.consequences).toContain('handle_suppressed');
    expect(outcome.value.confirmation.consequences).not.toContain('firm_suppressed');

    expect(
      await isSuppressed(context, { scope: 'handle', canonicalKey: 'reception@northwind.example.test' }),
    ).not.toBeNull();
    // The firm is not suppressed: the person said the address, not the company.
    expect(await isSuppressed(context, { scope: 'firm', canonicalKey: w.mail.crm.alpha.firmId })).toBeNull();

    // 10.2: the object-locked journal is written before the row.
    expect(w.mail.journal.appended.length).toBeGreaterThan(0);
  });

  it('suppresses the firm when the person says the request covers all contact', async () => {
    world = await classified('ambiguous-opt-out');
    const w = world;
    const outcome = await confirmReplyDisposition(w.context(), {
      messageId: w.messageIdOf('ambiguous-opt-out'),
      disposition: 'opt_out',
      firmWideOptOut: true,
      journal: w.mail.journal,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.confirmation.consequences).toContain('firm_suppressed');
    expect(
      await isSuppressed(w.systemContext(), { scope: 'firm', canonicalKey: w.mail.crm.alpha.firmId }),
    ).not.toBeNull();
  });
});

describe('committing a callback the model only proposed', () => {
  it('writes the callback the person supplied, and names it as the consequence', async () => {
    world = await classified('callback-proposal');
    const w = world;
    const outcome = await confirmReplyDisposition(w.context(), {
      messageId: w.messageIdOf('callback-proposal'),
      disposition: 'follow_up_later',
      callback: {
        localDate: '2027-01-15',
        localTime: '14:30',
        sourceTimeZone: 'America/New_York',
        dueAt: '2027-01-15T19:30:00.000Z',
      },
      journal: w.mail.journal,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.confirmation.consequences).toContain('callback_committed');
    expect(outcome.value.confirmation.callbackId).not.toBeNull();

    const { rows } = await w.mail.database.session.query<{
      requested_local_date: Date;
      source_time_zone: string;
      confirmed_by_user_id: string | null;
    }>(
      'SELECT requested_local_date, source_time_zone, confirmed_by_user_id FROM callbacks WHERE workspace_id = $1',
      [w.mail.seeded.alpha.workspaceId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.source_time_zone).toBe('America/New_York');
    // Appendix D stores the local wall clock, the zone and the instant. And a person.
    expect(rows[0]?.confirmed_by_user_id).toBe(w.mail.seeded.alpha.salesperson.userId);
  });

  it('refuses a callback on any other disposition', async () => {
    world = await classified('terse-human-reply');
    const w = world;
    const outcome = await confirmReplyDisposition(w.context(), {
      messageId: w.messageIdOf('terse-human-reply'),
      disposition: 'interested',
      callback: {
        localDate: '2027-01-15',
        sourceTimeZone: 'America/New_York',
        dueAt: '2027-01-15T19:30:00.000Z',
      },
      journal: w.mail.journal,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('callback_not_permitted');
  });
});
