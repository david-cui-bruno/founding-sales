-- changes: outreach_campaign_opening_policies, outreach_campaign_opening_attempts, outbound_messages, sourcing_candidates, sourcing_qualification_runs, firms, workspace_memberships, outreach_email_campaigns, template_versions, sourcing_candidate_discovery_origins, sourcing_discovery_promotions, sourcing_discovery_research_firms, sourcing_automatic_research_firms, evidence_items
-- LOCAL additive approved-choice composition only. Legacy generated-body columns
-- and their ban are untouched. No existing approval gains an opening policy.
CREATE FUNCTION campaign_opening_policy_valid(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v jsonb; stripped text;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p))<>14
 OR NOT p ?& ARRAY['id','workspaceId','ownerUserId','campaignId','campaignRevision','sequenceVersionId','templateVersionId','templateContentHash','revision','mode','firstEmailOnly','variants','approvedAt','expiresAt']
 OR p->>'mode' IS DISTINCT FROM 'approved_variant_selection_v1' OR p->'firstEmailOnly' IS DISTINCT FROM 'true'::jsonb
 OR p->'revision' IS DISTINCT FROM '1'::jsonb OR (p->>'campaignRevision')::integer<1
 OR p->>'templateContentHash' !~ '^[a-f0-9]{64}$' OR jsonb_typeof(p->'variants') IS DISTINCT FROM 'array'
 OR jsonb_array_length(p->'variants') NOT BETWEEN 1 AND 8 OR EXISTS(SELECT 1 FROM jsonb_each(p) WHERE value='null'::jsonb)
 OR NOT isfinite((p->>'approvedAt')::timestamptz) OR NOT isfinite((p->>'expiresAt')::timestamptz)
 OR (p->>'expiresAt')::timestamptz<=(p->>'approvedAt')::timestamptz THEN RETURN false; END IF;
 PERFORM (p->>'id')::uuid,(p->>'workspaceId')::uuid,(p->>'ownerUserId')::uuid,(p->>'campaignId')::uuid,(p->>'sequenceVersionId')::uuid,(p->>'templateVersionId')::uuid;
 FOR v IN SELECT value FROM jsonb_array_elements(p->'variants') LOOP
  IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(v))<>2
  OR NOT v ?& ARRAY['id','text'] OR jsonb_typeof(v->'id') IS DISTINCT FROM 'string' OR v->>'id' !~ '^[a-z][a-z0-9_-]{0,39}$'
  OR jsonb_typeof(v->'text') IS DISTINCT FROM 'string' OR length(v->>'text') NOT BETWEEN 1 AND 400
  OR btrim(v->>'text') IS DISTINCT FROM v->>'text' OR v->>'text' ~ '[\r\n]' THEN RETURN false; END IF;
  stripped:=regexp_replace(v->>'text','\{\{(firm_name|firm_locality|firm_region)\}\}','','g');
  IF stripped ~ '[{}<>]' THEN RETURN false; END IF;
 END LOOP;
 RETURN (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p->'variants'))=jsonb_array_length(p->'variants');
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE TABLE outreach_campaign_opening_policies (
 workspace_id uuid NOT NULL, id uuid NOT NULL, campaign_id uuid NOT NULL, policy jsonb NOT NULL,
 revoked_at timestamptz,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,campaign_id),
 FOREIGN KEY(workspace_id,campaign_id) REFERENCES outreach_email_campaigns(workspace_id,id),
 CONSTRAINT campaign_opening_policy_shape CHECK(campaign_opening_policy_valid(policy)
  AND policy->>'workspaceId'=workspace_id::text AND policy->>'id'=id::text AND policy->>'campaignId'=campaign_id::text)
);
CREATE FUNCTION campaign_opening_policy_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.workspace_id,NEW.id,NEW.campaign_id,NEW.policy) IS DISTINCT FROM (OLD.workspace_id,OLD.id,OLD.campaign_id,OLD.policy)
   OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN RAISE EXCEPTION 'opening policy immutable' USING ERRCODE='23514',CONSTRAINT='campaign_opening_policy_immutable'; END IF;
 ELSE
  IF NEW.revoked_at IS NOT NULL OR (NEW.policy->>'approvedAt')::timestamptz>clock_timestamp()
   OR (NEW.policy->>'expiresAt')::timestamptz<=clock_timestamp() OR NOT EXISTS(
    SELECT 1 FROM outreach_email_campaigns c JOIN workspace_memberships m ON m.workspace_id=c.workspace_id AND m.user_id=c.owner_user_id
    JOIN sequence_versions v ON v.workspace_id=c.workspace_id AND v.id=c.sequence_version_id AND v.state='published' AND v.retired_at IS NULL
    JOIN sequence_steps s ON s.workspace_id=v.workspace_id AND s.sequence_version_id=v.id AND s.channel='email'
    JOIN template_versions t ON t.workspace_id=s.workspace_id AND t.id=s.template_version_id AND t.approved_at IS NOT NULL AND t.retired_at IS NULL
    WHERE c.workspace_id=NEW.workspace_id AND c.id=NEW.campaign_id AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp()
    AND c.owner_user_id=(NEW.policy->>'ownerUserId')::uuid AND m.role='admin' AND m.status='active'
    AND c.revision=(NEW.policy->>'campaignRevision')::integer AND c.sequence_version_id=(NEW.policy->>'sequenceVersionId')::uuid
    AND t.id=(NEW.policy->>'templateVersionId')::uuid AND t.content_hash=NEW.policy->>'templateContentHash'
    AND s.ordinal=(SELECT min(ordinal) FROM sequence_steps WHERE workspace_id=v.workspace_id AND sequence_version_id=v.id AND channel='email')
    AND (NEW.policy->>'expiresAt')::timestamptz<=c.expires_at
   ) THEN RAISE EXCEPTION 'opening policy current binding required' USING ERRCODE='23514',CONSTRAINT='campaign_opening_policy_binding'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER campaign_opening_policy_fence BEFORE INSERT OR UPDATE ON outreach_campaign_opening_policies FOR EACH ROW EXECUTE FUNCTION campaign_opening_policy_fence();
CREATE FUNCTION campaign_opening_binding_valid(b jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text;
BEGIN
 IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(b))<>16
  OR NOT b ?& ARRAY['workspaceId','ownerUserId','campaignId','campaignRevision','policyId','sequenceVersionId','templateVersionId','templateContentHash','enrollmentId','executionId','firmId','candidateId','candidateRevision','qualificationRunId','sourceFingerprint','validUntil']
  OR b->>'templateContentHash' !~ '^[a-f0-9]{64}$' OR b->>'sourceFingerprint' !~ '^[a-f0-9]{64}$'
  OR (b->>'candidateRevision')::integer<1 OR (b->>'campaignRevision')::integer<1 OR NOT isfinite((b->>'validUntil')::timestamptz)
  OR EXISTS(SELECT 1 FROM jsonb_each(b) WHERE value='null'::jsonb) THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['workspaceId','ownerUserId','campaignId','policyId','sequenceVersionId','templateVersionId','enrollmentId','executionId','firmId','candidateId','qualificationRunId'] LOOP PERFORM (b->>k)::uuid; END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE TABLE outreach_campaign_opening_attempts (
 workspace_id uuid NOT NULL, execution_id uuid NOT NULL, attempt_id uuid NOT NULL,
 binding jsonb NOT NULL, snapshot_hash text NOT NULL CHECK(snapshot_hash ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'unknown' CHECK(state IN ('unknown','ready','refused','invalidated')),
 claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz, invalidated_at timestamptz,
 content jsonb, fence_id uuid, subject_hash text, body_hash text,
 PRIMARY KEY(workspace_id,execution_id), UNIQUE(workspace_id,attempt_id),
 CONSTRAINT campaign_opening_content_shape CHECK((state='ready' AND content IS NOT NULL) OR (state<>'ready' AND content IS NULL)),
 CONSTRAINT campaign_opening_finished CHECK((state IN ('ready','refused'))=(finished_at IS NOT NULL) OR state='invalidated'),
 CONSTRAINT campaign_opening_times CHECK(isfinite(claimed_at) AND (finished_at IS NULL OR (isfinite(finished_at) AND finished_at>=claimed_at))
  AND (invalidated_at IS NULL OR (isfinite(invalidated_at) AND invalidated_at>=claimed_at))),
 CONSTRAINT campaign_opening_fence_hashes CHECK((fence_id IS NULL AND subject_hash IS NULL AND body_hash IS NULL)
  OR (fence_id IS NOT NULL AND subject_hash ~ '^[a-f0-9]{64}$' AND body_hash ~ '^[a-f0-9]{64}$')),
 CONSTRAINT campaign_opening_binding_shape CHECK(campaign_opening_binding_valid(binding))
);
CREATE FUNCTION campaign_opening_attempt_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p jsonb; payload jsonb; expected text; cid jsonb;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'unknown' OR NEW.content IS NOT NULL OR NEW.finished_at IS NOT NULL OR NEW.invalidated_at IS NOT NULL OR NEW.fence_id IS NOT NULL
   OR NEW.claimed_at>clock_timestamp() THEN RAISE EXCEPTION 'opening must start unknown' USING ERRCODE='23514'; END IF;
 ELSE
  IF (NEW.workspace_id,NEW.execution_id,NEW.attempt_id,NEW.binding,NEW.snapshot_hash,NEW.claimed_at) IS DISTINCT FROM
     (OLD.workspace_id,OLD.execution_id,OLD.attempt_id,OLD.binding,OLD.snapshot_hash,OLD.claimed_at)
   OR (OLD.invalidated_at IS NOT NULL AND (NEW.invalidated_at IS DISTINCT FROM OLD.invalidated_at OR NEW.state IS DISTINCT FROM OLD.state OR NEW.content IS NOT NULL))
   OR (OLD.finished_at IS NOT NULL AND NEW.finished_at IS DISTINCT FROM OLD.finished_at)
   OR (OLD.state='unknown' AND NEW.state NOT IN ('unknown','ready','refused'))
   OR (OLD.state='ready' AND NEW.state NOT IN ('ready','invalidated'))
   OR (OLD.state IN ('refused','invalidated') AND NEW.state<>OLD.state)
   OR (OLD.state='ready' AND NEW.content IS NOT NULL AND NEW.content IS DISTINCT FROM OLD.content)
   OR (OLD.fence_id IS NOT NULL AND (NEW.fence_id,NEW.subject_hash,NEW.body_hash) IS DISTINCT FROM (OLD.fence_id,OLD.subject_hash,OLD.body_hash))
   THEN RAISE EXCEPTION 'opening immutable attempt or transition' USING ERRCODE='23514',CONSTRAINT='campaign_opening_attempt_immutable'; END IF;
 END IF;
 IF TG_OP='INSERT' OR (NEW.state='ready' AND NEW.content IS NOT NULL) THEN
  SELECT op.policy,c.payload INTO p,payload FROM outreach_campaign_opening_policies op
   JOIN outreach_email_campaigns campaign ON campaign.workspace_id=op.workspace_id AND campaign.id=op.campaign_id AND campaign.revoked_at IS NULL AND campaign.expires_at>clock_timestamp()
   JOIN outreach_email_campaign_admissions a ON a.workspace_id=op.workspace_id AND a.campaign_id=op.campaign_id
   JOIN sequence_enrollments e ON e.workspace_id=a.workspace_id AND e.id=a.enrollment_id AND e.ended_at IS NULL
   JOIN step_executions x ON x.workspace_id=e.workspace_id AND x.enrollment_id=e.id AND x.id=NEW.execution_id
   JOIN sequence_steps s ON s.workspace_id=x.workspace_id AND s.id=x.step_id AND s.channel='email'
   JOIN template_versions t ON t.workspace_id=s.workspace_id AND t.id=s.template_version_id AND t.approved_at IS NOT NULL AND t.retired_at IS NULL
   JOIN sourcing_candidates c ON c.workspace_id=a.workspace_id AND c.id=a.candidate_id AND NOT c.qualification_blocked AND c.status<>'dismissed'
   JOIN firms f ON f.workspace_id=e.workspace_id AND f.id=e.firm_id AND f.status='active' AND f.assigned_user_id=e.assigned_user_id
   JOIN workspace_memberships m ON m.workspace_id=f.workspace_id AND m.user_id=f.assigned_user_id AND m.role='admin' AND m.status='active'
   WHERE op.workspace_id=NEW.workspace_id AND op.id=(NEW.binding->>'policyId')::uuid AND op.revoked_at IS NULL
   AND op.policy->>'ownerUserId'=e.assigned_user_id::text AND campaign.revision=(NEW.binding->>'campaignRevision')::integer
   AND campaign.owner_user_id=e.assigned_user_id AND e.sequence_version_id=campaign.sequence_version_id
   AND op.policy->>'campaignRevision'=campaign.revision::text AND op.policy->>'sequenceVersionId'=e.sequence_version_id::text
   AND op.policy->>'templateVersionId'=t.id::text AND op.policy->>'templateContentHash'=t.content_hash
   AND (op.policy->>'approvedAt')::timestamptz<=NEW.claimed_at
   AND (NEW.binding->>'validUntil')::timestamptz>clock_timestamp() AND (NEW.binding->>'validUntil')::timestamptz<=(op.policy->>'expiresAt')::timestamptz
   AND NEW.binding->>'workspaceId'=NEW.workspace_id::text AND NEW.binding->>'executionId'=NEW.execution_id::text
   AND NEW.binding->>'campaignId'=campaign.id::text AND NEW.binding->>'ownerUserId'=campaign.owner_user_id::text
   AND NEW.binding->>'enrollmentId'=e.id::text AND NEW.binding->>'firmId'=e.firm_id::text
   AND NEW.binding->>'sequenceVersionId'=e.sequence_version_id::text AND NEW.binding->>'templateVersionId'=t.id::text AND NEW.binding->>'templateContentHash'=t.content_hash
   AND NEW.binding->>'candidateId'=c.id::text AND (NEW.binding->>'candidateRevision')::integer=c.revision
   AND NEW.binding->>'qualificationRunId'=a.qualification_run_id::text
   AND s.ordinal=(SELECT min(ordinal) FROM sequence_steps WHERE workspace_id=s.workspace_id AND sequence_version_id=s.sequence_version_id AND channel='email');
  IF p IS NULL THEN RAISE EXCEPTION 'opening current execution binding required' USING ERRCODE='23514',CONSTRAINT='campaign_opening_attempt_binding'; END IF;
  IF NEW.content IS NOT NULL THEN
   IF jsonb_typeof(NEW.content) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(NEW.content))<>2
    OR NOT NEW.content ?& ARRAY['opening','choice'] OR jsonb_typeof(NEW.content->'opening') IS DISTINCT FROM 'string'
    OR length(NEW.content->>'opening') NOT BETWEEN 1 AND 800 OR NEW.content->>'opening' ~ '[[:cntrl:]<>]'
    OR jsonb_typeof(NEW.content->'choice') IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(NEW.content->'choice'))<>2
    OR NOT (NEW.content->'choice') ?& ARRAY['variantId','citationIds'] THEN RAISE EXCEPTION 'invalid opening choice' USING ERRCODE='23514'; END IF;
   SELECT value->>'text' INTO expected FROM jsonb_array_elements(p->'variants') WHERE value->>'id'=NEW.content->'choice'->>'variantId';
   expected:=replace(replace(replace(expected,'{{firm_name}}',payload->>'firmName'),'{{firm_locality}}',payload->>'locality'),'{{firm_region}}',payload->>'region');
   IF expected IS NULL OR expected IS DISTINCT FROM NEW.content->>'opening' OR jsonb_typeof(NEW.content->'choice'->'citationIds') IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.content->'choice'->'citationIds') NOT BETWEEN 1 AND 30 THEN RAISE EXCEPTION 'unapproved opening' USING ERRCODE='23514'; END IF;
   IF (SELECT count(DISTINCT value) FROM jsonb_array_elements(NEW.content->'choice'->'citationIds'))<>jsonb_array_length(NEW.content->'choice'->'citationIds')
    THEN RAISE EXCEPTION 'duplicate opening citation' USING ERRCODE='23514'; END IF;
   FOR cid IN SELECT value FROM jsonb_array_elements(NEW.content->'choice'->'citationIds') LOOP
    IF jsonb_typeof(cid) IS DISTINCT FROM 'string' OR NOT EXISTS(SELECT 1 FROM sourcing_qualification_runs r,
      jsonb_array_elements(r.facts) fact WHERE r.workspace_id=NEW.workspace_id AND r.id=(NEW.binding->>'qualificationRunId')::uuid
      AND fact->>'kind' IN ('firm_identity','service_area','residential_management')
      AND (fact->>'observationId')||':'||(fact->>'blockId')=cid#>>'{}') THEN RAISE EXCEPTION 'foreign opening citation' USING ERRCODE='23514'; END IF;
   END LOOP;
  END IF;
 END IF;
 IF NEW.fence_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM outbound_messages o WHERE o.workspace_id=NEW.workspace_id AND o.id=NEW.fence_id AND o.step_execution_id=NEW.execution_id
  AND encode(sha256(convert_to(o.subject,'UTF8')),'hex')=NEW.subject_hash AND encode(sha256(convert_to(o.body,'UTF8')),'hex')=NEW.body_hash)
  AND NOT (TG_OP='UPDATE' AND OLD.fence_id IS NOT NULL) THEN RAISE EXCEPTION 'opening fence exact bytes required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER campaign_opening_attempt_fence BEFORE INSERT OR UPDATE ON outreach_campaign_opening_attempts FOR EACH ROW EXECUTE FUNCTION campaign_opening_attempt_fence();
-- The existing send gate/claim remains the only sending engine. This last check
-- closes wall-time expiry and footer-rewrite waits after stepPermission returns.
CREATE FUNCTION campaign_opening_dispatch_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a outreach_campaign_opening_attempts%ROWTYPE; p outreach_campaign_opening_policies%ROWTYPE;
BEGIN
 IF NEW.origin_kind<>'step_execution' OR NEW.state<>'dispatching' OR OLD.state<>'prepared' THEN RETURN NEW; END IF;
 SELECT * INTO a FROM outreach_campaign_opening_attempts WHERE workspace_id=NEW.workspace_id AND execution_id=NEW.step_execution_id;
 SELECT op.* INTO p FROM outreach_campaign_opening_policies op
  JOIN outreach_email_campaign_admissions admission ON admission.workspace_id=op.workspace_id AND admission.campaign_id=op.campaign_id
  JOIN step_executions x ON x.workspace_id=admission.workspace_id AND x.enrollment_id=admission.enrollment_id
  JOIN sequence_steps s ON s.workspace_id=x.workspace_id AND s.id=x.step_id AND s.channel='email'
  WHERE op.workspace_id=NEW.workspace_id AND x.id=NEW.step_execution_id
  AND s.ordinal=(SELECT min(ordinal) FROM sequence_steps WHERE workspace_id=s.workspace_id AND sequence_version_id=s.sequence_version_id AND channel='email');
 IF a.attempt_id IS NULL AND p.id IS NULL THEN RETURN NEW; END IF;
 IF a.attempt_id IS NULL OR a.state<>'ready' OR a.content IS NULL OR a.invalidated_at IS NOT NULL
  OR a.fence_id IS DISTINCT FROM NEW.id OR a.subject_hash IS DISTINCT FROM encode(sha256(convert_to(NEW.subject,'UTF8')),'hex')
  OR a.body_hash IS DISTINCT FROM encode(sha256(convert_to(NEW.body,'UTF8')),'hex')
  OR (a.binding->>'validUntil')::timestamptz<=clock_timestamp() OR p.id IS NULL OR p.revoked_at IS NOT NULL
  OR p.id::text IS DISTINCT FROM a.binding->>'policyId' OR (p.policy->>'expiresAt')::timestamptz<=clock_timestamp()
  OR NOT EXISTS(SELECT 1 FROM outreach_email_campaigns c WHERE c.workspace_id=NEW.workspace_id AND c.id=p.campaign_id
   AND c.revoked_at IS NULL AND c.revision=(a.binding->>'campaignRevision')::integer AND c.expires_at>clock_timestamp())
 THEN RAISE EXCEPTION 'opening current claim required' USING ERRCODE='23514',CONSTRAINT='campaign_opening_dispatch_current'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER campaign_opening_dispatch_fence BEFORE UPDATE OF state ON outbound_messages FOR EACH ROW EXECUTE FUNCTION campaign_opening_dispatch_fence();
GRANT SELECT,INSERT ON outreach_campaign_opening_policies TO app_runtime,migration;
GRANT UPDATE(revoked_at) ON outreach_campaign_opening_policies TO app_runtime,migration;
GRANT SELECT,INSERT ON outreach_campaign_opening_attempts TO app_runtime,migration;
GRANT UPDATE(state,content,finished_at,invalidated_at,fence_id,subject_hash,body_hash) ON outreach_campaign_opening_attempts TO app_runtime,migration;
REVOKE DELETE,TRUNCATE ON outreach_campaign_opening_policies,outreach_campaign_opening_attempts FROM app_runtime,migration;
-- Erasure never deletes/remints the attempt, resets admission/cap history or
-- changes an attempted envelope. Unclaimed prefix bytes are physically removed.
CREATE FUNCTION erase_campaign_opening(w uuid,x uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE a outreach_campaign_opening_attempts%ROWTYPE; n integer;
BEGIN
 SELECT * INTO a FROM outreach_campaign_opening_attempts WHERE workspace_id=w AND execution_id=x FOR UPDATE;
 IF NOT FOUND OR a.invalidated_at IS NOT NULL THEN RETURN 0; END IF;
 IF a.content IS NOT NULL AND a.fence_id IS NOT NULL THEN
  UPDATE outbound_messages o SET body=substring(o.body FROM length(a.content->>'opening')+3),
   rendered_hash=encode(sha256(convert_to(o.subject||E'\n\n'||substring(o.body FROM length(a.content->>'opening')+3),'UTF8')),'hex'),updated_at=now()
   WHERE o.workspace_id=w AND o.id=a.fence_id AND o.attempt_token IS NULL AND o.state IN ('prepared','held')
   AND left(o.body,length(a.content->>'opening')+2)=(a.content->>'opening')||E'\n\n';
 END IF;
 UPDATE outreach_campaign_opening_attempts SET content=NULL,invalidated_at=clock_timestamp(),
  state=CASE WHEN state='ready' THEN 'invalidated' ELSE state END
  WHERE workspace_id=w AND execution_id=x AND invalidated_at IS NULL;
 GET DIAGNOSTICS n=ROW_COUNT; RETURN n;
END $$;
CREATE FUNCTION campaign_opening_source_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record; w uuid; target uuid;
BEGIN
 w:=OLD.workspace_id;
 IF TG_OP='UPDATE' AND to_jsonb(NEW)=to_jsonb(OLD) THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('fss.send-gate:'||w::text,0));
 FOR a IN SELECT execution_id FROM outreach_campaign_opening_attempts r WHERE r.workspace_id=w AND r.invalidated_at IS NULL AND (
  (TG_TABLE_NAME='sourcing_candidates' AND (r.binding->>'candidateId'=to_jsonb(OLD)->>'id'
   OR EXISTS(SELECT 1 FROM sourcing_discovery_promotions p WHERE p.workspace_id=w AND p.raw_candidate_id=(to_jsonb(OLD)->>'id')::uuid AND p.legacy_candidate_id=(r.binding->>'candidateId')::uuid)))
  OR (TG_TABLE_NAME='sourcing_qualification_runs' AND r.binding->>'candidateId'=to_jsonb(OLD)->>'candidate_id')
  OR (TG_TABLE_NAME='firms' AND r.binding->>'firmId'=to_jsonb(OLD)->>'id')
  OR (TG_TABLE_NAME='workspace_memberships' AND r.binding->>'ownerUserId'=to_jsonb(OLD)->>'user_id')
  OR (TG_TABLE_NAME='outreach_email_campaigns' AND r.binding->>'campaignId'=to_jsonb(OLD)->>'id')
  OR (TG_TABLE_NAME='outreach_campaign_opening_policies' AND r.binding->>'policyId'=to_jsonb(OLD)->>'id')
  OR (TG_TABLE_NAME='template_versions' AND r.binding->>'templateVersionId'=to_jsonb(OLD)->>'id')
  OR (TG_TABLE_NAME IN ('sourcing_discovery_research_firms','sourcing_automatic_research_firms') AND r.binding->>'firmId'=to_jsonb(OLD)->>'firm_id')
  OR (TG_TABLE_NAME='sourcing_discovery_promotions' AND r.binding->>'candidateId'=to_jsonb(OLD)->>'legacy_candidate_id')
  OR (TG_TABLE_NAME='sourcing_candidate_discovery_origins' AND EXISTS(SELECT 1 FROM sourcing_discovery_promotions p WHERE p.workspace_id=w AND p.raw_candidate_id=(to_jsonb(OLD)->>'candidate_id')::uuid AND p.legacy_candidate_id=(r.binding->>'candidateId')::uuid))
  OR (TG_TABLE_NAME='evidence_items' AND EXISTS(SELECT 1 FROM sourcing_qualification_runs q,jsonb_array_elements(q.observations) o
   WHERE q.workspace_id=w AND q.id=(r.binding->>'qualificationRunId')::uuid AND rtrim(o->>'url','/')=rtrim(to_jsonb(OLD)->>'source_reference','/')))
 ) ORDER BY execution_id LOOP
  target:=a.execution_id; PERFORM erase_campaign_opening(w,target);
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE FUNCTION erase_campaign_opening_sources(w uuid,urls text[]) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE a record; n integer:=0;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('fss.send-gate:'||w::text,0));
 FOR a IN SELECT r.execution_id FROM outreach_campaign_opening_attempts r WHERE r.workspace_id=w AND r.invalidated_at IS NULL AND (
  EXISTS(SELECT 1 FROM sourcing_qualification_runs q,jsonb_array_elements(q.observations) o WHERE q.workspace_id=w AND q.id=(r.binding->>'qualificationRunId')::uuid AND rtrim(o->>'url','/')=ANY(ARRAY(SELECT rtrim(u,'/') FROM unnest(urls) u)))
  OR EXISTS(SELECT 1 FROM sourcing_candidates c WHERE c.workspace_id=w AND c.id=(r.binding->>'candidateId')::uuid AND rtrim(c.payload->>'sourceUrl','/')=ANY(ARRAY(SELECT rtrim(u,'/') FROM unnest(urls) u)))
  OR EXISTS(SELECT 1 FROM sourcing_discovery_promotions p JOIN sourcing_candidate_discovery_origins o ON o.workspace_id=p.workspace_id AND o.candidate_id=p.raw_candidate_id WHERE p.workspace_id=w AND p.legacy_candidate_id=(r.binding->>'candidateId')::uuid AND rtrim(o.source->>'sourceUrl','/')=ANY(ARRAY(SELECT rtrim(u,'/') FROM unnest(urls) u)))
  OR EXISTS(SELECT 1 FROM sourcing_automatic_research_firms p WHERE p.workspace_id=w AND p.firm_id=(r.binding->>'firmId')::uuid AND rtrim(p.source_url,'/')=ANY(ARRAY(SELECT rtrim(u,'/') FROM unnest(urls) u)))
 ) ORDER BY execution_id LOOP n:=n+erase_campaign_opening(w,a.execution_id); END LOOP;
 RETURN n;
END $$;
CREATE FUNCTION campaign_opening_evidence_denial() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.retention_expires_at<=clock_timestamp() OR (NOT NEW.terms_allow_retention AND NEW.retention_expires_at IS NULL) THEN
  PERFORM erase_campaign_opening_sources(NEW.workspace_id,ARRAY[NEW.source_reference]);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER campaign_opening_candidate_erasure BEFORE UPDATE OF revision,payload,status,qualification_blocked,source_check OR DELETE ON sourcing_candidates FOR EACH ROW EXECUTE FUNCTION campaign_opening_source_erasure();
CREATE TRIGGER campaign_opening_run_erasure BEFORE UPDATE OF facts,observations,state,reason OR DELETE ON sourcing_qualification_runs FOR EACH ROW EXECUTE FUNCTION campaign_opening_source_erasure();
CREATE FUNCTION campaign_opening_run_insert_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('fss.send-gate:'||NEW.workspace_id::text,0));
 FOR a IN SELECT execution_id FROM outreach_campaign_opening_attempts WHERE workspace_id=NEW.workspace_id
  AND binding->>'candidateId'=NEW.candidate_id::text AND invalidated_at IS NULL ORDER BY execution_id LOOP
  PERFORM erase_campaign_opening(NEW.workspace_id,a.execution_id);
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER campaign_opening_run_supersession AFTER INSERT ON sourcing_qualification_runs FOR EACH ROW EXECUTE FUNCTION campaign_opening_run_insert_erasure();
CREATE TRIGGER campaign_opening_firm_erasure BEFORE UPDATE OF name,website,locality,region_code,status,assigned_user_id OR DELETE ON firms FOR EACH ROW EXECUTE FUNCTION campaign_opening_source_erasure();
CREATE TRIGGER campaign_opening_member_erasure BEFORE UPDATE OF role,status OR DELETE ON workspace_memberships FOR EACH ROW EXECUTE FUNCTION campaign_opening_source_erasure();
CREATE TRIGGER campaign_opening_campaign_erasure BEFORE UPDATE OR DELETE ON outreach_email_campaigns FOR EACH ROW EXECUTE FUNCTION campaign_opening_source_erasure();
CREATE TRIGGER campaign_opening_policy_erasure BEFORE UPDATE OR DELETE ON outreach_campaign_opening_policies FOR EACH ROW EXECUTE FUNCTION campaign_opening_source_erasure();
CREATE TRIGGER campaign_opening_template_erasure BEFORE UPDATE OF subject,body,content_hash,approved_at,retired_at OR DELETE ON template_versions FOR EACH ROW EXECUTE FUNCTION campaign_opening_source_erasure();
CREATE TRIGGER campaign_opening_origin_erasure BEFORE UPDATE OR DELETE ON sourcing_candidate_discovery_origins FOR EACH ROW EXECUTE FUNCTION campaign_opening_source_erasure();
CREATE TRIGGER campaign_opening_promotion_erasure BEFORE UPDATE OR DELETE ON sourcing_discovery_promotions FOR EACH ROW EXECUTE FUNCTION campaign_opening_source_erasure();
CREATE TRIGGER campaign_opening_link_erasure BEFORE UPDATE OR DELETE ON sourcing_discovery_research_firms FOR EACH ROW EXECUTE FUNCTION campaign_opening_source_erasure();
CREATE TRIGGER campaign_opening_publication_erasure BEFORE UPDATE OR DELETE ON sourcing_automatic_research_firms FOR EACH ROW EXECUTE FUNCTION campaign_opening_source_erasure();
CREATE TRIGGER campaign_opening_evidence_erasure BEFORE UPDATE OF source_reference,content_hash,retrieved_at,terms_allow_retention,retention_expires_at OR DELETE ON evidence_items FOR EACH ROW EXECUTE FUNCTION campaign_opening_source_erasure();
CREATE TRIGGER campaign_opening_evidence_denial AFTER INSERT ON evidence_items FOR EACH ROW EXECUTE FUNCTION campaign_opening_evidence_denial();
CREATE FUNCTION sweep_campaign_openings(w uuid,batch integer) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE a record; n integer:=0;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('fss.send-gate:'||w::text,0));
 FOR a IN SELECT execution_id FROM outreach_campaign_opening_attempts WHERE workspace_id=w AND invalidated_at IS NULL
  AND (binding->>'validUntil')::timestamptz<=clock_timestamp() ORDER BY execution_id LIMIT greatest(0,least(batch,500)) FOR UPDATE SKIP LOCKED LOOP
  n:=n+erase_campaign_opening(w,a.execution_id);
 END LOOP;
 RETURN n;
END $$;
