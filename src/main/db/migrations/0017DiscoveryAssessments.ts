import { sql, type Kysely } from 'kysely';

import type { FoundationDatabase } from '../schema';

// These helpers generate only fixed migration SQL, never caller-supplied names.
const text = (column: string, max = 256) => `typeof(${column}) = 'text'
  AND length(${column}) BETWEEN 1 AND ${max} AND trim(${column}) = ${column}
  AND instr(${column}, char(0)) = 0
  AND ${column} NOT GLOB '*[' || char(1) || '-' || char(31) || char(127) || ']*'`;
const uuid = (column: string) => `length(${column}) = 36
  AND substr(${column},9,1) = '-' AND substr(${column},14,1) = '-'
  AND substr(${column},19,1) = '-' AND substr(${column},24,1) = '-'
  AND length(replace(${column},'-','')) = 32
  AND replace(${column},'-','') NOT GLOB '*[^0-9a-f]*'
  AND (${column} IN ('00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff')
    OR (substr(${column},15,1) GLOB '[1-8]' AND substr(${column},20,1) GLOB '[89ab]'))`;
const fingerprint = (column: string) => `length(${column}) = 64
  AND length(CAST(${column} AS BLOB)) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'`;
const utc = (column: string) => `length(${column}) = 24
  AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}, '+0 seconds') IS ${column}`;
const date = (column: string) => `length(${column}) = 10 AND date(${column}, '+0 days') IS ${column}`;
const json = (column: string) => `length(${column}) BETWEEN 2 AND 2000000
  AND json_valid(${column}) AND json_type(${column}) = 'object'`;
const field = (column: string, key: string, value: string) => `json_extract(${column}, '$.${key}') IS ${value}`;
const ownerMatch = `EXISTS (SELECT 1 FROM prospects p JOIN sales_cycles c
  ON c.prospect_id = p.id AND c.person_id = p.person_id
  WHERE p.id = NEW.prospect_id AND p.person_id = NEW.person_id AND c.id = NEW.sales_cycle_id)`;
const assessmentMatch = `EXISTS (SELECT 1 FROM discovery_assessments a
  WHERE a.id = NEW.assessment_id AND a.person_id = NEW.person_id
    AND a.prospect_id = NEW.prospect_id AND a.sales_cycle_id = NEW.sales_cycle_id
    AND a.fingerprint = NEW.fingerprint)`;

export const migration0017DiscoveryAssessments = {
  async up(db: Kysely<FoundationDatabase>) {
    const statements = [
      `CREATE TABLE discovery_assessments (
        id TEXT NOT NULL PRIMARY KEY CHECK (${uuid('id')}),
        person_id TEXT NOT NULL CHECK (${text('person_id')}),
        prospect_id TEXT NOT NULL CHECK (${text('prospect_id')}),
        sales_cycle_id TEXT NOT NULL CHECK (${text('sales_cycle_id')}),
        fingerprint TEXT NOT NULL CHECK (${fingerprint('fingerprint')}),
        policy_version TEXT NOT NULL CHECK (policy_version = 'discovery-v1'),
        rule_version_id TEXT NOT NULL REFERENCES prioritization_rule_versions(id),
        model_version TEXT CHECK (model_version IS NULL OR (${text('model_version')})),
        evaluated_at TEXT NOT NULL CHECK (${utc('evaluated_at')}),
        expires_at TEXT NOT NULL CHECK (${utc('expires_at')} AND expires_at > evaluated_at),
        local_date TEXT NOT NULL CHECK (${date('local_date')}),
        override_id TEXT REFERENCES discovery_overrides(id),
        disposition TEXT NOT NULL CHECK (disposition IN ('candidate','research','judgment','watch','excluded')),
        assessment_json TEXT NOT NULL CHECK (${json('assessment_json')}),
        CHECK (${[
          ['id', 'id'], ['personId', 'person_id'], ['prospectId', 'prospect_id'], ['salesCycleId', 'sales_cycle_id'],
          ['fingerprint', 'fingerprint'], ['policyVersion', 'policy_version'], ['ruleVersionId', 'rule_version_id'],
          ['modelVersion', 'model_version'], ['evaluatedAt', 'evaluated_at'], ['expiresAt', 'expires_at'],
          ['localDate', 'local_date'], ['overrideId', 'override_id'], ['disposition', 'disposition'],
        ].map(([key, column]) => field('assessment_json', key, column)).join(' AND ')}),
        UNIQUE (id, prospect_id),
        FOREIGN KEY (prospect_id, person_id) REFERENCES prospects(id, person_id),
        FOREIGN KEY (sales_cycle_id, person_id) REFERENCES sales_cycles(id, person_id)
      )`,
      `CREATE TABLE discovery_current (
        prospect_id TEXT NOT NULL PRIMARY KEY REFERENCES prospects(id) CHECK (${text('prospect_id')}),
        assessment_id TEXT NOT NULL CHECK (${uuid('assessment_id')}),
        version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version BETWEEN 1 AND 9007199254740991),
        FOREIGN KEY (assessment_id, prospect_id) REFERENCES discovery_assessments(id, prospect_id)
      )`,
      `CREATE TABLE discovery_overrides (
        id TEXT NOT NULL PRIMARY KEY CHECK (${uuid('id')}),
        assessment_id TEXT NOT NULL REFERENCES discovery_assessments(id),
        person_id TEXT NOT NULL CHECK (${text('person_id')}),
        prospect_id TEXT NOT NULL CHECK (${text('prospect_id')}),
        sales_cycle_id TEXT NOT NULL CHECK (${text('sales_cycle_id')}),
        fingerprint TEXT NOT NULL CHECK (${fingerprint('fingerprint')}),
        decision TEXT NOT NULL CHECK (decision IN ('watch','exclude','reconsider')),
        reason TEXT NOT NULL CHECK (${text('reason', 2000)}),
        created_at TEXT NOT NULL CHECK (${utc('created_at')}),
        FOREIGN KEY (prospect_id, person_id) REFERENCES prospects(id, person_id),
        FOREIGN KEY (sales_cycle_id, person_id) REFERENCES sales_cycles(id, person_id)
      )`,
      `CREATE TABLE discovery_preparations (
        id TEXT NOT NULL PRIMARY KEY CHECK (${uuid('id')}),
        assessment_id TEXT NOT NULL REFERENCES discovery_assessments(id),
        person_id TEXT NOT NULL CHECK (${text('person_id')}),
        prospect_id TEXT NOT NULL CHECK (${text('prospect_id')}),
        sales_cycle_id TEXT NOT NULL CHECK (${text('sales_cycle_id')}),
        fingerprint TEXT NOT NULL CHECK (${fingerprint('fingerprint')}),
        action_id TEXT NOT NULL CHECK (${text('action_id')}),
        request_json TEXT NOT NULL CHECK (${json('request_json')}),
        receipt_json TEXT NOT NULL CHECK (${json('receipt_json')}),
        CHECK (${[
          ['commandId', 'id'], ['assessmentId', 'assessment_id'], ['personId', 'person_id'],
          ['salesCycleId', 'sales_cycle_id'], ['expectedFingerprint', 'fingerprint'],
        ].map(([key, column]) => field('request_json', key, column)).join(' AND ')}),
        CHECK (${[
          ['assessmentId', 'assessment_id'], ['personId', 'person_id'], ['salesCycleId', 'sales_cycle_id'], ['actionId', 'action_id'],
        ].map(([key, column]) => field('receipt_json', key, column)).join(' AND ')}),
        CHECK (json_type(receipt_json, '$.mutation') IS 'object'
          AND json_type(receipt_json, '$.mutation.revision') IS 'integer'
          AND json_extract(receipt_json, '$.mutation.revision') BETWEEN 0 AND 9007199254740991),
        FOREIGN KEY (prospect_id, person_id) REFERENCES prospects(id, person_id),
        FOREIGN KEY (sales_cycle_id, person_id) REFERENCES sales_cycles(id, person_id),
        FOREIGN KEY (action_id, sales_cycle_id) REFERENCES next_actions(id, sales_cycle_id)
      )`,
      `CREATE TABLE discovery_scan_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        cursor TEXT CHECK (cursor IS NULL OR (${text('cursor')})),
        last_complete_scan_at TEXT CHECK (last_complete_scan_at IS NULL OR (${utc('last_complete_scan_at')})),
        last_complete_local_date TEXT CHECK (last_complete_local_date IS NULL OR (${date('last_complete_local_date')})),
        CHECK ((last_complete_scan_at IS NULL) = (last_complete_local_date IS NULL))
      )`,
      `CREATE INDEX discovery_assessments_prospect_evaluated_idx ON discovery_assessments(prospect_id, evaluated_at, id)`,
      `CREATE INDEX discovery_assessments_disposition_expires_idx ON discovery_assessments(disposition, expires_at)`,
      `CREATE INDEX discovery_overrides_owner_created_idx ON discovery_overrides(prospect_id, created_at, id)`,
      `CREATE INDEX jobs_type_state_created_idx ON jobs(type, state, created_at, id)`,
      `CREATE TRIGGER discovery_assessments_owner_insert BEFORE INSERT ON discovery_assessments
        WHEN NOT ${ownerMatch} OR (NEW.override_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM discovery_overrides o WHERE o.id = NEW.override_id
            AND o.person_id = NEW.person_id AND o.prospect_id = NEW.prospect_id AND o.sales_cycle_id = NEW.sales_cycle_id
        )) BEGIN SELECT RAISE(ABORT, 'Discovery assessment ownership mismatch.'); END`,
      ...['INSERT', 'UPDATE'].map(operation => `CREATE TRIGGER discovery_current_owner_${operation.toLowerCase()}
        BEFORE ${operation} ON discovery_current WHEN NOT EXISTS (
          SELECT 1 FROM discovery_assessments a JOIN prospects p ON p.id = a.prospect_id AND p.person_id = a.person_id
          JOIN sales_cycles c ON c.id = a.sales_cycle_id AND c.person_id = a.person_id AND c.prospect_id = a.prospect_id
          WHERE a.id = NEW.assessment_id AND a.prospect_id = NEW.prospect_id
        ) BEGIN SELECT RAISE(ABORT, 'Discovery current ownership mismatch.'); END`),
      ...['overrides', 'preparations'].map(table => `CREATE TRIGGER discovery_${table}_owner_insert
        BEFORE INSERT ON discovery_${table} WHEN NOT ${ownerMatch} OR NOT ${assessmentMatch}
        BEGIN SELECT RAISE(ABORT, 'Discovery receipt ownership mismatch.'); END`),
      ...['assessments', 'overrides', 'preparations'].flatMap(table => ['UPDATE', 'DELETE'].map(operation => (
        `CREATE TRIGGER discovery_${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON discovery_${table}
        BEGIN SELECT RAISE(ABORT, 'Discovery history is immutable.'); END`
      ))),
    ];
    for (const statement of statements) await sql.raw(statement).execute(db);
    // The worker explicitly initializes scan metadata. Composition never does.
    const timestamp = new Date().toISOString();
    await sql`UPDATE app_meta SET schema_version = 17, updated_at = ${timestamp} WHERE singleton = 1`.execute(db);
  },
};
