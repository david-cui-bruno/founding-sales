-- Qualification is evidence about a candidate, not authority to contact a firm.
CREATE TABLE sourcing_qualification_runs (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL,
  candidate_revision integer NOT NULL CHECK(candidate_revision>0),
  fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
  prompt_version text NOT NULL CHECK(length(prompt_version) BETWEEN 1 AND 80),
  policy_version text NOT NULL CHECK(length(policy_version) BETWEEN 1 AND 80),
  model_name text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','review','eligible','admitted','unavailable')),
  reason text CHECK(length(reason) BETWEEN 1 AND 120),
  observations jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(observations)='array' AND octet_length(observations::text)<=131072),
  facts jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(facts)='array' AND octet_length(facts::text)<=65536),
  verdict jsonb CHECK(jsonb_typeof(verdict)='object' AND octet_length(verdict::text)<=8192),
  opening_question text CHECK(length(opening_question)<=240),
  requested_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
  finished_at timestamptz,
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,candidate_id) REFERENCES sourcing_candidates(workspace_id,id) ON DELETE CASCADE,
  UNIQUE(workspace_id,candidate_id,fingerprint),
  CONSTRAINT sourcing_qualification_candidate_run UNIQUE(workspace_id,candidate_id,id),
  CONSTRAINT sourcing_qualification_deadline CHECK(deadline_at>requested_at)
);
CREATE INDEX sourcing_qualification_latest ON sourcing_qualification_runs(workspace_id,candidate_id,requested_at DESC,id DESC);
CREATE INDEX sourcing_qualification_due ON sourcing_qualification_runs(deadline_at) WHERE state IN ('pending','running');
CREATE TABLE sourcing_admissions (
  workspace_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  run_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  route_id uuid NOT NULL,
  admitted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,candidate_id),
  FOREIGN KEY(workspace_id,candidate_id) REFERENCES sourcing_candidates(workspace_id,id) ON DELETE CASCADE,
  CONSTRAINT sourcing_admissions_candidate_run FOREIGN KEY(workspace_id,candidate_id,run_id) REFERENCES sourcing_qualification_runs(workspace_id,candidate_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,firm_id) REFERENCES firms(workspace_id,id),
  FOREIGN KEY(workspace_id,route_id) REFERENCES phone_routes(workspace_id,id)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON sourcing_qualification_runs,sourcing_admissions TO app_runtime,migration;
ALTER TABLE provider_reservations DROP CONSTRAINT provider_reservations_subject_known,
  ADD CONSTRAINT provider_reservations_subject_known CHECK(subject_kind IN ('research_run','call_session','call_transcription','reply_classification','call_summary','call_analysis','meeting_transcription','meeting_analysis','sourcing_qualification')),
  DROP CONSTRAINT provider_reservations_priced_shape,
  ADD CONSTRAINT provider_reservations_priced_shape CHECK (
    (subject_kind NOT IN ('research_run','reply_classification','call_summary','call_analysis','meeting_analysis','sourcing_qualification') OR
      (model_name IS NOT NULL AND max_input_tokens IS NOT NULL AND max_output_tokens IS NOT NULL AND priced_unit IS NULL AND max_units IS NULL AND unit_price_micros IS NULL))
    AND (subject_kind NOT IN ('call_session','call_transcription','meeting_transcription') OR
      (model_name IS NULL AND max_input_tokens IS NULL AND max_output_tokens IS NULL AND priced_unit='minute' AND priced_unit IS NOT NULL
       AND max_units IS NOT NULL AND max_units BETWEEN 1 AND 240 AND unit_price_micros IS NOT NULL AND unit_price_micros BETWEEN 0 AND 10000000)));
