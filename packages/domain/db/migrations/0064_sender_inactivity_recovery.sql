-- changes: mailbox_recovery_epochs, mailbox_send_ramp, mailbox_send_days
-- An inactivity epoch is independent of earned history. Its activity anchor is a
-- durable accepted outbound/matched manual Sent instant (mailbox creation only
-- when no activity was recorded). A repeated assessment cannot create it twice.
CREATE TABLE mailbox_recovery_epochs (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 mailbox_id uuid NOT NULL,
 activity_at timestamptz NOT NULL,
 started_on date NOT NULL,
 earned_cap integer NOT NULL CHECK(earned_cap BETWEEN 0 AND 100),
 qualifying_days integer NOT NULL DEFAULT 0 CHECK(qualifying_days >= 0),
 last_qualified_on date,
 stage_started_on date NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,mailbox_id) REFERENCES mailboxes(workspace_id,id),
 UNIQUE(workspace_id,mailbox_id,activity_at)
);
ALTER TABLE mailbox_send_ramp ADD COLUMN recovery_epoch_id uuid,
 ADD FOREIGN KEY(workspace_id,recovery_epoch_id) REFERENCES mailbox_recovery_epochs(workspace_id,id);
ALTER TABLE mailbox_send_days ADD COLUMN recovery_credited boolean NOT NULL DEFAULT false,
 ADD COLUMN recovery_epoch_id uuid,
 ADD COLUMN recovery_stage integer CHECK(recovery_stage BETWEEN 0 AND 5),
 ADD COLUMN recovery_cap integer CHECK(recovery_cap BETWEEN 0 AND 100),
 ADD FOREIGN KEY(workspace_id,recovery_epoch_id) REFERENCES mailbox_recovery_epochs(workspace_id,id),
 ADD CHECK((recovery_epoch_id IS NULL)=(recovery_cap IS NULL)),
 ADD CHECK((recovery_epoch_id IS NULL)=(recovery_stage IS NULL));
GRANT SELECT,INSERT,UPDATE ON mailbox_recovery_epochs TO app_runtime,migration;
