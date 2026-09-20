-- 0008_today
--
-- The Today list (specification revision 3: sections 8.2 and 8.3, Appendix A rows
-- "Reassign firm" and "Callback confirm/complete", Appendix C `today:{workspace}:
-- {business_date}:{algorithm}`, Appendix D, and Appendix G 8 and 33). Forward-only;
-- this file never changes once it has been applied anywhere. See
-- docs/greenfield/migrations.md.
--
-- Three tables and one idea. `today_items` is the truth: one row per contact task on
-- one business date. `today_snapshots` is the *card*, and it is derived — every
-- column that describes the firm's position in the list is recomputed by
-- `today_refresh_card` from that firm's unfinished items, by a row trigger, inside
-- whatever transaction touched them. `today_snoozes` outlives both, because a task
-- snoozed until Thursday must not come back in Tuesday's 05:00 rebuild.
--
-- Deriving the card rather than writing it is what makes 8.2's hardest sentence true
-- by construction: "The firm's lane and sort instant come from its highest-priority
-- and earliest-due unfinished item." A writer cannot forget to update the card,
-- because no writer updates the card.
--
-- It is also how the promotions of 8.2 "commit with their source event" without the
-- lanes that own those events knowing this table exists. `callbacks_today_promotion`
-- fires inside G4's `createCallback` transaction and `firms_today_transfer` inside
-- G3a's `reassignFirm` transaction; a rolled-back callback leaves no Today entry, and
-- there is no window in which the assignee changed and the list had not.
--
-- Seeded rows carry a named constant instant rather than now(); this migration seeds
-- none.

-- ---------------------------------------------------------------------------
-- The lane vocabulary, as immutable functions
--
-- 8.2's precedence is data three different places need: the generated columns below,
-- the recompute, and every ORDER BY. Writing it once as an IMMUTABLE function lets it
-- be a GENERATED column and an index expression, so a row whose lane disagrees with
-- its kind cannot be inserted rather than merely being wrong.
-- ---------------------------------------------------------------------------
CREATE FUNCTION today_lane_of_kind(kind text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE kind
           WHEN 'reply' THEN 'reply'
           WHEN 'callback' THEN 'callback'
           WHEN 'email_due' THEN 'due_work'
           WHEN 'call_due' THEN 'due_work'
           WHEN 'linkedin_due' THEN 'due_work'
           WHEN 'new_firm' THEN 'new_firm'
         END
$$;

CREATE FUNCTION today_lane_precedence(lane text) RETURNS smallint
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT (CASE lane
            WHEN 'reply' THEN 1
            WHEN 'callback' THEN 2
            WHEN 'due_work' THEN 3
            WHEN 'new_firm' THEN 4
          END)::smallint
$$;

-- Appendix C: "Today list | today:{workspace}:{business_date}:{algorithm}". The
-- algorithm version is part of the job's identity, so it is recorded on every card
-- and it has to be the same string on both sides of the seam. `TODAY_ALGORITHM_VERSION`
-- in packages/domain/today/types.ts is the other side, and a test compares them.
CREATE FUNCTION today_algorithm_version() RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT 'today.1'::text $$;

-- ---------------------------------------------------------------------------
-- today_snapshots — the card (8.2)
--
-- "One workspace snapshot per workspace business date is keyed
-- UNIQUE(workspace_id, snapshot_date, firm_id)". Here that uniqueness is the primary
-- key, because it *is* the card's identity: a firm appears once on a date, and a
-- surrogate id would only be a second way to name the same row.
--
-- `assigned_user_id` is a copy of the firm's assignee, maintained by the recompute.
-- The items carry no assignee of their own: a firm has at most one assigned
-- salesperson (section 2), so a per-task copy could only ever disagree with the firm,
-- and "reassignment transfers unfinished entries" then has nothing to duplicate.
-- ---------------------------------------------------------------------------
CREATE TABLE today_snapshots (
  workspace_id uuid NOT NULL,
  snapshot_date date NOT NULL,
  firm_id uuid NOT NULL,
  lane text NOT NULL,
  lane_precedence smallint GENERATED ALWAYS AS (today_lane_precedence(lane)) STORED,
  /** The instant the list sorts on: the earliest unfinished item in the firm's lane. */
  sort_at timestamptz NOT NULL,
  assigned_user_id uuid,
  open_items integer NOT NULL DEFAULT 0,
  replies_due integer NOT NULL DEFAULT 0,
  emails_due integer NOT NULL DEFAULT 0,
  calls_due integer NOT NULL DEFAULT 0,
  linkedin_due integer NOT NULL DEFAULT 0,
  algorithm_version text NOT NULL DEFAULT today_algorithm_version(),
  built_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT today_snapshots_pkey PRIMARY KEY (workspace_id, snapshot_date, firm_id),
  CONSTRAINT today_snapshots_firm_fkey FOREIGN KEY (workspace_id, firm_id)
    REFERENCES firms (workspace_id, id),
  CONSTRAINT today_snapshots_assignee_fkey FOREIGN KEY (workspace_id, assigned_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT today_snapshots_lane_known CHECK (lane IN ('reply', 'callback', 'due_work', 'new_firm')),
  CONSTRAINT today_snapshots_counts_nonnegative
    CHECK (open_items >= 0 AND replies_due >= 0 AND emails_due >= 0 AND calls_due >= 0 AND linkedin_due >= 0),
  CONSTRAINT today_snapshots_algorithm_shape CHECK (algorithm_version ~ '^[a-z][a-z0-9.-]{0,31}$'),
  CONSTRAINT today_snapshots_updated_not_before_built CHECK (updated_at >= built_at)
);

-- The read: one workspace, one date, in 8.2's order. `firm_id` is the last tiebreak
-- the specification names; the firm's name is joined in by the reader, because a copy
-- here would be the name as it was at 05:00 and the card shows the name it has now.
CREATE INDEX today_snapshots_ordered
  ON today_snapshots (workspace_id, snapshot_date, lane_precedence, sort_at, firm_id)
  WHERE open_items > 0;

CREATE INDEX today_snapshots_by_assignee
  ON today_snapshots (workspace_id, snapshot_date, assigned_user_id)
  WHERE open_items > 0;

-- ---------------------------------------------------------------------------
-- today_items — the contact tasks behind one card (8.2)
--
-- "Expanding the card reveals contact-level tasks ordered by lane precedence and due
-- instant."
--
-- `item_key` is the task's identity within the day, built by the caller from the row
-- that produced it (`callback:<id>`, `step-execution:<id>`, `reply-message:<id>`,
-- `firm:<id>`). It is what makes a rebuild an upsert rather than a duplicate, and it
-- is what a snooze is recorded against — the snooze has to outlive the snapshot row,
-- so it cannot reference one.
--
-- There is no foreign key to `today_snapshots`. The card is derived from these rows
-- and created by the trigger below, so a parent that has to exist first would be a
-- second writer of the thing this table is the truth for — and a firm merge, which
-- cascades `contacts.firm_id`, would fail against a card the target firm has not got.
-- ---------------------------------------------------------------------------
CREATE TABLE today_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  snapshot_date date NOT NULL,
  firm_id uuid NOT NULL,
  /** Null for a firm-level task: a new firm, or a reply nobody has attributed yet. */
  contact_id uuid,
  item_key text NOT NULL,
  kind text NOT NULL,
  lane text GENERATED ALWAYS AS (today_lane_of_kind(kind)) STORED,
  -- Derived from `kind` rather than from `lane`: a generated column may not read
  -- another generated column, and the composition is the same answer either way.
  lane_precedence smallint GENERATED ALWAYS AS (today_lane_precedence(today_lane_of_kind(kind))) STORED,
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open',
  /**
   * True for work FSS performs by itself. 8.2: "Automated sends are not snoozed ad
   * hoc; delaying them creates a recorded hold." The column is what lets the snooze
   * command tell the two apart without asking the sequences lane.
   */
  automated boolean NOT NULL DEFAULT false,
  source_kind text NOT NULL,
  source_id uuid,
  snooze_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT today_items_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT today_items_one_per_key UNIQUE (workspace_id, snapshot_date, firm_id, item_key),
  CONSTRAINT today_items_firm_fkey FOREIGN KEY (workspace_id, firm_id)
    REFERENCES firms (workspace_id, id),
  -- The semantic composite key of 7.2: a task at firm B naming a contact at firm A is
  -- refused by the database, and a firm merge carries the task with the contact.
  CONSTRAINT today_items_contact_fkey FOREIGN KEY (workspace_id, contact_id, firm_id)
    REFERENCES contacts (workspace_id, id, firm_id) ON UPDATE CASCADE,
  CONSTRAINT today_items_kind_known
    CHECK (kind IN ('reply', 'callback', 'email_due', 'call_due', 'linkedin_due', 'new_firm')),
  CONSTRAINT today_items_status_known CHECK (status IN ('open', 'snoozed', 'completed', 'cancelled')),
  CONSTRAINT today_items_key_shape CHECK (item_key ~ '^[0-9a-zA-Z_:.-]{1,200}$'),
  CONSTRAINT today_items_source_kind_known
    CHECK (source_kind IN ('callback', 'firm', 'reply_message', 'step_execution')),
  -- Only sequence work is ever automated. A reply, a callback and a new firm are
  -- things a person does, and marking one automated would make it unsnoozeable.
  CONSTRAINT today_items_automated_is_due_work
    CHECK (NOT automated OR today_lane_of_kind(kind) = 'due_work'),
  CONSTRAINT today_items_snooze_consistent CHECK ((status = 'snoozed') = (snooze_until IS NOT NULL)),
  CONSTRAINT today_items_completion_consistent CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CONSTRAINT today_items_updated_not_before_created CHECK (updated_at >= created_at)
);

CREATE INDEX today_items_of_card
  ON today_items (workspace_id, snapshot_date, firm_id, status);

CREATE INDEX today_items_by_source
  ON today_items (workspace_id, source_kind, source_id)
  WHERE source_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- today_snoozes (8.2)
--
-- "Salespeople may snooze manual tasks with a required reason and explicit return
-- instant."
--
-- Both are NOT NULL, and the reason has a length CHECK, because a snooze with no
-- reason is indistinguishable from work quietly disappearing. The row is keyed by the
-- task's `item_key` rather than by a `today_items.id`, so it survives the 05:00
-- rebuild that replaces the day's rows: a task snoozed until Thursday is snoozed on
-- Wednesday's list too, and the partial unique index below is what stops two active
-- snoozes disagreeing about when it comes back.
-- ---------------------------------------------------------------------------
CREATE TABLE today_snoozes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  contact_id uuid,
  item_key text NOT NULL,
  reason text NOT NULL,
  return_at timestamptz NOT NULL,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  cancelled_by_user_id uuid,
  CONSTRAINT today_snoozes_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT today_snoozes_firm_fkey FOREIGN KEY (workspace_id, firm_id)
    REFERENCES firms (workspace_id, id),
  CONSTRAINT today_snoozes_contact_fkey FOREIGN KEY (workspace_id, contact_id, firm_id)
    REFERENCES contacts (workspace_id, id, firm_id) ON UPDATE CASCADE,
  CONSTRAINT today_snoozes_creator_fkey FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT today_snoozes_canceller_fkey FOREIGN KEY (workspace_id, cancelled_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT today_snoozes_key_shape CHECK (item_key ~ '^[0-9a-zA-Z_:.-]{1,200}$'),
  CONSTRAINT today_snoozes_reason_present CHECK (btrim(reason) <> '' AND length(reason) <= 300),
  CONSTRAINT today_snoozes_return_after_created CHECK (return_at > created_at),
  CONSTRAINT today_snoozes_cancellation_consistent
    CHECK ((cancelled_at IS NULL) = (cancelled_by_user_id IS NULL))
);

CREATE UNIQUE INDEX today_snoozes_one_active
  ON today_snoozes (workspace_id, firm_id, item_key)
  WHERE cancelled_at IS NULL;

-- ---------------------------------------------------------------------------
-- today_refresh_card — the card, recomputed from the items
--
-- 8.2, in one function: the lane and the sort instant come from the highest-priority
-- and earliest-due unfinished item; the counts are the aggregate the card shows;
-- "completing one item leaves the firm visible while another qualifying item remains"
-- is `open_items`, which the reader filters on.
--
-- When the last item is finished the card keeps the lane and instant it had. It stops
-- being on the list because `open_items` reaches zero, and it stays in the table as
-- the record of what that day's list contained.
-- ---------------------------------------------------------------------------
CREATE FUNCTION today_refresh_card(p_workspace_id uuid, p_snapshot_date date, p_firm_id uuid)
RETURNS void LANGUAGE plpgsql AS $today$
DECLARE
  v_lane text;
  v_sort timestamptz;
  v_open integer;
  v_replies integer;
  v_emails integer;
  v_calls integer;
  v_linkedin integer;
  v_assignee uuid;
BEGIN
  SELECT count(*)::integer,
         (count(*) FILTER (WHERE kind = 'reply'))::integer,
         (count(*) FILTER (WHERE kind = 'email_due'))::integer,
         (count(*) FILTER (WHERE kind = 'call_due'))::integer,
         (count(*) FILTER (WHERE kind = 'linkedin_due'))::integer
    INTO v_open, v_replies, v_emails, v_calls, v_linkedin
    FROM today_items
   WHERE workspace_id = p_workspace_id
     AND snapshot_date = p_snapshot_date
     AND firm_id = p_firm_id
     AND status = 'open';

  -- `item_key` is the last tiebreak rather than `id`, so two databases holding the
  -- same tasks choose the same one: a generated uuid is not the same in both.
  SELECT lane, due_at
    INTO v_lane, v_sort
    FROM today_items
   WHERE workspace_id = p_workspace_id
     AND snapshot_date = p_snapshot_date
     AND firm_id = p_firm_id
     AND status = 'open'
   ORDER BY today_lane_precedence(lane), due_at, item_key
   LIMIT 1;

  SELECT assigned_user_id INTO v_assignee
    FROM firms WHERE workspace_id = p_workspace_id AND id = p_firm_id;

  -- Nothing unfinished and no card: there is nothing to say. A card is never created
  -- empty, so the list never shows a firm with no work on it.
  IF v_lane IS NULL AND NOT EXISTS (
    SELECT 1 FROM today_snapshots
     WHERE workspace_id = p_workspace_id AND snapshot_date = p_snapshot_date AND firm_id = p_firm_id
  ) THEN
    RETURN;
  END IF;

  INSERT INTO today_snapshots
    (workspace_id, snapshot_date, firm_id, lane, sort_at, assigned_user_id,
     open_items, replies_due, emails_due, calls_due, linkedin_due)
  VALUES
    (p_workspace_id, p_snapshot_date, p_firm_id, COALESCE(v_lane, 'new_firm'),
     COALESCE(v_sort, now()), v_assignee, v_open, v_replies, v_emails, v_calls, v_linkedin)
  ON CONFLICT ON CONSTRAINT today_snapshots_pkey DO UPDATE
     SET lane = COALESCE(v_lane, today_snapshots.lane),
         sort_at = COALESCE(v_sort, today_snapshots.sort_at),
         assigned_user_id = v_assignee,
         open_items = v_open,
         replies_due = v_replies,
         emails_due = v_emails,
         calls_due = v_calls,
         linkedin_due = v_linkedin,
         updated_at = greatest(now(), today_snapshots.built_at);
END
$today$;

CREATE FUNCTION today_items_refresh_card() RETURNS trigger
LANGUAGE plpgsql AS $today$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM today_refresh_card(OLD.workspace_id, OLD.snapshot_date, OLD.firm_id);
    RETURN OLD;
  END IF;
  PERFORM today_refresh_card(NEW.workspace_id, NEW.snapshot_date, NEW.firm_id);
  -- A firm merge cascades `contacts.firm_id` into this row. Both cards change.
  IF TG_OP = 'UPDATE'
     AND (OLD.snapshot_date, OLD.firm_id) IS DISTINCT FROM (NEW.snapshot_date, NEW.firm_id) THEN
    PERFORM today_refresh_card(OLD.workspace_id, OLD.snapshot_date, OLD.firm_id);
  END IF;
  RETURN NEW;
END
$today$;

CREATE TRIGGER today_items_refresh_card
  AFTER INSERT OR UPDATE OR DELETE ON today_items
  FOR EACH ROW EXECUTE FUNCTION today_items_refresh_card();

-- ---------------------------------------------------------------------------
-- today_upsert_item — the one way a task reaches the list
--
-- Used by the daily build, by the promotion interface the reply lane will call, and
-- by the callback trigger below. One function, so the three cannot disagree about
-- what an existing task's status becomes.
--
-- Two rules are in here and nowhere else:
--
--   * a finished task is never reopened by a rebuild — completing something and
--     watching it come back at 05:00 is worse than not having the list;
--   * an active snooze wins over a rebuild, which is the whole reason the snooze
--     outlives the snapshot.
-- ---------------------------------------------------------------------------
CREATE FUNCTION today_upsert_item(
  p_workspace_id uuid,
  p_snapshot_date date,
  p_firm_id uuid,
  p_item_key text,
  p_kind text,
  p_due_at timestamptz,
  p_contact_id uuid,
  p_source_kind text,
  p_source_id uuid,
  p_automated boolean
) RETURNS uuid LANGUAGE plpgsql AS $today$
DECLARE
  v_id uuid;
  v_status text;
  v_return timestamptz;
BEGIN
  SELECT id, status INTO v_id, v_status
    FROM today_items
   WHERE workspace_id = p_workspace_id
     AND snapshot_date = p_snapshot_date
     AND firm_id = p_firm_id
     AND item_key = p_item_key;
  IF FOUND AND v_status IN ('completed', 'cancelled') THEN
    RETURN v_id;
  END IF;

  SELECT return_at INTO v_return
    FROM today_snoozes
   WHERE workspace_id = p_workspace_id
     AND firm_id = p_firm_id
     AND item_key = p_item_key
     AND cancelled_at IS NULL
     AND return_at > now();

  INSERT INTO today_items
    (workspace_id, snapshot_date, firm_id, contact_id, item_key, kind, due_at, status,
     automated, source_kind, source_id, snooze_until)
  VALUES
    (p_workspace_id, p_snapshot_date, p_firm_id, p_contact_id, p_item_key, p_kind, p_due_at,
     CASE WHEN v_return IS NULL THEN 'open' ELSE 'snoozed' END,
     COALESCE(p_automated, false), p_source_kind, p_source_id, v_return)
  ON CONFLICT ON CONSTRAINT today_items_one_per_key DO UPDATE
     SET contact_id = EXCLUDED.contact_id,
         kind = EXCLUDED.kind,
         due_at = EXCLUDED.due_at,
         automated = EXCLUDED.automated,
         source_kind = EXCLUDED.source_kind,
         source_id = EXCLUDED.source_id,
         status = EXCLUDED.status,
         snooze_until = EXCLUDED.snooze_until,
         updated_at = greatest(now(), today_items.created_at)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$today$;

-- ---------------------------------------------------------------------------
-- callbacks_today_promotion (8.2, Appendix A "Callback confirm/complete")
--
-- "Event-driven reply and callback promotions commit with their source event."
--
-- A trigger rather than a call inside `createCallback`, for the reason that sentence
-- gives: it has to commit with the event, and the event belongs to another lane's
-- file. A trigger is the one hook that cannot be forgotten by a caller and cannot be
-- committed separately from what caused it.
--
-- The card a callback lands on is the workspace business date of its due instant, or
-- today's if that has already passed — one rule, so the promotion and the 05:00 build
-- always choose the same date for the same callback.
-- ---------------------------------------------------------------------------
CREATE FUNCTION today_callback_changed() RETURNS trigger
LANGUAGE plpgsql AS $today$
DECLARE
  v_zone text;
  v_date date;
  v_key text;
BEGIN
  SELECT business_time_zone INTO v_zone FROM workspaces WHERE id = NEW.workspace_id;
  IF v_zone IS NULL THEN
    RETURN NULL;
  END IF;
  v_key := 'callback:' || NEW.id::text;
  v_date := greatest((NEW.due_at AT TIME ZONE v_zone)::date, (now() AT TIME ZONE v_zone)::date);

  IF NEW.status = 'open' THEN
    PERFORM today_upsert_item(NEW.workspace_id, v_date, NEW.firm_id, v_key, 'callback',
                              NEW.due_at, NEW.contact_id, 'callback', NEW.id, false);
  ELSE
    -- Appendix A: "Callback and Today promotion/removal". Completing the callback
    -- finishes its task; cancelling it takes the task off the list the same way.
    UPDATE today_items
       SET status = CASE WHEN NEW.status = 'completed' THEN 'completed' ELSE 'cancelled' END,
           completed_at = CASE WHEN NEW.status = 'completed' THEN now() ELSE NULL END,
           snooze_until = NULL,
           updated_at = greatest(now(), created_at)
     WHERE workspace_id = NEW.workspace_id
       AND firm_id = NEW.firm_id
       AND item_key = v_key
       AND status IN ('open', 'snoozed');
  END IF;
  RETURN NULL;
END
$today$;

CREATE TRIGGER callbacks_today_promotion
  AFTER INSERT OR UPDATE ON callbacks
  FOR EACH ROW EXECUTE FUNCTION today_callback_changed();

-- ---------------------------------------------------------------------------
-- firms_today_transfer (8.2, Appendix A "Reassign firm")
--
-- "Reassignment transfers unfinished entries."
--
-- The transfer is an update of the card's assignee, which is transfer without
-- duplication by construction: there is one card per firm per date and nothing to
-- copy. It fires on any change of `firms.assigned_user_id`, not only on
-- `reassignFirm`, so an import or a later command that changes the assignee cannot
-- leave the day's list pointing at the former owner.
-- ---------------------------------------------------------------------------
CREATE FUNCTION today_transfer_on_reassignment() RETURNS trigger
LANGUAGE plpgsql AS $today$
DECLARE
  v_date date;
BEGIN
  FOR v_date IN
    SELECT snapshot_date FROM today_snapshots
     WHERE workspace_id = NEW.workspace_id AND firm_id = NEW.id
  LOOP
    PERFORM today_refresh_card(NEW.workspace_id, v_date, NEW.id);
  END LOOP;
  RETURN NULL;
END
$today$;

CREATE TRIGGER firms_today_transfer
  AFTER UPDATE OF assigned_user_id ON firms
  FOR EACH ROW
  WHEN (OLD.assigned_user_id IS DISTINCT FROM NEW.assigned_user_id)
  EXECUTE FUNCTION today_transfer_on_reassignment();

-- ---------------------------------------------------------------------------
-- Privileges
--
-- Migration 0001's `GRANT ... ON ALL TABLES` covered only the tables that existed
-- then. None of these three is append-only: a task is completed, a card is
-- recomputed and a snooze is cancelled, all by the application role.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON today_snapshots TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON today_items TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON today_snoozes TO app_runtime, migration;
