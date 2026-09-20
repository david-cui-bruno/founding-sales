-- 0010_outbound
--
-- The at-most-once outbound fence, the reputation ramp and the domain guard
-- (specification revision 3: sections 12.5, 12.6, 12.7, 11.2, and Appendices B, C,
-- D, F and G 5, 12, 16, 32, 33, 36). Forward-only; this file never changes once it
-- has been applied anywhere. See docs/greenfield/migrations.md.
--
-- One sentence governs this whole migration. Appendix B: "Only the atomic `prepared
-- → dispatching` transition, with a non-reusable attempt token and database
-- timestamp, authorizes one process to call Gmail. `dispatching` never returns to
-- `prepared`, irrespective of job leases."
--
-- Everything here exists to make that sentence true in the database rather than in a
-- handler, because the failure it prevents — sending the same email twice to a
-- prospect — cannot be undone by any later correction.
--
-- What it adds:
--
--   * `outbound_messages`, one fence per FSS email, with exactly one origin, a
--     deterministic Message-ID unique per mailbox, an envelope that freezes when
--     dispatch begins, and a state machine enforced by trigger;
--   * `outbound_message_events`, the append-only ledger of every transition, so
--     "dispatching never returned to prepared" is auditable and not merely absent;
--   * `sending_domains`, the SPF/DKIM/DMARC admin checklist of 12.7 and the rolling
--     personal-Gmail recipient guard of 12.6, per workspace primary domain;
--   * `mailbox_send_ramp`, 12.7's per-mailbox ramp: the healthy-sending-day counter
--     the table is a function of, the admin's lower bound, and the raised cap;
--   * `mailbox_send_days`, one row per mailbox per business date, counting automated
--     and direct sends separately because the cap is on the first and the headroom
--     is on both.
--
-- Three things this migration deliberately does *not* do.
--
-- **No foreign key to `step_executions` or `drafts`.** Neither table exists: G8's
-- migration 0012 creates `step_executions` and adds the constraint. `origin_kind`
-- plus a nullable id is the shape that lets a fence exist before the table its
-- origin lives in does, and `outbound_messages_exactly_one_origin` is what stops
-- that flexibility becoming ambiguity.
--
-- **No `sequence` effects.** "Delivered continues the sequence with the next delay
-- calculated from the original dispatch time" is G8's to act on; what is recorded
-- here is the admin's resolution and the original dispatch timestamp, which is the
-- whole of what G8 needs to compute it.
--
-- **No DNS lookup, ever.** 12.7's authentication gate is an admin checklist flag.
-- The application never queries DNS: a resolver answer is a snapshot of a cache, and
-- an automated gate that opens because a cached TXT record looked right is worse
-- than a person who looked and said so.
--
-- Seeded rows would carry a named constant instant rather than now(). There are none.

-- ---------------------------------------------------------------------------
-- sending_domains (specification 12.6, 12.7)
--
-- The workspace's primary sending domain, its authentication checklist, and the
-- rolling guard.
--
-- 12.6: "FSS enforces a rolling primary-domain guard at 4,000 personal-Gmail
-- recipients per 24 hours while reply-only opt-out remains configured. Reaching the
-- guard holds further affected sends and requires a reviewed product-policy change;
-- it cannot be bypassed with extra mailboxes."
--
-- The guard lives here, on the *domain*, and that placement is the whole of "cannot
-- be bypassed with extra mailboxes": connecting a second mailbox on the same domain
-- adds a row to `mailboxes` and changes nothing here. A guard stored per mailbox
-- would be doubled by the obvious workaround.
--
-- `automated_sending_enabled` is the gate of 12.7 — "SPF, DKIM, and DMARC must pass
-- before automated sending is enabled" — and the CHECK beside it is what makes the
-- sentence structural: the flag cannot be set while any of the three is unconfirmed.
-- ---------------------------------------------------------------------------
CREATE TABLE sending_domains (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  domain text NOT NULL,
  is_primary boolean NOT NULL DEFAULT true,
  -- The admin checklist. Each is a person's confirmation, never a resolver answer.
  spf_pass boolean NOT NULL DEFAULT false,
  dkim_pass boolean NOT NULL DEFAULT false,
  dmarc_pass boolean NOT NULL DEFAULT false,
  authentication_checked_at timestamptz,
  authentication_checked_by_user_id uuid,
  -- 12.7: "Google Postmaster Tools or equivalent domain diagnostics are part of the
  -- admin checklist." Recorded, not queried.
  postmaster_reviewed_at timestamptz,
  automated_sending_enabled boolean NOT NULL DEFAULT false,
  automated_sending_enabled_at timestamptz,
  -- 12.6's guard. Stored rather than hard-coded so a reviewed product-policy change
  -- is an audited UPDATE of one row and not a release.
  personal_gmail_guard_per_24h integer NOT NULL DEFAULT 4000,
  reply_only_opt_out boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sending_domains_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT sending_domains_checker_fkey FOREIGN KEY (workspace_id, authentication_checked_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT sending_domains_one_per_domain UNIQUE (workspace_id, domain),
  CONSTRAINT sending_domains_domain_shape
    CHECK (domain = lower(domain)
           AND domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
           AND length(domain) <= 253),
  CONSTRAINT sending_domains_check_consistent
    CHECK ((authentication_checked_at IS NULL) = (authentication_checked_by_user_id IS NULL)),
  -- A pass is a thing a person confirmed at an instant. A pass with no confirmation
  -- behind it is the state this CHECK exists to make unrepresentable.
  CONSTRAINT sending_domains_passes_are_checked
    CHECK (authentication_checked_at IS NOT NULL
           OR (spf_pass = false AND dkim_pass = false AND dmarc_pass = false)),
  -- 12.7: authentication before automated sending. Not a warning; a constraint.
  CONSTRAINT sending_domains_enable_requires_authentication
    CHECK (automated_sending_enabled = false
           OR (spf_pass AND dkim_pass AND dmarc_pass AND postmaster_reviewed_at IS NOT NULL)),
  CONSTRAINT sending_domains_enable_consistent
    CHECK ((automated_sending_enabled = false) = (automated_sending_enabled_at IS NULL)),
  -- Zero is a legitimate guard: it stops the domain entirely, which is what an
  -- operator reaches for during an incident.
  CONSTRAINT sending_domains_guard_bounded
    CHECK (personal_gmail_guard_per_24h >= 0 AND personal_gmail_guard_per_24h <= 5000),
  CONSTRAINT sending_domains_updated_not_before_created CHECK (updated_at >= created_at)
);

-- One primary per workspace. A second primary would make "the primary-domain guard"
-- a question rather than a fact.
CREATE UNIQUE INDEX sending_domains_one_primary
  ON sending_domains (workspace_id)
  WHERE is_primary;

-- ---------------------------------------------------------------------------
-- mailbox_send_ramp (specification 12.7)
--
-- "For the new Callie domain, the initial per-mailbox automated cap is: first 5
-- sending days 5, next 5 days 10, next 5 days 15, next 5 days 25, weeks 5–6 35,
-- after six healthy weeks 50."
--
-- The table in the specification is a *function* of one number — how many healthy
-- sending days this mailbox has behind it — so that number is what is stored and the
-- schedule lives in `packages/domain/outbound/ramp.ts`. Storing the cap instead
-- would mean a schedule change could never be applied to a mailbox already ramping
-- without a data migration, and would let the stored cap drift from the rule.
--
-- "Admins may lower caps. After sustained healthy results they may raise a mailbox
-- to 75, but version one has a hard automated ceiling of 100 per mailbox per
-- business day." So there are two admin columns with opposite meanings, and the
-- ceiling is a CHECK rather than a comment: `admin_daily_cap` can only *lower* the
-- scheduled cap (the code takes the minimum), and `raised_daily_cap` can only raise
-- it, to at most the hard ceiling.
--
-- "New mailboxes begin a mailbox-specific ramp even after the domain matures." That
-- is why this is per mailbox and there is no domain-level ramp to inherit from.
-- ---------------------------------------------------------------------------
CREATE TABLE mailbox_send_ramp (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  mailbox_id uuid NOT NULL,
  -- The only input to the schedule. Advanced by at most one per business date, and
  -- only for a date that met every health condition of 12.7.
  healthy_sending_days integer NOT NULL DEFAULT 0,
  last_advanced_on date,
  -- An admin lowering the cap. Never raises: the code takes the minimum.
  admin_daily_cap integer,
  -- An admin raising it after sustained healthy results. At most the hard ceiling.
  raised_daily_cap integer,
  admin_changed_at timestamptz,
  admin_changed_by_user_id uuid,
  -- Why the ramp last failed to advance. An operator reads it; it is not a hold.
  last_health_failure text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailbox_send_ramp_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT mailbox_send_ramp_mailbox_fkey FOREIGN KEY (workspace_id, mailbox_id)
    REFERENCES mailboxes (workspace_id, id),
  CONSTRAINT mailbox_send_ramp_admin_fkey FOREIGN KEY (workspace_id, admin_changed_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT mailbox_send_ramp_one_per_mailbox UNIQUE (workspace_id, mailbox_id),
  CONSTRAINT mailbox_send_ramp_days_not_negative CHECK (healthy_sending_days >= 0),
  CONSTRAINT mailbox_send_ramp_admin_cap_bounded
    CHECK (admin_daily_cap IS NULL OR (admin_daily_cap >= 0 AND admin_daily_cap <= 100)),
  -- 12.7's hard ceiling, in the one place it cannot be argued with.
  CONSTRAINT mailbox_send_ramp_raised_cap_bounded
    CHECK (raised_daily_cap IS NULL OR (raised_daily_cap >= 1 AND raised_daily_cap <= 100)),
  CONSTRAINT mailbox_send_ramp_admin_change_consistent
    CHECK ((admin_changed_at IS NULL) = (admin_changed_by_user_id IS NULL)),
  CONSTRAINT mailbox_send_ramp_admin_change_recorded
    CHECK (admin_changed_at IS NOT NULL OR (admin_daily_cap IS NULL AND raised_daily_cap IS NULL)),
  CONSTRAINT mailbox_send_ramp_health_failure_bounded
    CHECK (last_health_failure IS NULL
           OR (btrim(last_health_failure) <> '' AND length(last_health_failure) <= 200)),
  CONSTRAINT mailbox_send_ramp_updated_not_before_created CHECK (updated_at >= created_at)
);

-- ---------------------------------------------------------------------------
-- mailbox_send_days (specification 12.7, Appendix D)
--
-- One row per mailbox per *workspace business date*, which is the date the cap is
-- expressed in ("per mailbox per business day"). Note that this is not the firm's
-- zone: the send *window* is in the firm's zone (Appendix D), the *cap* is in the
-- workspace's. Two different dates, deliberately, and conflating them would mean a
-- mailbox's cap rolled over at a different moment for each firm it writes to.
--
-- Automated and direct sends are counted separately because 12.7 asks two different
-- questions of them. The cap applies to `automated_sent`. Headroom — "All outgoing
-- Gmail messages, including direct sends, count toward operational headroom" —
-- applies to the sum, and is why `direct_sent` is here at all: a salesperson who
-- wrote two hundred emails by hand this morning has spent the account's capacity
-- whether or not FSS sent any of them.
--
-- `healthy` is the day's verdict for the ramp: it is written when the day closes and
-- is what `healthy_sending_days` counts.
-- ---------------------------------------------------------------------------
CREATE TABLE mailbox_send_days (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  mailbox_id uuid NOT NULL,
  business_date date NOT NULL,
  automated_sent integer NOT NULL DEFAULT 0,
  direct_sent integer NOT NULL DEFAULT 0,
  bounces integer NOT NULL DEFAULT 0,
  opt_outs integer NOT NULL DEFAULT 0,
  provider_errors integer NOT NULL DEFAULT 0,
  -- The highest cap this day was ever granted, recorded as it was used, so a later
  -- schedule change cannot rewrite what yesterday was allowed to do. It never
  -- decreases: an admin lowering a cap mid-incident lowers `admin_daily_cap` on the
  -- ramp, which the send path reads fresh, and must not be refused by a CHECK
  -- because five emails already went out this morning.
  cap_granted integer NOT NULL,
  healthy boolean,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailbox_send_days_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT mailbox_send_days_mailbox_fkey FOREIGN KEY (workspace_id, mailbox_id)
    REFERENCES mailboxes (workspace_id, id),
  CONSTRAINT mailbox_send_days_one_per_date UNIQUE (workspace_id, mailbox_id, business_date),
  CONSTRAINT mailbox_send_days_counts_not_negative
    CHECK (automated_sent >= 0 AND direct_sent >= 0 AND bounces >= 0
           AND opt_outs >= 0 AND provider_errors >= 0),
  CONSTRAINT mailbox_send_days_cap_bounded CHECK (cap_granted >= 0 AND cap_granted <= 100),
  -- The backstop. The send path reads the effective cap fresh and refuses; this
  -- refuses a counter that ran past every cap the day was ever granted, whatever the
  -- caller believed it was doing.
  CONSTRAINT mailbox_send_days_within_cap CHECK (automated_sent <= cap_granted),
  CONSTRAINT mailbox_send_days_verdict_consistent CHECK ((healthy IS NULL) = (closed_at IS NULL)),
  CONSTRAINT mailbox_send_days_updated_not_before_created CHECK (updated_at >= created_at)
);

-- ---------------------------------------------------------------------------
-- outbound_messages (specification 12.5, Appendix B, Appendix G 5, 12, 16, 36)
--
-- The fence. One row per FSS email, for the whole life of that email.
--
-- 12.5: "Each FSS email has exactly one `outbound_messages` fence. A check requires
-- exactly one origin (`step_execution_id` or `draft_id`); partial unique indexes
-- enforce one fence per origin; deterministic Message-ID is unique per mailbox;
-- envelope columns become immutable when dispatch begins."
--
-- Every clause of that sentence is a named constraint below, and the state machine
-- is a trigger rather than a CHECK because a CHECK cannot see the old row.
--
-- ## The envelope is frozen, including the route
--
-- `recipient_address`, `recipient_route_id` and `recipient_route_version` are copied
-- on to the fence at preparation. The address is stored as text and not only as a
-- reference because 12.3's bounce handling *invalidates* the route, and a bounce
-- that arrives after the route row changed must still be able to say which bytes
-- were in the To header. The version is stored so that an invalidation can prove it
-- invalidated the route as it was sent to.
--
-- ## The attempt token is the authorization, and it is single use
--
-- `attempt_token` is written exactly once, by the atomic `prepared → dispatching`
-- update, and is immutable afterwards. Only the process holding the token it just
-- received may move the fence to `sent`. A replacement worker — one that reclaimed
-- the job after a lease expired — does not have the token, so its only lawful move
-- is `dispatching → reconciling`. That is Appendix B's "a replacement worker may
-- reconcile but never send a dispatching fence again", expressed as a value rather
-- than as a rule somebody has to remember.
--
-- ## `unknown_terminal` is terminal
--
-- There is no transition out of `unknown_terminal`. An admin's resolution is
-- recorded in `admin_resolution` and changes no state, because both resolutions mean
-- the same thing about Gmail: nothing further will be sent for this fence. 12.5:
-- "Neither choice ever releases the same step for resend."
-- ---------------------------------------------------------------------------
CREATE TABLE outbound_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  mailbox_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'prepared',

  -- Exactly one origin. Neither table exists yet; G8's 0012 adds the foreign keys.
  --
  -- `enrollment_id` is carried beside the step execution rather than derived from it
  -- because the fence has to be readable — by an admin resolving an
  -- `unknown_terminal`, by the reply path stopping an enrollment — at moments when
  -- joining through a table this migration cannot reference would be the only way to
  -- find it. It is nullable for the same reason the step execution is: a draft has no
  -- enrollment.
  origin_kind text NOT NULL,
  enrollment_id uuid,
  step_execution_id uuid,
  draft_id uuid,

  -- The frozen envelope.
  firm_id uuid NOT NULL,
  contact_id uuid,
  opportunity_id uuid,
  recipient_address text NOT NULL,
  recipient_route_id uuid,
  recipient_route_version integer,
  subject text NOT NULL,
  body text NOT NULL,
  template_version_id uuid,
  -- The rendered bytes' hash, so a later read can prove what was sent without the
  -- template still existing in the same shape.
  rendered_hash text NOT NULL,
  -- Deterministic, derived from this row's id, so a crashed process can search the
  -- Sent folder for a message it is not sure it sent (Appendix B).
  provider_message_id_header text NOT NULL,

  -- The placement the caller computed (11.2, Appendix D): the earliest instant this
  -- fence may dispatch, the firm's zone it was computed in, and the rule version
  -- that computed it. Stored rather than recomputed at dispatch because a placement
  -- is a decision made once, and an email that silently moved to a different hour
  -- than the one it was scheduled for is a pacing bug nobody can reconstruct. The
  -- dispatch path still re-checks the window: this is the schedule, not the licence.
  send_at timestamptz NOT NULL,
  source_zone text NOT NULL,
  placement_rule_version text NOT NULL,

  -- Dispatch.
  attempt_token uuid,
  dispatch_started_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  provider_thread_id text,

  -- Reconciliation (Appendix B: a bounded 24-hour observation window with backoff).
  reconcile_started_at timestamptz,
  reconcile_deadline_at timestamptz,
  reconcile_attempts integer NOT NULL DEFAULT 0,
  reconcile_last_attempt_at timestamptz,

  -- Terminal outcomes.
  held_reason text,
  held_at timestamptz,
  unknown_terminal_at timestamptz,
  admin_resolution text,
  admin_resolved_at timestamptz,
  admin_resolved_by_user_id uuid,

  -- The business date the cap counted this send against (12.7, Appendix D).
  business_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT outbound_messages_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT outbound_messages_mailbox_fkey FOREIGN KEY (workspace_id, mailbox_id)
    REFERENCES mailboxes (workspace_id, id),
  CONSTRAINT outbound_messages_firm_fkey FOREIGN KEY (workspace_id, firm_id)
    REFERENCES firms (workspace_id, id),
  CONSTRAINT outbound_messages_contact_fkey FOREIGN KEY (workspace_id, contact_id, firm_id)
    REFERENCES contacts (workspace_id, id, firm_id) ON UPDATE CASCADE,
  CONSTRAINT outbound_messages_opportunity_fkey FOREIGN KEY (workspace_id, opportunity_id)
    REFERENCES opportunities (workspace_id, id),
  CONSTRAINT outbound_messages_route_fkey FOREIGN KEY (workspace_id, recipient_route_id)
    REFERENCES email_addresses (workspace_id, id),
  CONSTRAINT outbound_messages_template_fkey FOREIGN KEY (workspace_id, template_version_id)
    REFERENCES template_versions (workspace_id, id),
  CONSTRAINT outbound_messages_resolver_fkey FOREIGN KEY (workspace_id, admin_resolved_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),

  CONSTRAINT outbound_messages_state_known
    CHECK (state IN ('prepared', 'held', 'dispatching', 'reconciling', 'sent', 'unknown_terminal')),
  CONSTRAINT outbound_messages_origin_kind_known CHECK (origin_kind IN ('step_execution', 'draft')),
  -- 12.5: "A check requires exactly one origin."
  CONSTRAINT outbound_messages_exactly_one_origin
    CHECK (num_nonnulls(step_execution_id, draft_id) = 1),
  CONSTRAINT outbound_messages_origin_kind_matches
    CHECK ((origin_kind = 'step_execution') = (step_execution_id IS NOT NULL)),
  -- An enrollment belongs to a step execution and to nothing else.
  CONSTRAINT outbound_messages_enrollment_needs_step
    CHECK (enrollment_id IS NULL OR step_execution_id IS NOT NULL),
  -- An IANA zone name. The region is optional because `UTC` is a real zone and a
  -- pattern that demanded a slash would refuse it.
  CONSTRAINT outbound_messages_zone_shape
    CHECK (source_zone ~ '^[A-Za-z][A-Za-z0-9+_-]*(/[A-Za-z0-9+._-]+)*$' AND length(source_zone) <= 64),
  CONSTRAINT outbound_messages_placement_rule_shape
    CHECK (placement_rule_version ~ '^[a-z0-9._-]{1,40}$'),

  CONSTRAINT outbound_messages_recipient_shape
    CHECK (recipient_address = lower(recipient_address)
           AND recipient_address ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
           AND length(recipient_address) <= 320),
  CONSTRAINT outbound_messages_route_consistent
    CHECK ((recipient_route_id IS NULL) = (recipient_route_version IS NULL)),
  CONSTRAINT outbound_messages_route_version_positive
    CHECK (recipient_route_version IS NULL OR recipient_route_version >= 1),
  CONSTRAINT outbound_messages_subject_bounded
    CHECK (btrim(subject) <> '' AND length(subject) <= 160),
  CONSTRAINT outbound_messages_body_bounded CHECK (btrim(body) <> '' AND length(body) <= 4000),
  -- 12.6, the same rule `template_versions` carries, restated on the bytes that
  -- actually leave: a rendered body may not contain an unsubscribe link either.
  CONSTRAINT outbound_messages_no_unsubscribe_link
    CHECK (body !~* 'unsubscribe' AND subject !~* 'unsubscribe'),
  CONSTRAINT outbound_messages_rendered_hash_shape CHECK (rendered_hash ~ '^[0-9a-f]{64}$'),
  -- `<fss.{uuid}@{domain}>`: derivable from the row and from nothing else.
  CONSTRAINT outbound_messages_header_shape
    CHECK (provider_message_id_header ~ '^<[^<>[:space:]@]+@[^<>[:space:]@]+>$'
           AND length(provider_message_id_header) <= 200),

  -- The state machine's invariants that a single row can state. The transitions
  -- themselves are the trigger below.
  CONSTRAINT outbound_messages_dispatch_consistent
    CHECK ((attempt_token IS NULL) = (dispatch_started_at IS NULL)),
  -- Appendix B: only the atomic transition authorizes a call. Every state at or past
  -- `dispatching` has a token and a database timestamp; no earlier state has either.
  CONSTRAINT outbound_messages_dispatch_states
    CHECK ((state IN ('dispatching', 'reconciling', 'sent', 'unknown_terminal'))
           = (attempt_token IS NOT NULL)),
  CONSTRAINT outbound_messages_sent_consistent
    CHECK ((state = 'sent') = (sent_at IS NOT NULL)),
  CONSTRAINT outbound_messages_sent_has_provider_id
    CHECK (state <> 'sent' OR provider_message_id IS NOT NULL),
  CONSTRAINT outbound_messages_provider_id_bounded
    CHECK (provider_message_id IS NULL
           OR (btrim(provider_message_id) <> '' AND length(provider_message_id) <= 200)),
  CONSTRAINT outbound_messages_provider_thread_bounded
    CHECK (provider_thread_id IS NULL
           OR (btrim(provider_thread_id) <> '' AND length(provider_thread_id) <= 200)),
  CONSTRAINT outbound_messages_held_consistent CHECK ((state = 'held') = (held_at IS NOT NULL)),
  CONSTRAINT outbound_messages_held_has_reason CHECK ((held_at IS NULL) = (held_reason IS NULL)),
  CONSTRAINT outbound_messages_held_reason_bounded
    CHECK (held_reason IS NULL OR (btrim(held_reason) <> '' AND length(held_reason) <= 60)),
  CONSTRAINT outbound_messages_reconcile_consistent
    CHECK ((reconcile_started_at IS NULL) = (reconcile_deadline_at IS NULL)),
  CONSTRAINT outbound_messages_reconcile_window_ordered
    CHECK (reconcile_deadline_at IS NULL OR reconcile_deadline_at > reconcile_started_at),
  CONSTRAINT outbound_messages_reconcile_attempts_not_negative CHECK (reconcile_attempts >= 0),
  CONSTRAINT outbound_messages_unknown_consistent
    CHECK ((state = 'unknown_terminal') = (unknown_terminal_at IS NOT NULL)),
  CONSTRAINT outbound_messages_resolution_known
    CHECK (admin_resolution IS NULL OR admin_resolution IN ('delivered', 'skipped')),
  -- 12.5: only an `unknown_terminal` fence has a resolution to make.
  CONSTRAINT outbound_messages_resolution_only_when_unknown
    CHECK (admin_resolution IS NULL OR state = 'unknown_terminal'),
  CONSTRAINT outbound_messages_resolution_consistent
    CHECK (num_nonnulls(admin_resolution, admin_resolved_at, admin_resolved_by_user_id) IN (0, 3)),
  CONSTRAINT outbound_messages_updated_not_before_created CHECK (updated_at >= created_at)
);

-- 12.5: "partial unique indexes enforce one fence per origin".
CREATE UNIQUE INDEX outbound_messages_one_per_step_execution
  ON outbound_messages (workspace_id, step_execution_id)
  WHERE step_execution_id IS NOT NULL;

CREATE UNIQUE INDEX outbound_messages_one_per_draft
  ON outbound_messages (workspace_id, draft_id)
  WHERE draft_id IS NOT NULL;

-- 12.5: "deterministic Message-ID is unique per mailbox". Unconditional, because a
-- header that repeated for any reason would make the Sent-folder search ambiguous,
-- and an ambiguous reconciliation is the one thing Appendix B cannot tolerate.
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_one_header_per_mailbox
  UNIQUE (workspace_id, mailbox_id, provider_message_id_header);

-- The reconciliation sweep's query: every fence still owed an observation.
CREATE INDEX outbound_messages_reconciling
  ON outbound_messages (workspace_id, mailbox_id, reconcile_deadline_at)
  WHERE state = 'reconciling';

-- The sending sweep's query, and the daily cap's count.
CREATE INDEX outbound_messages_ready
  ON outbound_messages (workspace_id, mailbox_id, send_at)
  WHERE state IN ('prepared', 'held');

-- The reply path's question: which enrollment did this fence belong to.
CREATE INDEX outbound_messages_by_enrollment
  ON outbound_messages (workspace_id, enrollment_id)
  WHERE enrollment_id IS NOT NULL;

-- 12.6's rolling guard reads this one: everything sent from any mailbox in the last
-- 24 hours, with the recipient address the personal-Gmail test is applied to.
CREATE INDEX outbound_messages_sent_recent
  ON outbound_messages (workspace_id, sent_at)
  WHERE state = 'sent';

-- ---------------------------------------------------------------------------
-- The state machine (Appendix B)
--
--   prepared    → dispatching | held
--   held        → prepared
--   dispatching → reconciling | sent
--   reconciling → sent | unknown_terminal
--
-- Everything else is refused, including every transition back to `prepared` from
-- `dispatching` or later, which is Appendix B's central promise.
--
-- `held → prepared` is the one reverse edge and it is the one that is safe: the
-- failure table defines `held` as "local validation, hold, policy, coverage, window,
-- or cap failure ... never enter dispatching", so a held fence provably made no
-- Gmail request. Without this edge a fence held by yesterday's daily cap could never
-- send at all, because `outbound_messages_one_per_step_execution` forbids its origin
-- a second fence — the retry would have nowhere to go.
-- ---------------------------------------------------------------------------
CREATE FUNCTION assert_outbound_transition() RETURNS trigger
  LANGUAGE plpgsql AS $outbound$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT (
      (OLD.state = 'prepared' AND NEW.state IN ('dispatching', 'held'))
      OR (OLD.state = 'held' AND NEW.state = 'prepared')
      OR (OLD.state = 'dispatching' AND NEW.state IN ('reconciling', 'sent'))
      OR (OLD.state = 'reconciling' AND NEW.state IN ('sent', 'unknown_terminal'))
    ) THEN
      RAISE EXCEPTION 'outbound fence % cannot move from % to %', OLD.id, OLD.state, NEW.state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- The token is written by the one atomic transition and never again. A second
  -- write would be a second authorization to call Gmail.
  IF OLD.attempt_token IS NOT NULL AND NEW.attempt_token IS DISTINCT FROM OLD.attempt_token THEN
    RAISE EXCEPTION 'the attempt token of outbound fence % is not reusable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.dispatch_started_at IS NOT NULL
     AND NEW.dispatch_started_at IS DISTINCT FROM OLD.dispatch_started_at THEN
    RAISE EXCEPTION 'the dispatch instant of outbound fence % is written once', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- 12.5: "envelope columns become immutable when dispatch begins". `prepared` and
  -- `held` may still be re-rendered — a template correction before anything left is
  -- exactly what should be allowed — but once a token exists the bytes are history.
  IF OLD.attempt_token IS NOT NULL AND (
    NEW.mailbox_id IS DISTINCT FROM OLD.mailbox_id
    OR NEW.origin_kind IS DISTINCT FROM OLD.origin_kind
    OR NEW.enrollment_id IS DISTINCT FROM OLD.enrollment_id
    OR NEW.step_execution_id IS DISTINCT FROM OLD.step_execution_id
    OR NEW.draft_id IS DISTINCT FROM OLD.draft_id
    OR NEW.firm_id IS DISTINCT FROM OLD.firm_id
    OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
    OR NEW.opportunity_id IS DISTINCT FROM OLD.opportunity_id
    OR NEW.recipient_address IS DISTINCT FROM OLD.recipient_address
    OR NEW.recipient_route_id IS DISTINCT FROM OLD.recipient_route_id
    OR NEW.recipient_route_version IS DISTINCT FROM OLD.recipient_route_version
    OR NEW.subject IS DISTINCT FROM OLD.subject
    OR NEW.body IS DISTINCT FROM OLD.body
    OR NEW.template_version_id IS DISTINCT FROM OLD.template_version_id
    OR NEW.rendered_hash IS DISTINCT FROM OLD.rendered_hash
    OR NEW.provider_message_id_header IS DISTINCT FROM OLD.provider_message_id_header
    OR NEW.send_at IS DISTINCT FROM OLD.send_at
    OR NEW.source_zone IS DISTINCT FROM OLD.source_zone
  ) THEN
    RAISE EXCEPTION 'the envelope of outbound fence % is immutable once dispatch began', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$outbound$;

CREATE TRIGGER outbound_messages_transition
  BEFORE UPDATE ON outbound_messages
  FOR EACH ROW EXECUTE FUNCTION assert_outbound_transition();



-- ---------------------------------------------------------------------------
-- outbound_message_events (specification 12.5, 13.2, Appendix F)
--
-- Append-only. One row per transition, with the token that authorized it where there
-- was one.
--
-- The fence itself only ever shows its current state, and the question an incident
-- asks is the historical one: did this fence ever leave `dispatching` twice, and
-- which process held the token when it did? A ledger answers that; a state column
-- cannot. UPDATE and DELETE are revoked so the answer cannot be edited afterwards,
-- the same treatment `mail_message_effects` and the suppression journal get.
-- ---------------------------------------------------------------------------
CREATE TABLE outbound_message_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  outbound_message_id uuid NOT NULL,
  sequence_number integer NOT NULL,
  from_state text,
  to_state text NOT NULL,
  attempt_token uuid,
  -- Which process said so. A worker instance key or an actor description, never a
  -- credential and never a person's address.
  actor text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbound_message_events_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT outbound_message_events_fence_fkey FOREIGN KEY (workspace_id, outbound_message_id)
    REFERENCES outbound_messages (workspace_id, id),
  CONSTRAINT outbound_message_events_ordered UNIQUE (workspace_id, outbound_message_id, sequence_number),
  CONSTRAINT outbound_message_events_sequence_positive CHECK (sequence_number >= 1),
  CONSTRAINT outbound_message_events_from_state_known
    CHECK (from_state IS NULL
           OR from_state IN ('prepared', 'held', 'dispatching', 'reconciling', 'sent', 'unknown_terminal')),
  CONSTRAINT outbound_message_events_to_state_known
    CHECK (to_state IN ('prepared', 'held', 'dispatching', 'reconciling', 'sent', 'unknown_terminal')),
  CONSTRAINT outbound_message_events_actor_bounded
    CHECK (btrim(actor) <> '' AND length(actor) <= 120),
  CONSTRAINT outbound_message_events_detail_is_object CHECK (jsonb_typeof(detail) = 'object'),
  CONSTRAINT outbound_message_events_detail_bounded CHECK (pg_column_size(detail) <= 4000)
);

CREATE INDEX outbound_message_events_by_fence
  ON outbound_message_events (workspace_id, outbound_message_id, sequence_number);


-- ---------------------------------------------------------------------------
-- Privileges
--
-- Migration 0001's `GRANT ... ON ALL TABLES` covered only the tables that existed
-- then, so each table here needs its own grant.
--
-- Two of them are narrower than the rest, and both narrowings are the point of the
-- table.
--
-- `outbound_messages` has no DELETE. A fence is the record that an email was sent to
-- a prospect: it is business history, it corroborates a suppression, and 10.3 keeps
-- it with the business record rather than expiring it with the draft. Deleting one
-- would also destroy the evidence that it was sent *once*.
--
-- `outbound_message_events` has no UPDATE and no DELETE. It is the ledger that
-- answers "did this fence ever leave dispatching twice", and an answer that can be
-- edited afterwards is not evidence. The same treatment `mail_message_effects` gets.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON sending_domains TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE ON mailbox_send_ramp TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE ON mailbox_send_days TO app_runtime, migration;

GRANT SELECT, INSERT, UPDATE ON outbound_messages TO app_runtime, migration;
REVOKE DELETE, TRUNCATE ON outbound_messages FROM app_runtime, migration;

GRANT SELECT, INSERT ON outbound_message_events TO app_runtime, migration;
REVOKE UPDATE, DELETE, TRUNCATE ON outbound_message_events FROM app_runtime, migration;
