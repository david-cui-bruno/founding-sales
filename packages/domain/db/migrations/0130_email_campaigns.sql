-- changes: outreach_email_sources
-- LOCAL schema 130 only. Approval never changes any sending switch.
CREATE TABLE outreach_email_campaigns (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 owner_user_id uuid NOT NULL,
 mailbox_id uuid NOT NULL,
 sequence_version_id uuid NOT NULL,
 authorization_revision integer NOT NULL CONSTRAINT email_campaign_authorization_revision CHECK(authorization_revision>0),
 regions text[] NOT NULL CONSTRAINT email_campaign_regions CHECK(cardinality(regions) BETWEEN 1 AND 3 AND regions <@ ARRAY['TX','RI','MA']::text[] AND array_position(regions,NULL) IS NULL AND cardinality(array_positions(regions,'TX'))<=1 AND cardinality(array_positions(regions,'RI'))<=1 AND cardinality(array_positions(regions,'MA'))<=1),
 max_enrollments integer NOT NULL CONSTRAINT email_campaign_lifetime_cap CHECK(max_enrollments BETWEEN 1 AND 25),
 daily_admission_limit integer NOT NULL CONSTRAINT email_campaign_daily_cap CHECK(daily_admission_limit BETWEEN 1 AND 5),
 approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 revision integer NOT NULL DEFAULT 1 CONSTRAINT email_campaign_revision CHECK(revision>0),
 revoked_at timestamptz,
 CONSTRAINT email_campaign_pkey PRIMARY KEY(workspace_id,id),
 CONSTRAINT email_campaign_owner_fkey FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 CONSTRAINT email_campaign_mailbox_fkey FOREIGN KEY(workspace_id,mailbox_id) REFERENCES mailboxes(workspace_id,id),
 CONSTRAINT email_campaign_sequence_fkey FOREIGN KEY(workspace_id,sequence_version_id) REFERENCES sequence_versions(workspace_id,id),
 CONSTRAINT email_campaign_expiry CHECK(expires_at>approved_at AND expires_at<=approved_at+interval '30 days'),
 CONSTRAINT email_campaign_revocation CHECK((revoked_at IS NULL AND revision=1) OR (revoked_at IS NOT NULL AND revoked_at>=approved_at AND revision=2))
);
CREATE UNIQUE INDEX email_campaign_one_unrevoked ON outreach_email_campaigns(workspace_id,owner_user_id) WHERE revoked_at IS NULL;
GRANT SELECT,INSERT ON outreach_email_campaigns TO app_runtime,migration;
GRANT UPDATE(revision,revoked_at) ON outreach_email_campaigns TO app_runtime,migration;
CREATE FUNCTION outreach_email_campaign_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-ARRAY['revision','revoked_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revision','revoked_at'])
 OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.revision<>OLD.revision+1
 THEN RAISE EXCEPTION 'Invalid campaign transition' USING ERRCODE='23514',CONSTRAINT='email_campaign_immutable'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER email_campaign_immutable BEFORE UPDATE ON outreach_email_campaigns FOR EACH ROW EXECUTE FUNCTION outreach_email_campaign_transition();
ALTER TABLE outreach_email_sources ADD COLUMN campaign_id uuid,
 ADD CONSTRAINT outreach_email_sources_campaign_fkey FOREIGN KEY(workspace_id,campaign_id) REFERENCES outreach_email_campaigns(workspace_id,id),
 ADD CONSTRAINT outreach_email_sources_campaign_not_reviewed CHECK(campaign_id IS NULL OR NOT reviewed);
CREATE TABLE outreach_email_campaign_admissions (
 workspace_id uuid NOT NULL,
 campaign_id uuid NOT NULL,
 firm_id uuid NOT NULL,
 contact_id uuid NOT NULL,
 -- Opaque history, not a deletion dependency on the private email route.
 route_id uuid NOT NULL,
 plan_id uuid NOT NULL,
 enrollment_id uuid NOT NULL,
 -- Documentary opaque source IDs deliberately have no deletion cascade/FK.
 -- Source erasure must neither reset caps nor erase a successful admission.
 candidate_id uuid NOT NULL,
 qualification_run_id uuid NOT NULL,
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT email_campaign_admission_pkey PRIMARY KEY(workspace_id,campaign_id,firm_id),
 CONSTRAINT email_campaign_admission_one_firm UNIQUE(workspace_id,firm_id),
 CONSTRAINT email_campaign_admission_one_enrollment UNIQUE(workspace_id,enrollment_id),
 CONSTRAINT email_campaign_admission_campaign_fkey FOREIGN KEY(workspace_id,campaign_id) REFERENCES outreach_email_campaigns(workspace_id,id),
 CONSTRAINT email_campaign_admission_contact_fkey FOREIGN KEY(workspace_id,contact_id,firm_id) REFERENCES contacts(workspace_id,id,firm_id) ON UPDATE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT email_campaign_admission_plan_fkey FOREIGN KEY(workspace_id,plan_id,firm_id) REFERENCES outreach_plans(workspace_id,id,firm_id) ON UPDATE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT email_campaign_admission_enrollment_fkey FOREIGN KEY(workspace_id,enrollment_id,firm_id) REFERENCES sequence_enrollments(workspace_id,id,firm_id) ON UPDATE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
GRANT SELECT,INSERT ON outreach_email_campaign_admissions TO app_runtime,migration;
-- Exact workspace/source/route/plan/enrollment lineage is verified on INSERT,
-- without retaining private evidence or blocking later source erasure.
CREATE FUNCTION outreach_email_campaign_admission_lineage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM outreach_email_campaigns c
 JOIN outreach_email_sources s ON s.workspace_id=c.workspace_id AND s.campaign_id=c.id AND NOT s.reviewed AND NOT s.association_review_required
 JOIN outreach_plans p ON p.workspace_id=s.workspace_id AND p.id=NEW.plan_id AND p.firm_id=s.firm_id AND p.contact_id=s.contact_id AND p.candidate_id=s.candidate_id AND p.qualification_run_id=s.run_id AND p.owner_user_id=c.owner_user_id AND p.mailbox_id=c.mailbox_id AND p.lane='email_first'
 JOIN sequence_enrollments e ON e.workspace_id=p.workspace_id AND e.id=NEW.enrollment_id AND e.outreach_plan_id=p.id AND e.firm_id=p.firm_id AND e.contact_id=p.contact_id AND e.sequence_version_id=c.sequence_version_id AND e.origin_kind='prospecting'
 JOIN email_addresses r ON r.workspace_id=s.workspace_id AND r.id=s.route_id AND r.firm_id=s.firm_id AND r.contact_id=s.contact_id
 WHERE c.workspace_id=NEW.workspace_id AND c.id=NEW.campaign_id AND s.firm_id=NEW.firm_id AND s.contact_id=NEW.contact_id AND s.route_id=NEW.route_id AND s.candidate_id=NEW.candidate_id AND s.run_id=NEW.qualification_run_id)
 THEN RAISE EXCEPTION 'Invalid campaign admission lineage' USING ERRCODE='23514',CONSTRAINT='email_campaign_admission_lineage'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER email_campaign_admission_lineage BEFORE INSERT ON outreach_email_campaign_admissions FOR EACH ROW EXECUTE FUNCTION outreach_email_campaign_admission_lineage();
