-- ---------------------------------------------------------------------------
-- 0027_mailbox_accounts.sql — which Google account a mailbox row was, and when
-- changes: none
--
-- Call-to-booking slice A2 (30 September 2026): David switches his sales mailbox from
-- one Google account to another in place. The `mailboxes` row keeps its id, so every
-- message, match, permission, fence, send day and ramp that references it carries
-- over; what the row can no longer say on its own is *which account* it was at a given
-- instant. This table says it.
--
-- One row per account interval of one mailbox:
--
--   * `active_from` / `active_until` — the half-open interval `[from, until)` in which
--     the mailbox was this address. `active_until` is NULL for the interval in force,
--     and at most one interval per mailbox is open (`mailbox_accounts_one_open`).
--   * `generation_from` — the mailbox generation the interval began at, so a reader
--     can tell a switch's generation from a re-consent's.
--
-- **No backfill.** A mailbox with no rows here has only ever had its current address,
-- which is every mailbox that exists when this migration runs. A switch
-- (`completeGmailGrant`) writes the old account's closed interval and the new
-- account's open one in the transaction that moves the row.
--
-- Two readers: the direct-send boundary (`mail/effects.ts` — an outgoing message from
-- before the current account's `active_from` is not a direct send) and the
-- open-in-Gmail link (`retention/attachments.ts` — the account the message was
-- recorded under names the `authuser`).
--
-- New table, unreferenced by any deployed binary, so `changes: none`; granted to
-- `app_runtime` explicitly, because migration 0001's `GRANT ... ON ALL TABLES` covered
-- only the tables that existed then.
-- ---------------------------------------------------------------------------
CREATE TABLE mailbox_accounts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  mailbox_id uuid NOT NULL,
  email_address text NOT NULL,
  active_from timestamptz NOT NULL,
  active_until timestamptz,
  generation_from integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailbox_accounts_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT mailbox_accounts_mailbox_fkey FOREIGN KEY (workspace_id, mailbox_id)
    REFERENCES mailboxes (workspace_id, id),
  -- The spelling `mailboxes_address_shape` holds the row itself to.
  CONSTRAINT mailbox_accounts_address_shape
    CHECK (email_address = lower(email_address)
           AND email_address ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
           AND length(email_address) <= 320),
  CONSTRAINT mailbox_accounts_interval_ordered
    CHECK (active_until IS NULL OR active_until >= active_from),
  CONSTRAINT mailbox_accounts_generation_positive CHECK (generation_from >= 1)
);

-- One account in force per mailbox.
CREATE UNIQUE INDEX mailbox_accounts_one_open
  ON mailbox_accounts (workspace_id, mailbox_id)
  WHERE active_until IS NULL;

-- The interval lookup both readers make: this mailbox, by time.
CREATE INDEX mailbox_accounts_by_mailbox
  ON mailbox_accounts (workspace_id, mailbox_id, active_from DESC);

GRANT SELECT, INSERT, UPDATE ON mailbox_accounts TO app_runtime, migration;
