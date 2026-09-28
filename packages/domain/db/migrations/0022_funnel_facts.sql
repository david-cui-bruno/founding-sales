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
--
-- **Nothing here may carry free text.** The key's alphabet has no space in it
-- (the shape `today_items_key_shape` uses), and `detail` is checked by
-- `funnel_facts_detail_coded` below to be a flat object of ids, codes, numbers and
-- flags. That is not tidiness: a firm-less fact has no firm for the deletion
-- workflow to find it by, so a fact that could hold a name would be a name with no
-- deletion path. `recordFunnelFact` checks the same rule before it inserts, so a
-- refusal does not abort the caller's transaction; the CHECK is what makes the rule
-- true of a raw insert as well.
--
-- UPDATE is granted on `detail` and nothing else; see the privileges at the foot.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The coded-detail rule, as an immutable function
--
-- `detail` being an object and being small is not the rule; the rule is that every
-- value in it is an id, a code, a number or a flag. `recordFunnelFact` checks that
-- before it inserts, so a refusal never aborts the caller's transaction — but
-- `app_runtime` holds INSERT on this table, and a rule that lives only in TypeScript
-- is a rule a raw insert walks past. A firm-less fact has no firm for the deletion
-- workflow to find it by, so a sentence that got in here would be a sentence nothing
-- could ever redact. That is why it is enforced twice, and why the database's copy
-- is the one that is load-bearing.
--
-- A function inside a CHECK has a precedent in this schema: `today_items_automated_is_due_work`
-- calls `today_lane_of_kind(kind)` (0008, line 181), declared the same way — `LANGUAGE
-- sql IMMUTABLE STRICT`. IMMUTABLE is what makes it legal in a CHECK at all, and it
-- is honestly immutable: it reads nothing but its argument.
--
-- `CASE` rather than a chain of `AND`s because PostgreSQL does not promise the order
-- it evaluates `AND` in, and `jsonb_each` raises on a value that is not an object.
-- `CASE` does promise it, so the type test really does guard the rest.
-- ---------------------------------------------------------------------------
CREATE FUNCTION funnel_facts_detail_coded(detail jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE
           WHEN jsonb_typeof(detail) <> 'object' THEN false
           WHEN (SELECT count(*) FROM jsonb_object_keys(detail)) > 32 THEN false
           ELSE NOT EXISTS (
             SELECT 1
               FROM jsonb_each(detail) AS entry(key, value)
              WHERE entry.key !~ '^[a-zA-Z][0-9a-zA-Z_]{0,63}$'
                 OR jsonb_typeof(entry.value) NOT IN ('boolean', 'number', 'null', 'string')
                 OR (jsonb_typeof(entry.value) = 'string'
                     AND (entry.value #>> '{}') !~ '^[0-9a-zA-Z_:.-]{1,64}$'))
         END
$$;

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
  -- The tenant, named directly. Every other table reaches `workspaces` through a
  -- composite key onto `firms`, and a firm-less fact — a demo visitor, a published
  -- post — has no such key, so without this one its `workspace_id` would be an
  -- unconstrained uuid and a typo would create a fact in a tenant that is not there.
  CONSTRAINT funnel_facts_workspace_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
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
  -- One child id, never both, and this is a merge rule rather than a taste.
  -- `crm/merges.ts` moves contacts before opportunities, so a fact naming both would
  -- have its `firm_id` cascaded to the target by the contact triple while its
  -- opportunity triple still pointed at the source firm, and the opportunity key
  -- would fail *inside* the merge transaction. No kind of the v1 dictionary needs
  -- both — a call or a meeting names a contact, an offer names an opportunity — so
  -- the constraint costs nothing and deferring the keys would have bought a shape
  -- nobody wants.
  CONSTRAINT funnel_facts_one_child CHECK (contact_id IS NULL OR opportunity_id IS NULL),
  -- Ids, colons, dots and dashes: enough for `<uuid>:<code>` and a provider's own
  -- reference, and not enough for a name — there is no space in the alphabet. The
  -- shape `crm_domain_events.command_id` has, for the same reason.
  CONSTRAINT funnel_facts_dedupe_key_shape
    CHECK (dedupe_key ~ '^[0-9a-zA-Z_:.-]{1,200}$'),
  -- The module that wrote it: `crm`, and later `research`, `telephony`, `calendar`,
  -- `demo`, `social`, `offers`. One flat lower-case word, so a report can say which
  -- part of the system a figure came from.
  CONSTRAINT funnel_facts_source_shape
    CHECK (source ~ '^[a-z][a-z0-9_]*$' AND length(source) <= 32),
  CONSTRAINT funnel_facts_actor_kind_known CHECK (actor_kind IN ('user', 'admin', 'system', 'worker')),
  CONSTRAINT funnel_facts_user_actor_identified
    CHECK ((actor_kind IN ('user', 'admin')) = (actor_user_id IS NOT NULL)),
  -- A flat object of ids, codes, numbers and flags, and a small one. The function
  -- above is the shape; the length bound is the belt beside it. Between them there
  -- is nowhere in this row a sentence can go.
  CONSTRAINT funnel_facts_detail_is_object
    CHECK (funnel_facts_detail_coded(detail) AND length(detail::text) <= 4000)
);

-- The two reads the dashboard makes: everything in a window by kind, and one firm's
-- facts. The second is partial because a firm-less fact — a demo visitor, a
-- published post — is never found through it.
-- The window read comes first and asks for every kind at once, so the window leads.
CREATE INDEX funnel_facts_by_window ON funnel_facts (workspace_id, occurred_at, kind);
-- Kept for the per-kind reads the later slices will make.
CREATE INDEX funnel_facts_by_kind ON funnel_facts (workspace_id, kind, occurred_at);
CREATE INDEX funnel_facts_by_firm ON funnel_facts (workspace_id, firm_id, occurred_at)
  WHERE firm_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Privileges
--
-- Migration 0001's `GRANT ... ON ALL TABLES` covered only the tables that existed
-- then, so this one needs its own (docs/greenfield/migrations.md, step 4).
--
-- **`UPDATE` is granted on one column and no others.** A table-wide UPDATE would
-- let the application rewrite a fact's kind, its ids, its dedupe key and the instant
-- it happened at — which is the whole of the row, and would make "append-only"
-- untrue while the grant said otherwise. The one writer that has to change anything
-- here is the deletion workflow's redaction, and all it clears is `detail`
-- (`packages/domain/retention/deletion.ts`), so that is the only column granted. The
-- recorder never updates at all: a fact is written once and the unique constraint
-- makes a second write a no-op.
--
-- `DELETE` and `TRUNCATE` are revoked, so business history cannot be removed by
-- anything, the deletion workflow included.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON funnel_facts TO app_runtime, migration;
GRANT UPDATE (detail) ON funnel_facts TO app_runtime, migration;
REVOKE DELETE, TRUNCATE ON funnel_facts FROM app_runtime, migration;
