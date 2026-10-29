-- changes: sourcing_automatic_research_firms
-- Legacy rows keep the exact legacy interpretation. New coverage is explicit;
-- no evidence, fingerprint, owner, source or historical row is rewritten.
ALTER TABLE sourcing_automatic_research_firms
 ADD COLUMN native_policy_version text NOT NULL DEFAULT 'native-firm-eligibility-v1',
 ADD CONSTRAINT automatic_research_native_policy_supported
 CHECK(native_policy_version IN ('native-firm-eligibility-v1','native-firm-eligibility-us-v1'));

CREATE FUNCTION automatic_research_native_policy_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.native_policy_version IS DISTINCT FROM OLD.native_policy_version THEN
  RAISE EXCEPTION 'automatic research native policy is immutable'
   USING ERRCODE='23514',CONSTRAINT='automatic_research_native_policy_immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER automatic_research_native_policy_immutable
 AFTER UPDATE ON sourcing_automatic_research_firms
 FOR EACH ROW EXECUTE FUNCTION automatic_research_native_policy_immutable();
