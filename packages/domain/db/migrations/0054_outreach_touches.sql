-- changes: outreach_plans, sequence_enrollments
ALTER TABLE outreach_plans ADD COLUMN cadence jsonb, ADD COLUMN expires_at timestamptz,
 ADD CONSTRAINT outreach_cadence_pair CHECK((cadence IS NULL)=(expires_at IS NULL)),
 ADD CONSTRAINT outreach_cadence_shape CHECK(cadence IS NULL OR (jsonb_typeof(cadence)='object' AND cadence->>'version'='outreach-cadence-v1'));
-- Schedule and lane are frozen on creation. State changes cannot restart their clock.
REVOKE UPDATE ON outreach_plans FROM app_runtime;
GRANT UPDATE(state,revision,updated_at) ON outreach_plans TO app_runtime;
CREATE TABLE outreach_touch_reservations (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 plan_id uuid NOT NULL,
 firm_id uuid NOT NULL,
 action_id text NOT NULL CHECK(length(action_id) BETWEEN 1 AND 200),
 channel text NOT NULL CHECK(channel IN ('phone','email')),
 ordinal integer NOT NULL CHECK(ordinal>0 AND ordinal<=8),
 skipped_ordinals integer[] NOT NULL DEFAULT '{}' CHECK(skipped_ordinals <@ ARRAY[1,2,3,4,5,6,7,8]),
 local_date date NOT NULL,
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','accepted','unknown','released')),
 claimed_at timestamptz NOT NULL,
 settled_at timestamptz,
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,channel,action_id),
 FOREIGN KEY(workspace_id,plan_id) REFERENCES outreach_plans(workspace_id,id),
 FOREIGN KEY(workspace_id,firm_id) REFERENCES firms(workspace_id,id),
 CONSTRAINT outreach_touch_settlement CHECK((state='reserved')=(settled_at IS NULL))
);
CREATE UNIQUE INDEX outreach_touch_one_day ON outreach_touch_reservations(workspace_id,firm_id,local_date) WHERE state<>'released';
CREATE UNIQUE INDEX outreach_touch_one_ordinal ON outreach_touch_reservations(workspace_id,plan_id,ordinal) WHERE state<>'released';
GRANT SELECT,INSERT,UPDATE,DELETE ON outreach_touch_reservations TO app_runtime,migration;

-- Existing unscoped cold work is not a selected new cohort. A mailbox authorization
-- never promotes it into the new prospecting engine.
UPDATE sequence_enrollments SET origin_kind='cold_legacy' WHERE origin_kind='prospecting' AND outreach_plan_id IS NULL;
