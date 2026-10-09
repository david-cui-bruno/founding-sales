-- Versioned processing receipts contain source identity, never copied source text.
CREATE TABLE crm_extraction_generations (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL,
  source_kind text NOT NULL CHECK(source_kind IN ('selected_note','mail','call_transcript','meeting_transcript')),
  source_revision integer NOT NULL CHECK(source_revision>0),
  source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
  requested_by uuid NOT NULL,
  purpose_revision integer NOT NULL DEFAULT 0 CHECK(purpose_revision>=0),
  processor_version text NOT NULL CHECK(length(processor_version) BETWEEN 1 AND 100),
  model_version text CHECK(model_version IS NULL OR length(model_version) BETWEEN 1 AND 200),
  state text NOT NULL CHECK(state IN ('unavailable','pending','processing','complete','failed','stale','deleted','unknown_acceptance')),
  reason text CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 100),
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,source_kind,source_id,source_revision,source_hash,processor_version,purpose_revision),
  FOREIGN KEY(workspace_id,requested_by) REFERENCES workspace_memberships(workspace_id,user_id)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_extraction_generations TO app_runtime,migration;
CREATE TABLE crm_extraction_purposes (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  revision integer NOT NULL CHECK(revision>0),
  enabled boolean NOT NULL DEFAULT false,
  endpoint_id text NOT NULL CHECK(length(endpoint_id) BETWEEN 1 AND 100),
  model_version text NOT NULL CHECK(length(model_version) BETWEEN 1 AND 200),
  access_grant_version text NOT NULL CHECK(length(access_grant_version) BETWEEN 1 AND 200),
  data_handling_version text NOT NULL CHECK(length(data_handling_version) BETWEEN 1 AND 200),
  daily_ceiling_cents integer NOT NULL CHECK(daily_ceiling_cents BETWEEN 1 AND 100000),
  monthly_ceiling_cents integer NOT NULL CHECK(monthly_ceiling_cents BETWEEN 1 AND 1000000),
  input_token_price_micros integer NOT NULL CHECK(input_token_price_micros BETWEEN 1 AND 1000000),
  output_token_price_micros integer NOT NULL CHECK(output_token_price_micros BETWEEN 1 AND 1000000),
  approved_by uuid NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,approved_by) REFERENCES workspace_memberships(workspace_id,user_id)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_extraction_purposes TO app_runtime,migration;
-- Every selected-source lifecycle path (including operational deletion) invalidates old work.
CREATE FUNCTION invalidate_crm_extraction_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revision IS DISTINCT FROM NEW.revision OR OLD.availability IS DISTINCT FROM NEW.availability
     OR OLD.content_hash IS DISTINCT FROM NEW.content_hash THEN
    UPDATE crm_extraction_generations SET
      state=CASE WHEN NEW.availability='deleted' THEN 'deleted' ELSE 'stale' END,
      reason=CASE WHEN NEW.availability='deleted' THEN 'source_deleted' ELSE 'source_changed' END
    WHERE workspace_id=NEW.workspace_id AND source_id=NEW.id AND source_kind='selected_note'
      AND state NOT IN ('deleted','stale');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_selected_source_extraction_invalidation AFTER UPDATE ON crm_selected_sources
FOR EACH ROW EXECUTE FUNCTION invalidate_crm_extraction_source();
