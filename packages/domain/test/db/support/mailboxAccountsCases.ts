import type { MailCase, MailCaseFixture } from './mailCases.ts';

/**
 * A failing insert for every constraint migration 0027 adds (`mailbox_accounts`,
 * call-to-booking slice A2). Each case breaks exactly one constraint, inside the
 * transaction the caller rolls back.
 */

const workspace = (f: MailCaseFixture): string => f.seeded.alpha.workspaceId;
const mailbox = (f: MailCaseFixture): string => f.mail.alpha.mailboxId;
/** A syntactically valid UUID that is never a row. */
const ABSENT = '00000000-0000-4000-8000-0000000000fe';

async function account(
  f: MailCaseFixture,
  input: {
    readonly id?: string;
    readonly mailboxId?: string;
    readonly address?: string;
    readonly from?: string;
    readonly until?: string | null;
    readonly generation?: number;
  } = {},
): Promise<unknown> {
  return await f.session.query(
    `INSERT INTO mailbox_accounts (id, workspace_id, mailbox_id, email_address, active_from, active_until, generation_from)
     VALUES (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5::timestamptz, $6::timestamptz, $7)`,
    [
      input.id ?? null,
      workspace(f),
      input.mailboxId ?? mailbox(f),
      input.address ?? 'old.account@example.test',
      input.from ?? '2026-09-01T00:00:00Z',
      input.until === undefined ? '2026-09-20T00:00:00Z' : input.until,
      input.generation ?? 1,
    ],
  );
}

export const MAILBOX_ACCOUNTS_CONSTRAINT_CASES: readonly MailCase[] = [
  {
    constraint: 'mailbox_accounts_pkey',
    run: async f => {
      await account(f, { id: ABSENT });
      return await account(f, { id: ABSENT, from: '2026-09-02T00:00:00Z' });
    },
  },
  {
    constraint: 'mailbox_accounts_mailbox_fkey',
    run: async f => await account(f, { mailboxId: ABSENT }),
  },
  {
    constraint: 'mailbox_accounts_address_shape',
    run: async f => await account(f, { address: 'Old.Account@Example.test' }),
  },
  {
    constraint: 'mailbox_accounts_interval_ordered',
    run: async f => await account(f, { from: '2026-09-20T00:00:00Z', until: '2026-09-01T00:00:00Z' }),
  },
  {
    constraint: 'mailbox_accounts_generation_positive',
    run: async f => await account(f, { generation: 0 }),
  },
  {
    // Two accounts in force for one mailbox at once.
    constraint: 'mailbox_accounts_one_open',
    run: async f => {
      await account(f, { until: null, address: 'first.open@example.test' });
      return await account(f, { until: null, address: 'second.open@example.test' });
    },
  },
];
