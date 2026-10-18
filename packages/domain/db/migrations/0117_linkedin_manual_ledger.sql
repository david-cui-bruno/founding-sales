-- changes: linkedin_manual_ledgers, linkedin_manual_entries, linkedin_manual_stops
-- Manual owner assertions only. Additive history, never native dispatch or acceptance.
-- Profile/name/body bytes remain in existing erasure-aware CRM sources, not this ledger.
CREATE TABLE linkedin_manual_ledgers (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL,
 owner_user_id uuid NOT NULL,
 account_id uuid NOT NULL,
 person_id uuid NOT NULL,
 firm_id uuid NOT NULL,
 claim_id uuid NOT NULL,
 claim_revision integer NOT NULL CHECK(claim_revision>0),
 relationship_id uuid NOT NULL,
 relationship_revision integer NOT NULL CHECK(relationship_revision>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,owner_user_id,account_id,person_id,firm_id,claim_id,claim_revision,relationship_id,relationship_revision),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 FOREIGN KEY(workspace_id,account_id) REFERENCES social_accounts(workspace_id,id),
 FOREIGN KEY(workspace_id,person_id) REFERENCES crm_people(workspace_id,id),
 FOREIGN KEY(workspace_id,firm_id) REFERENCES firms(workspace_id,id),
 FOREIGN KEY(workspace_id,claim_id,claim_revision) REFERENCES crm_endpoint_claim_revisions(workspace_id,claim_id,revision),
 FOREIGN KEY(workspace_id,relationship_id,relationship_revision) REFERENCES crm_relationship_revisions(workspace_id,relationship_id,revision)
);
CREATE TABLE linkedin_manual_entries (
 workspace_id uuid NOT NULL,
 ledger_id uuid NOT NULL,
 entry_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 sequence bigint GENERATED ALWAYS AS IDENTITY,
 kind text NOT NULL CHECK(kind IN ('connection','invite','message','reply','refusal')),
 connection_state text CHECK(connection_state IN ('unknown','pending','accepted')),
 occurred_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 voided boolean NOT NULL DEFAULT false,
 correction text CHECK(correction IN ('date','kind','connection_state','void')),
 actor_user_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,entry_id,revision),
 UNIQUE(sequence),
 FOREIGN KEY(workspace_id,ledger_id) REFERENCES linkedin_manual_ledgers(workspace_id,id),
 FOREIGN KEY(workspace_id,actor_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 CHECK((kind='connection')=(connection_state IS NOT NULL)),
 CHECK((revision=1)=(correction IS NULL)),
 CHECK(revision>1 OR NOT voided)
);
CREATE INDEX linkedin_manual_entries_history ON linkedin_manual_entries(workspace_id,ledger_id,sequence DESC);
CREATE TABLE linkedin_manual_stops (
 workspace_id uuid NOT NULL,
 person_id uuid NOT NULL,
 firm_id uuid NOT NULL,
 entry_id uuid NOT NULL,
 entry_revision integer NOT NULL,
 hold_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,person_id,firm_id),
 FOREIGN KEY(workspace_id,person_id) REFERENCES crm_people(workspace_id,id),
 FOREIGN KEY(workspace_id,firm_id) REFERENCES firms(workspace_id,id),
 FOREIGN KEY(workspace_id,entry_id,entry_revision) REFERENCES linkedin_manual_entries(workspace_id,entry_id,revision),
 FOREIGN KEY(workspace_id,hold_id) REFERENCES active_holds(workspace_id,id)
);
GRANT SELECT,INSERT ON linkedin_manual_ledgers,linkedin_manual_entries,linkedin_manual_stops TO app_runtime,migration;
GRANT USAGE,SELECT ON SEQUENCE linkedin_manual_entries_sequence_seq TO app_runtime,migration;
REVOKE UPDATE,DELETE,TRUNCATE ON linkedin_manual_ledgers,linkedin_manual_entries,linkedin_manual_stops FROM app_runtime,migration;
