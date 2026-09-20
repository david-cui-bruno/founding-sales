import type { SessionQueryable } from '../../../db/queryable.ts';
import type { TwoWorkspaces } from './fixtures.ts';
import type { SeededCrm } from './crmFixtures.ts';
import type { SeededMail } from './mailFixtures.ts';

/**
 * A failing insert for every constraint migration 0011 adds (lane G7b: the model
 * layer's three columns, the workspace's classifier settings, the append-only call
 * log and the salesperson's confirmed disposition).
 *
 * Same rules as `mailCases.ts`: its own file so two lanes never edit the middle of
 * one array, each case inside a transaction the caller rolls back, and each row
 * breaking exactly one thing.
 *
 * No real person, address, firm or credential appears here, and no API key shape:
 * the only model ids are the two public names `classifier_settings_model_known`
 * allows.
 */

export interface ClassificationCaseFixture {
  readonly session: SessionQueryable;
  readonly seeded: TwoWorkspaces;
  readonly crm: SeededCrm;
  readonly mail: SeededMail;
}

export interface ClassificationCase {
  readonly constraint: string;
  readonly run: (fixture: ClassificationCaseFixture) => Promise<unknown>;
}

const workspace = (f: ClassificationCaseFixture): string => f.seeded.alpha.workspaceId;
const salesperson = (f: ClassificationCaseFixture): string => f.seeded.alpha.salesperson.userId;
const otherWorkspaceUser = (f: ClassificationCaseFixture): string => f.seeded.beta.salesperson.userId;
const message = (f: ClassificationCaseFixture): string => f.mail.alpha.messageId;
const firm = (f: ClassificationCaseFixture): string => f.crm.alpha.firmId;
const opportunity = (f: ClassificationCaseFixture): string => f.crm.alpha.opportunityId;

/** A syntactically valid UUID that is never a row. */
const MISSING = '00000000-0000-4000-8000-000000000000';

/**
 * One model-layer classification row with one extra column spliced in. Every "model
 * layer" case below is the same insert with a different last column, so the shared
 * part is written once and the case is the one value that breaks something.
 */
async function modelRow(
  f: ClassificationCaseFixture,
  column: string,
  value: string,
): Promise<unknown> {
  return await f.session.query(
    `INSERT INTO mail_message_classifications (workspace_id, mail_message_id, layer, class,
                                               requires_confirmation, rules_version, model_name,
                                               prompt_version, ${column})
     VALUES ($1, $2, 'model', 'uncertain', true, 'reply.1', 'claude-opus-5', 'g7b.replies.1', ${value})`,
    [workspace(f), message(f)],
  );
}

/** A settings row for the alpha workspace, with one column overridden. */
async function settings(
  f: ClassificationCaseFixture,
  column: string,
  value: string,
): Promise<unknown> {
  return await f.session.query(
    `INSERT INTO classifier_settings (workspace_id, ${column}) VALUES ($1, ${value})`,
    [workspace(f)],
  );
}

/** A call row for the alpha workspace's seeded message, with overrides spliced in. */
async function call(
  f: ClassificationCaseFixture,
  columns: string,
  values: string,
): Promise<unknown> {
  return await f.session.query(
    `INSERT INTO mail_classification_calls
       (workspace_id, mail_message_id, model_name, prompt_version, request_sent, outcome,
        business_date${columns === '' ? '' : `, ${columns}`})
     VALUES ($1, $2, 'claude-opus-5', 'g7b.replies.1', true, 'accepted',
             DATE '2026-09-02'${values === '' ? '' : `, ${values}`})`,
    [workspace(f), message(f)],
  );
}

export const CLASSIFICATION_CONSTRAINT_CASES: readonly ClassificationCase[] = [
  // ------------------------------- mail_message_classifications, the new columns
  {
    // 12.4: the excerpt, the callback proposal and the effort belong to the model
    // layer. A deterministic row that carried one would be a rule claiming to have
    // quoted something.
    constraint: 'mail_message_classifications_suggestion_is_the_model_layer',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_message_classifications (workspace_id, mail_message_id, layer, class,
                                                   requires_confirmation, rules_version, supporting_excerpt)
         VALUES ($1, $2, 'deterministic', 'uncertain', true, 'reply.1', 'a quoted sentence')`,
        [workspace(f), message(f)],
      ),
  },
  {
    constraint: 'mail_message_classifications_excerpt_bounded',
    run: async f => await modelRow(f, 'supporting_excerpt', "'   '"),
  },
  {
    constraint: 'mail_message_classifications_callback_proposal_is_object',
    run: async f => await modelRow(f, 'callback_proposal', `'["next tuesday"]'::jsonb`),
  },
  {
    constraint: 'mail_message_classifications_effort_known',
    run: async f => await modelRow(f, 'effort', "'enormous'"),
  },

  // ------------------------------------------------------------ classifier_settings
  {
    constraint: 'classifier_settings_pkey',
    run: async f => {
      await f.session.query('INSERT INTO classifier_settings (workspace_id) VALUES ($1)', [workspace(f)]);
      return await f.session.query('INSERT INTO classifier_settings (workspace_id) VALUES ($1)', [workspace(f)]);
    },
  },
  {
    constraint: 'classifier_settings_workspace_id_fkey',
    run: async f =>
      await f.session.query('INSERT INTO classifier_settings (workspace_id) VALUES ($1)', [MISSING]),
  },
  {
    // The updater is a member of *this* workspace. Appendix G 8: nothing crosses.
    constraint: 'classifier_settings_updater_fkey',
    run: async f =>
      await f.session.query(
        'INSERT INTO classifier_settings (workspace_id, updated_by_user_id) VALUES ($1, $2)',
        [workspace(f), otherWorkspaceUser(f)],
      ),
  },
  {
    // An old model this workspace will not call. The allow-list is the only thing
    // between a typo in an admin's configuration and a request that fails at the
    // provider on every classification until somebody notices.
    constraint: 'classifier_settings_model_known',
    run: async f => await settings(f, 'model_name', "'claude-3-haiku-20240307'"),
  },
  {
    constraint: 'classifier_settings_effort_known',
    run: async f => await settings(f, 'effort', "'exhaustive'"),
  },
  {
    constraint: 'classifier_settings_output_bounded',
    run: async f => await settings(f, 'max_output_tokens', '8'),
  },
  {
    constraint: 'classifier_settings_cap_bounded',
    run: async f => await settings(f, 'daily_call_cap', '-1'),
  },

  // ------------------------------------------------------ mail_classification_calls
  {
    constraint: 'mail_classification_calls_pkey',
    run: async f => {
      const first = await f.session.query<{ id: string }>(
        `INSERT INTO mail_classification_calls
           (workspace_id, mail_message_id, model_name, prompt_version, request_sent, outcome, business_date)
         VALUES ($1, $2, 'claude-opus-5', 'g7b.replies.1', true, 'accepted', DATE '2026-09-02')
         RETURNING id`,
        [workspace(f), message(f)],
      );
      return await f.session.query(
        `INSERT INTO mail_classification_calls
           (id, workspace_id, mail_message_id, model_name, prompt_version, request_sent, outcome, business_date)
         VALUES ($1, $2, $3, 'claude-opus-5', 'g7b.replies.1', true, 'accepted', DATE '2026-09-03')`,
        [first.rows[0]?.id, workspace(f), message(f)],
      );
    },
  },
  {
    constraint: 'mail_classification_calls_message_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_classification_calls
           (workspace_id, mail_message_id, model_name, prompt_version, request_sent, outcome, business_date)
         VALUES ($1, $2, 'claude-opus-5', 'g7b.replies.1', true, 'accepted', DATE '2026-09-02')`,
        [workspace(f), MISSING],
      ),
  },
  {
    constraint: 'mail_classification_calls_outcome_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_classification_calls
           (workspace_id, mail_message_id, model_name, prompt_version, request_sent, outcome, business_date)
         VALUES ($1, $2, 'claude-opus-5', 'g7b.replies.1', true, 'shrugged', DATE '2026-09-02')`,
        [workspace(f), message(f)],
      ),
  },
  {
    constraint: 'mail_classification_calls_effort_known',
    run: async f => await call(f, 'effort', "'enormous'"),
  },
  {
    constraint: 'mail_classification_calls_prompt_version_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_classification_calls
           (workspace_id, mail_message_id, model_name, prompt_version, request_sent, outcome, business_date)
         VALUES ($1, $2, 'claude-opus-5', 'Prompt Version One', true, 'accepted', DATE '2026-09-02')`,
        [workspace(f), message(f)],
      ),
  },
  {
    constraint: 'mail_classification_calls_counts_are_not_negative',
    run: async f => await call(f, 'output_tokens', '-1'),
  },
  {
    // An attempt that sent nothing spent nothing: the dashboard must not be able to
    // show a cost for a classifier nobody switched on.
    constraint: 'mail_classification_calls_unsent_spent_nothing',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_classification_calls
           (workspace_id, mail_message_id, model_name, prompt_version, request_sent, outcome,
            input_tokens, business_date)
         VALUES ($1, $2, 'claude-opus-5', 'g7b.replies.1', false, 'disabled', 1500, DATE '2026-09-02')`,
        [workspace(f), message(f)],
      ),
  },
  {
    constraint: 'mail_classification_calls_unsent_outcome',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_classification_calls
           (workspace_id, mail_message_id, model_name, prompt_version, request_sent, outcome, business_date)
         VALUES ($1, $2, 'claude-opus-5', 'g7b.replies.1', true, 'disabled', DATE '2026-09-02')`,
        [workspace(f), message(f)],
      ),
  },
  {
    constraint: 'mail_classification_calls_refusal_category_is_a_refusal',
    run: async f => await call(f, 'refusal_category', "'cyber'"),
  },

  // ------------------------------------------------------ mail_reply_confirmations
  {
    constraint: 'mail_reply_confirmations_pkey',
    run: async f => {
      const first = await confirmation(f, {});
      return await f.session.query(
        `INSERT INTO mail_reply_confirmations
           (id, workspace_id, mail_message_id, firm_id, opportunity_id, disposition,
            suggested_disposition, suggested_by, corrected, confirmed_by_user_id)
         VALUES ($1, $2, $3, $4, $5, 'interested', 'interested', 'model', false, $6)`,
        [first, workspace(f), message(f), firm(f), opportunity(f), salesperson(f)],
      );
    },
  },
  {
    constraint: 'mail_reply_confirmations_message_fkey',
    run: async f => await confirmation(f, { messageId: MISSING }),
  },
  {
    constraint: 'mail_reply_confirmations_opportunity_fkey',
    run: async f => await confirmation(f, { opportunityId: MISSING }),
  },
  {
    constraint: 'mail_reply_confirmations_callback_fkey',
    run: async f =>
      await confirmation(f, { callbackId: MISSING, consequences: "ARRAY['callback_committed']::text[]" }),
  },
  {
    // The authority boundary as a foreign key: a confirmation belongs to a member of
    // this workspace, so the worker's `system` actor has nobody to be.
    constraint: 'mail_reply_confirmations_confirmer_fkey',
    run: async f => await confirmation(f, { userId: otherWorkspaceUser(f) }),
  },
  {
    constraint: 'mail_reply_confirmations_one_per_message',
    run: async f => {
      await confirmation(f, {});
      return await confirmation(f, {});
    },
  },
  {
    constraint: 'mail_reply_confirmations_disposition_known',
    run: async f => await confirmation(f, { disposition: 'enthusiastic' }),
  },
  {
    constraint: 'mail_reply_confirmations_suggested_disposition_known',
    run: async f =>
      await confirmation(f, { suggested: 'enthusiastic', disposition: 'interested', corrected: true }),
  },
  {
    constraint: 'mail_reply_confirmations_suggested_by_known',
    run: async f => await confirmation(f, { suggestedBy: 'a hunch' }),
  },
  {
    // A correction that recorded itself as a confirmation would make 12.4's "a
    // corrected classification is audited" unauditable.
    constraint: 'mail_reply_confirmations_corrected_agrees',
    run: async f =>
      await confirmation(f, { suggested: 'interested', disposition: 'not_interested', corrected: false }),
  },
  {
    constraint: 'mail_reply_confirmations_consequences_known',
    run: async f => await confirmation(f, { consequences: "ARRAY['opportunity_closed']::text[]" }),
  },
  {
    constraint: 'mail_reply_confirmations_callback_is_a_consequence',
    run: async f => await confirmation(f, { consequences: "ARRAY['callback_committed']::text[]" }),
  },
  {
    constraint: 'mail_reply_confirmations_note_bounded',
    run: async f => await confirmation(f, { note: '   ' }),
  },
];

interface ConfirmationOverrides {
  readonly messageId?: string;
  readonly opportunityId?: string;
  readonly userId?: string;
  readonly disposition?: string;
  readonly suggested?: string | null;
  readonly suggestedBy?: string;
  readonly corrected?: boolean;
  readonly consequences?: string;
  readonly callbackId?: string;
  readonly note?: string;
}

/** One confirmation row, defaulting to a valid one, returning its id. */
async function confirmation(f: ClassificationCaseFixture, over: ConfirmationOverrides): Promise<string> {
  const disposition = over.disposition ?? 'interested';
  const suggested = over.suggested === undefined ? disposition : over.suggested;
  const corrected = over.corrected ?? suggested !== disposition;
  const { rows } = await f.session.query<{ id: string }>(
    `INSERT INTO mail_reply_confirmations
       (workspace_id, mail_message_id, firm_id, opportunity_id, disposition, suggested_disposition,
        suggested_by, corrected, confirmed_by_user_id, consequences, callback_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ${over.consequences ?? "'{}'::text[]"}, $10, $11)
     RETURNING id`,
    [
      workspace(f),
      over.messageId ?? message(f),
      firm(f),
      over.opportunityId ?? opportunity(f),
      disposition,
      suggested,
      over.suggestedBy ?? 'model',
      corrected,
      over.userId ?? salesperson(f),
      over.callbackId ?? null,
      over.note ?? null,
    ],
  );
  return rows[0]?.id ?? '';
}
