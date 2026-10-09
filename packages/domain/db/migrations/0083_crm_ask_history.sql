-- #494 owner-private history shares the existing request identity and copied input.
ALTER TABLE crm_ask_requests
 ADD COLUMN history_revision integer NOT NULL DEFAULT 1 CONSTRAINT crm_ask_history_revision_positive CHECK(history_revision>0),
 ADD COLUMN history_title text CONSTRAINT crm_ask_history_title_bound CHECK(history_title IS NULL OR length(btrim(history_title)) BETWEEN 1 AND 100),
 ADD COLUMN history_pinned boolean NOT NULL DEFAULT false,
 ADD COLUMN history_updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
UPDATE crm_ask_requests SET history_updated_at=created_at;
CREATE INDEX crm_ask_owner_history ON crm_ask_requests(workspace_id,owner_user_id,history_pinned DESC,created_at DESC,id DESC);
