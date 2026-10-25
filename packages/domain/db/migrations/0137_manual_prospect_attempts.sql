-- changes: sourcing_manual_prospect_attempts
-- Private current user reports only. No canonical call/callback/Today side effects.
CREATE FUNCTION valid_manual_activity_content(c jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE occurrence jsonb; cb jsonb; timing jsonb; prose text; units integer;
BEGIN
 IF jsonb_typeof(c)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(c))<>6
  OR NOT c ?& ARRAY['performedByUser','channel','occurrence','result','note','callback']
  OR c->'performedByUser'<>'true'::jsonb OR c->>'channel'<>'manual_phone'
  OR jsonb_typeof(c->'channel')<>'string' OR jsonb_typeof(c->'result')<>'string'
  OR c->>'result' NOT IN ('unknown','no_answer','busy','voicemail_left','conversation','callback_requested','not_interested','wrong_number','do_not_call','technical_failure') THEN RETURN false; END IF;
 occurrence:=c->'occurrence';
 IF jsonb_typeof(occurrence)<>'object' THEN RETURN false; END IF;
 IF occurrence->>'kind'='unknown' THEN
  IF (SELECT count(*) FROM jsonb_object_keys(occurrence))<>1 THEN RETURN false; END IF;
 ELSIF occurrence->>'kind'='known' THEN
  IF (SELECT count(*) FROM jsonb_object_keys(occurrence))<>2 OR jsonb_typeof(occurrence->'occurredAt')<>'string'
   OR occurrence->>'occurredAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$' THEN RETURN false; END IF;
  PERFORM (occurrence->>'occurredAt')::timestamptz;
 ELSE RETURN false; END IF;
 IF c->'note'<>'null'::jsonb THEN
  IF jsonb_typeof(c->'note')<>'string' OR octet_length(c->>'note')>4000 THEN RETURN false; END IF;
  SELECT COALESCE(sum(CASE WHEN octet_length(ch)>3 THEN 2 ELSE 1 END),0) INTO units FROM regexp_split_to_table(c->>'note','') ch;
  IF units>1000 THEN RETURN false; END IF;
 END IF;
 cb:=c->'callback';
 IF (c->>'result'='callback_requested') IS DISTINCT FROM (cb<>'null'::jsonb) THEN RETURN false; END IF;
 IF cb<>'null'::jsonb THEN
  IF jsonb_typeof(cb)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(cb))<>2 OR NOT cb ?& ARRAY['note','timing'] THEN RETURN false; END IF;
  IF cb->'note'<>'null'::jsonb THEN
   IF jsonb_typeof(cb->'note')<>'string' OR octet_length(cb->>'note')>2000 THEN RETURN false; END IF;
   prose:=cb->>'note'; SELECT COALESCE(sum(CASE WHEN octet_length(ch)>3 THEN 2 ELSE 1 END),0) INTO units FROM regexp_split_to_table(prose,'') ch;
   IF units>500 THEN RETURN false; END IF;
  END IF;
  timing:=cb->'timing';
  IF jsonb_typeof(timing)<>'object' THEN RETURN false; END IF;
  IF timing->>'kind'='unknown' THEN
   IF (SELECT count(*) FROM jsonb_object_keys(timing))<>1 THEN RETURN false; END IF;
  ELSIF timing->>'kind'='confirmed' THEN
   IF (SELECT count(*) FROM jsonb_object_keys(timing))<>5 OR NOT timing ?& ARRAY['kind','localDate','localTime','sourceTimeZone','dueAt']
    OR jsonb_typeof(timing->'localDate')<>'string' OR jsonb_typeof(timing->'localTime')<>'string'
    OR jsonb_typeof(timing->'sourceTimeZone')<>'string' OR jsonb_typeof(timing->'dueAt')<>'string'
    OR length(timing->>'sourceTimeZone') NOT BETWEEN 1 AND 64 OR timing->>'localDate' !~ '^\d{4}-\d{2}-\d{2}$'
    OR timing->>'localTime' !~ '^([01]\d|2[0-3]):[0-5]\d$'
    OR timing->>'dueAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$' THEN RETURN false; END IF;
   PERFORM (timing->>'localDate')::date; PERFORM (timing->>'dueAt')::timestamptz;
  ELSE RETURN false; END IF;
 END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE TABLE sourcing_manual_prospect_attempts (
 workspace_id uuid NOT NULL,
 candidate_id uuid NOT NULL,
 id uuid NOT NULL,
 candidate_revision integer NOT NULL,
 revision integer NOT NULL DEFAULT 1,
 content jsonb,
 reason text,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id),
 CONSTRAINT manual_activity_candidate_fk FOREIGN KEY(workspace_id,candidate_id) REFERENCES sourcing_candidates(workspace_id,id) ON DELETE CASCADE,
 CONSTRAINT manual_activity_candidate_revision CHECK(candidate_revision>0),
 CONSTRAINT manual_activity_revision CHECK(revision>0),
 CONSTRAINT manual_activity_clock CHECK(updated_at>=recorded_at),
 CONSTRAINT manual_activity_content CHECK((content IS NOT NULL AND reason IS NULL AND valid_manual_activity_content(content)) OR
  (content IS NULL AND reason IS NOT NULL AND reason IN ('withdrawn','source_changed_or_unavailable','candidate_revision_changed','removed')))
);
CREATE INDEX manual_activity_candidate_page ON sourcing_manual_prospect_attempts(workspace_id,candidate_id,candidate_revision,id);
CREATE FUNCTION manual_activity_current_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.workspace_id,NEW.candidate_id,NEW.id,NEW.candidate_revision,NEW.recorded_at) IS DISTINCT FROM
    (OLD.workspace_id,OLD.candidate_id,OLD.id,OLD.candidate_revision,OLD.recorded_at)
    OR NEW.revision<>OLD.revision+1 OR (OLD.content IS NULL AND NEW.content IS NOT NULL) THEN
  RAISE EXCEPTION 'manual activity immutable or terminal identity' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER manual_activity_current_only BEFORE UPDATE ON sourcing_manual_prospect_attempts FOR EACH ROW EXECUTE FUNCTION manual_activity_current_only();
GRANT SELECT,INSERT,UPDATE,DELETE ON sourcing_manual_prospect_attempts TO app_runtime,migration;
-- Source references are read under the existing workspace source lifecycle lock.
-- This function erases current content before source rows/predicates disappear.
CREATE FUNCTION erase_manual_activity_sources(w uuid, urls text[]) RETURNS bigint LANGUAGE sql AS $$
 WITH erased AS (
 UPDATE sourcing_manual_prospect_attempts a SET content=NULL,reason='source_changed_or_unavailable',revision=a.revision+1,updated_at=clock_timestamp()
 FROM sourcing_candidates c WHERE a.workspace_id=w AND c.workspace_id=w AND a.candidate_id=c.id AND a.content IS NOT NULL
 AND (rtrim(c.payload->>'sourceUrl','/')=ANY(urls) OR rtrim(c.source_check->'lastSuccess'->>'url','/')=ANY(urls)
  OR EXISTS(SELECT 1 FROM sourcing_candidate_discovery_origins o WHERE o.workspace_id=w AND o.candidate_id=c.id AND rtrim(o.source->>'sourceUrl','/')=ANY(urls))) RETURNING a.id)
 SELECT count(*) FROM erased;
$$;
CREATE FUNCTION manual_activity_candidate_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.revision IS DISTINCT FROM OLD.revision OR NEW.status='dismissed' THEN
  UPDATE sourcing_manual_prospect_attempts SET content=NULL,reason='candidate_revision_changed',revision=revision+1,updated_at=clock_timestamp()
   WHERE workspace_id=OLD.workspace_id AND candidate_id=OLD.id AND content IS NOT NULL;
 END IF;
 IF NEW.source_check->>'state'='unavailable' AND NEW.source_check->>'reason' IN ('source_unavailable','source_not_permitted','no_readable_text') THEN
  PERFORM erase_manual_activity_sources(OLD.workspace_id,ARRAY[rtrim(OLD.payload->>'sourceUrl','/'),rtrim(OLD.source_check->'lastSuccess'->>'url','/'),rtrim(NEW.source_check->'lastSuccess'->>'url','/')]);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER manual_activity_candidate_lifecycle BEFORE UPDATE OF revision,status,source_check ON sourcing_candidates FOR EACH ROW EXECUTE FUNCTION manual_activity_candidate_lifecycle();
CREATE FUNCTION manual_activity_origin_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE sourcing_manual_prospect_attempts SET content=NULL,reason='source_changed_or_unavailable',revision=revision+1,updated_at=clock_timestamp()
 WHERE workspace_id=OLD.workspace_id AND candidate_id=OLD.candidate_id AND content IS NOT NULL;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER manual_activity_origin_lifecycle BEFORE DELETE OR UPDATE ON sourcing_candidate_discovery_origins FOR EACH ROW EXECUTE FUNCTION manual_activity_origin_lifecycle();
