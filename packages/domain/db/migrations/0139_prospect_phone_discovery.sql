-- changes: sourcing_prospect_phone_discoveries, sourcing_candidates, workspace_memberships, evidence_items, sourcing_candidate_discovery_origins
-- Temporary exact public-page capture. No qualification, CRM, route or outreach grant.
CREATE FUNCTION prospect_phone_content_valid(c jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE p jsonb; b jsonb; u jsonb; host text; n integer; serialized text;
BEGIN
 IF c IS NULL OR jsonb_typeof(c) IS DISTINCT FROM 'object' OR octet_length(c::text)>110000
  OR (SELECT count(*) FROM jsonb_object_keys(c))<>3 OR NOT c ?& ARRAY['website','sourceUrls','observations']
  OR jsonb_typeof(c->'website') IS DISTINCT FROM 'string' OR length(c->>'website') NOT BETWEEN 1 AND 2000
  OR (c->>'website') !~ '^https://[^/@?#:]+([/][^?#]*)?$'
  OR jsonb_typeof(c->'sourceUrls') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'sourceUrls') NOT BETWEEN 1 AND 18
  OR jsonb_typeof(c->'observations') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'observations')>4
  OR octet_length((c->'observations')::text)>100000 THEN RETURN false; END IF;
 host:=regexp_replace(lower(substring(c->>'website' FROM '^https://([^/]+)')),'^www\.','');
 FOR u IN SELECT value FROM jsonb_array_elements(c->'sourceUrls') LOOP
  IF jsonb_typeof(u) IS DISTINCT FROM 'string' OR length(u#>>'{}') NOT BETWEEN 1 AND 2000 THEN RETURN false; END IF;
 END LOOP;
 IF (SELECT count(DISTINCT value) FROM jsonb_array_elements(c->'sourceUrls'))<>jsonb_array_length(c->'sourceUrls') THEN RETURN false; END IF;
 FOR p IN SELECT value FROM jsonb_array_elements(c->'observations') LOOP
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p))<>10
   OR NOT p ?& ARRAY['id','url','contentHash','relevantTextHash','retrievedAt','publishedAt','publishedAtBlockId','firstParty','truncated','blocks']
   OR jsonb_typeof(p->'id') IS DISTINCT FROM 'string' OR (p->>'id') !~ '^[a-f0-9-]{36}$'
   OR jsonb_typeof(p->'url') IS DISTINCT FROM 'string' OR length(p->>'url') NOT BETWEEN 1 AND 2000
   OR (p->>'url') !~ '^https://[^/@?#:]+([/][^?#]*)?$'
   OR regexp_replace(lower(substring(p->>'url' FROM '^https://([^/]+)')),'^www\.','') IS DISTINCT FROM host
   OR jsonb_typeof(p->'contentHash') IS DISTINCT FROM 'string' OR (p->>'contentHash') !~ '^[a-f0-9]{64}$'
   OR jsonb_typeof(p->'relevantTextHash') IS DISTINCT FROM 'string' OR (p->>'relevantTextHash') !~ '^[a-f0-9]{64}$'
   OR jsonb_typeof(p->'retrievedAt') IS DISTINCT FROM 'string' OR NOT isfinite((p->>'retrievedAt')::timestamptz)
   OR p->'publishedAt' IS DISTINCT FROM 'null'::jsonb OR p->'publishedAtBlockId' IS DISTINCT FROM 'null'::jsonb
   OR p->'firstParty' IS DISTINCT FROM 'true'::jsonb OR p->'truncated' IS DISTINCT FROM 'false'::jsonb
   OR jsonb_typeof(p->'blocks') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'blocks') NOT BETWEEN 1 AND 100 THEN RETURN false; END IF;
  FOR b IN SELECT value FROM jsonb_array_elements(p->'blocks') LOOP
   IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(b))<>2 OR NOT b ?& ARRAY['id','text']
    OR jsonb_typeof(b->'id') IS DISTINCT FROM 'string' OR length(b->>'id') NOT BETWEEN 1 AND 80
    OR jsonb_typeof(b->'text') IS DISTINCT FROM 'string' OR length(b->>'text')<1 THEN RETURN false; END IF;
   SELECT COALESCE(sum(CASE WHEN octet_length(ch)>3 THEN 2 ELSE 1 END),0) INTO n FROM regexp_split_to_table(b->>'text','') ch;
   IF n>4000 THEN RETURN false; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p->'blocks'))<>jsonb_array_length(p->'blocks') THEN RETURN false; END IF;
  PERFORM (p->>'id')::uuid;
  SELECT '['||string_agg('{"id":'||to_jsonb(value->>'id')::text||',"text":'||to_jsonb(value->>'text')::text||'}',',' ORDER BY ord)||']'
   INTO serialized FROM jsonb_array_elements(p->'blocks') WITH ORDINALITY blocks(value,ord);
  IF encode(sha256(convert_to(serialized,'UTF8')),'hex') IS DISTINCT FROM p->>'relevantTextHash' THEN RETURN false; END IF;
 END LOOP;
 IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(c->'observations'))<>jsonb_array_length(c->'observations')
 OR (SELECT count(DISTINCT value->>'url') FROM jsonb_array_elements(c->'observations'))<>jsonb_array_length(c->'observations') THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE TABLE sourcing_prospect_phone_discoveries (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL,
 candidate_id uuid NOT NULL,
 candidate_revision integer NOT NULL CHECK(candidate_revision>0),
 creator_user_id uuid NOT NULL,
 creator_ref uuid,
 method text NOT NULL CHECK(method='company-public-phone-v1'),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','complete','unavailable')),
 reason text CHECK(reason IN ('candidate_unavailable','candidate_changed','source_unavailable','source_not_permitted','source_changed','source_expired','official_site_unknown','retained_only','research_disabled','research_held','daily_firm_ceiling','authority_changed','discovery_interrupted','discovery_expired','no_readable_text','bounded_capture_incomplete')),
 requested_at timestamptz NOT NULL,
 deadline_at timestamptz NOT NULL,
 checked_at timestamptz,
 expires_at timestamptz NOT NULL,
 dispatched_at timestamptz,
 dispatch_finished_at timestamptz,
 content jsonb,
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,candidate_id,candidate_revision,method),
 FOREIGN KEY(workspace_id,candidate_id) REFERENCES sourcing_candidates(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,creator_ref) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE SET NULL (creator_ref),
 CHECK(isfinite(requested_at) AND isfinite(deadline_at) AND isfinite(expires_at)),
 CHECK(deadline_at>requested_at AND deadline_at<=requested_at+interval '30 minutes'),
 CHECK(expires_at>requested_at AND expires_at<=requested_at+interval '7 days'),
 CHECK(dispatched_at IS NULL OR dispatched_at>=requested_at),
 CHECK(dispatch_finished_at IS NULL OR (dispatched_at IS NOT NULL AND dispatch_finished_at>=dispatched_at)),
 CHECK((state='unavailable' AND content IS NULL AND reason IS NOT NULL AND checked_at IS NOT NULL)
  OR (state<>'unavailable' AND content IS NOT NULL AND reason IS NULL AND prospect_phone_content_valid(content) AND creator_ref=creator_user_id AND creator_ref IS NOT NULL)),
 CHECK((state='pending' AND dispatched_at IS NULL AND checked_at IS NULL AND dispatch_finished_at IS NULL AND jsonb_array_length(content->'observations')=0)
  OR (state='running' AND dispatched_at IS NOT NULL AND checked_at IS NULL AND dispatch_finished_at IS NULL AND jsonb_array_length(content->'observations')=0)
  OR (state='complete' AND dispatched_at IS NOT NULL AND dispatch_finished_at IS NOT NULL AND checked_at IS NOT NULL AND jsonb_array_length(content->'observations')>0)
  OR state='unavailable')
);
CREATE INDEX prospect_phone_expiry ON sourcing_prospect_phone_discoveries(workspace_id,expires_at) WHERE content IS NOT NULL;
CREATE FUNCTION prospect_phone_run_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payload jsonb; observed jsonb; actual_urls jsonb;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'pending' OR NEW.dispatched_at IS NOT NULL OR NEW.requested_at>clock_timestamp() THEN RAISE EXCEPTION 'phone discovery must start pending' USING ERRCODE='23514'; END IF;
 ELSE
  IF (NEW.workspace_id,NEW.id,NEW.candidate_id,NEW.candidate_revision,NEW.creator_user_id,NEW.method,NEW.requested_at,NEW.deadline_at)
   IS DISTINCT FROM (OLD.workspace_id,OLD.id,OLD.candidate_id,OLD.candidate_revision,OLD.creator_user_id,OLD.method,OLD.requested_at,OLD.deadline_at)
   OR NEW.expires_at>OLD.expires_at OR (NEW.creator_ref IS NOT NULL AND NEW.creator_ref IS DISTINCT FROM OLD.creator_ref)
   OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at)
   OR (OLD.dispatch_finished_at IS NOT NULL AND NEW.dispatch_finished_at IS DISTINCT FROM OLD.dispatch_finished_at)
   OR (OLD.state='unavailable' AND NEW.state<>'unavailable') OR (OLD.state='complete' AND NEW.state NOT IN ('complete','unavailable'))
   OR (OLD.state='pending' AND NEW.state NOT IN ('pending','running','unavailable'))
   OR (OLD.state='running' AND NEW.state NOT IN ('running','complete','unavailable'))
   OR (OLD.dispatched_at IS NULL AND NEW.dispatched_at IS NOT NULL AND NOT (OLD.state='pending' AND NEW.state='running'))
   OR (OLD.content IS NULL AND NEW.content IS NOT NULL)
   OR (NEW.content IS NOT NULL AND ((NEW.content->'website',NEW.content->'sourceUrls') IS DISTINCT FROM (OLD.content->'website',OLD.content->'sourceUrls')))
   OR (OLD.state='complete' AND NEW.content IS NOT NULL AND NEW.content IS DISTINCT FROM OLD.content)
   OR (NEW.content IS NOT NULL AND NEW.state IN ('pending','running') AND NEW.content IS DISTINCT FROM OLD.content) THEN
    RAISE EXCEPTION 'phone discovery immutable identity or dispatch fence' USING ERRCODE='23514';
  END IF;
  IF NEW.creator_ref IS NULL AND NEW.content IS NOT NULL THEN NEW.content:=NULL;NEW.state:='unavailable';NEW.reason:='authority_changed';NEW.checked_at:=clock_timestamp(); END IF;
 END IF;
 IF NEW.content IS NOT NULL THEN
  IF NEW.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'phone discovery grant expired' USING ERRCODE='23514'; END IF;
  SELECT c.payload INTO payload FROM sourcing_candidates c WHERE c.workspace_id=NEW.workspace_id AND c.id=NEW.candidate_id AND c.revision=NEW.candidate_revision AND c.status<>'dismissed';
  IF payload IS NULL OR NOT EXISTS(SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=NEW.workspace_id AND m.user_id=NEW.creator_user_id AND m.role='admin' AND m.status='active') THEN
   RAISE EXCEPTION 'phone discovery current candidate and creator required' USING ERRCODE='23514';
  END IF;
  observed:=CASE WHEN payload->>'kind'='discovery-v1' THEN payload->'row' ELSE payload END;
  IF rtrim(observed->>'website','/') IS DISTINCT FROM rtrim(NEW.content->>'website','/') THEN RAISE EXCEPTION 'phone discovery observed website mismatch' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(url) ORDER BY url),'[]') INTO actual_urls FROM (
   SELECT DISTINCT rtrim(url,'/') AS url FROM (
    SELECT payload->>'sourceUrl' AS url
    UNION ALL SELECT c.source_check->'lastSuccess'->>'url' FROM sourcing_candidates c WHERE c.workspace_id=NEW.workspace_id AND c.id=NEW.candidate_id
    UNION ALL SELECT o.source->>'sourceUrl' FROM sourcing_candidate_discovery_origins o WHERE o.workspace_id=NEW.workspace_id AND o.candidate_id=NEW.candidate_id
   ) sources WHERE url IS NOT NULL
  ) normalized;
  IF NOT actual_urls @> (NEW.content->'sourceUrls') OR jsonb_array_length(actual_urls)<>jsonb_array_length(NEW.content->'sourceUrls') THEN RAISE EXCEPTION 'phone discovery exact source association required' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.content->'observations') p WHERE (p->>'retrievedAt')::timestamptz<NEW.requested_at OR (p->>'retrievedAt')::timestamptz>clock_timestamp()) THEN
   RAISE EXCEPTION 'phone discovery capture time outside request' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER prospect_phone_run_fence BEFORE INSERT OR UPDATE ON sourcing_prospect_phone_discoveries FOR EACH ROW EXECUTE FUNCTION prospect_phone_run_fence();
CREATE FUNCTION erase_prospect_phone_sources(w uuid,urls text[]) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
 UPDATE sourcing_prospect_phone_discoveries r SET content=NULL,state='unavailable',reason='source_unavailable',checked_at=clock_timestamp()
 WHERE r.workspace_id=w AND r.content IS NOT NULL AND (
  EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.content->'sourceUrls') u WHERE rtrim(u,'/')=ANY(urls))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(r.content->'observations') p WHERE rtrim(p->>'url','/')=ANY(urls))
  OR rtrim(r.content->>'website','/')=ANY(urls));
 GET DIAGNOSTICS n=ROW_COUNT;RETURN n;
END $$;
CREATE FUNCTION prospect_phone_source_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE urls text[];
BEGIN
 IF TG_TABLE_NAME='workspace_memberships' THEN
  IF TG_OP='UPDATE' AND NEW.status='active' AND NEW.role='admin' THEN RETURN NEW; END IF;
  UPDATE sourcing_prospect_phone_discoveries SET content=NULL,state='unavailable',reason='authority_changed',checked_at=clock_timestamp()
   WHERE workspace_id=OLD.workspace_id AND creator_user_id=OLD.user_id AND content IS NOT NULL;
 ELSIF TG_TABLE_NAME='sourcing_candidates' THEN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF (NEW.revision,NEW.payload,NEW.status,NEW.source_check->'lastSuccess'->>'url') IS DISTINCT FROM (OLD.revision,OLD.payload,OLD.status,OLD.source_check->'lastSuccess'->>'url') THEN
   UPDATE sourcing_prospect_phone_discoveries SET content=NULL,state='unavailable',reason=CASE WHEN NEW.revision<>OLD.revision THEN 'candidate_changed' ELSE 'source_changed' END,checked_at=clock_timestamp()
    WHERE workspace_id=OLD.workspace_id AND candidate_id=OLD.id AND content IS NOT NULL;
  END IF;
  IF NEW.source_check->>'state'='unavailable' AND NEW.source_check->>'reason' IN ('source_unavailable','source_not_permitted','no_readable_text') THEN
   SELECT array_agg(rtrim(url,'/')) INTO urls FROM (
    SELECT NEW.payload->>'sourceUrl' url UNION ALL SELECT NEW.source_check->'lastSuccess'->>'url'
    UNION ALL SELECT o.source->>'sourceUrl' FROM sourcing_candidate_discovery_origins o WHERE o.workspace_id=NEW.workspace_id AND o.candidate_id=NEW.id
   ) refs WHERE url IS NOT NULL;
   PERFORM erase_prospect_phone_sources(NEW.workspace_id,urls);
  END IF;
 ELSIF TG_TABLE_NAME='evidence_items' THEN
  IF TG_OP='INSERT' THEN
   IF NEW.retention_expires_at<=clock_timestamp() OR (NOT NEW.terms_allow_retention AND NEW.retention_expires_at IS NULL) THEN
    PERFORM erase_prospect_phone_sources(NEW.workspace_id,ARRAY[rtrim(NEW.source_reference,'/')]);
   END IF;
  ELSE PERFORM erase_prospect_phone_sources(OLD.workspace_id,ARRAY[rtrim(OLD.source_reference,'/')]); END IF;
 ELSE
  UPDATE sourcing_prospect_phone_discoveries SET content=NULL,state='unavailable',reason='source_changed',checked_at=clock_timestamp()
   WHERE workspace_id=OLD.workspace_id AND candidate_id=OLD.candidate_id AND content IS NOT NULL;
  PERFORM erase_prospect_phone_sources(OLD.workspace_id,ARRAY[rtrim(OLD.source->>'sourceUrl','/')]);
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
CREATE TRIGGER prospect_phone_member_erasure BEFORE UPDATE OF status,role OR DELETE ON workspace_memberships FOR EACH ROW EXECUTE FUNCTION prospect_phone_source_erasure();
CREATE TRIGGER prospect_phone_candidate_erasure AFTER UPDATE OF revision,payload,status,source_check ON sourcing_candidates FOR EACH ROW EXECUTE FUNCTION prospect_phone_source_erasure();
CREATE TRIGGER prospect_phone_evidence_erasure BEFORE UPDATE OF source_reference,content_hash,retrieved_at,terms_allow_retention,retention_expires_at OR DELETE ON evidence_items FOR EACH ROW EXECUTE FUNCTION prospect_phone_source_erasure();
CREATE TRIGGER prospect_phone_evidence_denial AFTER INSERT ON evidence_items FOR EACH ROW EXECUTE FUNCTION prospect_phone_source_erasure();
CREATE TRIGGER prospect_phone_origin_erasure BEFORE UPDATE OR DELETE ON sourcing_candidate_discovery_origins FOR EACH ROW EXECUTE FUNCTION prospect_phone_source_erasure();
CREATE FUNCTION sweep_prospect_phone_discoveries(w uuid,batch integer) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
 WITH targets AS (
  SELECT r.id FROM sourcing_prospect_phone_discoveries r WHERE r.workspace_id=w AND r.content IS NOT NULL AND (
   r.expires_at<=clock_timestamp() OR (r.state IN ('pending','running') AND r.deadline_at<=clock_timestamp())
   OR NOT EXISTS(SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=w AND m.user_id=r.creator_user_id AND m.role='admin' AND m.status='active')
   OR NOT EXISTS(SELECT 1 FROM sourcing_candidates c WHERE c.workspace_id=w AND c.id=r.candidate_id AND c.revision=r.candidate_revision AND c.status<>'dismissed')
   OR EXISTS(SELECT 1 FROM sourcing_retained_identity_decisions d WHERE d.workspace_id=w AND d.candidate_id=r.candidate_id)
   OR EXISTS(SELECT 1 FROM (
    SELECT value AS url FROM jsonb_array_elements_text(r.content->'sourceUrls')
    UNION ALL SELECT p->>'url' FROM jsonb_array_elements(r.content->'observations') p
   ) urls WHERE
    EXISTS(SELECT 1 FROM evidence_items e WHERE e.workspace_id=w AND rtrim(e.source_reference,'/')=rtrim(urls.url,'/')
     AND (e.retention_expires_at<=clock_timestamp() OR (NOT e.terms_allow_retention AND e.retention_expires_at IS NULL)))
    OR EXISTS(SELECT 1 FROM audit_events a WHERE a.workspace_id=w AND a.action='sourcing.manual_source_retention_expired' AND a.subject_kind='sourcing_source_hash'
     AND a.subject_id=encode(sha256(convert_to(rtrim(urls.url,'/'),'UTF8')),'hex')))
  ) ORDER BY r.id LIMIT greatest(0,least(batch,500)) FOR UPDATE SKIP LOCKED
 ) UPDATE sourcing_prospect_phone_discoveries r SET content=NULL,state='unavailable',reason=CASE WHEN r.expires_at<=clock_timestamp() THEN 'source_expired'
  WHEN r.state IN ('pending','running') AND r.deadline_at<=clock_timestamp() THEN 'discovery_expired' ELSE 'source_unavailable' END,checked_at=clock_timestamp()
 FROM targets t WHERE r.workspace_id=w AND r.id=t.id AND r.content IS NOT NULL;
 GET DIAGNOSTICS n=ROW_COUNT;RETURN n;
END $$;
GRANT SELECT,INSERT,UPDATE ON sourcing_prospect_phone_discoveries TO app_runtime,migration;
REVOKE DELETE,TRUNCATE ON sourcing_prospect_phone_discoveries FROM app_runtime;
