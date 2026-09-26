import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { listReplyCards, readReplyCard } from '../../classification/cards.ts';
import { classifyReplyWithModel } from '../../classification/classify.ts';
import { confirmReplyDisposition } from '../../classification/confirmations.ts';
import { CLASSIFIER_SYSTEM_PROMPT } from '../../classification/prompt.ts';
import { readClassifierSettings, updateClassifierSettings } from '../../classification/settings.ts';
import { CLASSIFIER_MODELS, CLASSIFIER_PROMPT_VERSION, MODEL_CAPABILITIES } from '../../classification/types.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { openHold } from '../../policy/holds.ts';
import { resolveAmbiguity } from '../../mail/matching.ts';
import { replyItemKey } from '../../mail/replyLane.ts';
import { businessDateOf } from '../../today/snapshots.ts';
import { REPLY_CORPUS } from '../corpus/replies/cases.ts';
import { seedAnotherFirm } from '../mail/support/mailWorld.ts';
import { createClassifierWorld, type ClassifierWorld } from './support/classifierWorld.ts';

/**
 * The reply card: what it contains, who may see it, and which command it offers
 * (specification 8.3, 8.2, Appendix F, Appendix G 8 and 14).
 */

let world: ClassifierWorld | null = null;

afterEach(async () => {
  await world?.stop();
  world = null;
});

const only = (...ids: readonly string[]) => REPLY_CORPUS.filter(c => ids.includes(c.id));

describe('the prompt is versioned by its bytes', () => {
  it('pins the system prompt to the version the corpus was recorded against', () => {
    // A changed prompt with an unchanged version would make two corpora look
    // comparable when they answer different questions. Editing the prompt means
    // bumping `CLASSIFIER_PROMPT_VERSION`, re-recording, and updating this digest.
    expect(createHash('sha256').update(CLASSIFIER_SYSTEM_PROMPT).digest('hex')).toBe(
      '352f2129d6eef61f819d19830af94bb6adfb191963301f6e8ab812dd3d82ef8c',
    );
    expect(CLASSIFIER_PROMPT_VERSION).toBe('g7b.replies.1');
  });

  it('carries nothing in the prompt that changes between two calls', () => {
    // The audit in docs/greenfield/classification.md, as an assertion: a date, a
    // firm name, a person or an id in the cached prefix is a cache that never hits.
    expect(CLASSIFIER_SYSTEM_PROMPT).not.toMatch(/\b20\d\d-\d\d-\d\d\b/u);
    expect(CLASSIFIER_SYSTEM_PROMPT).not.toContain('example.test');
    expect(CLASSIFIER_SYSTEM_PROMPT).not.toContain('Callie');
  });
});

describe('what a reply card contains (8.3)', () => {
  it('carries the message, the contact, the firm-wide impact and both layers’ signals', async () => {
    world = await createClassifierWorld({ cases: only('terse-human-reply') });
    const w = world;
    const messageId = w.messageIdOf('terse-human-reply');
    await classifyReplyWithModel(w.systemContext(), w.deps, { messageId });

    const card = await readReplyCard(w.context(), { messageId });
    expect(card).not.toBeNull();
    if (card === null) return;

    expect(card.from).toBe('reception@northwind.example.test');
    expect(card.subject).toBe('Re: hello');
    expect(card.body?.text).toContain('Tuesday works.');
    expect(card.firmId).toBe(w.mail.crm.alpha.firmId);
    expect(card.contactId).toBe(w.mail.crm.alpha.contactId);
    expect(card.contactName).not.toBeNull();

    expect(card.impact.controlMode).toBe('automated');
    expect(card.impact.ambiguous).toBe(false);
    expect(card.impact.contactsAtFirm).toBeGreaterThan(0);
    expect(card.impact.holds.map(hold => hold.reasonCode)).toEqual(['uncertain_reply']);
    expect(card.impact.holds[0]?.recoveryAction).toBe('confirm_reply');
    expect(card.impact.holds[0]?.recoverable).toBe(true);
    expect(card.impact.holds[0]?.blockedActionKinds).toEqual([
      'email_send',
      'call_task',
      'enrollment_advance',
    ]);

    // Both layers, labelled, so a reader can tell a rule from a suggestion.
    expect(card.signals.filter(signal => signal.layer === 'deterministic').length).toBeGreaterThan(0);
    expect(card.signals.filter(signal => signal.layer === 'model').map(signal => signal.evidence)).toContain(
      'human@0.88',
    );

    expect(card.proposedDisposition).toBe('interested');
    expect(card.confidence).toBeCloseTo(0.88, 3);
    expect(card.supportingExcerpt).toBe('Tuesday works.');
    expect(card.modelName).toBe('claude-opus-5');
    expect(card.promptVersion).toBe(CLASSIFIER_PROMPT_VERSION);
    expect(card.nextAction).toBe('confirm_disposition');
  });

  it('shows a member who is neither the assignee nor an admin the envelope and nothing else', async () => {
    world = await createClassifierWorld({ cases: only('terse-human-reply') });
    const w = world;
    const messageId = w.messageIdOf('terse-human-reply');
    await classifyReplyWithModel(w.systemContext(), w.deps, { messageId });

    // The workspace's admin is not this firm's assignee, but Appendix F gives an
    // admin the same row as the assignee. The other salesperson is the case that
    // matters, so the firm is reassigned to the admin and the salesperson reads it.
    await w.mail.database.session.query('UPDATE firms SET assigned_user_id = $2 WHERE workspace_id = $1 AND id = $3', [
      w.mail.seeded.alpha.workspaceId,
      w.mail.seeded.alpha.admin.userId,
      w.mail.crm.alpha.firmId,
    ]);
    const other = repositoryContext(
      workspaceScope(w.mail.seeded.alpha.workspaceId, {
        kind: 'user',
        userId: w.mail.seeded.alpha.salesperson.userId,
        role: 'salesperson',
      }),
      w.mail.database.session,
    );

    const card = await readReplyCard(other, { messageId });
    expect(card?.visibility).toBe('any_active_member');
    expect(card?.body).toBeNull();
    expect(card?.subject).toBeNull();
    expect(card?.contactName).toBeNull();
    // The excerpt is a quotation from the body, so it is redacted with it.
    expect(card?.supportingExcerpt).toBeNull();
    expect(card?.callbackProposal).toBeNull();
    // The impact is not private: a held firm is workflow status (Appendix F row 1).
    expect(card?.impact.holds.length).toBeGreaterThan(0);
    expect(card?.proposedDisposition).toBe('interested');
  });

  it('sends an ambiguous message to the resolution first, and refuses a confirmation (G 14)', async () => {
    world = await createClassifierWorld({ cases: only('terse-human-reply') });
    const w = world;
    const messageId = w.messageIdOf('terse-human-reply');

    // A second firm sharing the same address: 12.3's several plausible candidates.
    // Built after the fact, so the world is one shared fixture and this test owns
    // the ambiguity rather than every other test paying for it.
    const second = await seedAnotherFirm(w.mail, w.mail.seeded.alpha, {
      name: 'Second Test Holdings',
      address: 'reception@northwind.example.test',
    });
    const system = w.systemContext();
    for (const candidate of [
      { firmId: w.mail.crm.alpha.firmId, opportunityId: w.mail.crm.alpha.opportunityId, existing: true },
      { firmId: second.firmId, opportunityId: second.opportunityId, existing: false },
    ]) {
      const holdId = await openHold(system, {
        scopeKind: 'opportunity',
        scopeKey: candidate.opportunityId,
        reasonCode: 'ambiguous_match',
        blockedActionKinds: ['email_send', 'call_task', 'enrollment_advance'],
        sourceEventKind: 'mail_message',
        sourceEventId: messageId,
        recoveryAction: 'resolve_ambiguity',
      });
      if (candidate.existing) {
        await w.mail.database.session.query(
          `UPDATE mail_message_matches SET ambiguous = true, hold_id = $3
            WHERE workspace_id = $1 AND mail_message_id = $2`,
          [w.mail.seeded.alpha.workspaceId, messageId, holdId],
        );
      } else {
        await w.mail.database.session.query(
          `INSERT INTO mail_message_matches (workspace_id, mail_message_id, firm_id, opportunity_id,
                                             match_rule, ambiguous, hold_id)
           VALUES ($1, $2, $3, $4, 'participant', true, $5)`,
          [w.mail.seeded.alpha.workspaceId, messageId, candidate.firmId, candidate.opportunityId, holdId],
        );
      }
    }

    const card = await readReplyCard(w.context(), { messageId });
    expect(card?.impact.ambiguous).toBe(true);
    expect(card?.impact.candidates.length).toBe(2);
    expect(card?.nextAction).toBe('resolve_ambiguity');

    const refused = await confirmReplyDisposition(w.context(), {
      messageId,
      disposition: 'interested',
      journal: w.mail.journal,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe('ambiguity_unresolved');

    // After the resolution, the card offers the confirmation again.
    const resolved = await resolveAmbiguity(w.context(), {
      messageId,
      selectedOpportunityId: w.mail.crm.alpha.opportunityId,
      human: false,
    });
    expect(resolved.ok).toBe(true);
    const after = await readReplyCard(w.context(), { messageId });
    expect(after?.nextAction).toBe('confirm_disposition');
    expect(after?.opportunityId).toBe(w.mail.crm.alpha.opportunityId);
  });

  it('offers nothing to do for an automated message and a review for a bounce', async () => {
    world = await createClassifierWorld({
      cases: only('vacation-notice', 'terse-human-reply', 'delivery-status-notification'),
    });
    const w = world;
    const automated = await readReplyCard(w.context(), { messageId: w.messageIdOf('vacation-notice') });
    expect(automated?.nextAction).toBe('nothing_to_do');
    // 12.4: out-of-office bodies are not retained. The card has no body to show.
    expect(automated?.body).toBeNull();

    const bounce = await readReplyCard(w.context(), { messageId: w.messageIdOf('delivery-status-notification') });
    expect(bounce?.nextAction).toBe('review_bounce');
    expect(bounce?.impact.holds.map(hold => hold.reasonCode)).toContain('route_invalid');
  });
});

describe('the day’s reply lane', () => {
  it('reads the today items the mail lane promoted, under the key both lanes spell', async () => {
    world = await createClassifierWorld({ cases: only('terse-human-reply', 'referral') });
    const w = world;
    const card = await readReplyCard(w.context(), { messageId: w.messageIdOf('terse-human-reply') });
    const businessDate = await businessDateOf(w.context(), card?.receivedAt ?? '');

    const cards = await listReplyCards(w.context(), { businessDate });
    expect(cards.map(one => one.messageId).sort()).toEqual(
      [w.messageIdOf('terse-human-reply'), w.messageIdOf('referral')].sort(),
    );

    // The key this lane reads is the one the mail lane writes; a disagreement here
    // is a task nobody can close.
    const { rows } = await w.mail.database.session.query<{ item_key: string }>(
      "SELECT item_key FROM today_items WHERE workspace_id = $1 AND kind = 'reply' ORDER BY item_key",
      [w.mail.seeded.alpha.workspaceId],
    );
    expect(rows.map(row => row.item_key)).toContain(replyItemKey(w.messageIdOf('terse-human-reply')));
  });

  it('never crosses a workspace (Appendix G 8)', async () => {
    world = await createClassifierWorld({ cases: only('terse-human-reply') });
    const w = world;
    const messageId = w.messageIdOf('terse-human-reply');
    const betaContext = w.mail.userContext(w.mail.seeded.beta.workspaceId);
    expect(await readReplyCard(betaContext, { messageId })).toBeNull();

    const refused = await confirmReplyDisposition(betaContext, {
      messageId,
      disposition: 'interested',
      journal: w.mail.journal,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe('message_unknown');
  });
});

describe('the classifier configuration (10.1)', () => {
  it('defaults to Claude Opus 5 at low effort and is an admin’s to change', async () => {
    world = await createClassifierWorld({ cases: only('terse-human-reply') });
    const w = world;
    const defaults = await readClassifierSettings(w.context());
    expect(defaults).toMatchObject({ enabled: true, modelName: 'claude-opus-5', effort: 'low' });

    const refused = await updateClassifierSettings(w.context(), { modelName: 'claude-haiku-4-5' });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe('admin_only');

    const accepted = await updateClassifierSettings(w.adminContext(), {
      modelName: 'claude-haiku-4-5',
      effort: 'medium',
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value.modelName).toBe('claude-haiku-4-5');
    expect(accepted.value.updatedByUserId).toBe(w.mail.seeded.alpha.admin.userId);

    const { rows } = await w.mail.database.session.query<{ action: string; detail: Record<string, unknown> }>(
      "SELECT action, detail FROM audit_events WHERE workspace_id = $1 AND action = 'classifier.configured'",
      [w.mail.seeded.alpha.workspaceId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.detail['previousModel']).toBe('claude-opus-5');
  });

  it('refuses a model id the adapter has never been told about, and accepts both spellings of Haiku', async () => {
    world = await createClassifierWorld({ cases: only('terse-human-reply') });
    const w = world;
    // Every allowed id has a capability row, which is the actual rule: an id is
    // acceptable because the adapter knows what parameters it takes.
    for (const id of CLASSIFIER_MODELS) expect(MODEL_CAPABILITIES[id]).toBeDefined();
    // The dated Haiku snapshot and its alias are both real, and both accepted.
    for (const id of ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'] as const) {
      const accepted = await updateClassifierSettings(w.adminContext(), { modelName: id });
      expect(accepted.ok).toBe(true);
      if (accepted.ok) expect(accepted.value.modelName).toBe(id);
    }
    await expect(
      w.mail.database.session.query(
        'INSERT INTO classifier_settings (workspace_id, model_name) VALUES ($1, $2)',
        [w.mail.seeded.beta.workspaceId, 'claude-3-haiku-20240307'],
      ),
    ).rejects.toMatchObject({ constraint: 'classifier_settings_model_known' });
  });
});
