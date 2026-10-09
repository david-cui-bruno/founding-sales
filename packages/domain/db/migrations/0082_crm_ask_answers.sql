-- Owner-private requests are also the future private history identity.
CREATE TABLE crm_ask_requests (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 owner_user_id uuid NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 epoch integer NOT NULL DEFAULT 1 CHECK(epoch>0),
 question text,
 scope jsonb,
 initial_contexts jsonb,
 initial_access_closure jsonb,
 state text NOT NULL CHECK(state IN ('pending','unavailable','unknown_acceptance','stale','complete','deleted')),
 reason text CHECK(reason IS NULL OR reason IN ('purpose_unavailable','evaluation_unavailable','processing_authority_unavailable','budget_held','input_bound_reached','source_unavailable','source_changed','purpose_changed','provider_acceptance_unknown','processing_failed','unsupported_answer','deleted')),
 result jsonb,
 result_at timestamptz,
 purpose_revision integer CHECK(purpose_revision IS NULL OR purpose_revision>0),
 evaluation_fingerprint text CHECK(evaluation_fingerprint IS NULL OR evaluation_fingerprint ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 CONSTRAINT crm_ask_request_private_shape CHECK (
  (state='deleted' AND question IS NULL AND scope IS NULL AND initial_contexts IS NULL AND initial_access_closure IS NULL AND result IS NULL AND result_at IS NULL)
  OR (state<>'deleted' AND scope IS NOT NULL AND jsonb_typeof(scope)='object' AND jsonb_typeof(scope->'sources')='array' AND jsonb_array_length(scope->'sources') BETWEEN 1 AND 10 AND initial_contexts IS NOT NULL AND jsonb_typeof(initial_contexts)='array' AND crm_access_closure_valid(initial_access_closure) AND (question IS NOT NULL AND length(question) BETWEEN 1 AND 300 OR state='stale' AND question IS NULL))),
 CONSTRAINT crm_ask_request_result_shape CHECK ((state='complete' AND result IS NOT NULL AND jsonb_typeof(result)='object' AND octet_length(result::text)<=100000 AND result_at IS NOT NULL) OR (state<>'complete' AND result IS NULL AND result_at IS NULL))
);
CREATE FUNCTION crm_ask_initial_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.workspace_id,NEW.id,NEW.owner_user_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.id,OLD.owner_user_id,OLD.created_at)
 OR OLD.state='deleted' AND NEW.state<>'deleted'
 OR NEW.state<>'deleted' AND ROW(NEW.scope,NEW.initial_contexts,NEW.initial_access_closure) IS DISTINCT FROM ROW(OLD.scope,OLD.initial_contexts,OLD.initial_access_closure) THEN
 RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='crm_ask_initial_identity_immutable',MESSAGE='Ask initial identity is immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER crm_ask_initial_identity_immutable AFTER UPDATE ON crm_ask_requests DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION crm_ask_initial_identity_immutable();
CREATE TABLE crm_ask_purposes (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 purpose text NOT NULL CHECK(purpose IN ('answer','embedding','support')),
 revision integer NOT NULL CHECK(revision>0),
 enabled boolean NOT NULL DEFAULT false,
 endpoint_id text NOT NULL CHECK(length(endpoint_id) BETWEEN 1 AND 100),
 model_version text NOT NULL CHECK(length(model_version) BETWEEN 1 AND 200),
 access_grant_version text NOT NULL CHECK(length(access_grant_version) BETWEEN 1 AND 200),
 data_handling_version text NOT NULL CHECK(length(data_handling_version) BETWEEN 1 AND 200),
 evaluation_fingerprint text NOT NULL CHECK(evaluation_fingerprint ~ '^[a-f0-9]{64}$'),
 processor_version text NOT NULL CHECK(length(processor_version) BETWEEN 1 AND 100),
 retrieval_version text NOT NULL CHECK(length(retrieval_version) BETWEEN 1 AND 100),
 answer_version text NOT NULL CHECK(length(answer_version) BETWEEN 1 AND 100),
 support_version text NOT NULL CHECK(length(support_version) BETWEEN 1 AND 100),
 chunker_version text NOT NULL CHECK(length(chunker_version) BETWEEN 1 AND 100),
 daily_ceiling_cents integer NOT NULL CHECK(daily_ceiling_cents BETWEEN 1 AND 100000),
 monthly_ceiling_cents integer NOT NULL CHECK(monthly_ceiling_cents BETWEEN 1 AND 1000000),
 input_token_price_micros integer NOT NULL CHECK(input_token_price_micros BETWEEN 1 AND 1000000),
 output_token_price_micros integer NOT NULL CHECK(output_token_price_micros BETWEEN 1 AND 1000000),
 approved_by uuid NOT NULL,
 approved_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,purpose),
 FOREIGN KEY(workspace_id,approved_by) REFERENCES workspace_memberships(workspace_id,user_id)
);
GRANT SELECT,INSERT,UPDATE ON crm_ask_requests TO app_runtime,migration;
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_ask_purposes TO app_runtime,migration;
