-- ---------------------------------------------------------------------------
-- 0022_funnel_facts.sql — one table for the funnel, counted (lane J-facts)
--
-- An expand migration, additive only: one new table, two new indexes, its own
-- grants. Nothing existing is dropped, narrowed or rewritten, so there is no data
-- this file can meet that it cannot accept.
--
-- Both service ranges move to {22, 22} in the same release
-- (`packages/domain/db/schemaRange.ts`), as every release since 0006 has: an image
-- only ever meets its own schema. So the release is a stop-migrate-start one,
-- `infra/scripts/deploy.sh release --schema-change`, which applies this after the
-- Terraform apply with both services at zero. The images of the previous release
-- declare {21, 21} and refuse this schema at startup; nothing of theirs runs while
-- it is applied.
--
-- **It refuses on nothing, so it has no `fss admin schema-preflight` command and the
-- release skips that step.** A preflight exists to let a migration that *can* refuse
-- say so, read-only, while both services are still running (0020 and 0021 each had
-- one). This file has no condition under which it raises: there is no row it reads,
-- no constraint it adds to an existing table, and no count that could make it stop.
-- `docs/greenfield/runbooks/operate.md` step 3 says the same in the operator's voice.
--
-- ## What a funnel fact is
--
-- **A count, not a record: ids and codes, never a name, an address, a phone or an
-- e-mail.** One row means one thing happened once — a firm was created, a call
-- connected, an offer was accepted — and what it carries is the ids of the records
-- it happened to, a lower-case kind from an open vocabulary, the module that wrote
-- it, and a small `detail` object of flags and codes. Nothing in the table is a
-- field a person's name or handle could go in, which is the same redaction by
-- construction the dashboard DTO uses: a later change cannot leak one by forgetting
-- to strip it. See `docs/greenfield/funnel.md`.
--
-- `kind` is deliberately **open**: a shape, not a closed list. Every other slice of
-- the CRM plan — research, telephony, meetings, warm mail, offers, demos, publishing
-- — records its own facts here, and a closed CHECK would make each of them a
-- migration and a schema release before it could emit anything. The v1 dictionary
-- lives in `packages/domain/funnel/kinds.ts` as documentation constants, where a
-- lane can extend it without stopping production. What the database enforces is that
-- a kind is a dotted, lower-case, two- or three-part name and nothing else, so a
-- typo is refused and a free-text sentence can never become a dashboard key.
--
-- `dedupe_key` is what makes an at-least-once writer safe: one fact per (kind, key),
-- enforced by a unique constraint rather than by the writer remembering. The key is
-- built from the ids that identify the thing, never from a timestamp, so a replayed
-- command or a re-run handler produces one fact.
-- ---------------------------------------------------------------------------
CREATE TABLE funnel_facts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  kind text NOT NULL,
  -- All three nullable: a demo visitor or a published post has no firm yet, and a
  -- fact about a firm has no contact or opportunity. The CHECK below is the only
  -- rule between them.
  firm_id uuid,
  contact_id uuid,
  opportunity_id uuid,
  dedupe_key text NOT NULL,
  source text NOT NULL,
  actor_kind text NOT NULL,
  actor_user_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Defaulted, and an emitter may supply it: a reconciled provider record carries
  -- its own instant, and backfilling it as `now()` would put a call that happened
  -- yesterday in today's window.
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT funnel_facts_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT funnel_facts_dedupe UNIQUE (workspace_id, kind, dedupe_key),
  -- The composite keys `crm_domain_events` uses, and for the same reason: the
  -- triples cascade on update so a merge that rewrites an id carries its facts with
  -- it rather than orphaning them.
  CONSTRAINT funnel_facts_firm_fkey FOREIGN KEY (workspace_id, firm_id) REFERENCES firms (workspace_id, id),
  CONSTRAINT funnel_facts_contact_fkey FOREIGN KEY (workspace_id, contact_id, firm_id)
    REFERENCES contacts (workspace_id, id, firm_id) ON UPDATE CASCADE,
  CONSTRAINT funnel_facts_opportunity_fkey FOREIGN KEY (workspace_id, opportunity_id, firm_id)
    REFERENCES opportunities (workspace_id, id, firm_id) ON UPDATE CASCADE,
  -- Open-kinded: a shape rather than a list. Two or three dotted lower-case parts.
  CONSTRAINT funnel_facts_kind_shape
    CHECK (kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,2}$' AND length(kind) <= 64),
  -- A contact or an opportunity names the firm it belongs to. Without this the
  -- composite foreign keys above would be satisfied by a null firm and the audience
  -- rule of the read would have a hole in it.
  CONSTRAINT funnel_facts_firm_present_for_child
    CHECK (firm_id IS NOT NULL OR (contact_id IS NULL AND opportunity_id IS NULL)),
  CONSTRAINT funnel_facts_dedupe_key_present
    CHECK (btrim(dedupe_key) <> '' AND length(dedupe_key) <= 200),
  -- The module that wrote it: `crm`, and later `research`, `telephony`, `calendar`,
  -- `demo`, `social`, `offers`. One flat lower-case word, so a report can say which
  -- part of the system a figure came from.
  CONSTRAINT funnel_facts_source_shape
    CHECK (source ~ '^[a-z][a-z0-9_]*$' AND length(source) <= 32),
  CONSTRAINT funnel_facts_actor_kind_known CHECK (actor_kind IN ('user', 'admin', 'system', 'worker')),
  CONSTRAINT funnel_facts_user_actor_identified
    CHECK ((actor_kind IN ('user', 'admin')) = (actor_user_id IS NOT NULL)),
  -- An object, and a small one. The bound is what stops `detail` becoming somewhere
  -- a message body could be kept.
  CONSTRAINT funnel_facts_detail_is_object
    CHECK (jsonb_typeof(detail) = 'object' AND length(detail::text) <= 4000)
);

-- The two reads the dashboard makes: everything in a window by kind, and one firm's
-- facts. The second is partial because a firm-less fact — a demo visitor, a
-- published post — is never found through it.
CREATE INDEX funnel_facts_by_kind ON funnel_facts (workspace_id, kind, occurred_at);
CREATE INDEX funnel_facts_by_firm ON funnel_facts (workspace_id, firm_id, occurred_at)
  WHERE firm_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Privileges
--
-- Migration 0001's `GRANT ... ON ALL TABLES` covered only the tables that existed
-- then, so this one needs its own (docs/greenfield/migrations.md, step 4).
--
-- `UPDATE` is granted for exactly one writer: the deletion workflow's redaction,
-- which clears `detail` and keeps the row (`packages/domain/retention/deletion.ts`).
-- The recorder never updates — a fact is written once and the unique constraint
-- makes a second write a no-op. `DELETE` and `TRUNCATE` are revoked, so business
-- history cannot be rewritten by anything, the deletion workflow included.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON funnel_facts TO app_runtime, migration;
REVOKE DELETE, TRUNCATE ON funnel_facts FROM app_runtime, migration;
