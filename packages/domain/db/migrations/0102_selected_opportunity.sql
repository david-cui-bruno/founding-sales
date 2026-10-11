-- changes: crm_selected_sources
-- Explicit selected evidence association; never inferred from excerpt text.
ALTER TABLE crm_selected_sources ADD COLUMN opportunity_id uuid, ADD COLUMN opportunity_firm_id uuid,
 ADD CONSTRAINT selected_opportunity_pair CHECK ((opportunity_id IS NULL)=(opportunity_firm_id IS NULL)),
 ADD CONSTRAINT selected_opportunity_identity FOREIGN KEY(workspace_id,opportunity_id,opportunity_firm_id) REFERENCES opportunities(workspace_id,id,firm_id);
CREATE FUNCTION crm_selected_opportunity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.availability='available' AND NEW.availability='available' AND ROW(NEW.opportunity_id,NEW.opportunity_firm_id) IS DISTINCT FROM ROW(OLD.opportunity_id,OLD.opportunity_firm_id)
 THEN RAISE EXCEPTION 'Selected opportunity association is immutable until explicit recapture' USING ERRCODE='23514'; END IF;
 IF NEW.availability<>'available' THEN NEW.opportunity_id=NULL; NEW.opportunity_firm_id=NULL; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_selected_opportunity_binding BEFORE UPDATE ON crm_selected_sources FOR EACH ROW EXECUTE FUNCTION crm_selected_opportunity_immutable();
CREATE OR REPLACE FUNCTION capture_crm_selected_access_closure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior jsonb;firms jsonb;people jsonb;
BEGIN
 IF TG_OP='INSERT' THEN prior='{"firmIds":[],"personIds":[]}'::jsonb;
 ELSE
   IF NOT(OLD.availability<>'available' AND NEW.availability='available') THEN
     IF NEW.original_access_closure IS DISTINCT FROM OLD.original_access_closure THEN RAISE EXCEPTION 'Original copied authority is immutable' USING ERRCODE='23514',CONSTRAINT='crm_selected_original_access_immutable'; END IF;
     RETURN NEW;
   END IF;
   prior=COALESCE(OLD.original_access_closure,'{"firmIds":[],"personIds":[]}'::jsonb);
 END IF;
 SELECT COALESCE(jsonb_agg(id ORDER BY id),'[]'::jsonb) INTO firms FROM (
   SELECT jsonb_array_elements_text(prior->'firmIds') id
   UNION SELECT NEW.firm_id::text WHERE NEW.firm_id IS NOT NULL
   UNION SELECT NEW.opportunity_firm_id::text WHERE NEW.opportunity_firm_id IS NOT NULL
   UNION SELECT cx.firm_id::text FROM crm_source_relationship_contexts cx WHERE cx.workspace_id=NEW.workspace_id AND cx.source_id=NEW.id
   UNION SELECT c.firm_id::text FROM crm_legacy_contact_people b JOIN contacts c ON c.workspace_id=b.workspace_id AND c.id=b.contact_id
     WHERE b.workspace_id=NEW.workspace_id AND b.person_id=NEW.person_id AND NOT EXISTS(SELECT 1 FROM crm_source_relationship_contexts cx WHERE cx.workspace_id=NEW.workspace_id AND cx.source_id=NEW.id)
 ) selected;
 SELECT COALESCE(jsonb_agg(id ORDER BY id),'[]'::jsonb) INTO people FROM (
   SELECT jsonb_array_elements_text(prior->'personIds') id
   UNION SELECT NEW.person_id::text WHERE NEW.person_id IS NOT NULL
   UNION SELECT cx.person_id::text FROM crm_source_relationship_contexts cx WHERE cx.workspace_id=NEW.workspace_id AND cx.source_id=NEW.id
 ) selected;
 NEW.original_access_closure=jsonb_build_object('firmIds',firms,'personIds',people);
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION crm_extraction_context_valid(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE element jsonb; field text; uuid_pattern text := '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$';
BEGIN
 IF value IS NULL THEN RETURN true; END IF;
 IF jsonb_typeof(value)<>'object' OR value-ARRAY['personId','firmIds','relationships','review','mailContexts','opportunityId']<>'{}'::jsonb
 OR NOT value ?& ARRAY['personId','firmIds','relationships','review']
 OR jsonb_typeof(value->'firmIds')<>'array' OR jsonb_typeof(value->'relationships')<>'array'
 OR jsonb_typeof(value->'review')<>'string' OR value->>'review' NOT IN ('current','required') THEN RETURN false; END IF;
 IF value ? 'opportunityId' AND value->'opportunityId'<>'null'::jsonb AND (jsonb_typeof(value->'opportunityId')<>'string' OR value->>'opportunityId' !~ uuid_pattern) THEN RETURN false; END IF;
 IF value ? 'mailContexts' THEN
  IF jsonb_typeof(value->'mailContexts')<>'array' OR jsonb_array_length(value->'mailContexts')>100 THEN RETURN false; END IF;
  FOR element IN SELECT jsonb_array_elements(value->'mailContexts') LOOP
   IF jsonb_typeof(element)<>'object' OR element-ARRAY['contextId','sourceRevision','personId','firmId','opportunityId','operationalMatchId','operationalMatchHash','kind']<>'{}'::jsonb
   OR NOT element ?& ARRAY['contextId','sourceRevision','personId','firmId','opportunityId','operationalMatchId','operationalMatchHash','kind']
   OR jsonb_typeof(element->'contextId')<>'string' OR element->>'contextId' !~ uuid_pattern
   OR jsonb_typeof(element->'sourceRevision')<>'number' OR element->>'sourceRevision' !~ '^[1-9][0-9]{0,9}$'
   OR jsonb_typeof(element->'kind')<>'string' OR element->>'kind' NOT IN ('acquired','reviewed') THEN RETURN false; END IF;
   IF (element->>'sourceRevision')::bigint>2147483647 THEN RETURN false; END IF;
   FOREACH field IN ARRAY ARRAY['personId','firmId','opportunityId','operationalMatchId'] LOOP
    IF element->field<>'null'::jsonb AND (jsonb_typeof(element->field)<>'string' OR element->>field !~ uuid_pattern) THEN RETURN false; END IF;
   END LOOP;
   IF element->'operationalMatchHash'<>'null'::jsonb AND (jsonb_typeof(element->'operationalMatchHash')<>'string' OR element->>'operationalMatchHash' !~ '^[a-f0-9]{64}$') THEN RETURN false; END IF;
   IF (element->'operationalMatchId'='null'::jsonb)<>(element->'operationalMatchHash'='null'::jsonb) THEN RETURN false; END IF;
  END LOOP;
 END IF;
 IF octet_length(value::text)>(CASE WHEN jsonb_typeof(value->'mailContexts')='array' AND jsonb_array_length(value->'mailContexts')>0 THEN 64000 ELSE 20000 END) THEN RETURN false; END IF;
 IF value->'personId'<>'null'::jsonb AND (jsonb_typeof(value->'personId')<>'string' OR value->>'personId' !~ uuid_pattern) THEN RETURN false; END IF;
 IF jsonb_array_length(value->'firmIds')>100 OR jsonb_array_length(value->'relationships')>100 THEN RETURN false; END IF;
 FOR element IN SELECT jsonb_array_elements(value->'firmIds') LOOP
  IF jsonb_typeof(element)<>'string' OR element #>> '{}' !~ uuid_pattern THEN RETURN false; END IF;
 END LOOP;
 FOR element IN SELECT jsonb_array_elements(value->'relationships') LOOP
  IF jsonb_typeof(element)<>'object' OR element-ARRAY['relationshipId','revision']<>'{}'::jsonb
  OR NOT element ?& ARRAY['relationshipId','revision'] OR jsonb_typeof(element->'relationshipId')<>'string'
  OR element->>'relationshipId' !~ uuid_pattern OR jsonb_typeof(element->'revision')<>'number'
  OR element->>'revision' !~ '^[1-9][0-9]{0,9}$' THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
